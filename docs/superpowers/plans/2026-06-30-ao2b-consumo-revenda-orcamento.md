# AO-2b — Consumo do Catálogo de Revenda no Orçamento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Precificar um item do orçamento a partir do catálogo de revenda: combo unificado, escolha da tiragem/prazo/acabamentos, preço = (faixa + acabamentos) × (1 + margem global).

**Architecture:** Precificador puro (`pricer.js`, testável) + `precificarItemRevenda` no service + `POST /revenda/preview` + integração no POST/PATCH de item + UI (combo unificado + modo revenda). Migration 045 adiciona campos de revenda ao item.

**Tech Stack:** Node.js + Express, PostgreSQL (`pg`), Jest (função pura), frontend vanilla em `public/dashboard.html`. Auth cookie-session; escrita admin/gestor/atendente.

**Spec:** `docs/superpowers/specs/2026-06-30-ao2b-consumo-revenda-orcamento-design.md`

---

## File Structure

- **Create** `sql/migrations/045_orcamento_itens_revenda.sql` — colunas de revenda no item.
- **Create** `src/modules/revenda/pricer.js` — `calcularRevenda(ctx, opts)` (puro).
- **Create** `tests/revenda-pricer.test.js` — testes do pricer.
- **Modify** `src/modules/revenda/service.js` — `precificarItemRevenda(...)`.
- **Modify** `src/modules/revenda/router.js` — `POST /preview`.
- **Modify** `src/modules/orcamentos/router.js` — POST/PATCH item aceitam/priorizam revenda.
- **Modify** `public/dashboard.html` — combo unificado + modo revenda nos forms de item.

> **Convenções do projeto:** sem Postgres local (só suítes puras rodam local e DEVEM passar; integração é smoke no VPS). `orcamento_itens` pertence ao user `postgres` → `ALTER` via `sudo -u postgres psql`. Deploy = `rsync` + `pm2 restart lkl-chatbot --update-env`. Próxima migration livre: **045**. `api(path,{...})` no front usa caminho completo `/api/v2/...`.

---

## Task 1: Migration 045 — campos de revenda no item

**Files:**
- Create: `sql/migrations/045_orcamento_itens_revenda.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- 045_orcamento_itens_revenda.sql — AO-2b: item de orçamento vindo do catálogo de revenda
-- ATENÇÃO: orcamento_itens pertence ao user postgres → rodar via `sudo -u postgres psql`.
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS revenda_produto_id UUID REFERENCES revenda_produtos(id) ON DELETE SET NULL;
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS revenda_prazo_horas INTEGER;
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS revenda_acabamentos JSONB DEFAULT '[]'::jsonb;
```

- [ ] **Step 2: Sanidade**

Run: `node -e "const s=require('fs').readFileSync('sql/migrations/045_orcamento_itens_revenda.sql','utf8'); if(!/revenda_produto_id/.test(s)||!/revenda_prazo_horas/.test(s)||!/revenda_acabamentos/.test(s))throw new Error('incompleta'); console.log('OK: 3 colunas de revenda');"`
Expected: `OK: 3 colunas de revenda`

- [ ] **Step 3: Commit**

```bash
git add sql/migrations/045_orcamento_itens_revenda.sql
git commit -m "feat(ao2b): migration 045 campos de revenda no orcamento_itens"
```

---

## Task 2: Precificador puro `calcularRevenda` (TDD)

**Files:**
- Create: `src/modules/revenda/pricer.js`
- Test: `tests/revenda-pricer.test.js`

`calcularRevenda(ctx, opts)`:
- `ctx = { faixas:[{quantidade,prazo_horas,preco_total}], acabamentos:[{nome,preco}], markup_percent }`
- `opts = { quantidade, prazo_horas, selecionados:[nomes] }`
- retorna `{ valor_unitario, valor_total, memoria, faixa_usada }` ou `null`.

- [ ] **Step 1: Escrever os testes** `tests/revenda-pricer.test.js`:

```javascript
const { calcularRevenda } = require('../src/modules/revenda/pricer');

const faixas = [
  { quantidade: 2500, prazo_horas: 12, preco_total: 76.29 },
  { quantidade: 2500, prazo_horas: 24, preco_total: 74.00 },
  { quantidade: 2500, prazo_horas: 48, preco_total: 71.78 },
  { quantidade: 5000, prazo_horas: 24, preco_total: 110.00 },
  { quantidade: 10000, prazo_horas: 24, preco_total: 195.00 },
];
const acabamentos = [
  { nome: '1 Corte Extra', preco: 3.00 },
  { nome: 'Checagem das Galáxias', preco: 9.00 },
];

describe('calcularRevenda', () => {
  test('faixa exata, prazo 24h, markup 40%, sem acabamento', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 40 }, { quantidade: 2500, prazo_horas: 24, selecionados: [] });
    expect(r.faixa_usada).toBe(2500);
    expect(r.valor_total).toBeCloseTo(103.60, 2); // 74 × 1.4
    expect(r.valor_unitario).toBeCloseTo(0.0414, 3); // 103.60 / 2500
  });
  test('quantidade abaixo da mínima usa a menor faixa (1000 → 2500)', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 0 }, { quantidade: 1000, prazo_horas: 24, selecionados: [] });
    expect(r.faixa_usada).toBe(2500);
    expect(r.valor_total).toBeCloseTo(74.00, 2);
  });
  test('próxima faixa acima (3000 → 5000)', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 0 }, { quantidade: 3000, prazo_horas: 24, selecionados: [] });
    expect(r.faixa_usada).toBe(5000);
    expect(r.valor_total).toBeCloseTo(110.00, 2);
  });
  test('acima da máxima usa a maior (99999 → 10000)', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 0 }, { quantidade: 99999, prazo_horas: 24, selecionados: [] });
    expect(r.faixa_usada).toBe(10000);
    expect(r.valor_total).toBeCloseTo(195.00, 2);
  });
  test('acabamentos somam antes da margem', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 40 }, { quantidade: 2500, prazo_horas: 24, selecionados: ['1 Corte Extra'] });
    expect(r.valor_total).toBeCloseTo(107.80, 2); // (74+3) × 1.4
  });
  test('prazo diferente (12h)', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 0 }, { quantidade: 2500, prazo_horas: 12, selecionados: [] });
    expect(r.valor_total).toBeCloseTo(76.29, 2);
  });
  test('prazo sem faixas → null', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 0 }, { quantidade: 2500, prazo_horas: 48, selecionados: [] });
    // só 2500 tem 48h; ok. Testa prazo inexistente:
    const r2 = calcularRevenda({ faixas: [{ quantidade: 2500, prazo_horas: 24, preco_total: 74 }], acabamentos, markup_percent: 0 }, { quantidade: 2500, prazo_horas: 12, selecionados: [] });
    expect(r2).toBeNull();
  });
  test('quantidade ausente vira 1 (usa menor faixa)', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 0 }, { prazo_horas: 24, selecionados: [] });
    expect(r.faixa_usada).toBe(2500);
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

Run: `npx jest tests/revenda-pricer.test.js --no-coverage`
Expected: FAIL — `Cannot find module '../src/modules/revenda/pricer'`.

- [ ] **Step 3: Implementar** `src/modules/revenda/pricer.js`:

```javascript
const round2 = (x) => Math.round(x * 100) / 100;

// ctx = { faixas, acabamentos, markup_percent } ; opts = { quantidade, prazo_horas, selecionados }
function calcularRevenda(ctx, opts) {
  const qtd = Number(opts.quantidade) > 0 ? Number(opts.quantidade) : 1;
  const prazo = Number(opts.prazo_horas);
  const doPrazo = (ctx.faixas || [])
    .filter((f) => Number(f.prazo_horas) === prazo)
    .sort((a, b) => a.quantidade - b.quantidade);
  if (!doPrazo.length) return null;

  const faixa = doPrazo.find((f) => f.quantidade >= qtd) || doPrazo[doPrazo.length - 1];
  const base = Number(faixa.preco_total);

  const selecionados = new Set(opts.selecionados || []);
  const acab = (ctx.acabamentos || [])
    .filter((a) => selecionados.has(a.nome))
    .reduce((s, a) => s + Number(a.preco), 0);

  const markup = Number(ctx.markup_percent) || 0;
  const total = round2((base + acab) * (1 + markup / 100));
  const valor_unitario = round2(total / qtd);
  const memoria = `Faixa ${faixa.quantidade}un/${prazo}h R$ ${round2(base)}`
    + (acab ? ` + acab R$ ${round2(acab)}` : '')
    + ` ×(1+${markup}%) = R$ ${total} (un R$ ${valor_unitario})`;

  return { valor_unitario, valor_total: total, memoria, faixa_usada: faixa.quantidade };
}

module.exports = { calcularRevenda, round2 };
```

- [ ] **Step 4: Rodar — deve passar**

Run: `npx jest tests/revenda-pricer.test.js --no-coverage`
Expected: PASS — todos verdes.

- [ ] **Step 5: Commit**

```bash
git add src/modules/revenda/pricer.js tests/revenda-pricer.test.js
git commit -m "feat(ao2b): pricer de revenda (faixa proxima-acima + acabamentos + markup) com testes"
```

---

## Task 3: Serviço `precificarItemRevenda` + rota de preview

**Files:**
- Modify: `src/modules/revenda/service.js`
- Modify: `src/modules/revenda/router.js`

- [ ] **Step 1: Adicionar `precificarItemRevenda` ao service**

No topo de `src/modules/revenda/service.js`, abaixo de `const { spawn } = require('child_process');`, adicionar:
```javascript
const pricer = require('./pricer');
```
E adicionar a função (antes do `module.exports`):
```javascript
async function precificarItemRevenda({ revenda_produto_id, quantidade, prazo_horas, acabamentos }) {
  if (!revenda_produto_id) return null;
  const cfg = (await db.query('SELECT markup_percent, prazo_padrao_horas FROM revenda_config WHERE id=1')).rows[0] || { markup_percent: 0, prazo_padrao_horas: 24 };
  const prazo = Number(prazo_horas) > 0 ? Number(prazo_horas) : cfg.prazo_padrao_horas;
  const faixas = (await db.query('SELECT quantidade, prazo_horas, preco_total FROM revenda_precos WHERE produto_id=$1', [revenda_produto_id])).rows;
  const acabs = (await db.query('SELECT nome, preco FROM revenda_acabamentos WHERE produto_id=$1', [revenda_produto_id])).rows;
  const calc = pricer.calcularRevenda(
    { faixas, acabamentos: acabs, markup_percent: cfg.markup_percent },
    { quantidade, prazo_horas: prazo, selecionados: Array.isArray(acabamentos) ? acabamentos.map((a) => (typeof a === 'string' ? a : a.nome)) : [] }
  );
  if (!calc) return null;
  return { ...calc, prazo_horas: prazo };
}
```
E incluir `precificarItemRevenda` no `module.exports` (adicionar à lista existente).

- [ ] **Step 2: Adicionar a rota de preview no router**

Em `src/modules/revenda/router.js`, antes do `module.exports = router;`, adicionar:
```javascript
router.post('/preview', wrap(async (req, res) => {
  const { revenda_produto_id, quantidade, prazo_horas, acabamentos } = req.body;
  const r = await service.precificarItemRevenda({ revenda_produto_id, quantidade, prazo_horas, acabamentos });
  if (!r) return res.json({ auto: false });
  res.json({ auto: true, ...r });
}));
```

- [ ] **Step 3: Sanidade**

Run: `node -e "const s=require('./src/modules/revenda/service'); console.log('precificarItemRevenda' in s ? 'service OK' : 'FALTA'); require('./src/modules/revenda/router'); console.log('router OK');"`
Expected: `service OK` e `router OK`.

- [ ] **Step 4: Commit**

```bash
git add src/modules/revenda/service.js src/modules/revenda/router.js
git commit -m "feat(ao2b): precificarItemRevenda no service + POST /api/v2/revenda/preview"
```

---

## Task 4: Integração no POST/PATCH de item do orçamento

**Files:**
- Modify: `src/modules/orcamentos/router.js` (handlers `POST /:id/itens` e `PATCH /:id/itens/:itemId`)

Regra: se `revenda_produto_id` veio, prioriza a precificação de revenda (quando sem valor explícito ou `recalcular`), grava os campos de revenda e `tipo_producao='REVENDA'`. Itens não-revenda seguem o caminho AO-1 inalterado.

- [ ] **Step 1: Importar o service de revenda**

Em `src/modules/orcamentos/router.js`, abaixo de `const precificacao = require('../precificacao/service');` (seção CRUD de itens), adicionar:
```javascript
const revendaService = require('../revenda/service');
```

- [ ] **Step 2: Estender o `INSERT` da tabela de itens com as colunas de revenda**

O projeto insere itens em `INSERT INTO orcamento_itens (...)`. Adicionar as 3 colunas de revenda ao INSERT do handler `POST /:id/itens`. Substituir o bloco de auto-precificação + INSERT por:

```javascript
    const { revenda_produto_id, revenda_prazo_horas, revenda_acabamentos } = req.body;
    let preco_origem = 'manual', preco_memoria = null, tp = tipo_producao || null;
    let rev_prazo = revenda_prazo_horas || null;
    const revAcab = Array.isArray(revenda_acabamentos) ? JSON.stringify(revenda_acabamentos) : '[]';
    const semValor = (valor_unitario == null && valor_total == null);
    if (semValor || recalcular) {
      let calc = null;
      if (revenda_produto_id) {
        calc = await revendaService.precificarItemRevenda({ revenda_produto_id, quantidade, prazo_horas: revenda_prazo_horas, acabamentos: revenda_acabamentos });
        if (calc) { tp = 'REVENDA'; rev_prazo = calc.prazo_horas; }
      } else {
        calc = await precificacao.precificarItem({ produto, material_id, quantidade, largura_cm, altura_cm });
      }
      if (calc) { valor_unitario = calc.valor_unitario; valor_total = calc.valor_total; preco_origem = 'auto'; preco_memoria = calc.memoria; }
    }

    const cod = await db.query('SELECT COALESCE(MAX(codigo),0)+1 AS c FROM orcamento_itens WHERE orcamento_id=$1', [req.params.id]);
    const { rows } = await db.query(
      `INSERT INTO orcamento_itens (orcamento_id, codigo, produto, especificacao, descricao, tipo_producao, quantidade, valor_unitario, valor_total, largura_cm, altura_cm, material_id, tem_arte, preco_origem, preco_memoria, revenda_produto_id, revenda_prazo_horas, revenda_acabamentos)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [req.params.id, cod.rows[0].c, produto || null, especificacao || null, descricao, tp,
       quantidade, valor_unitario || 0, valor_total || 0,
       largura_cm || null, altura_cm || null, material_id || null, !!tem_arte, preco_origem, preco_memoria,
       revenda_produto_id || null, rev_prazo, revAcab]
    );
```

> Manter o resto do handler (update do total, `_rebuildOrderItems`, resposta). `descricao` já é derivada de produto/especificação no topo do handler.

- [ ] **Step 3: Estender o PATCH `/:id/itens/:itemId` de forma análoga**

No handler PATCH, adicionar `revenda_produto_id`, `revenda_prazo_horas`, `revenda_acabamentos` ao destructuring de `req.body`, e no ramo de recálculo (quando `recalcular` e sem valor explícito) usar revenda quando `revenda_produto_id` estiver presente:

```javascript
    const { revenda_produto_id, revenda_prazo_horas, revenda_acabamentos } = req.body;
    // dentro do "else if (recalcular)" existente, ANTES de chamar precificacao.precificarItem:
    let calc = null;
    if (revenda_produto_id ?? it.revenda_produto_id) {
      calc = await revendaService.precificarItemRevenda({
        revenda_produto_id: revenda_produto_id ?? it.revenda_produto_id,
        quantidade: quantidade ?? it.quantidade,
        prazo_horas: revenda_prazo_horas ?? it.revenda_prazo_horas,
        acabamentos: revenda_acabamentos ?? it.revenda_acabamentos,
      });
      if (calc) { preco_origem = 'auto'; preco_memoria = calc.memoria; valor_unitario = calc.valor_unitario; valor_total = calc.valor_total; }
    } else {
      calc = await precificacao.precificarItem({ /* ...campos atuais... */ });
      if (calc) { /* ...como hoje... */ }
    }
```

E acrescentar as 3 colunas ao `UPDATE orcamento_itens SET ...` com COALESCE, e ao array de parâmetros (mantendo a numeração `$` correta):
```sql
         revenda_produto_id=COALESCE($16,revenda_produto_id),
         revenda_prazo_horas=COALESCE($17,revenda_prazo_horas),
         revenda_acabamentos=COALESCE($18,revenda_acabamentos)
```
com os parâmetros `revenda_produto_id ?? null`, `revenda_prazo_horas ?? null`, `(revenda_acabamentos ? JSON.stringify(revenda_acabamentos) : null)` adicionados na ordem.

> O SELECT do estado atual do item (`const cur = ... SELECT ...`) precisa incluir `revenda_produto_id, revenda_prazo_horas, revenda_acabamentos` para o recálculo. Ajustar esse SELECT.

- [ ] **Step 4: Sanidade — módulo carrega**

Run: `node -e "require('./src/modules/orcamentos/router'); console.log('orcamentos router OK')"`
Expected: `orcamentos router OK`

- [ ] **Step 5: Commit**

```bash
git add src/modules/orcamentos/router.js
git commit -m "feat(ao2b): item de revenda no POST/PATCH do orcamento (precifica via catalogo + grava campos)"
```

---

## Task 5: UI — combo unificado + modo revenda

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Cache do catálogo de revenda + injeção no combo**

Adicionar (perto de `PRODUTOS_LKL`):
```javascript
let REVENDA_CATALOGO = [];
async function carregarCatalogoRevenda() {
  if (REVENDA_CATALOGO.length) return REVENDA_CATALOGO;
  try { REVENDA_CATALOGO = await api('/api/v2/revenda/produtos') || []; } catch (e) { REVENDA_CATALOGO = []; }
  return REVENDA_CATALOGO;
}
```
Modificar `selectProduto(id, onchange)` para acrescentar as opções de revenda (value `revenda:<id>`):
```javascript
function selectProduto(id, onchange) {
  const opts = PRODUTOS_LKL.map(p => `<option value="${p.produto}">${p.produto}</option>`).join('');
  const rev = (REVENDA_CATALOGO || []).map(p => `<option value="revenda:${p.id}">🛰️ ${escHtml(p.nome)} [${escHtml(p.ref)}]</option>`).join('');
  const grupoRev = rev ? `<optgroup label="Revenda (Graficonauta)">${rev}</optgroup>` : '';
  return `<div>
    <label style="font-size:11px;font-weight:600;text-transform:uppercase;color:#555;display:block;margin-bottom:4px">PRODUTO / SERVIÇO *</label>
    <select id="${id}" onchange="${onchange}" style="width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:8px;font-size:13px;box-sizing:border-box">
      <option value="">Selecione...</option>${opts}${grupoRev}
    </select>
  </div>`;
}
```

- [ ] **Step 2: Garantir o catálogo carregado antes de abrir o form + placeholder de revenda**

Em `abrirAdicionarItemOrc(orcId)` e `abrirEditarItemOrc(...)`, adicionar `await carregarCatalogoRevenda();` antes de montar o HTML (ambas já são `async`). Adicionar, logo abaixo do bloco de "COMUNICAÇÃO VISUAL" em cada form, um container:
```html
<div id="ni-revenda" style="display:none"></div>
```
(e `id="ei-revenda"` no form de editar).

- [ ] **Step 3: Handler de troca de produto → modo revenda**

Trocar o `onchange` passado ao `selectProduto` nas duas telas para `onItemProdutoChange('ni')` / `onItemProdutoChange('ei')`, e adicionar:
```javascript
function onItemProdutoChange(prefix) {
  const val = document.getElementById(prefix + '-produto').value;
  const box = document.getElementById(prefix + '-revenda');
  const cvBlocoLabels = document.querySelectorAll(`#${prefix}-larg, #${prefix}-alt, #${prefix}-mat`);
  if (val.startsWith('revenda:')) {
    const id = val.slice(8);
    const p = (REVENDA_CATALOGO || []).find(x => String(x.id) === id);
    cvBlocoLabels.forEach(el => { const w = el.closest('div'); if (w) w.style.display = 'none'; });
    renderModoRevenda(prefix, id, p);
    box.style.display = '';
  } else {
    box.style.display = 'none'; box.innerHTML = '';
    cvBlocoLabels.forEach(el => { const w = el.closest('div'); if (w) w.style.display = ''; });
    const tipoEl = document.getElementById(prefix + '-tipo'); if (tipoEl) tipoEl.value = tipoPorProduto(val) || '';
  }
}
async function renderModoRevenda(prefix, id, p) {
  const det = await api('/api/v2/revenda/produtos/' + id);
  const prazoDefault = 24;
  const acabs = (det?.acabamentos || []).map((a, i) =>
    `<label style="display:block;font-size:13px"><input type="checkbox" class="${prefix}-acab" value="${escHtml(a.nome)}" data-preco="${a.preco}" onchange="previewRevenda('${prefix}')"> ${escHtml(a.nome)} — R$ ${Number(a.preco).toFixed(2)}</label>`).join('');
  document.getElementById(prefix + '-revenda').innerHTML = `
    <div style="border:1px solid #e0e6ff;border-radius:8px;padding:10px;margin-bottom:8px;background:#f7f9ff">
      <div style="font-size:12px;color:#555;font-weight:600;margin-bottom:6px">🛰️ REVENDA — tiragem, prazo e acabamentos</div>
      <label style="font-size:12px">Prazo<br>
        <select id="${prefix}-rev-prazo" onchange="previewRevenda('${prefix}')" style="padding:6px;border:1px solid #ddd;border-radius:6px">
          <option value="12">12h</option><option value="24" selected>24h</option><option value="48">48h</option></select></label>
      <div style="margin-top:8px">${acabs || '<span style="color:#999;font-size:12px">Sem acabamentos.</span>'}</div>
      <button type="button" class="btn btn-outline" style="margin-top:8px;font-size:12px;padding:5px 10px" onclick="previewRevenda('${prefix}')">🔄 calcular preço</button>
      <small id="${prefix}-rev-memoria" style="display:block;color:#666;margin-top:4px"></small>
    </div>`;
  previewRevenda(prefix);
}
async function previewRevenda(prefix) {
  const val = document.getElementById(prefix + '-produto').value;
  if (!val.startsWith('revenda:')) return;
  const id = val.slice(8);
  const quantidade = parseFloat(document.getElementById(prefix + '-qtd').value) || 1;
  const prazo_horas = parseInt(document.getElementById(prefix + '-rev-prazo').value, 10);
  const acabamentos = [...document.querySelectorAll('.' + prefix + '-acab:checked')].map(c => c.value);
  const r = await api('/api/v2/revenda/preview', { method: 'POST', body: JSON.stringify({ revenda_produto_id: id, quantidade, prazo_horas, acabamentos }) });
  const mem = document.getElementById(prefix + '-rev-memoria');
  if (r && r.auto) {
    const vEl = document.getElementById(prefix + '-val'); if (vEl) vEl.value = r.valor_unitario;
    if (mem) mem.textContent = r.memoria;
  } else if (mem) { mem.textContent = 'Sem preço para essa combinação.'; }
}
```

- [ ] **Step 4: Enviar os campos de revenda no salvar**

Em `adicionarItemOrc` e `salvarItemOrc`, quando o produto for de revenda, montar o body com os campos de revenda. Logo após ler `produto`:
```javascript
  const revSel = produto && produto.startsWith('revenda:');
  const revenda_produto_id = revSel ? produto.slice(8) : null;
  const revenda_prazo_horas = revSel ? parseInt(document.getElementById('PREFIX-rev-prazo')?.value, 10) : null;
  const revenda_acabamentos = revSel ? [...document.querySelectorAll('.PREFIX-acab:checked')].map(c => ({ nome: c.value, preco: parseFloat(c.dataset.preco) })) : undefined;
```
(substituir `PREFIX` por `ni` em `adicionarItemOrc` e `ei` em `salvarItemOrc`). Incluir no `body`: `revenda_produto_id`, `revenda_prazo_horas`, `revenda_acabamentos`. Para produtos de revenda, o campo `produto` enviado ao backend deve ser o **nome** (não `revenda:<id>`): usar `produto: revSel ? (REVENDA_CATALOGO.find(x=>String(x.id)===revenda_produto_id)?.nome || 'Revenda') : produto`. Manter a lógica `auto` (valor vazio/0 → `recalcular:true`) já existente.

- [ ] **Step 5: Verificar sintaxe dos `<script>`**

Run: `node -e "const h=require('fs').readFileSync('public/dashboard.html','utf8');const re=/<script[^>]*>([\s\S]*?)<\/script>/g;const cp=require('child_process');let m,i=0,f=0;while((m=re.exec(h))){i++;const c=m[1];if(!c.trim())continue;const t='/tmp/b'+i+'.js';require('fs').writeFileSync(t,c);try{cp.execSync('node --check '+t,{stdio:'pipe'})}catch(e){f++;console.log('script#'+i+' ERRO')}}console.log(f?'FAIL '+f:'ALL SCRIPTS OK')"`
Expected: `ALL SCRIPTS OK`

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(ao2b): combo unificado + modo revenda (tiragem/prazo/acabamentos + preview) no item"
```

---

## Task 6: Deploy VPS + smoke + memória

**Files:**
- Modify: `~/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Deploy**

```bash
rsync -az --exclude node_modules --exclude .git --exclude backups --exclude 'tests/fixtures/revenda' /Users/klebercamara/LKL/ root@2.25.147.243:/var/www/lkl-chatbot/
```

- [ ] **Step 2: Migration 045 (via postgres)**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -v ON_ERROR_STOP=1 -c \"ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS revenda_produto_id UUID REFERENCES revenda_produtos(id) ON DELETE SET NULL; ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS revenda_prazo_horas INTEGER; ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS revenda_acabamentos JSONB DEFAULT '[]'::jsonb;\""
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```
Expected: 3× `ALTER TABLE`, app `online`.

- [ ] **Step 3: Smoke — precificarItemRevenda com produto real**

```bash
ssh root@2.25.147.243 'cd /var/www/lkl-chatbot && node -e "
require(\"dotenv\").config();
const db=require(\"./src/db\"); const svc=require(\"./src/modules/revenda/service\");
(async()=>{
  await db.query(\"UPDATE revenda_config SET markup_percent=40 WHERE id=1\");
  const p=(await db.query(\"SELECT id,nome FROM revenda_produtos WHERE ref=\x27flt001\x27\")).rows[0];
  const r=await svc.precificarItemRevenda({revenda_produto_id:p.id, quantidade:1000, prazo_horas:24, acabamentos:[]});
  console.log(p.nome, JSON.stringify(r));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
"'
```
Expected: usa a faixa 2.500/24h (R$74,00) × 1,40 = **R$103,60**; `valor_total` ≈ 103.6, `faixa_usada` 2500.

- [ ] **Step 4: Atualizar memória**

Acrescentar ao `project_sprint_status.md`: AO-2b concluído — migration 045 (revenda_produto_id/prazo/acabamentos no item), pricer.js puro (faixa próxima-acima + acabamentos + markup, testes), precificarItemRevenda + POST /revenda/preview, integração POST/PATCH item (tipo REVENDA), UI combo unificado + modo revenda; smoke flt001 1000un/24h markup40 = R$103,60. AO-2 COMPLETO. Próxima migration livre: 046.

- [ ] **Step 5: Commit final**

```bash
git add -A
git commit -m "chore(ao2b): smoke VPS + registro do AO-2b na memoria (AO-2 completo)"
```

---

## Self-Review (autor do plano)

**Cobertura do spec:** combo unificado (Task 5) ✓; faixa próxima-acima/abaixo-mín/acima-máx (Task 2) ✓; preço (base+acab)×(1+markup) e valor_unitario=total/qtd (Task 2) ✓; prazo default+trocável (Tasks 3/5) ✓; migration campos revenda (Task 1) ✓; integração item + tipo REVENDA (Task 4) ✓; preview endpoint (Task 3) ✓; deploy+smoke+memória (Task 6) ✓.

**Consistência:** `calcularRevenda(ctx,opts)` e `precificarItemRevenda({revenda_produto_id,quantidade,prazo_horas,acabamentos})` idênticos em service/router/integração. Colunas `revenda_produto_id/revenda_prazo_horas/revenda_acabamentos` iguais na migration, INSERT/UPDATE e UI.

**Nota de execução:** só `tests/revenda-pricer.test.js` roda local (deve passar); integração/UI via smoke no VPS. A Task 4 mexe em handlers já modificados pelo AO-1 — o implementador deve LER os handlers atuais antes de editar e preservar a numeração dos parâmetros `$` do UPDATE.
