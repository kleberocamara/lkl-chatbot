# OS-3C — Baixa de Materiais de Produção — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar baixa automática (e estornável) no estoque dos materiais consumidos por uma OS ao entrar em impressão — papel offset (folhas) e material de CV (m² por dimensões).

**Architecture:** Um motor único de requisição/estorno (`os_requisicoes` + `os_requisicao_itens`) que coleta consumo de duas fontes: offset (`os_materiais.folhas_total`) e CV (`orcamento_itens` dimensões → m²). Disparo automático em `atualizarStatus` quando a OS entra em `'impressao'`, idempotente, reversível, com saldo podendo negativar.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), vanilla-JS dashboard. Sem postgres local — verificação por `node --check` + smoke E2E no VPS.

**Convenções do projeto:**
- Migrations em `sql/migrations/NNN_*.sql`, aplicadas via psql no VPS. Próximo número livre: **037**.
- Services retornam `{ chave }` em sucesso ou `{ erro: ['msg'] }` em falha.
- VPS: root@2.25.147.243, app `/var/www/lkl-chatbot`. DB em `$DATABASE_URL`.
- Deploy: `rsync -az <path> root@2.25.147.243:/var/www/lkl-chatbot/<path>`; restart: `ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"`; node server-side: `ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e '<js>'"`.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Fatos do código (já verificados):**
- `src/modules/os/service.js`: `atualizarStatus(id, novoStatus, responsavel_id)` busca a OS atual em `existing.rows[0]` (tem `os.status` anterior) ANTES do UPDATE; `STATUS_VALIDOS` inclui `'impressao'`. `buscarPorId(id)` retorna a OS + materiais; `module.exports` lista as funções.
- `os_materiais(os_id, via, material_id, folhas_total, ...)` já existe.
- `os_itens(os_id, orcamento_item_id)` liga OS ↔ item do orçamento.
- `materiais(id, nome, estoque_atual NUMERIC(10,3))`.
- Item do orçamento (CRUD inline no router `src/modules/orcamentos/router.js`): `POST /:id/itens` e `PATCH /:id/itens/:itemId` fazem INSERT/UPDATE direto em `orcamento_itens`.
- Dashboard: forms de item em `abrirEditarItemOrc`/add-item (ids `ei-*`/`ni-*`); detalhe da OS em `abrirDetalheOS`.

**File Structure:**
- Create: `sql/migrations/037_os_requisicoes.sql` — tabelas de requisição + colunas de dimensão/material em `orcamento_itens`.
- Modify: `src/modules/os/service.js` — `baixarMateriais`, `estornarRequisicao`, hook em `atualizarStatus`, requisição em `buscarPorId`, exports.
- Modify: `src/modules/os/router.js` — rotas de requisição/estorno.
- Modify: `src/modules/orcamentos/router.js` — itens aceitam `largura_cm`/`altura_cm`/`material_id`.
- Modify: `public/dashboard.html` — bloco de requisição na OS + campos de CV no form do item.

---

## FASE 1 — Motor de requisição + baixa offset

### Task 1: Migration 037 — tabelas de requisição + colunas de CV

**Files:**
- Create: `sql/migrations/037_os_requisicoes.sql`

- [ ] **Step 1: Escrever a migration**

Create `sql/migrations/037_os_requisicoes.sql`:

```sql
-- OS-3C: requisição/baixa de materiais (offset + CV) + dimensões de CV
CREATE TABLE IF NOT EXISTS os_requisicoes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  os_id         UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  status        VARCHAR(12) NOT NULL DEFAULT 'baixada' CHECK (status IN ('baixada','estornada')),
  criada_em     TIMESTAMPTZ DEFAULT now(),
  criada_por    UUID REFERENCES users(id) ON DELETE SET NULL,
  estornada_em  TIMESTAMPTZ,
  estornada_por UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_os_requisicoes_os ON os_requisicoes(os_id);

CREATE TABLE IF NOT EXISTS os_requisicao_itens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requisicao_id UUID NOT NULL REFERENCES os_requisicoes(id) ON DELETE CASCADE,
  material_id   UUID NOT NULL REFERENCES materiais(id),
  quantidade    NUMERIC(10,3) NOT NULL,
  unidade       VARCHAR(10) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_os_requisicao_itens_req ON os_requisicao_itens(requisicao_id);

ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS largura_cm  NUMERIC(8,2);
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS altura_cm   NUMERIC(8,2);
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS material_id UUID REFERENCES materiais(id);
```

- [ ] **Step 2: Aplicar no VPS**

```bash
rsync -az sql/migrations/037_os_requisicoes.sql root@2.25.147.243:/var/www/lkl-chatbot/sql/migrations/037_os_requisicoes.sql
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && psql \$DATABASE_URL -f sql/migrations/037_os_requisicoes.sql"
```
Expected: 2× `CREATE TABLE`, 2× `CREATE INDEX`, 3× `ALTER TABLE`, sem erro.

- [ ] **Step 3: Verificar**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && psql \$DATABASE_URL -c '\\d os_requisicoes' -c '\\d os_requisicao_itens' -c \"SELECT column_name FROM information_schema.columns WHERE table_name='orcamento_itens' AND column_name IN ('largura_cm','altura_cm','material_id') ORDER BY column_name\""
```
Expected: as duas tabelas existem; a query retorna `altura_cm`, `largura_cm`, `material_id`.

- [ ] **Step 4: Commit**

```bash
git add sql/migrations/037_os_requisicoes.sql
git commit -m "feat(os3c): migration 037 — os_requisicoes + dimensões/material em orcamento_itens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Motor de baixa/estorno (offset) + hook no status + buscarPorId

**Files:**
- Modify: `src/modules/os/service.js`

- [ ] **Step 1: Adicionar `baixarMateriais` e `estornarRequisicao`**

Em `src/modules/os/service.js`, adicionar estas duas funções (antes do `module.exports`). NESTA FASE o coletor lê só a fonte offset; a fonte CV entra na Task 6 (deixe o comentário marcando o ponto):

```js
// OS-3C: coleta o consumo de materiais da OS (offset; CV é adicionado na fase 2)
async function _coletarConsumo(client, osId) {
  const consumo = []; // { material_id, quantidade, unidade }
  // Fonte OFFSET: vias da ficha com material e folhas_total
  const off = await client.query(
    `SELECT material_id, folhas_total FROM os_materiais
     WHERE os_id=$1 AND material_id IS NOT NULL AND folhas_total > 0`, [osId]);
  for (const r of off.rows) {
    consumo.push({ material_id: r.material_id, quantidade: Number(r.folhas_total), unidade: 'folha' });
  }
  // (fase 2) Fonte CV entra aqui
  return consumo;
}

async function baixarMateriais(osId, { userId } = {}) {
  const osR = await db.query('SELECT id FROM ordens_servico WHERE id=$1', [osId]);
  if (!osR.rows[0]) return { erro: ['OS não encontrada'] };
  // idempotência: já existe requisição ativa?
  const ativa = await db.query(`SELECT id FROM os_requisicoes WHERE os_id=$1 AND status='baixada'`, [osId]);
  if (ativa.rows[0]) {
    const itens = await db.query('SELECT * FROM os_requisicao_itens WHERE requisicao_id=$1', [ativa.rows[0].id]);
    return { requisicao: { id: ativa.rows[0].id, status: 'baixada' }, itens: itens.rows, jaExistia: true };
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const consumo = await _coletarConsumo(client, osId);
    const req = await client.query(
      `INSERT INTO os_requisicoes (os_id, status, criada_por) VALUES ($1,'baixada',$2) RETURNING *`,
      [osId, userId || null]);
    const requisicao = req.rows[0];
    const itens = [];
    for (const c of consumo) {
      await client.query('UPDATE materiais SET estoque_atual = estoque_atual - $1, updated_at=NOW() WHERE id=$2',
        [c.quantidade, c.material_id]);
      const it = await client.query(
        `INSERT INTO os_requisicao_itens (requisicao_id, material_id, quantidade, unidade)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [requisicao.id, c.material_id, c.quantidade, c.unidade]);
      itens.push(it.rows[0]);
    }
    await client.query('COMMIT');
    return { requisicao, itens, ignorados: consumo.length === 0 };
  } catch (e) {
    await client.query('ROLLBACK');
    return { erro: [e.message] };
  } finally {
    client.release();
  }
}

async function estornarRequisicao(osId, { userId } = {}) {
  const reqR = await db.query(`SELECT id FROM os_requisicoes WHERE os_id=$1 AND status='baixada'`, [osId]);
  if (!reqR.rows[0]) return { erro: ['Nenhuma requisição ativa para estornar'] };
  const requisicaoId = reqR.rows[0].id;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const itens = await client.query('SELECT material_id, quantidade FROM os_requisicao_itens WHERE requisicao_id=$1', [requisicaoId]);
    for (const it of itens.rows) {
      await client.query('UPDATE materiais SET estoque_atual = estoque_atual + $1, updated_at=NOW() WHERE id=$2',
        [it.quantidade, it.material_id]);
    }
    await client.query(`UPDATE os_requisicoes SET status='estornada', estornada_em=NOW(), estornada_por=$1 WHERE id=$2`,
      [userId || null, requisicaoId]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    return { erro: [e.message] };
  } finally {
    client.release();
  }
}
```

NOTA (verificado): `os/service.js` faz `const db = require('../../db')` e `src/db` exporta `{ query, pool }`. Portanto use `db.pool.connect()` para a transação (como no código acima). `db.query(...)` para queries fora da transação.

- [ ] **Step 2: Disparar a baixa ao entrar em impressão**

Em `atualizarStatus`, LOGO APÓS o `const updatedOs = r.rows[0];` (depois do UPDATE), adicionar:

```js
  // OS-3C: baixa automática de materiais ao ENTRAR em impressão (idempotente, não bloqueia o status)
  if (novoStatus === 'impressao' && os.status !== 'impressao') {
    try {
      const b = await baixarMateriais(id, { userId: responsavel_id });
      if (b.erro) console.warn('[OS-3C] baixa de materiais falhou:', b.erro[0]);
    } catch (e) {
      console.warn('[OS-3C] baixa de materiais erro:', e.message);
    }
  }
```
(`os` é a linha anterior carregada em `existing.rows[0]`; `os.status` é o status ANTES da troca.)

- [ ] **Step 3: Anexar a requisição ativa em `buscarPorId`**

No FINAL de `buscarPorId(id)`, antes do `return` do objeto da OS, buscar e anexar a requisição ativa + itens. Localize o ponto onde a OS (`os`) já foi montada com `materiais` e adicione:

```js
  const reqR = await db.query(
    `SELECT * FROM os_requisicoes WHERE os_id=$1 ORDER BY criada_em DESC LIMIT 1`, [id]);
  if (reqR.rows[0]) {
    const reqItens = await db.query(
      `SELECT ri.*, m.nome AS material_nome, m.estoque_atual
       FROM os_requisicao_itens ri JOIN materiais m ON m.id = ri.material_id
       WHERE ri.requisicao_id=$1`, [reqR.rows[0].id]);
    os.requisicao = reqR.rows[0];
    os.requisicao_itens = reqItens.rows;
  } else {
    os.requisicao = null;
    os.requisicao_itens = [];
  }
```
(Use o nome real da variável que `buscarPorId` retorna — pode ser `os`, `osObj`, etc. Confirme lendo a função.)

- [ ] **Step 4: Exportar as novas funções**

No `module.exports` de `src/modules/os/service.js`, acrescentar `baixarMateriais` e `estornarRequisicao`.

- [ ] **Step 5: node --check + deploy + smoke (offset)**

```bash
node --check src/modules/os/service.js && echo OK
rsync -az src/modules/os/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/os/service.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const os=require('./src/modules/os/service'); const db=require('./src/db');
(async()=>{
  // acha uma OS offset com via+material+folhas
  const r=await db.query(\\\"SELECT om.os_id, om.material_id, om.folhas_total, m.estoque_atual FROM os_materiais om JOIN materiais m ON m.id=om.material_id WHERE om.material_id IS NOT NULL AND om.folhas_total>0 LIMIT 1\\\");
  if(!r.rows[0]){console.log('SEM via offset com material (cadastre para testar) — ok');process.exit(0);}
  const {os_id, material_id, folhas_total, estoque_atual}=r.rows[0];
  console.log('antes estoque=',estoque_atual,'folhas=',folhas_total);
  const b=await os.baixarMateriais(os_id,{});
  if(b.erro){console.log('ERRO',b.erro);process.exit(1);}
  const e1=(await db.query('SELECT estoque_atual FROM materiais WHERE id=\$1',[material_id])).rows[0].estoque_atual;
  console.log('depois baixa estoque=',e1);
  await os.estornarRequisicao(os_id,{});
  const e2=(await db.query('SELECT estoque_atual FROM materiais WHERE id=\$1',[material_id])).rows[0].estoque_atual;
  console.log('depois estorno estoque=',e2);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
\""
```
Expected: `depois baixa estoque` = antes − folhas; `depois estorno estoque` = valor original. (Ou `SEM via offset` se não houver dados — aceitável.)

- [ ] **Step 6: Commit**

```bash
git add src/modules/os/service.js
git commit -m "feat(os3c): motor de baixa/estorno de materiais + auto-baixa ao entrar em impressão (offset)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Rotas de requisição manual + estorno

**Files:**
- Modify: `src/modules/os/router.js`

- [ ] **Step 1: Adicionar as rotas**

Em `src/modules/os/router.js`, após a rota `PATCH /:id/producao`, adicionar:

```js
// OS-3C: baixa manual de materiais
router.post('/:id/requisicao', requireRole('admin','gestor','atendente'), async (req, res) => {
  try {
    const result = await service.baixarMateriais(req.params.id, { userId: req.user.id });
    if (result.erro) {
      const nf = result.erro.some(e => e.includes('não encontrada'));
      return res.status(nf ? 404 : 400).json(nf ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.status(201).json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// OS-3C: estorno da requisição ativa
router.post('/:id/requisicao/estornar', requireRole('admin','gestor'), async (req, res) => {
  try {
    const result = await service.estornarRequisicao(req.params.id, { userId: req.user.id });
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
```

- [ ] **Step 2: node --check + deploy**

```bash
node --check src/modules/os/router.js && echo OK
rsync -az src/modules/os/router.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/os/router.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && echo restarted"
```
Expected: `OK` e `restarted`.

- [ ] **Step 3: Commit**

```bash
git add src/modules/os/router.js
git commit -m "feat(os3c): rotas POST /os/:id/requisicao e /requisicao/estornar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Dashboard — bloco "Requisição de Materiais" no detalhe da OS

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Investigar o detalhe da OS**

```bash
grep -n "abrirDetalheOS\|salvarFichaOS\|renderViasOS\|os.requisicao\|detalhe-os\|modal" public/dashboard.html | head -20
```
Identificar a função `abrirDetalheOS(id)` que monta o HTML do detalhe (usa `os` carregado de `/api/v2/os/:id`, que agora traz `os.requisicao` e `os.requisicao_itens`), e onde inserir um novo bloco. Confirmar os helpers reais (`api`, `showToast`, `escHtml`).

- [ ] **Step 2: Adicionar o bloco de requisição ao HTML do detalhe**

No template de `abrirDetalheOS`, após o bloco da ficha/vias, inserir um placeholder e renderizar via função dedicada:

```html
<div id="os-requisicao-bloco" style="margin-top:16px"></div>
```

Após inserir o HTML do detalhe no DOM, chamar `renderRequisicaoOS(os)`.

- [ ] **Step 3: Adicionar as funções JS**

Adicionar (perto de `salvarFichaOS`), adaptando nomes de helper aos reais:

```js
function renderRequisicaoOS(os) {
  const box = document.getElementById('os-requisicao-bloco');
  if (!box) return;
  const req = os.requisicao;
  const itens = os.requisicao_itens || [];
  let corpo;
  if (!req || req.status === 'estornada') {
    const estornadaMsg = req && req.status === 'estornada'
      ? `<div style="font-size:12px;color:#c62828;margin-bottom:8px">Requisição estornada em ${new Date(req.estornada_em).toLocaleDateString('pt-BR')}</div>` : '';
    corpo = `${estornadaMsg}
      <div style="color:#777;font-size:13px;margin-bottom:8px">Materiais não baixados.</div>
      <button onclick="requisitarOS('${os.id}')" style="background:#43a047;border:none;border-radius:6px;color:white;font-size:12px;font-weight:600;padding:6px 12px;cursor:pointer">Requisitar materiais</button>`;
  } else {
    const linhas = itens.length ? itens.map(it => `
      <tr>
        <td style="padding:4px 8px">${escHtml(it.material_nome||'—')}</td>
        <td style="padding:4px 8px;text-align:right">${parseFloat(it.quantidade).toLocaleString('pt-BR',{maximumFractionDigits:3})}</td>
        <td style="padding:4px 8px">${escHtml(it.unidade)}</td>
        <td style="padding:4px 8px;text-align:right">${parseFloat(it.estoque_atual).toLocaleString('pt-BR',{maximumFractionDigits:3})}</td>
      </tr>`).join('')
      : '<tr><td colspan="4" style="padding:8px;color:#999">Nenhum material do catálogo vinculado.</td></tr>';
    corpo = `
      <div style="font-size:12px;color:#2e7d32;margin-bottom:8px">✅ Baixado em ${new Date(req.criada_em).toLocaleDateString('pt-BR')}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px">
        <thead><tr style="color:#777;text-align:left"><th style="padding:4px 8px">Material</th><th style="padding:4px 8px;text-align:right">Qtd</th><th style="padding:4px 8px">Un</th><th style="padding:4px 8px;text-align:right">Estoque</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
      <button onclick="estornarOS('${os.id}')" style="background:#ad1457;border:none;border-radius:6px;color:white;font-size:12px;font-weight:600;padding:6px 12px;cursor:pointer">↩ Estornar baixa</button>`;
  }
  box.innerHTML = `<div style="border:1px solid #e8eaf6;border-radius:8px;padding:12px 14px;background:#fafbff">
    <div style="font-weight:700;color:#3949ab;font-size:13px;margin-bottom:8px">REQUISIÇÃO DE MATERIAIS</div>${corpo}</div>`;
}

async function requisitarOS(id) {
  if (!confirm('Dar baixa dos materiais desta OS no estoque?')) return;
  const res = await api(`/api/v2/os/${id}/requisicao`, { method: 'POST' });
  if (res?.errors || res?.error) { showToast('Erro: ' + (res.errors?.[0] || res.error)); return; }
  showToast('✅ Materiais baixados');
  abrirDetalheOS(id);
}

async function estornarOS(id) {
  if (!confirm('Estornar a baixa (devolver ao estoque)?')) return;
  const res = await api(`/api/v2/os/${id}/requisicao/estornar`, { method: 'POST' });
  if (res?.errors || res?.error) { showToast('Erro: ' + (res.errors?.[0] || res.error)); return; }
  showToast('↩ Baixa estornada');
  abrirDetalheOS(id);
}
```
(Se `abrirDetalheOS` não puder ser re-chamado direto para recarregar, use o mecanismo real de refresh do detalhe que você encontrar no Step 1.)

- [ ] **Step 4: Deploy**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(os3c): bloco Requisição de Materiais no detalhe da OS (baixar/estornar)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## FASE 2 — Consumo de Comunicação Visual (m² por dimensões)

### Task 5: Item do orçamento aceita largura/altura/material no backend

**Files:**
- Modify: `src/modules/orcamentos/router.js`

- [ ] **Step 1: Aceitar os campos no POST de item**

Em `src/modules/orcamentos/router.js`, na rota `router.post('/:id/itens', ...)`, estender o INSERT para incluir `largura_cm`, `altura_cm`, `material_id`. Substituir o bloco de criação por:

```js
    const { produto, tipo_producao, especificacao, quantidade, valor_unitario, valor_total,
            largura_cm, altura_cm, material_id } = req.body;
    let { descricao } = req.body;
    if (produto) descricao = especificacao ? `${produto} — ${especificacao}` : produto;
    if (!descricao || !quantidade) return res.status(400).json({ erro: ['produto/descrição e quantidade são obrigatórios'] });
    const cod = await db.query('SELECT COALESCE(MAX(codigo),0)+1 AS c FROM orcamento_itens WHERE orcamento_id=$1', [req.params.id]);
    const { rows } = await db.query(
      `INSERT INTO orcamento_itens (orcamento_id, codigo, produto, especificacao, descricao, tipo_producao, quantidade, valor_unitario, valor_total, largura_cm, altura_cm, material_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.params.id, cod.rows[0].c, produto || null, especificacao || null, descricao, tipo_producao || null,
       quantidade, valor_unitario || 0, valor_total || 0,
       largura_cm || null, altura_cm || null, material_id || null]
    );
```
(Mantenha o restante do handler — `UPDATE orcamentos SET total...`, `_rebuildOrderItems`, `res.status(201)` — inalterado.)

- [ ] **Step 2: Aceitar os campos no PATCH de item**

Na rota `router.patch('/:id/itens/:itemId', ...)`, localizar o `UPDATE orcamento_itens SET ...` e acrescentar as três colunas. Ler o handler real e adicionar ao SET: `largura_cm=$N, altura_cm=$N+1, material_id=$N+2` com os valores `req.body.largura_cm||null`, `req.body.altura_cm||null`, `req.body.material_id||null` (ajustar a numeração dos placeholders conforme o UPDATE existente). Preservar a derivação de `descricao` e o `_rebuildOrderItems`.

- [ ] **Step 3: node --check + deploy + smoke**

```bash
node --check src/modules/orcamentos/router.js && echo OK
rsync -az src/modules/orcamentos/router.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/router.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && echo restarted"
```
Expected: `OK` e `restarted`.

- [ ] **Step 4: Commit**

```bash
git add src/modules/orcamentos/router.js
git commit -m "feat(os3c): item do orçamento aceita largura_cm/altura_cm/material_id (CV)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Coletar consumo de CV no motor de baixa

**Files:**
- Modify: `src/modules/os/service.js` (função `_coletarConsumo`)

- [ ] **Step 1: Adicionar a fonte CV em `_coletarConsumo`**

Em `_coletarConsumo`, substituir o comentário `// (fase 2) Fonte CV entra aqui` por:

```js
  // Fonte CV: itens da OS com material e dimensões → m²
  const cv = await client.query(
    `SELECT oi.material_id,
            (oi.largura_cm/100.0) * (oi.altura_cm/100.0) * oi.quantidade AS m2
     FROM os_itens si
     JOIN orcamento_itens oi ON oi.id = si.orcamento_item_id
     WHERE si.os_id = $1
       AND oi.material_id IS NOT NULL
       AND oi.largura_cm > 0 AND oi.altura_cm > 0 AND oi.quantidade > 0`, [osId]);
  for (const r of cv.rows) {
    consumo.push({ material_id: r.material_id, quantidade: Math.round(Number(r.m2) * 1000) / 1000, unidade: 'm2' });
  }
```

- [ ] **Step 2: node --check + deploy + smoke (CV)**

```bash
node --check src/modules/os/service.js && echo OK
rsync -az src/modules/os/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/os/service.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const os=require('./src/modules/os/service'); const db=require('./src/db');
(async()=>{
  // procura uma OS cujo item de orçamento tenha material+dimensões
  const r=await db.query(\\\"SELECT si.os_id, oi.material_id, oi.largura_cm, oi.altura_cm, oi.quantidade FROM os_itens si JOIN orcamento_itens oi ON oi.id=si.orcamento_item_id WHERE oi.material_id IS NOT NULL AND oi.largura_cm>0 AND oi.altura_cm>0 LIMIT 1\\\");
  if(!r.rows[0]){console.log('SEM item CV com material+dimensões (cadastre para testar) — ok');process.exit(0);}
  const row=r.rows[0];
  const m2=(row.largura_cm/100)*(row.altura_cm/100)*row.quantidade;
  console.log('esperado m2=',m2.toFixed(3));
  const e0=(await db.query('SELECT estoque_atual FROM materiais WHERE id=\$1',[row.material_id])).rows[0].estoque_atual;
  const b=await os.baixarMateriais(row.os_id,{});
  if(b.erro){console.log('ERRO',b.erro);process.exit(1);}
  const e1=(await db.query('SELECT estoque_atual FROM materiais WHERE id=\$1',[row.material_id])).rows[0].estoque_atual;
  console.log('estoque antes=',e0,'depois=',e1,'(delta deve incluir',m2.toFixed(3),'m2)');
  await os.estornarRequisicao(row.os_id,{});
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
\""
```
Expected: o estoque cai pelo m² esperado (ou `SEM item CV` se não houver dados — aceitável).

- [ ] **Step 3: Commit**

```bash
git add src/modules/os/service.js
git commit -m "feat(os3c): coletar consumo de CV (m² por dimensões) no motor de baixa

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Dashboard — campos largura/altura/material no form do item

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Investigar os forms de item**

```bash
grep -n "abrirEditarItemOrc\|ni-produto\|ei-produto\|selectProduto\|salvarNovoItem\|/itens" public/dashboard.html | head
```
Identificar o form de adicionar item (ids `ni-*`) e o de editar (ids `ei-*`), e as funções que montam o payload do POST/PATCH de item. Confirmar como existe um combo de material em outro lugar (ex.: a ficha da OS busca material por catálogo) para reaproveitar o padrão de busca/seleção de `materiais`.

- [ ] **Step 2: Adicionar os campos ao form de adicionar item**

No HTML do form de novo item, após o campo de quantidade, adicionar (ids `ni-larg`, `ni-alt`, `ni-mat`):

```html
<div style="display:flex;gap:8px;margin-bottom:10px">
  <label style="flex:1">Largura (cm)<input id="ni-larg" type="number" step="0.01" min="0" style="width:100%"></label>
  <label style="flex:1">Altura (cm)<input id="ni-alt" type="number" step="0.01" min="0" style="width:100%"></label>
</div>
<label style="display:block;margin-bottom:10px">Material (Comunicação Visual)
  <select id="ni-mat" style="width:100%"><option value="">— sem material —</option></select>
</label>
```
Após renderizar o form, popular o `#ni-mat` com `api('/api/v2/materiais?status=ativo&limit=500')` (resposta `{ materiais }`), criando uma `<option>` por material (`m.id` / `escHtml(m.nome)`).

No builder do payload do POST (a função que chama `POST /api/v2/orcamentos/:id/itens`), acrescentar:
```js
  largura_cm: document.getElementById('ni-larg')?.value || null,
  altura_cm: document.getElementById('ni-alt')?.value || null,
  material_id: document.getElementById('ni-mat')?.value || null,
```

- [ ] **Step 3: Adicionar os campos ao form de editar item**

Replicar no form de editar (ids `ei-larg`, `ei-alt`, `ei-mat`), pré-preenchendo com os valores do item (`largura_cm`, `altura_cm`, `material_id`) — para isso, a função de editar precisa ter o item completo; se ela hoje recebe só alguns campos, buscar o item via `api('/api/v2/orcamentos/'+orcId)` e achar o item por id, OU passar os novos campos na chamada de abertura. Popular `#ei-mat` igual ao Step 2, com a opção do material atual marcada como `selected`. No payload do PATCH, acrescentar os mesmos três campos a partir de `ei-larg`/`ei-alt`/`ei-mat`.

- [ ] **Step 4: Deploy**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(os3c): campos largura/altura/material no item do orçamento (CV)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Atualizar memória do projeto

**Files:**
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Registrar OS-3C como concluído**

Marcar `**OS-3C (estoque)**: PENDENTE` como `CONCLUÍDO — 2026-06-24`, com resumo: tabelas `os_requisicoes`/`os_requisicao_itens` (migration 037); motor `baixarMateriais`/`estornarRequisicao` (offset folhas + CV m²); auto-baixa ao entrar em `'impressao'` (idempotente, estornável, saldo pode negativar); rotas `POST /os/:id/requisicao` e `/requisicao/estornar`; bloco de requisição no detalhe da OS; campos largura/altura/material em `orcamento_itens` + form do item. Atualizar próxima migration livre para **038**. Manter "Estoque-Entrada via NF-e de compra" na fila como próximo.

- [ ] **Step 2: Sem commit** (memória fica fora do git do projeto).

---

## Notas de verificação final

- Após a Fase 1: abrir uma OS offset com via+material+folhas, mudar status para "Em impressão" e confirmar no detalhe da OS o bloco "✅ Baixado" + a queda no estoque do material (aba Materiais). Estornar e confirmar a devolução.
- Após a Fase 2: criar um item de CV com largura/altura/material, gerar/abrir a OS de CV, dar baixa e confirmar o m² decrementado.
- Confirmar idempotência: dar baixa duas vezes não duplica o consumo.
