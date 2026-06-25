# Itens do chatbot estruturados (tipo/dimensões/material) + modal robusto + Voltar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o pedido do chatbot gravar tipo_producao, largura/altura e material_id por item; tornar o modal Editar Item tolerante a produto singular/plural e sempre extrair medidas; adicionar botão Voltar; e backfill do pedido #25.

**Architecture:** Novo módulo backend `src/constants/produtos.js` (lista canônica + helpers `matchProduto`/`tipoPorProduto`/`parseDimensoes`). `orders/service.js` passa a derivar tipo, parsear medidas e resolver material_id ao criar o pedido, persistindo em `orcamento_itens`. `ai/agent.js` passa `dimensoes`/`material` estruturados por item. `dashboard.html` ganha match singular/plural, parse de medidas para todos os tipos e botão Voltar. Backfill do #25 via SQL.

**Tech Stack:** Node/Express, PostgreSQL (pg), vanilla-JS, Jest.

**Decisões do usuário (2026-06-25):** (1) corrigir a persistência agora (chatbot grava material_id + dimensões); (2) extrair Largura/Altura da especificação para QUALQUER item quando houver medida (inclusive offset).

**Fatos verificados:**
- `orders/service.js`: `_normalizarItens` (linhas ~35-57) mantém só produto/tipo_producao/quantidade/especificacao/tem_arte; `criarOrder` insere em `orcamento_itens` (INSERT ~linha 119) sem largura/altura/material_id.
- `ai/agent.js` (~225-235): `itensBrutos` tem `{produto, dimensoes, quantidade, material, tem_arte}`; `itensDados` achata dimensoes+material em `especificacao` e NÃO envia campos estruturados.
- `orcamento_itens` já tem colunas `largura_cm`, `altura_cm`, `material_id`, `tipo_producao` (sem migration).
- `materiais` tem `nome`, `codigo`, `status` (ILIKE em `materiais/service.js:8`).
- Lista canônica de produtos (origem da verdade hoje só no front, `PRODUTOS_LKL` em `public/dashboard.html:3047-3077`). Reproduzir no backend.
- Modal: `abrirEditarItemOrc(orcId,itemId,descricao,qtd,valorUnit)` (`dashboard.html:1185`); chamado de `carregarItensPedidoEdit` (`dashboard.html:3179`) e de `renderOrcItens` (`dashboard.html:1172`). `editarPedido(id)` (`dashboard.html:3143`) chama `carregarItensPedidoEdit(o.orcamento_id, o.orcamento_status)` (linha 3164). `showModal`/`closeModal`/`api`/`showToast` disponíveis.
- Jest configurado; testes em `tests/` ou `*.test.js`. Rodar `npx jest <arquivo>`.
- Deploy backend: `rsync -az <arq> root@2.25.147.243:/var/www/lkl-chatbot/<destino>` + `pm2 restart lkl-chatbot --update-env`. Deploy painel: rsync do dashboard.html (sem restart). Smoke: `ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e '<js>'"`.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:**
- Create: `src/constants/produtos.js` — lista canônica + `matchProduto`, `tipoPorProduto`, `parseDimensoes`.
- Create: `tests/produtos.test.js` — testes dos helpers.
- Modify: `src/modules/orders/service.js` — derivar tipo, parsear medidas, resolver material, persistir.
- Modify: `src/ai/agent.js` — enviar `dimensoes`/`material` estruturados por item.
- Modify: `public/dashboard.html` — match singular/plural, parse sempre, botão Voltar.
- Backfill: SQL no VPS para o pedido #25.

---

### Task 1: Módulo backend `src/constants/produtos.js` (+ testes)

**Files:**
- Create: `src/constants/produtos.js`
- Test: `tests/produtos.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Criar `tests/produtos.test.js`:
```js
const { matchProduto, tipoPorProduto, parseDimensoes } = require('../src/constants/produtos');

describe('matchProduto', () => {
  test('exato case-insensitive', () => { expect(matchProduto('cartaz').produto).toBe('CARTAZ'); });
  test('singular -> plural (Banner -> BANNERS)', () => { expect(matchProduto('Banner').produto).toBe('BANNERS'); });
  test('plural -> singular (Adesivo -> ADESIVOS)', () => { expect(matchProduto('adesivo').produto).toBe('ADESIVOS'); });
  test('acentos ignorados (catalogo -> CATÁLOGO)', () => { expect(matchProduto('catalogo').produto).toBe('CATÁLOGO'); });
  test('sem correspondência', () => { expect(matchProduto('xyz')).toBeNull(); });
  test('vazio', () => { expect(matchProduto('')).toBeNull(); });
});

describe('tipoPorProduto', () => {
  test('Banner -> COMUNICAÇÃO VISUAL', () => { expect(tipoPorProduto('Banner')).toBe('COMUNICAÇÃO VISUAL'); });
  test('Cartaz -> OFFSET', () => { expect(tipoPorProduto('Cartaz')).toBe('OFFSET'); });
  test('desconhecido -> null', () => { expect(tipoPorProduto('xyz')).toBeNull(); });
});

describe('parseDimensoes', () => {
  test('metros', () => { expect(parseDimensoes('1,20 x 0,60 m')).toEqual({ largura_cm: 120, altura_cm: 60 }); });
  test('cm', () => { expect(parseDimensoes('200x100 cm')).toEqual({ largura_cm: 200, altura_cm: 100 }); });
  test('sem unidade', () => { expect(parseDimensoes('40X30')).toEqual({ largura_cm: 40, altura_cm: 30 }); });
  test('dentro de texto', () => { expect(parseDimensoes('40x30 cm · Couchê 90g')).toEqual({ largura_cm: 40, altura_cm: 30 }); });
  test('sem medida', () => { expect(parseDimensoes('Couchê 90g')).toBeNull(); });
  test('nulo', () => { expect(parseDimensoes(null)).toBeNull(); });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest tests/produtos.test.js`
Expected: FAIL (módulo não existe).

- [ ] **Step 3: Implementar o módulo**

Criar `src/constants/produtos.js`:
```js
const PRODUTOS = [
  { produto: 'ACRILICO',           tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'ADESIVOS',           tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'BANNERS',            tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'BLOCK LETTER',       tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'CARTAZ',             tipo: 'OFFSET' },
  { produto: 'CARTOES DE VISITA',  tipo: 'OFFSET' },
  { produto: 'CATÁLOGO',           tipo: 'OFFSET' },
  { produto: 'ENVELOPAMENTO',      tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'ENVELOPES',          tipo: 'OFFSET' },
  { produto: 'ETIQUETA ADESIVA',   tipo: 'OFFSET' },
  { produto: 'FOLDER',             tipo: 'OFFSET' },
  { produto: 'ILUMINAÇÃO',         tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'JORNAL',             tipo: 'OFFSET' },
  { produto: 'LÂMINAS',            tipo: 'OFFSET' },
  { produto: 'LETREIRO',           tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'LIVROS',             tipo: 'OFFSET' },
  { produto: 'NOTAS',              tipo: 'OFFSET' },
  { produto: 'PAINEL',             tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'PAINEL ACM',         tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'PEDIDOS',            tipo: 'OFFSET' },
  { produto: 'RECEITUÁRIOS',       tipo: 'OFFSET' },
  { produto: 'RECORTE ELETRÔNICO', tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'REVISTA',            tipo: 'OFFSET' },
  { produto: 'ROUTER',             tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'SINALIZAÇÃO',        tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'TAG',                tipo: 'OFFSET' },
  { produto: 'TIMBRADOS',          tipo: 'OFFSET' },
  { produto: 'WIND BANNER',        tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'OUTROS/OFFSET',      tipo: 'OFFSET' },
];

function _norm(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Z0-9 /]/g, '').trim();
}
function _singular(s) { return _norm(s).replace(/S$/, ''); }

function matchProduto(nome) {
  const n = _norm(nome);
  if (!n) return null;
  let hit = PRODUTOS.find(p => _norm(p.produto) === n);
  if (hit) return hit;
  const sg = _singular(nome);
  hit = PRODUTOS.find(p => _singular(p.produto) === sg);
  return hit || null;
}
function tipoPorProduto(nome) { const h = matchProduto(nome); return h ? h.tipo : null; }

function parseDimensoes(texto) {
  if (!texto) return null;
  const m = String(texto).match(/(\d+(?:[.,]\d+)?)\s*[x×X]\s*(\d+(?:[.,]\d+)?)\s*(m|cm|mm)?/i);
  if (!m) return null;
  const num = (s) => parseFloat(String(s).replace(',', '.'));
  let l = num(m[1]), a = num(m[2]);
  const unidade = (m[3] || '').toLowerCase();
  if (unidade === 'm') { l *= 100; a *= 100; }
  else if (unidade === 'mm') { l /= 10; a /= 10; }
  if (!(l > 0) || !(a > 0)) return null;
  return { largura_cm: Math.round(l * 100) / 100, altura_cm: Math.round(a * 100) / 100 };
}

module.exports = { PRODUTOS, matchProduto, tipoPorProduto, parseDimensoes };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx jest tests/produtos.test.js`
Expected: PASS (todos os testes verdes).

- [ ] **Step 5: Commit**

```bash
git add src/constants/produtos.js tests/produtos.test.js
git commit -m "feat(constants): produtos canônicos + matchProduto/tipoPorProduto/parseDimensoes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Persistir tipo/dimensões/material na criação do pedido (`orders/service.js`)

**Files:**
- Modify: `src/modules/orders/service.js`

- [ ] **Step 1: Importar helpers e adicionar resolvedor de material**

No topo de `src/modules/orders/service.js`, logo após os `require` existentes (procure a linha `const db = require(` ), adicionar:
```js
const { tipoPorProduto, parseDimensoes } = require('../../constants/produtos');

async function _resolverMaterialId(nome) {
  const termo = String(nome || '').trim();
  if (!termo) return null;
  try {
    const exato = await db.query('SELECT id FROM materiais WHERE status=$1 AND nome ILIKE $2 ORDER BY nome LIMIT 1', ['ativo', termo]);
    if (exato.rows[0]) return exato.rows[0].id;
    const parcial = await db.query('SELECT id FROM materiais WHERE status=$1 AND nome ILIKE $2 ORDER BY nome LIMIT 1', ['ativo', `%${termo}%`]);
    return parcial.rows[0] ? parcial.rows[0].id : null;
  } catch (e) { return null; }
}
```

- [ ] **Step 2: Estender `_normalizarItens` para carregar dimensoes/material brutos**

Substituir a função `_normalizarItens` inteira por:
```js
function _normalizarItens(dados) {
  let itens = Array.isArray(dados.itens) ? dados.itens : [];
  itens = itens
    .map(it => ({
      produto: (it.produto || '').trim(),
      tipo_producao: it.tipo_producao || null,
      quantidade: parseInt(it.quantidade) || 1,
      especificacao: (it.especificacao || '').trim() || null,
      tem_arte: !!it.tem_arte,
      dimensoes: it.dimensoes || null,
      material: it.material || null,
      largura_cm: it.largura_cm != null ? it.largura_cm : null,
      altura_cm: it.altura_cm != null ? it.altura_cm : null,
      material_id: it.material_id || null,
    }))
    .filter(it => it.produto);
  if (!itens.length && dados.produto) {
    itens = [{
      produto: dados.produto,
      tipo_producao: dados.tipo_producao || null,
      quantidade: parseInt(dados.quantidade) || 1,
      especificacao: null,
      tem_arte: dados.tem_arte || false,
      dimensoes: dados.dimensoes || null,
      material: dados.material || null,
      largura_cm: null,
      altura_cm: null,
      material_id: null,
    }];
  }
  return itens;
}
```

- [ ] **Step 3: Enriquecer os itens (tipo + dimensões + material_id) antes de inserir no orçamento**

Em `criarOrder`, localize o bloco que insere em `orcamento_itens` dentro do `try` do auto-orçamento:
```js
    let codigo = 1;
    for (const it of itens) {
      const descricao = it.especificacao ? `${it.produto} — ${it.especificacao}` : it.produto;
      await db.query(
        `INSERT INTO orcamento_itens (orcamento_id, codigo, produto, especificacao, descricao, quantidade, valor_unitario, valor_total, tem_arte, tipo_producao)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7, $8)`,
        [orcamentoId, codigo++, it.produto, it.especificacao || null, descricao, it.quantidade, it.tem_arte || false, it.tipo_producao || null]
      );
    }
```
Substituir por:
```js
    let codigo = 1;
    for (const it of itens) {
      const descricao = it.especificacao ? `${it.produto} — ${it.especificacao}` : it.produto;
      const tipo = it.tipo_producao || tipoPorProduto(it.produto);
      let larg = it.largura_cm, alt = it.altura_cm;
      if (larg == null && alt == null) {
        const dim = parseDimensoes(it.dimensoes || it.especificacao);
        if (dim) { larg = dim.largura_cm; alt = dim.altura_cm; }
      }
      let materialId = it.material_id;
      if (!materialId && it.material) materialId = await _resolverMaterialId(it.material);
      await db.query(
        `INSERT INTO orcamento_itens (orcamento_id, codigo, produto, especificacao, descricao, quantidade, valor_unitario, valor_total, tem_arte, tipo_producao, largura_cm, altura_cm, material_id)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7, $8, $9, $10, $11)`,
        [orcamentoId, codigo++, it.produto, it.especificacao || null, descricao, it.quantidade, it.tem_arte || false, tipo || null, larg != null ? larg : null, alt != null ? alt : null, materialId || null]
      );
    }
```

- [ ] **Step 4: Verificar sintaxe**

Run: `node --check src/modules/orders/service.js`
Expected: sem saída (exit 0).

- [ ] **Step 5: Smoke local do enriquecimento (sem banco)**

Run:
```bash
node -e "const {tipoPorProduto,parseDimensoes}=require('./src/constants/produtos'); console.log(tipoPorProduto('Banner'), JSON.stringify(parseDimensoes('1,20 x 0,60 m')), tipoPorProduto('Cartaz'), JSON.stringify(parseDimensoes('40x30 cm · Couchê 90g')));"
```
Expected: `COMUNICAÇÃO VISUAL {"largura_cm":120,"altura_cm":60} OFFSET {"largura_cm":40,"altura_cm":30}`

- [ ] **Step 6: Commit**

```bash
git add src/modules/orders/service.js
git commit -m "feat(orders): derivar tipo, parsear medidas e resolver material_id ao criar pedido

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Agente envia dimensões/material estruturados (`ai/agent.js`)

**Files:**
- Modify: `src/ai/agent.js`

- [ ] **Step 1: Encaminhar campos estruturados por item**

Em `src/ai/agent.js`, localize:
```js
        const itensDados = itensBrutos.map(it => ({
          produto: (it.produto || args.tipo_servico || 'Pedido via chatbot'),
          quantidade: parseInt(it.quantidade) || 1,
          especificacao: [it.dimensoes, it.material].filter(Boolean).join(' · ') || null,
          tem_arte: !!it.tem_arte,
        }));
```
Substituir por:
```js
        const itensDados = itensBrutos.map(it => ({
          produto: (it.produto || args.tipo_servico || 'Pedido via chatbot'),
          quantidade: parseInt(it.quantidade) || 1,
          especificacao: [it.dimensoes, it.material].filter(Boolean).join(' · ') || null,
          tem_arte: !!it.tem_arte,
          dimensoes: it.dimensoes || null,
          material: it.material || null,
        }));
```
(Mantém a `especificacao` legível e passa os campos crus para o `orders/service` estruturar.)

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check src/ai/agent.js`
Expected: sem saída (exit 0).

- [ ] **Step 3: Commit**

```bash
git add src/ai/agent.js
git commit -m "feat(chatbot): enviar dimensoes/material estruturados por item ao criar pedido

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Modal — match singular/plural, parse sempre, botão Voltar (`dashboard.html`)

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Tornar o match de produto tolerante (singular/plural/acentos)**

Em `public/dashboard.html`, dentro de `abrirEditarItemOrc`, no bloco que casa o produto pelo detalhe, localize:
```js
      // Produto: casar item.produto contra as opções sem diferença de maiúsculas
      if (sel && item.produto) {
        const alvo = String(item.produto).toUpperCase();
        const opt = [...sel.options].find(o => String(o.value).toUpperCase() === alvo);
        if (opt) sel.value = opt.value;
      }
```
Substituir por:
```js
      // Produto: casar item.produto contra as opções (exato; senão singular/plural sem acento)
      if (sel && item.produto) {
        const norm = (s) => String(s||'').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Z0-9 /]/g,'').trim();
        const sing = (s) => norm(s).replace(/S$/,'');
        const alvo = norm(item.produto), alvoSg = sing(item.produto);
        let opt = [...sel.options].find(o => norm(o.value) === alvo);
        if (!opt) opt = [...sel.options].find(o => sing(o.value) === alvoSg);
        if (opt) sel.value = opt.value;
      }
```

- [ ] **Step 2: Parsear medidas para QUALQUER item (não só CV)**

Ainda em `abrirEditarItemOrc`, localize o bloco do auto-parse gated por CV:
```js
      const ehCV = (tipoEl && tipoEl.value === 'COMUNICAÇÃO VISUAL');
      if (ehCV && item.largura_cm == null && item.altura_cm == null) {
        const dim = parseDimensoes(item.especificacao || especGuess);
        if (dim) { if (largEl) largEl.value = dim.largura_cm; if (altEl) altEl.value = dim.altura_cm; }
      }
```
Substituir por:
```js
      if (item.largura_cm == null && item.altura_cm == null) {
        const dim = parseDimensoes(item.especificacao || especGuess);
        if (dim) { if (largEl) largEl.value = dim.largura_cm; if (altEl) altEl.value = dim.altura_cm; }
      }
```

- [ ] **Step 3: Aceitar `voltarOrderId` em `abrirEditarItemOrc` e renderizar o botão Voltar**

Alterar a assinatura e o início de `abrirEditarItemOrc`. Localize a linha:
```js
async function abrirEditarItemOrc(orcId, itemId, descricao, qtd, valorUnit) {
```
Substituir por:
```js
async function abrirEditarItemOrc(orcId, itemId, descricao, qtd, valorUnit, voltarOrderId) {
```
Em seguida, no template `html`, logo no início (antes de `<div style="margin-bottom:10px">${selectProduto(...)`), inserir o botão condicional:
```js
    ${voltarOrderId ? `<button type="button" onclick="editarPedido('${voltarOrderId}')" class="btn btn-outline" style="margin-bottom:10px;padding:5px 12px;font-size:12px">← Voltar ao pedido</button>` : ''}
```

- [ ] **Step 4: Passar o orderId desde `editarPedido` → `carregarItensPedidoEdit` → botão de editar item**

Localize em `editarPedido`:
```js
  showModal('Editar Pedido', html);
  carregarItensPedidoEdit(o.orcamento_id, o.orcamento_status);
```
Substituir por:
```js
  showModal('Editar Pedido', html);
  carregarItensPedidoEdit(o.orcamento_id, o.orcamento_status, o.id);
```
Localize a assinatura:
```js
async function carregarItensPedidoEdit(orcId, orcStatus) {
```
Substituir por:
```js
async function carregarItensPedidoEdit(orcId, orcStatus, orderId) {
```
Localize o botão de editar item dentro do `itens.map` desta função:
```js
      <button onclick="abrirEditarItemOrc('${orcId}','${it.id}','${escHtml(it.descricao||'').replace(/'/g,"\\'")}',${it.quantidade},${it.valor_unitario||0})" style="background:none;border:none;cursor:pointer;font-size:15px">✏️</button>
```
Substituir por (acrescenta o 6º argumento `orderId`):
```js
      <button onclick="abrirEditarItemOrc('${orcId}','${it.id}','${escHtml(it.descricao||'').replace(/'/g,"\\'")}',${it.quantidade},${it.valor_unitario||0},'${orderId||''}')" style="background:none;border:none;cursor:pointer;font-size:15px">✏️</button>
```
(O outro chamador, em `renderOrcItens` ~linha 1172, NÃO recebe o 6º arg → sem botão Voltar lá, correto.)

- [ ] **Step 5: Sanidade**

```bash
cd /Users/klebercamara/LKL
grep -c "voltarOrderId\|← Voltar ao pedido" public/dashboard.html
grep -c "carregarItensPedidoEdit(o.orcamento_id, o.orcamento_status, o.id)" public/dashboard.html
grep -c "sing(o.value) === alvoSg" public/dashboard.html
```
Expected: primeira ≥ 3; segunda = 1; terceira = 1. Conferir que o `renderOrcItens` (linha ~1172) continua chamando `abrirEditarItemOrc` SEM o 6º argumento.

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "fix(ui): Editar Item — match produto singular/plural, parse de medidas sempre, botão Voltar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Deploy + backfill #25 + smoke E2E + memória

**Files:**
- Deploy: `src/constants/produtos.js`, `src/modules/orders/service.js`, `src/ai/agent.js`, `public/dashboard.html`
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Deploy**

```bash
cd /Users/klebercamara/LKL
ssh root@2.25.147.243 "mkdir -p /var/www/lkl-chatbot/src/constants"
rsync -az src/constants/produtos.js root@2.25.147.243:/var/www/lkl-chatbot/src/constants/produtos.js
rsync -az src/modules/orders/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orders/service.js
rsync -az src/ai/agent.js root@2.25.147.243:/var/www/lkl-chatbot/src/ai/agent.js
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && sleep 2 && pm2 jlist | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const a=JSON.parse(d);const p=a.find(x=>x.name===\"lkl-chatbot\");console.log(\"status:\",p?.pm2_env?.status)})'"
```
Expected: `status: online`.

- [ ] **Step 2: Backfill do pedido #25 (derivar tipo + medidas; material best-effort)**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e '
const db = require(\"./src/db/index\");
const { tipoPorProduto, parseDimensoes } = require(\"./src/constants/produtos\");
(async () => {
  const r = await db.query(\"SELECT oi.id, oi.produto, oi.especificacao FROM orcamento_itens oi JOIN orcamentos o ON o.id=oi.orcamento_id JOIN orders od ON od.orcamento_id=o.id WHERE od.numero_os=25\");
  for (const it of r.rows) {
    const tipo = tipoPorProduto(it.produto);
    const dim = parseDimensoes(it.especificacao);
    await db.query(\"UPDATE orcamento_itens SET tipo_producao=COALESCE(\$1,tipo_producao), largura_cm=COALESCE(\$2,largura_cm), altura_cm=COALESCE(\$3,altura_cm) WHERE id=\$4\",
      [tipo, dim?dim.largura_cm:null, dim?dim.altura_cm:null, it.id]);
    console.log(it.produto, \"->\", tipo, JSON.stringify(dim));
  }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
'"
```
Expected: imprime `Cartaz -> OFFSET {"largura_cm":40,"altura_cm":30}` e `Banner -> COMUNICAÇÃO VISUAL {"largura_cm":120,"altura_cm":60}`.

- [ ] **Step 3: Conferência visual no painel (pedido #25)**

No painel → Pedidos → Editar Pedido #25:
- Editar Item do **Banner**: Produto = "BANNERS", Tipo = "COMUNICAÇÃO VISUAL", Largura 120 / Altura 60. Botão "← Voltar ao pedido" presente e retorna ao Editar Pedido.
- Editar Item do **Cartaz**: Produto = "CARTAZ", Tipo = "OFFSET", Largura 40 / Altura 30.
- Material: ainda manual nesses itens antigos (texto não estruturado no #25) — anotar. Em pedidos NOVOS do chatbot, material_id é resolvido na criação.
- Sem erros no console. Reportar cada item.

- [ ] **Step 4: Atualizar memória**

Em `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`, acrescentar:
"Chatbot itens estruturados — CONCLUÍDO 2026-06-25. Novo src/constants/produtos.js (lista canônica + matchProduto singular/plural/sem-acento + tipoPorProduto + parseDimensoes); orders/service.js deriva tipo_producao, parseia largura/altura (de dimensoes||especificacao) e resolve material_id (materiais.nome ILIKE) ao criar pedido, gravando em orcamento_itens; ai/agent.js envia dimensoes/material estruturados por item. dashboard.html Editar Item: match produto singular/plural, parse de medidas para qualquer tipo, botão '← Voltar ao pedido' (6º arg voltarOrderId passado só pelo Editar Pedido). Backfill do #25 (tipo+medidas). Limitação: material de pedidos ANTIGOS não estruturado fica manual. Lista canônica duplicada entre front (PRODUTOS_LKL) e back (produtos.js)."

- [ ] **Step 5: Sem commit de memória** (fora do git).

---

## Notas de verificação final

- `parseDimensoes` é idêntica entre `src/constants/produtos.js` e o `dashboard.html` (já existente). Não divergir a lógica.
- A lista canônica fica duplicada (front `PRODUTOS_LKL` vs back `produtos.js`). Se um dia mudar produtos, atualizar os dois. (Fora de escopo unificar agora.)
- Resolução de material por nome é best-effort (exato ILIKE → parcial). Pode não achar material para textos como "Couchê 90g" se não houver cadastro correspondente — nesse caso material_id fica null e o atendente seleciona.
- O 6º argumento `voltarOrderId` só é passado pelo Editar Pedido; o caminho da aba Orçamentos (`renderOrcItens`) continua sem botão Voltar — confirmar que não foi alterado.
- Reverter é `git revert` do commit correspondente; o backfill do #25 é idempotente (COALESCE) e não destrói dados.
