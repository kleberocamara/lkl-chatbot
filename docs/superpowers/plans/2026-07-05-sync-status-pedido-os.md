# Sincronizar status do pedido com a OS (visão Produção / Pagamento) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O status do pedido na aba Pedidos passa a refletir a esteira da OS (Em produção → Concluído → Entregue) e o pagamento (Aguard. pagamento / Pago) como duas dimensões exibidas juntas.

**Architecture:** Uma função pura mapeia o conjunto de status das OS de um orçamento para o status de produção do pedido; um helper de sincronização (chamado após cada mudança de fase de OS) recalcula e grava `orders.status` respeitando uma guarda "só avança"; o pagamento continua em `orcamento.status_pagamento` e o frontend compõe os dois. O webhook do Mercado Pago para de escrever pagamento em `orders.status`.

**Tech Stack:** Node.js, PostgreSQL (pg), socket.io, Jest, HTML/JS vanilla (dashboard).

**Referência:** `docs/superpowers/specs/2026-07-05-sync-status-pedido-os-design.md`

**Vínculo OS↔pedido (crítico):** OS de comunicação visual têm `ordens_servico.orcamento_id`; OS **offset** têm `orcamento_id` NULL e ligam via `os_itens → orcamento_itens.orcamento_id`, podendo agrupar vários orçamentos. Toda resolução OS→pedido usa os **dois caminhos**.

---

### Task 1: Funções puras de mapeamento (TDD)

**Files:**
- Modify: `src/constants/fluxoProducao.js`
- Test: `tests/pedido-status-os.test.js` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/pedido-status-os.test.js`:

```javascript
const { pedidoStatusDaOS, podeAvancarPedido } = require('../src/constants/fluxoProducao');

describe('pedidoStatusDaOS', () => {
  test('nenhuma OS → null', () => {
    expect(pedidoStatusDaOS([])).toBeNull();
  });
  test('todas canceladas → null', () => {
    expect(pedidoStatusDaOS(['cancelado', 'cancelado'])).toBeNull();
  });
  test('uma OS em corte → em_producao', () => {
    expect(pedidoStatusDaOS(['corte'])).toBe('em_producao');
  });
  test('multi-OS parcial (acabamento + entregue) → em_producao', () => {
    expect(pedidoStatusDaOS(['acabamento', 'entregue'])).toBe('em_producao');
  });
  test('todas em entrega → concluido', () => {
    expect(pedidoStatusDaOS(['entrega', 'entrega'])).toBe('concluido');
  });
  test('entrega + entregue → concluido', () => {
    expect(pedidoStatusDaOS(['entrega', 'entregue'])).toBe('concluido');
  });
  test('todas entregue → entregue', () => {
    expect(pedidoStatusDaOS(['entregue', 'entregue'])).toBe('entregue');
  });
  test('cancelada ignorada; resto entregue → entregue', () => {
    expect(pedidoStatusDaOS(['entregue', 'cancelado'])).toBe('entregue');
  });
  test('impressao + acabamento → em_producao', () => {
    expect(pedidoStatusDaOS(['impressao', 'acabamento'])).toBe('em_producao');
  });
});

describe('podeAvancarPedido', () => {
  test('de aguardando_pagamento avança para em_producao', () => {
    expect(podeAvancarPedido('aguardando_pagamento', 'em_producao')).toBe(true);
  });
  test('de pago avança para entregue', () => {
    expect(podeAvancarPedido('pago', 'entregue')).toBe(true);
  });
  test('de novo avança para em_producao', () => {
    expect(podeAvancarPedido('novo', 'em_producao')).toBe(true);
  });
  test('em_producao avança para concluido', () => {
    expect(podeAvancarPedido('em_producao', 'concluido')).toBe(true);
  });
  test('entregue NÃO regride para em_producao', () => {
    expect(podeAvancarPedido('entregue', 'em_producao')).toBe(false);
  });
  test('concluido NÃO regride para em_producao', () => {
    expect(podeAvancarPedido('concluido', 'em_producao')).toBe(false);
  });
  test('mesmo status → false (no-op)', () => {
    expect(podeAvancarPedido('em_producao', 'em_producao')).toBe(false);
  });
  test('cancelado nunca avança', () => {
    expect(podeAvancarPedido('cancelado', 'entregue')).toBe(false);
  });
  test('reprovado nunca avança', () => {
    expect(podeAvancarPedido('reprovado', 'entregue')).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx jest tests/pedido-status-os.test.js`
Expected: FAIL — `pedidoStatusDaOS is not a function`.

- [ ] **Step 3: Implementar as funções puras**

Em `src/constants/fluxoProducao.js`, antes do `module.exports`, adicionar:

```javascript
const RANK_PRODUCAO = { em_producao: 1, concluido: 2, entregue: 3 };
const PRE_PRODUCAO = new Set([
  'novo', 'em_orcamento', 'aguardando_aprovacao', 'aprovado',
  'aguardando_pagamento', 'pago',
]);

// Mapeia os status das OS (não canceladas) de um orçamento para o status
// de produção do pedido. Retorna null quando não há OS ativa (no-op).
function pedidoStatusDaOS(statuses) {
  const ativos = (statuses || []).filter(s => s !== 'cancelado');
  if (ativos.length === 0) return null;
  if (ativos.every(s => s === 'entregue')) return 'entregue';
  if (ativos.every(s => s === 'entrega' || s === 'entregue')) return 'concluido';
  return 'em_producao';
}

// Guarda "só avança": produção nunca regride; pré-produção/pagamento sempre
// podem avançar; cancelado/reprovado nunca são tocados.
function podeAvancarPedido(atual, alvo) {
  if (atual === 'cancelado' || atual === 'reprovado') return false;
  if (PRE_PRODUCAO.has(atual)) return true;
  return (RANK_PRODUCAO[alvo] || 0) > (RANK_PRODUCAO[atual] || 0);
}
```

Atualizar o `module.exports` (atualmente `{ FLUXO, FASE_LABEL, proximaFase }`) para:

```javascript
module.exports = { FLUXO, FASE_LABEL, proximaFase, pedidoStatusDaOS, podeAvancarPedido };
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx jest tests/pedido-status-os.test.js`
Expected: PASS (18 testes).

- [ ] **Step 5: Rodar a suíte toda para não quebrar nada**

Run: `npx jest`
Expected: sem novas falhas (testes de integração que dependem de DB já falham localmente — pré-existente; ignore esses).

- [ ] **Step 6: Commit**

```bash
git add src/constants/fluxoProducao.js tests/pedido-status-os.test.js
git commit -m "feat(pedidos): funções puras pedidoStatusDaOS + podeAvancarPedido"
```

---

### Task 2: Helper de sincronização + wiring nos 3 pontos de mudança de OS

**Files:**
- Modify: `src/modules/os/service.js`

- [ ] **Step 1: Importar as novas funções puras**

Localizar o `require` de `fluxoProducao` no topo de `src/modules/os/service.js` (hoje traz `proximaFase`). Trocar para incluir as novas funções, por exemplo:

```javascript
const { proximaFase, pedidoStatusDaOS, podeAvancarPedido } = require('../../constants/fluxoProducao');
```

(Se o require atual usar caminho/nomes diferentes, preservar o caminho e apenas acrescentar `pedidoStatusDaOS, podeAvancarPedido` à desestruturação.)

- [ ] **Step 2: Adicionar o helper de sincronização**

Em `src/modules/os/service.js`, adicionar estas três funções (antes do `module.exports`):

```javascript
// Resolve os orçamentos afetados por uma OS pelos dois caminhos de vínculo:
// direto (ordens_servico.orcamento_id) e via itens (os_itens → orcamento_itens).
async function orcamentosAfetadosPorOS(osId) {
  const r = await db.query(
    `SELECT orcamento_id FROM (
       SELECT orcamento_id FROM ordens_servico WHERE id=$1 AND orcamento_id IS NOT NULL
       UNION
       SELECT oi.orcamento_id FROM os_itens oit
         JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
         WHERE oit.os_id=$1
     ) t WHERE orcamento_id IS NOT NULL`,
    [osId]
  );
  return r.rows.map(x => x.orcamento_id);
}

// Status de todas as OS não canceladas de um orçamento (dois caminhos).
async function statusOSsDoOrcamento(orcamentoId) {
  const r = await db.query(
    `SELECT DISTINCT os.id, os.status FROM ordens_servico os
     WHERE os.status != 'cancelado' AND (
       os.orcamento_id = $1
       OR os.id IN (SELECT oit.os_id FROM os_itens oit
                    JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
                    WHERE oi.orcamento_id = $1)
     )`,
    [orcamentoId]
  );
  return r.rows.map(x => x.status);
}

// Sincroniza o(s) pedido(s) afetado(s) por uma OS que mudou de fase.
async function sincronizarPedidoPorOS(osId) {
  const orcs = await orcamentosAfetadosPorOS(osId);
  for (const orcId of orcs) {
    const statuses = await statusOSsDoOrcamento(orcId);
    const alvo = pedidoStatusDaOS(statuses);
    if (!alvo) continue;
    const oR = await db.query('SELECT id, status FROM orders WHERE orcamento_id=$1', [orcId]);
    const order = oR.rows[0];
    if (!order) continue;
    if (!podeAvancarPedido(order.status, alvo)) continue;
    await db.query('UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2', [alvo, order.id]);
    if (global.io) global.io.emit('order_status_update', { orderId: order.id, status: alvo });
  }
}
```

- [ ] **Step 3: Chamar o helper em `avancarFase`**

Em `avancarFase`, imediatamente antes de `return { os: updatedOs };` (hoje ~linha 176), adicionar:

```javascript
  sincronizarPedidoPorOS(osId).catch(e => console.warn('[SYNC-PEDIDO avancarFase]', e.message));
```

- [ ] **Step 4: Chamar o helper em `atualizarStatus`**

Em `atualizarStatus`, imediatamente antes de `return { os: updatedOs };` (hoje ~linha 371), adicionar:

```javascript
  sincronizarPedidoPorOS(id).catch(e => console.warn('[SYNC-PEDIDO atualizarStatus]', e.message));
```

- [ ] **Step 5: Chamar o helper em `entregar`**

Em `entregar`, imediatamente antes de `return { os };` (hoje ~linha 421), adicionar:

```javascript
  sincronizarPedidoPorOS(id).catch(e => console.warn('[SYNC-PEDIDO entregar]', e.message));
```

- [ ] **Step 6: Checar sintaxe**

Run: `node -e "require('./src/modules/os/service.js'); console.log('parse OK')"`
Expected: `parse OK`.

- [ ] **Step 7: Commit**

```bash
git add src/modules/os/service.js
git commit -m "feat(pedidos): sincroniza status do pedido ao avançar/entregar OS"
```

---

### Task 3: Reverter escrita de pagamento em orders.status no webhook MP

**Files:**
- Modify: `src/webhook/mercadopago.js`

- [ ] **Step 1: Remover o UPDATE em orders**

Em `src/webhook/mercadopago.js`, remover o bloco adicionado em 2026-07-05 (dentro da transação, logo após o `UPDATE ordens_servico ... pago=true`):

```javascript
      // Sync pedido → pago (espelha o caminho do C6 em orcamentos/service.js)
      await client.query(
        `UPDATE orders SET status='pago', updated_at=NOW() WHERE orcamento_id=$1 AND status NOT IN ('cancelado')`,
        [orcId]
      );
```

Deixando a sequência: `UPDATE orcamentos ... status_pagamento='pago'` → `UPDATE ordens_servico ... pago=true` → `COMMIT`.

- [ ] **Step 2: Checar sintaxe**

Run: `node -e "require('./src/webhook/mercadopago.js'); console.log('parse OK')"`
Expected: `parse OK`.

- [ ] **Step 3: Commit**

```bash
git add src/webhook/mercadopago.js
git commit -m "refactor(pagamento): webhook MP não escreve mais em orders.status (pagamento fica no badge)"
```

---

### Task 4: Frontend — trazer status_pagamento e compor o rótulo

**Files:**
- Modify: `src/modules/orders/service.js` (query `listar`, ~linha 285)
- Modify: `public/dashboard.html` (~linha 3988 helpers; ~linha 4033 render)

- [ ] **Step 1: Adicionar status_pagamento ao SELECT de `listar`**

Em `src/modules/orders/service.js`, na query de `listar`, logo após a linha `orc.status AS orcamento_status,` (~linha 285), adicionar:

```sql
              orc.status_pagamento AS pagamento_status,
```

- [ ] **Step 2: Adicionar helper de composição no dashboard**

Em `public/dashboard.html`, logo após a função `statusColor` (~linha 3989), adicionar:

```javascript
function pedidoStatusBadges(o) {
  const prod = `<span style="background:${statusColor(o.status)};color:white;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600">${statusLabel(o.status)}</span>`;
  const pg = o.pagamento_status;
  if (pg !== 'pago' && pg !== 'aguardando_pagamento') return prod;
  const pgLabel = pg === 'pago' ? 'Pago' : 'Aguard. pagamento';
  const pgColor = pg === 'pago' ? '#16a34a' : '#f97316';
  const pgBadge = `<span style="background:${pgColor};color:white;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600;margin-left:4px">${pgLabel}</span>`;
  return `${prod}${pgBadge}`;
}
```

- [ ] **Step 3: Usar o helper no render da linha do pedido**

Em `public/dashboard.html`, na função que monta `ordersBody` (~linha 4033), substituir a célula de status:

```html
      <td style="${C}"><span style="background:${statusColor(o.status)};color:white;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600">${statusLabel(o.status)}</span></td>
```

por:

```html
      <td style="${C}">${pedidoStatusBadges(o)}</td>
```

- [ ] **Step 4: Checar sintaxe (JS embutido)**

Run: `node --check <(sed -n '/<script>/,/<\/script>/p' public/dashboard.html)` — se falhar por causa do multi-script, alternativa: `node -e "const fs=require('fs');const h=fs.readFileSync('public/dashboard.html','utf8');if(h.includes('pedidoStatusBadges'))console.log('helper presente');"`
Expected: confirma presença do helper. (A validação real é no smoke via browser preview.)

- [ ] **Step 5: Commit**

```bash
git add src/modules/orders/service.js public/dashboard.html
git commit -m "feat(pedidos): card mostra Produção + Pagamento (dois badges)"
```

---

### Task 5: Script de migração de dados (backfill)

**Files:**
- Create: `scripts/backfill-status-pedido.js`

- [ ] **Step 1: Escrever o script**

Criar `scripts/backfill-status-pedido.js` (seguir o estilo de `scripts/reprecificar-orcamento.js` para o require do db):

```javascript
// Recalcula orders.status a partir do estado atual das OS (dois caminhos de vínculo).
// Rodar uma vez: node -r dotenv/config scripts/backfill-status-pedido.js
const db = require('../src/db');
const { pedidoStatusDaOS } = require('../src/constants/fluxoProducao');

async function statusOSsDoOrcamento(orcamentoId) {
  const r = await db.query(
    `SELECT DISTINCT os.id, os.status FROM ordens_servico os
     WHERE os.status != 'cancelado' AND (
       os.orcamento_id = $1
       OR os.id IN (SELECT oit.os_id FROM os_itens oit
                    JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
                    WHERE oi.orcamento_id = $1)
     )`,
    [orcamentoId]
  );
  return r.rows.map(x => x.status);
}

(async () => {
  const orders = await db.query(
    `SELECT id, status, orcamento_id FROM orders WHERE orcamento_id IS NOT NULL`
  );
  let changed = 0;
  for (const o of orders.rows) {
    const statuses = await statusOSsDoOrcamento(o.orcamento_id);
    let alvo = pedidoStatusDaOS(statuses);
    if (!alvo) {
      // Sem OS: se pagamento vazou pro campo, normaliza para aprovado.
      if (o.status === 'pago' || o.status === 'aguardando_pagamento') alvo = 'aprovado';
      else continue;
    }
    if (alvo !== o.status) {
      await db.query('UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2', [alvo, o.id]);
      changed++;
      console.log(`Pedido ${String(o.id).slice(0, 8)}  ${o.status} -> ${alvo}`);
    }
  }
  console.log(`\nBackfill concluído: ${changed} pedido(s) atualizado(s).`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Checar sintaxe**

Run: `node --check scripts/backfill-status-pedido.js`
Expected: sem saída (OK).

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-status-pedido.js
git commit -m "chore(pedidos): script de backfill de orders.status a partir das OS"
```

---

### Task 6: Deploy no VPS + backfill + smoke + memória

**Contexto de deploy:** `root@2.25.147.243`, app em `/var/www/lkl-chatbot`, DB `lkl_chatbot`, processo pm2 `lkl-chatbot`. **Confirmar com o usuário antes de deployar (toca produção).**

- [ ] **Step 1: Rsync dos arquivos alterados**

```bash
rsync -av \
  src/constants/fluxoProducao.js \
  src/modules/os/service.js \
  src/modules/orders/service.js \
  src/webhook/mercadopago.js \
  public/dashboard.html \
  scripts/backfill-status-pedido.js \
  root@2.25.147.243:/var/www/lkl-chatbot/ --relative
```

(Se `--relative` não preservar a árvore como esperado, enviar arquivo a arquivo para os caminhos exatos correspondentes em `/var/www/lkl-chatbot/`.)

- [ ] **Step 2: Restart do app**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```
Expected: processo `online`.

- [ ] **Step 3: Rodar o backfill (uma vez)**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config scripts/backfill-status-pedido.js"
```
Expected: lista de transições e "Backfill concluído". Conferir que o pedido `numero_os=31` aparece como `-> entregue` (ou já está entregue).

- [ ] **Step 4: Smoke — pedido reflete a OS**

Escolher uma OS de teste em fase inicial e avançá-la via API/painel; conferir no DB que `orders.status` acompanhou:

```bash
ssh root@2.25.147.243 "sudo -u postgres psql lkl_chatbot -x -c \"SELECT o.numero_os, o.status AS pedido, orc.status_pagamento FROM orders o JOIN orcamentos orc ON orc.id=o.orcamento_id WHERE o.numero_os=31;\""
```
Expected: `pedido = entregue`, `status_pagamento = pago`.

- [ ] **Step 5: Smoke — webhook não escreve mais em orders**

Confirmar (leitura de código já garante) e validar que um novo pagamento MP só altera `status_pagamento`, não `orders.status` (via badge no painel). Registrar no relato.

- [ ] **Step 6: Atualizar memória**

Anexar entrada em `project_sprint_status.md` (fora do repo git, em `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/`) resumindo o sprint. Atualizar `reference_pagamento_sync_orders.md`: o webhook MP **não** escreve mais em `orders.status`; produção agora dirige `orders.status` via `sincronizarPedidoPorOS`; pagamento vive em `status_pagamento` (badge). Sem novo item no MEMORY.md (atualização de arquivo existente).

- [ ] **Step 7: Commit final (se houver ajustes do smoke)**

```bash
git add -A && git commit -m "chore(pedidos): sync status pedido↔OS deployado e validado no VPS" || echo "nada a commitar"
```

---

## Self-Review (checklist do autor)

**Spec coverage:**
- Componente 1 (função pura) → Task 1 ✅
- Componente 2 (helper dois-caminhos + wiring) → Task 2 ✅
- Componente 3 (reverter webhook) → Task 3 ✅
- Componente 4 (frontend listar + badges) → Task 4 ✅
- Componente 5 (backfill) → Task 5 + Task 6 (execução) ✅
- Testes unitários → Task 1; smoke → Task 6 ✅

**Consistência de nomes:** `pedidoStatusDaOS`, `podeAvancarPedido`, `orcamentosAfetadosPorOS`, `statusOSsDoOrcamento`, `sincronizarPedidoPorOS`, `pedidoStatusBadges`, `pagamento_status` — usados de forma idêntica em todas as tasks. ✅

**Sem placeholders:** todo passo de código traz o código real. ✅
