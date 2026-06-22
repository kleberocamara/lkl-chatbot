# OS-1 · Criação e Fluxo da Ordem de Serviço — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir a criação de Ordens de Serviço a partir de orçamentos aprovados — 1 OS automática com todos os itens de Comunicação Visual ao aprovar, e agrupamento manual de itens Offset (de qualquer cliente/orçamento) numa OS — com especificações/acabamentos e o fluxo de status existente.

**Architecture:** Node.js/Express + PostgreSQL no VPS. `ordens_servico` deixa de ser 1-item e passa a referenciar vários `orcamento_itens` via tabela `os_itens` (M2M). A regra auto/manual é decidida por `orcamento_itens.tipo_producao`. Backend em `src/modules/os` e gancho em `src/modules/orcamentos`. Frontend no dashboard (aba OS) + ajustes leves nas PWAs de produção.

**Tech Stack:** Express, pg (pool), Jest/supertest (suite roda no VPS/DB de teste), dashboard HTML vanilla, PWAs HTML.

**Convenções deste repositório (importante):**
- Migrations incrementais ficam em `sql/migrations/NNN_*.sql` e são aplicadas **manualmente** via `psql` no VPS (o `npm run migrate` aplica apenas `sql/schema.sql`, não os incrementais).
- **Não há postgres local** — verificação é feita por: `node --check <arquivo>`; smoke server-side no VPS com `node -r dotenv/config -e '...'`; e smoke HTTP em produção (`curl 127.0.0.1:3000`). Os testes jest (`tests/modules/*.test.js`) miram a API legada `/api/*` e o DB `lkl_chatbot_test`; atualize-os como artefato, mas o gate de verificação é o smoke no VPS.
- Deploy: `rsync -az <arquivo> root@2.25.147.243:/var/www/lkl-chatbot/<arquivo>` + `ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"`.
- DB no VPS: `ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot ..."`.
- Os módulos v2 são montados em `/api/v2/*` (o dashboard usa esse prefixo). A última migration existente é a **024**.
- **O banco de OS está zerado** (ordens_servico/orcamento_itens de teste apagados) — migração de schema é limpa, sem dados a preservar.

**Mapa de arquivos (o que cada um faz):**
- `sql/migrations/025..028_*.sql` — schema: tipo_producao no item, OS multi-item, os_itens, especificacoes.
- `src/modules/orders/service.js` — passar a gravar `tipo_producao` em cada `orcamento_itens` na auto-criação do orçamento.
- `src/modules/os/service.js` — refactor multi-item; funções `criarOSComunicacaoVisual`, `itensOffsetDisponiveis`, `criarOSOffset`.
- `src/modules/orcamentos/service.js` — gancho que chama `criarOSComunicacaoVisual` ao aprovar.
- `src/modules/os/router.js` — novos endpoints (`itens-disponiveis`, `POST /`).
- `src/modules/especificacoes/router.js` — novo módulo de domínio (GET lista).
- `src/modules/index.js` — registrar `/especificacoes`.
- `public/dashboard.html` — aba OS: botão "Gerar OS Offset" + modal + lista multi-item.
- `public/pwa/producao.html`, `arte_final.html`, `motorista.html` — exibir itens da OS (array).

---

## Task 1: Migrations de schema (025–028)

**Files:**
- Create: `sql/migrations/025_orcamento_itens_tipo_producao.sql`
- Create: `sql/migrations/026_ordens_servico_multi_item.sql`
- Create: `sql/migrations/027_os_itens.sql`
- Create: `sql/migrations/028_especificacoes.sql`

- [ ] **Step 1: Criar 025 — tipo_producao no item do orçamento**

`sql/migrations/025_orcamento_itens_tipo_producao.sql`:
```sql
-- Tipo de produção por item: decide auto (COMUNICAÇÃO VISUAL) vs manual (OFFSET)
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS tipo_producao VARCHAR(30);
```

- [ ] **Step 2: Criar 026 — ordens_servico multi-item + cabeçalho**

`sql/migrations/026_ordens_servico_multi_item.sql`:
```sql
ALTER TABLE ordens_servico ALTER COLUMN orcamento_item_id DROP NOT NULL;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS tipo_servico     VARCHAR(20);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS tipo_produto     VARCHAR(100);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS cliente_id       UUID REFERENCES clientes_lkl(id);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS previsao_entrega DATE;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS quantidade       INTEGER;
```

- [ ] **Step 3: Criar 027 — os_itens (M2M)**

`sql/migrations/027_os_itens.sql`:
```sql
CREATE TABLE IF NOT EXISTS os_itens (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  os_id              UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  orcamento_item_id  UUID NOT NULL REFERENCES orcamento_itens(id),
  created_at         TIMESTAMPTZ DEFAULT now(),
  UNIQUE (orcamento_item_id)
);
CREATE INDEX IF NOT EXISTS idx_os_itens_os ON os_itens(os_id);
```

- [ ] **Step 4: Criar 028 — especificacoes + os_especificacoes + seed**

`sql/migrations/028_especificacoes.sql`:
```sql
CREATE TABLE IF NOT EXISTS especificacoes (
  id    SERIAL PRIMARY KEY,
  nome  VARCHAR(60) UNIQUE NOT NULL,
  ativo BOOLEAN DEFAULT true
);
CREATE TABLE IF NOT EXISTS os_especificacoes (
  os_id            UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  especificacao_id INTEGER NOT NULL REFERENCES especificacoes(id),
  PRIMARY KEY (os_id, especificacao_id)
);
INSERT INTO especificacoes (nome) VALUES
 ('ARTE FINAL'),('BLOCO'),('COLAGEM'),('CORTE'),('DOBRA'),('ENVELOPE'),
 ('FIXO CABEÇA'),('FIXO ESQUERDA'),('GRAMPO'),('ILHÓS'),('IMPRESSO'),
 ('INTERCALAÇÃO'),('LAMINAÇÃO BRILHO'),('LAMINAÇÃO FOSCA'),('NUMERAÇÃO'),
 ('REFILE'),('SERRILHA'),('TALÃO'),('VINCO')
ON CONFLICT (nome) DO NOTHING;
```

- [ ] **Step 5: Aplicar as 4 migrations no VPS**

```bash
cd /Users/klebercamara/LKL
for n in 025_orcamento_itens_tipo_producao 026_ordens_servico_multi_item 027_os_itens 028_especificacoes; do
  cat sql/migrations/$n.sql | ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot"
done
```
Esperado: `ALTER TABLE`/`CREATE TABLE`/`INSERT 0 19` sem erro.

- [ ] **Step 6: Verificar schema aplicado**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"SELECT count(*) FROM especificacoes; \d os_itens\""
```
Esperado: count = 19; tabela `os_itens` com `os_id`, `orcamento_item_id`, UNIQUE(orcamento_item_id).

- [ ] **Step 7: Commit**

```bash
git add sql/migrations/025_orcamento_itens_tipo_producao.sql sql/migrations/026_ordens_servico_multi_item.sql sql/migrations/027_os_itens.sql sql/migrations/028_especificacoes.sql
git commit -m "feat(os-1): migrations — tipo_producao no item, OS multi-item, os_itens, especificacoes"
```

---

## Task 2: Gravar tipo_producao por item na auto-criação do orçamento

**Files:**
- Modify: `src/modules/orders/service.js` (bloco de auto-criação do orçamento dentro de `criarOrder`)

**Contexto:** `_normalizarItens(dados)` já produz `{ produto, tipo_producao, quantidade, especificacao, tem_arte }`. O loop que insere em `orcamento_itens` hoje NÃO grava `tipo_producao`. Após a migration 025, passa a gravar.

- [ ] **Step 1: Incluir tipo_producao no INSERT de orcamento_itens**

Em `src/modules/orders/service.js`, localizar o loop dentro do bloco "Auto-cria orçamento" e substituir o INSERT por:
```javascript
    let codigo = 1;
    for (const it of itens) {
      const descricao = it.especificacao ? `${it.produto} — ${it.especificacao}` : it.produto;
      await db.query(
        `INSERT INTO orcamento_itens (orcamento_id, codigo, descricao, quantidade, valor_unitario, valor_total, tem_arte, tipo_producao)
         VALUES ($1, $2, $3, $4, 0, 0, $5, $6)`,
        [orcamentoId, codigo++, descricao, it.quantidade, it.tem_arte || false, it.tipo_producao || null]
      );
    }
```

- [ ] **Step 2: Verificar sintaxe**

```bash
node --check src/modules/orders/service.js
```
Esperado: sem saída (OK).

- [ ] **Step 3: Deploy + smoke (cria pedido com 1 item CV e 1 item Offset, confere tipo_producao no item)**

```bash
rsync -az src/modules/orders/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orders/service.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const svc=require('./src/modules/orders/service'); const db=require('./src/db');
(async()=>{ const c=await db.query('SELECT id FROM clientes_lkl LIMIT 1'); 
 const r=await svc.criarOrder({origin_channel:'balcao',cliente_id:c.rows[0].id,observacoes:'T',
  itens:[{produto:'BANNER',tipo_producao:'COMUNICAÇÃO VISUAL',quantidade:1},
         {produto:'CARTÃO DE VISITA',tipo_producao:'OFFSET',quantidade:1000}]},null);
 const oi=await db.query('SELECT descricao,tipo_producao FROM orcamento_itens WHERE orcamento_id=\\\$1 ORDER BY codigo',[r.order.orcamento_id]);
 console.log(JSON.stringify(oi.rows));
 // limpeza
 await db.query('UPDATE orders SET orcamento_id=NULL WHERE id=\\\$1',[r.order.id]);
 await db.query('DELETE FROM orcamento_itens WHERE orcamento_id=\\\$1',[r.order.orcamento_id]);
 await db.query('DELETE FROM orcamentos WHERE id=\\\$1',[r.order.orcamento_id]);
 await db.query('DELETE FROM order_items WHERE order_id=\\\$1',[r.order.id]);
 await db.query('DELETE FROM orders WHERE id=\\\$1',[r.order.id]);
 process.exit(0); })().catch(e=>{console.error(e.message);process.exit(1);});
\""
```
Esperado: `[{"descricao":"BANNER","tipo_producao":"COMUNICAÇÃO VISUAL"},{"descricao":"CARTÃO DE VISITA","tipo_producao":"OFFSET"}]`

- [ ] **Step 4: Commit**

```bash
git add src/modules/orders/service.js
git commit -m "feat(os-1): grava tipo_producao por item na auto-criação do orçamento"
```

---

## Task 3: Refactor multi-item no os/service.js (listar + buscarPorId)

**Files:**
- Modify: `src/modules/os/service.js` (`listar`, `buscarPorId`)

**Contexto:** Hoje ambos fazem `JOIN orcamento_itens oi ON oi.id = os.orcamento_item_id` (1 item). Passam a agregar via `os_itens`.

- [ ] **Step 1: Reescrever `listar()` para agregar itens via os_itens**

Substituir a query principal de `listar()` por:
```javascript
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT os.id, os.numero_os, os.status, os.tipo_servico, os.tipo_produto,
              os.previsao_entrega, os.quantidade, os.data_inicio, os.data_conclusao,
              os.created_at, os.updated_at,
              COALESCE(cli.nome, cdir.nome) AS cliente_nome,
              u.name AS responsavel_nome,
              (SELECT COUNT(*) FROM os_itens oit WHERE oit.os_id = os.id) AS itens_count,
              (SELECT oi.descricao FROM os_itens oit
                 JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
                 WHERE oit.os_id = os.id ORDER BY oi.codigo LIMIT 1) AS item_descricao
       FROM ordens_servico os
       LEFT JOIN clientes_lkl cdir ON cdir.id = os.cliente_id
       LEFT JOIN orcamentos o ON o.id = os.orcamento_id
       LEFT JOIN clientes_lkl cli ON cli.id = o.cliente_id
       LEFT JOIN users u ON u.id = os.responsavel_id
       ${where} ORDER BY os.numero_os DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) FROM ordens_servico os ${where}`, params),
  ]);
```

- [ ] **Step 2: Reescrever `buscarPorId()` para retornar array de itens + especificações**

Substituir o corpo de `buscarPorId(id)` por:
```javascript
async function buscarPorId(id) {
  const r = await db.query(
    `SELECT os.*,
            COALESCE(cli.nome, cdir.nome) AS cliente_nome,
            o.numero AS numero_orcamento,
            u.name AS responsavel_nome
     FROM ordens_servico os
     LEFT JOIN clientes_lkl cdir ON cdir.id = os.cliente_id
     LEFT JOIN orcamentos o ON o.id = os.orcamento_id
     LEFT JOIN clientes_lkl cli ON cli.id = o.cliente_id
     LEFT JOIN users u ON u.id = os.responsavel_id
     WHERE os.id = $1`,
    [id]
  );
  if (!r.rows[0]) return null;
  const os = r.rows[0];

  const itens = await db.query(
    `SELECT oi.id, oi.descricao, oi.quantidade, oi.tipo_producao,
            orc.numero AS numero_orcamento, cl.nome AS cliente_nome
     FROM os_itens oit
     JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
     JOIN orcamentos orc ON orc.id = oi.orcamento_id
     LEFT JOIN clientes_lkl cl ON cl.id = orc.cliente_id
     WHERE oit.os_id = $1 ORDER BY oi.codigo`,
    [id]
  );
  const especs = await db.query(
    `SELECT e.id, e.nome FROM os_especificacoes oe
     JOIN especificacoes e ON e.id = oe.especificacao_id
     WHERE oe.os_id = $1 ORDER BY e.nome`,
    [id]
  );
  return { ...os, itens: itens.rows, especificacoes: especs.rows };
}
```

- [ ] **Step 3: Verificar sintaxe**

```bash
node --check src/modules/os/service.js
```
Esperado: sem saída.

- [ ] **Step 4: Deploy + smoke (lista responde sem erro)**

```bash
rsync -az src/modules/os/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/os/service.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
require('./src/modules/os/service').listar({limit:5}).then(r=>{console.log('listar OK, total',r.total);process.exit(0);}).catch(e=>{console.error(e.message);process.exit(1);});\""
```
Esperado: `listar OK, total 0`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/os/service.js
git commit -m "feat(os-1): os/service refactor multi-item (listar/buscarPorId via os_itens)"
```

---

## Task 4: Auto-criação de OS para Comunicação Visual ao aprovar

**Files:**
- Modify: `src/modules/os/service.js` (nova função `criarOSComunicacaoVisual`)
- Modify: `src/modules/orcamentos/service.js` (gancho em `aprovar` e em `mudarStatus` quando vira `aprovado`)

- [ ] **Step 1: Adicionar `criarOSComunicacaoVisual` em os/service.js**

Adicionar antes do `module.exports`:
```javascript
// Cria 1 OS com TODOS os itens de Comunicação Visual de um orçamento aprovado.
// Idempotente: ignora itens que já estão em alguma OS.
async function criarOSComunicacaoVisual(orcamentoId) {
  const itens = await db.query(
    `SELECT oi.id, oi.quantidade
     FROM orcamento_itens oi
     WHERE oi.orcamento_id = $1
       AND oi.tipo_producao = 'COMUNICAÇÃO VISUAL'
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)`,
    [orcamentoId]
  );
  if (!itens.rows.length) return null;

  const orc = await db.query('SELECT cliente_id, prazo_entrega FROM orcamentos WHERE id=$1', [orcamentoId]);
  const clienteId = orc.rows[0]?.cliente_id || null;
  const qtdTotal = itens.rows.reduce((s, i) => s + (parseInt(i.quantidade) || 0), 0);

  const osR = await db.query(
    `INSERT INTO ordens_servico (orcamento_id, status, tipo_servico, cliente_id, quantidade)
     VALUES ($1, 'aguardando', 'comunicacao_visual', $2, $3) RETURNING id, numero_os`,
    [orcamentoId, clienteId, qtdTotal]
  );
  const osId = osR.rows[0].id;
  for (const it of itens.rows) {
    await db.query(`INSERT INTO os_itens (os_id, orcamento_item_id) VALUES ($1,$2)`, [osId, it.id]);
  }
  if (global.io) global.io.emit('nova_os', { os_id: osId, orcamento_id: orcamentoId });
  return { os_id: osId, numero_os: osR.rows[0].numero_os, itens: itens.rows.length };
}
```
Incluir `criarOSComunicacaoVisual` no `module.exports`.

- [ ] **Step 2: Chamar o gancho ao aprovar (orcamentos/service.js)**

Em `src/modules/orcamentos/service.js`, no topo garantir o require do módulo de OS (sem ciclo — os/service não importa orcamentos/service):
```javascript
const osService = require('../os/service');
```
Em `aprovar()`, logo após `_notifyVendedorResposta(id, 'aprovado');`, adicionar:
```javascript
  osService.criarOSComunicacaoVisual(id).catch(e => console.warn('[OS-CV]', e.message));
```
Em `mudarStatus()`, logo após `_notifyVendedorResposta(id, novoStatus);`, adicionar:
```javascript
  if (novoStatus === 'aprovado') {
    osService.criarOSComunicacaoVisual(id).catch(e => console.warn('[OS-CV]', e.message));
  }
```

- [ ] **Step 3: Verificar sintaxe (sem ciclo de require)**

```bash
node --check src/modules/os/service.js && node --check src/modules/orcamentos/service.js
node -e "require('./src/modules/orcamentos/service'); require('./src/modules/os/service'); console.log('require OK sem ciclo')"
```
Esperado: `require OK sem ciclo`.

- [ ] **Step 4: Deploy + smoke end-to-end (orçamento CV aprovado → 1 OS com os itens)**

```bash
rsync -az src/modules/os/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/os/service.js
rsync -az src/modules/orcamentos/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/service.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const orders=require('./src/modules/orders/service'); const orc=require('./src/modules/orcamentos/service'); const db=require('./src/db');
(async()=>{ const c=await db.query('SELECT id FROM clientes_lkl LIMIT 1');
 const r=await orders.criarOrder({origin_channel:'balcao',cliente_id:c.rows[0].id,observacoes:'T',
   itens:[{produto:'BANNER',tipo_producao:'COMUNICAÇÃO VISUAL',quantidade:2},{produto:'ADESIVO',tipo_producao:'COMUNICAÇÃO VISUAL',quantidade:3}]},null);
 const oid=r.order.orcamento_id;
 await orc.mudarStatus(oid,'concluido'); // em_orcamento->... não: força enviado->aprovado abaixo
 await db.query(\\\"UPDATE orcamentos SET status='enviado' WHERE id=\\\$1\\\",[oid]);
 await orc.aprovar(oid,'manual');
 const os=await db.query('SELECT o.id,o.numero_os,o.tipo_servico,(SELECT count(*) FROM os_itens WHERE os_id=o.id) itens FROM ordens_servico o WHERE o.orcamento_id=\\\$1',[oid]);
 console.log('OS criada:',JSON.stringify(os.rows));
 // limpeza
 await db.query('DELETE FROM os_itens WHERE os_id IN (SELECT id FROM ordens_servico WHERE orcamento_id=\\\$1)',[oid]);
 await db.query('DELETE FROM ordens_servico WHERE orcamento_id=\\\$1',[oid]);
 await db.query('UPDATE orders SET orcamento_id=NULL WHERE id=\\\$1',[r.order.id]);
 await db.query('DELETE FROM orcamento_itens WHERE orcamento_id=\\\$1',[oid]);
 await db.query('DELETE FROM orcamentos WHERE id=\\\$1',[oid]);
 await db.query('DELETE FROM order_items WHERE order_id=\\\$1',[r.order.id]);
 await db.query('DELETE FROM orders WHERE id=\\\$1',[r.order.id]);
 process.exit(0); })().catch(e=>{console.error(e.message);process.exit(1);});
\""
```
Esperado: `OS criada: [{"...","tipo_servico":"comunicacao_visual","itens":"2"}]` (1 OS, 2 itens).

- [ ] **Step 5: Commit**

```bash
git add src/modules/os/service.js src/modules/orcamentos/service.js
git commit -m "feat(os-1): auto-criação de OS de Comunicação Visual ao aprovar orçamento"
```

---

## Task 5: Criação manual de OS Offset (service)

**Files:**
- Modify: `src/modules/os/service.js` (`itensOffsetDisponiveis`, `criarOSOffset`)

- [ ] **Step 1: Adicionar `itensOffsetDisponiveis`**

```javascript
// Itens OFFSET de orçamentos aprovados que ainda não estão em nenhuma OS
async function itensOffsetDisponiveis() {
  const r = await db.query(
    `SELECT oi.id, oi.descricao, oi.quantidade,
            orc.id AS orcamento_id, orc.numero AS numero_orcamento,
            cl.id AS cliente_id, cl.nome AS cliente_nome
     FROM orcamento_itens oi
     JOIN orcamentos orc ON orc.id = oi.orcamento_id
     LEFT JOIN clientes_lkl cl ON cl.id = orc.cliente_id
     WHERE orc.status = 'aprovado'
       AND oi.tipo_producao = 'OFFSET'
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)
     ORDER BY cl.nome, orc.numero, oi.codigo`
  );
  return r.rows;
}
```

- [ ] **Step 2: Adicionar `criarOSOffset`**

```javascript
// Cria 1 OS offset agrupando N itens (de qualquer cliente/orçamento) + especificações
async function criarOSOffset({ item_ids, especificacoes, observacao, tipo_produto, previsao_entrega }, userId) {
  if (!Array.isArray(item_ids) || item_ids.length === 0) return { erro: ['Selecione ao menos 1 item'] };

  // Valida itens: existem, são OFFSET aprovados e ainda sem OS
  const val = await db.query(
    `SELECT oi.id, oi.quantidade, orc.cliente_id
     FROM orcamento_itens oi JOIN orcamentos orc ON orc.id = oi.orcamento_id
     WHERE oi.id = ANY($1) AND orc.status='aprovado' AND oi.tipo_producao='OFFSET'
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)`,
    [item_ids]
  );
  if (val.rows.length !== item_ids.length) {
    return { erro: ['Um ou mais itens são inválidos, não são offset aprovados ou já estão em outra OS'] };
  }

  const clientes = [...new Set(val.rows.map(r => r.cliente_id).filter(Boolean))];
  const clienteId = clientes.length === 1 ? clientes[0] : null; // null = OS multi-cliente
  const qtdTotal = val.rows.reduce((s, i) => s + (parseInt(i.quantidade) || 0), 0);

  const osR = await db.query(
    `INSERT INTO ordens_servico
       (status, tipo_servico, tipo_produto, cliente_id, quantidade, previsao_entrega, observacao_interna, responsavel_id)
     VALUES ('aguardando','offset',$1,$2,$3,$4,$5,$6) RETURNING id, numero_os`,
    [tipo_produto || null, clienteId, qtdTotal, previsao_entrega || null, observacao || null, userId || null]
  );
  const osId = osR.rows[0].id;

  for (const it of val.rows) {
    await db.query(`INSERT INTO os_itens (os_id, orcamento_item_id) VALUES ($1,$2)`, [osId, it.id]);
  }
  if (Array.isArray(especificacoes)) {
    for (const eid of especificacoes) {
      await db.query(`INSERT INTO os_especificacoes (os_id, especificacao_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [osId, eid]);
    }
  }
  if (global.io) global.io.emit('nova_os', { os_id: osId });
  return { os_id: osId, numero_os: osR.rows[0].numero_os, itens: val.rows.length };
}
```
Incluir `itensOffsetDisponiveis` e `criarOSOffset` no `module.exports`.

- [ ] **Step 3: Verificar sintaxe**

```bash
node --check src/modules/os/service.js
```
Esperado: sem saída.

- [ ] **Step 4: Deploy + smoke (2 itens offset de orçamentos diferentes → 1 OS)**

```bash
rsync -az src/modules/os/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/os/service.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const orders=require('./src/modules/orders/service'); const orc=require('./src/modules/orcamentos/service'); const os=require('./src/modules/os/service'); const db=require('./src/db');
(async()=>{ const c=await db.query('SELECT id FROM clientes_lkl LIMIT 2');
 async function aprovado(cid){ const r=await orders.criarOrder({origin_channel:'balcao',cliente_id:cid,observacoes:'T',itens:[{produto:'CARTÃO',tipo_producao:'OFFSET',quantidade:1000}]},null); const oid=r.order.orcamento_id; await db.query(\\\"UPDATE orcamentos SET status='enviado' WHERE id=\\\$1\\\",[oid]); await orc.aprovar(oid,'manual'); return {orderId:r.order.id,oid}; }
 const a=await aprovado(c.rows[0].id); const b=await aprovado(c.rows[1]?c.rows[1].id:c.rows[0].id);
 const disp=await os.itensOffsetDisponiveis(); console.log('disponiveis:',disp.length);
 const ids=disp.slice(0,2).map(d=>d.id);
 const novo=await os.criarOSOffset({item_ids:ids,especificacoes:[],observacao:'OFFSET TESTE',tipo_produto:'CARTÃO'},null);
 console.log('OS offset:',JSON.stringify(novo));
 // limpeza
 for(const x of [a,b]){ await db.query('DELETE FROM os_itens WHERE orcamento_item_id IN (SELECT id FROM orcamento_itens WHERE orcamento_id=\\\$1)',[x.oid]); await db.query('DELETE FROM ordens_servico WHERE orcamento_id=\\\$1 OR id IN (SELECT os_id FROM os_itens)',[x.oid]); }
 await db.query(\\\"DELETE FROM ordens_servico WHERE observacao_interna='OFFSET TESTE'\\\");
 for(const x of [a,b]){ await db.query('UPDATE orders SET orcamento_id=NULL WHERE id=\\\$1',[x.orderId]); await db.query('DELETE FROM orcamento_itens WHERE orcamento_id=\\\$1',[x.oid]); await db.query('DELETE FROM orcamentos WHERE id=\\\$1',[x.oid]); await db.query('DELETE FROM order_items WHERE order_id=\\\$1',[x.orderId]); await db.query('DELETE FROM orders WHERE id=\\\$1',[x.orderId]); }
 process.exit(0); })().catch(e=>{console.error(e.message);process.exit(1);});
\""
```
Esperado: `disponiveis: 2` e `OS offset: {"os_id":"...","numero_os":N,"itens":2}`.
> Nota: se a limpeza deixar resíduo, conferir `SELECT * FROM ordens_servico` e limpar manualmente — é ambiente de teste.

- [ ] **Step 5: Commit**

```bash
git add src/modules/os/service.js
git commit -m "feat(os-1): criação manual de OS offset (itensOffsetDisponiveis + criarOSOffset)"
```

---

## Task 6: Endpoints REST (os router + módulo especificacoes)

**Files:**
- Modify: `src/modules/os/router.js`
- Create: `src/modules/especificacoes/router.js`
- Modify: `src/modules/index.js`

- [ ] **Step 1: Novos endpoints no os/router.js**

Adicionar (antes de `module.exports`), reutilizando o `service` já importado e `requireRole`:
```javascript
// Itens offset aprovados sem OS (fila de agrupamento)
router.get('/itens-disponiveis', requireRole('admin','gestor','analista'), async (req, res) => {
  try {
    const itens = await service.itensOffsetDisponiveis();
    res.json(itens);
  } catch (e) { console.error('[OS-DISP]', e); res.status(500).json({ error: 'Erro interno' }); }
});

// Cria OS offset agrupada
router.post('/', requireRole('admin','gestor','analista'), async (req, res) => {
  try {
    const result = await service.criarOSOffset(req.body, req.user.id);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result);
  } catch (e) { console.error('[OS-CRIAR]', e); res.status(500).json({ error: 'Erro interno' }); }
});
```
> Atenção: a rota `GET /itens-disponiveis` deve vir **antes** de `GET /:id` para não ser capturada pelo parâmetro.

- [ ] **Step 2: Módulo especificacoes**

`src/modules/especificacoes/router.js`:
```javascript
const express = require('express');
const db = require('../../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const r = await db.query('SELECT id, nome FROM especificacoes WHERE ativo = true ORDER BY nome');
    res.json(r.rows);
  } catch (e) { console.error('[ESPEC]', e); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
```

- [ ] **Step 3: Registrar no index.js**

Em `src/modules/index.js`, perto do registro de `/os`, adicionar:
```javascript
router.use('/especificacoes', requireAuthApi, require('./especificacoes/router'));
```

- [ ] **Step 4: Verificar sintaxe + ordem de rotas**

```bash
node --check src/modules/os/router.js && node --check src/modules/especificacoes/router.js && node --check src/modules/index.js
grep -n "itens-disponiveis\|/:id" src/modules/os/router.js
```
Esperado: a linha de `itens-disponiveis` aparece com número **menor** que a de `/:id`.

- [ ] **Step 5: Deploy + smoke HTTP autenticado**

```bash
rsync -az src/modules/os/router.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/os/router.js
rsync -az src/modules/especificacoes/router.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/especificacoes/router.js
rsync -az src/modules/index.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/index.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const jwt=require('jsonwebtoken'); const t=jwt.sign({id:'00000000-0000-0000-0000-000000000002',role:'admin',name:'T',email:'t@t.com'},process.env.JWT_SECRET);
const http=require('http');
function get(p){return new Promise(r=>{http.get({host:'127.0.0.1',port:3000,path:p,headers:{Authorization:'Bearer '+t}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>r(res.statusCode+' '+d.slice(0,80)));});});}
(async()=>{ console.log('especificacoes:',await get('/api/v2/especificacoes')); console.log('itens-disponiveis:',await get('/api/v2/os/itens-disponiveis?tipo=offset')); process.exit(0); })();
\""
```
Esperado: `especificacoes: 200 [{"id":1,...}]` (19 itens) e `itens-disponiveis: 200 []`.

- [ ] **Step 6: Commit**

```bash
git add src/modules/os/router.js src/modules/especificacoes/router.js src/modules/index.js
git commit -m "feat(os-1): endpoints itens-disponiveis, POST /os e GET /especificacoes"
```

---

## Task 7: Dashboard — aba OS com "Gerar OS Offset" e lista multi-item

**Files:**
- Modify: `public/dashboard.html` (página `page-os`, render da lista, modal de criação)

**Contexto:** `loadOS`/render da lista de OS já existem (consomem `/api/v2/os`). Vamos: (a) adicionar botão e modal "Gerar OS Offset"; (b) exibir `itens_count` e `tipo_servico` na lista.

- [ ] **Step 1: Adicionar botão "Gerar OS Offset" no cabeçalho da página OS**

Em `public/dashboard.html`, dentro de `<div class="page" id="page-os">`, no `page-header`, adicionar à direita:
```html
      <button class="btn btn-primary" onclick="abrirGerarOSOffset()">+ Gerar OS Offset</button>
```

- [ ] **Step 2: Funções JS do modal (carregar itens + especificações + criar)**

Adicionar no `<script>` do dashboard:
```javascript
let _osOffsetItens = [];
let _osEspecs = [];

async function abrirGerarOSOffset() {
  const [itens, especs] = await Promise.all([
    api('/api/v2/os/itens-disponiveis?tipo=offset'),
    api('/api/v2/especificacoes'),
  ]);
  _osOffsetItens = Array.isArray(itens) ? itens : [];
  _osEspecs = Array.isArray(especs) ? especs : [];
  if (!_osOffsetItens.length) { showToast('Nenhum item offset aprovado aguardando OS'); return; }

  const linhas = _osOffsetItens.map(it => `
    <label style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #eee;font-size:13px;cursor:pointer">
      <input type="checkbox" class="os-off-item" value="${it.id}">
      <span style="flex:1">${escHtml(it.descricao||'—')}</span>
      <span style="color:#666">${it.quantidade} un</span>
      <span style="color:#888;font-size:12px">ORC #${it.numero_orcamento} · ${escHtml(it.cliente_nome||'—')}</span>
    </label>`).join('');
  const chips = _osEspecs.map(e => `
    <label style="display:inline-flex;align-items:center;gap:4px;border:1px solid #ddd;border-radius:16px;padding:4px 10px;font-size:12px;cursor:pointer">
      <input type="checkbox" class="os-off-espec" value="${e.id}"> ${escHtml(e.nome)}
    </label>`).join(' ');

  const html = `
    <div style="margin-bottom:10px;font-size:12px;font-weight:700;color:#7986cb">ITENS OFFSET DISPONÍVEIS</div>
    <div style="max-height:220px;overflow:auto;border:1px solid #eee;border-radius:8px;margin-bottom:12px">${linhas}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      <div><label style="font-size:12px;color:#666">Tipo de produto</label>
        <input id="os-off-tipoprod" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px"></div>
      <div><label style="font-size:12px;color:#666">Previsão de entrega</label>
        <input id="os-off-previsao" type="date" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px"></div>
    </div>
    <div style="margin-bottom:6px;font-size:12px;color:#666">Especificações / acabamentos</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">${chips}</div>
    <div style="margin-bottom:12px"><label style="font-size:12px;color:#666">Observação</label>
      <textarea id="os-off-obs" rows="2" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px"></textarea></div>
    <button onclick="salvarOSOffset()" class="btn btn-primary" style="width:100%">Gerar OS</button>`;
  showModal('Gerar OS Offset', html);
}

async function salvarOSOffset() {
  const item_ids = [...document.querySelectorAll('.os-off-item:checked')].map(c => c.value);
  if (!item_ids.length) { showToast('Selecione ao menos 1 item'); return; }
  const especificacoes = [...document.querySelectorAll('.os-off-espec:checked')].map(c => parseInt(c.value));
  const body = {
    item_ids, especificacoes,
    tipo_produto: document.getElementById('os-off-tipoprod').value.trim() || null,
    previsao_entrega: document.getElementById('os-off-previsao').value || null,
    observacao: document.getElementById('os-off-obs').value.trim() || null,
  };
  const r = await api('/api/v2/os', { method: 'POST', body: JSON.stringify(body) });
  if (r?.error || r?.errors) { showToast(r.error || (r.errors||[]).join(', '), 'error'); return; }
  closeModal();
  showToast(`✅ OS #${r.numero_os} criada com ${r.itens} item(ns)`);
  loadOS();
}
```
> Se o nome real da função de carregar a lista de OS não for `loadOS`, ajustar a chamada (confirmar com `grep -n "page-os\|loadOS\|function load.*[Oo]s" public/dashboard.html`).

- [ ] **Step 3: Exibir tipo_servico + itens_count na lista de OS**

Localizar a função que renderiza as linhas de OS (a partir de `/api/v2/os`) e na coluna de produto/descrição usar:
```javascript
    const tipo = os.tipo_servico === 'offset' ? 'Offset' : (os.tipo_servico === 'comunicacao_visual' ? 'Com. Visual' : '—');
    const extra = (parseInt(os.itens_count)||1) > 1 ? ` <span style="background:#e8eaf6;color:#3949ab;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:600">+${(parseInt(os.itens_count)-1)}</span>` : '';
    // usar: `${escHtml(os.item_descricao||'—')}${extra}` na célula de descrição e `tipo` numa coluna/again badge
```

- [ ] **Step 4: Verificação no navegador (preview)**

Abrir o dashboard, aba OS:
- Botão "Gerar OS Offset" aparece.
- Com itens offset aprovados, o modal lista itens + especificações; sem itens, mostra toast "Nenhum item offset...".
- Criar uma OS seleciona itens e some da lista de disponíveis.

(Verificação manual no preview; sem teste automatizado de UI neste projeto.)

- [ ] **Step 5: Deploy + commit**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
git add public/dashboard.html
git commit -m "feat(os-1): dashboard — Gerar OS Offset + lista de OS multi-item"
```

---

## Task 8: PWAs de produção exibindo itens da OS (array)

**Files:**
- Modify: `public/pwa/producao.html`
- Modify: `public/pwa/arte_final.html`
- Modify: `public/pwa/motorista.html`

**Contexto:** essas telas mostram a descrição do item da OS lendo um campo único (`descricao`/`item_descricao`). Com o novo `buscarPorId`, o detalhe traz `itens: [...]`. Ajustar a exibição para listar os itens.

- [ ] **Step 1: producao.html — render dos itens**

Localizar onde a OS exibe a descrição (`grep -n "descricao\|item_descricao\|quantidade" public/pwa/producao.html`) e, onde mostra o item único, trocar por uma lista:
```javascript
  const itensHtml = (os.itens || []).map(i => `<div>• ${i.descricao} — ${i.quantidade} un</div>`).join('') || (os.item_descricao||'—');
```
Usar `itensHtml` no lugar do campo único.

- [ ] **Step 2: arte_final.html — mesmo ajuste**

`grep -n "descricao\|item_descricao" public/pwa/arte_final.html` e aplicar o mesmo padrão de `itensHtml`.

- [ ] **Step 3: motorista.html — mesmo ajuste**

`grep -n "descricao\|item_descricao" public/pwa/motorista.html` e aplicar o mesmo padrão de `itensHtml`.

- [ ] **Step 4: Verificação no preview/navegador**

Abrir cada PWA com uma OS multi-item e confirmar que todos os itens aparecem (sem `undefined`).

- [ ] **Step 5: Deploy + commit**

```bash
rsync -az public/pwa/producao.html root@2.25.147.243:/var/www/lkl-chatbot/public/pwa/producao.html
rsync -az public/pwa/arte_final.html root@2.25.147.243:/var/www/lkl-chatbot/public/pwa/arte_final.html
rsync -az public/pwa/motorista.html root@2.25.147.243:/var/www/lkl-chatbot/public/pwa/motorista.html
git add public/pwa/producao.html public/pwa/arte_final.html public/pwa/motorista.html
git commit -m "feat(os-1): PWAs de produção exibem itens da OS (multi-item)"
```

---

## Task 9: Smoke end-to-end em produção + limpeza

**Files:** nenhum (validação)

- [ ] **Step 1: Fluxo completo via dashboard (manual)**

1. Criar um pedido com itens mistos (1 Comunicação Visual + 1 Offset).
2. Na aba Orçamentos, precificar e **aprovar** o orçamento.
3. Confirmar: 1 **OS de Comunicação Visual** apareceu automaticamente na aba OS.
4. Abrir "Gerar OS Offset" → o item offset aparece → agrupar e criar OS.
5. Confirmar que a OS offset aparece com o tipo e os itens.

- [ ] **Step 2: Conferir no banco**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"
SELECT o.numero_os, o.tipo_servico, (SELECT count(*) FROM os_itens WHERE os_id=o.id) itens, o.status
FROM ordens_servico o ORDER BY o.numero_os DESC LIMIT 10;\""
```
Esperado: as 2 OS (comunicacao_visual e offset) com a contagem de itens correta.

- [ ] **Step 3: Limpar dados de teste (se forem testes)**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"
BEGIN;
DELETE FROM os_especificacoes WHERE os_id IN (SELECT id FROM ordens_servico);
DELETE FROM os_itens;
DELETE FROM ordens_servico;
COMMIT;\""
```
(Só rodar se o teste do Step 1 foi com dados descartáveis. Caso contrário, pular.)

- [ ] **Step 4: Atualizar memória do projeto**

Editar `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`: marcar **OS-1 como CONCLUÍDO** e listar OS-2 como próximo.

---

## Self-Review (cobertura do spec)

- ✅ tipo_producao por item (migration 025 + Task 2)
- ✅ OS multi-item + os_itens (migrations 026/027 + Task 3)
- ✅ especificacoes domínio + seed (migration 028 + Task 6)
- ✅ Auto-criação CV ao aprovar (Task 4)
- ✅ Agrupamento manual offset, multi-cliente/multi-orçamento (Task 5/6/7)
- ✅ Refactor listar/buscarPorId multi-item (Task 3) + PWAs (Task 8)
- ✅ Endpoints itens-disponiveis / POST /os / GET /especificacoes (Task 6)
- ✅ Critérios de aceite cobertos pelo Smoke E2E (Task 9)

**Consistência de nomes:** `criarOSComunicacaoVisual`, `itensOffsetDisponiveis`, `criarOSOffset` usados de forma idêntica em service/router/dashboard. `tipo_servico` ∈ {`comunicacao_visual`,`offset`}. `tipo_producao` ∈ {`COMUNICAÇÃO VISUAL`,`OFFSET`}.

**Nota sobre os testes jest legados:** `tests/modules/os.test.js` mira a API legada `/api/*` e assume `aprovar` retornando `ordens_servico`. Com OS-1, a v2 passa a criar OS no aprovar (CV). Atualizar/!skip esses testes legados é item de housekeeping (rodam só no DB de teste do VPS) — não bloqueia OS-1, cuja verificação é via smoke no VPS.
