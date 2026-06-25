# Entrada de pedido — arte por item + pré-preenchimento do Editar Item — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir editar "tem arte" por item na tela Editar Pedido e pré-preencher corretamente Produto/Tipo/Comunicação Visual/arte no modal Editar Item, melhorando os pedidos vindos do chatbot.

**Architecture:** Uma adição mínima no backend (`orcamentos/router.js`) para aceitar `tem_arte` no POST/PATCH de item; o restante é só `public/dashboard.html` (função pura `parseDimensoes`, correção do `abrirEditarItemOrc`/`salvarItemOrc`, chip de arte em `carregarItensPedidoEdit`). Sem migration — a coluna `tem_arte` já existe e `SELECT *` já a retorna.

**Tech Stack:** Node/Express + PostgreSQL (backend), HTML/vanilla-JS (painel). Verificação: `node --check`, sanity script Node para a função pura, smoke E2E no VPS, conferência visual.

**Fatos verificados:**
- Backend item POST/PATCH em `src/modules/orcamentos/router.js:370–414`; hoje **não** tratam `tem_arte`.
- `buscarPorId` faz `SELECT * FROM orcamento_itens` → item já traz `tem_arte`, `produto`, `tipo_producao`, `largura_cm`, `altura_cm`, `material_id`.
- Modal Editar Item: `abrirEditarItemOrc` (`public/dashboard.html:1185`), `salvarItemOrc` (1227), `_popularMateriaisSelect` (1249). `tipoPorProduto`/`selectProduto`/`campoTipoProd`/`PRODUTOS_LKL` em `public/dashboard.html:3036–3073`.
- Lista de itens do Editar Pedido: `carregarItensPedidoEdit` (`public/dashboard.html:3167`); variável `travado` já controla bloqueio.
- Deploy backend: `rsync -az src/modules/orcamentos/router.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/router.js` + `ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"`.
- Deploy painel: `rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html` (sem restart).
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:**
- `src/modules/orcamentos/router.js` — aceitar `tem_arte` no item (POST + PATCH).
- `public/dashboard.html` — `parseDimensoes`, `setArteEi`, `_arteChip`, `toggleArteItem`; ajustes em `abrirEditarItemOrc`, `salvarItemOrc`, `carregarItensPedidoEdit`.

---

### Task 1: Backend — aceitar `tem_arte` no POST e PATCH de item

**Files:**
- Modify: `src/modules/orcamentos/router.js:370-414`

- [ ] **Step 1: Adicionar `tem_arte` ao POST `/:id/itens`**

No handler `router.post('/:id/itens', ...)`, trocar o bloco de destructuring + INSERT.

Trocar:
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
Por:
```js
    const { produto, tipo_producao, especificacao, quantidade, valor_unitario, valor_total,
            largura_cm, altura_cm, material_id, tem_arte } = req.body;
    let { descricao } = req.body;
    if (produto) descricao = especificacao ? `${produto} — ${especificacao}` : produto;
    if (!descricao || !quantidade) return res.status(400).json({ erro: ['produto/descrição e quantidade são obrigatórios'] });
    const cod = await db.query('SELECT COALESCE(MAX(codigo),0)+1 AS c FROM orcamento_itens WHERE orcamento_id=$1', [req.params.id]);
    const { rows } = await db.query(
      `INSERT INTO orcamento_itens (orcamento_id, codigo, produto, especificacao, descricao, tipo_producao, quantidade, valor_unitario, valor_total, largura_cm, altura_cm, material_id, tem_arte)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.params.id, cod.rows[0].c, produto || null, especificacao || null, descricao, tipo_producao || null,
       quantidade, valor_unitario || 0, valor_total || 0,
       largura_cm || null, altura_cm || null, material_id || null, !!tem_arte]
    );
```

- [ ] **Step 2: Adicionar `tem_arte` ao PATCH `/:id/itens/:itemId`**

No handler `router.patch('/:id/itens/:itemId', ...)`, trocar o bloco de destructuring + UPDATE.

Trocar:
```js
    const { produto, tipo_producao, especificacao, quantidade, valor_unitario, valor_total,
            largura_cm, altura_cm, material_id } = req.body;
    let { descricao } = req.body;
    if (produto !== undefined) descricao = especificacao ? `${produto} — ${especificacao}` : produto;
    const { rows } = await db.query(
      `UPDATE orcamento_itens SET
         produto=COALESCE($1,produto), especificacao=COALESCE($2,especificacao),
         descricao=COALESCE($3,descricao), tipo_producao=COALESCE($4,tipo_producao),
         quantidade=COALESCE($5,quantidade), valor_unitario=COALESCE($6,valor_unitario), valor_total=COALESCE($7,valor_total),
         largura_cm=COALESCE($8,largura_cm), altura_cm=COALESCE($9,altura_cm), material_id=COALESCE($10,material_id)
       WHERE id=$11 AND orcamento_id=$12 RETURNING *`,
      [produto ?? null, especificacao ?? null, descricao ?? null, tipo_producao ?? null,
       quantidade ?? null, valor_unitario ?? null, valor_total ?? null,
       largura_cm ?? null, altura_cm ?? null, material_id ?? null,
       req.params.itemId, req.params.id]
    );
```
Por:
```js
    const { produto, tipo_producao, especificacao, quantidade, valor_unitario, valor_total,
            largura_cm, altura_cm, material_id, tem_arte } = req.body;
    let { descricao } = req.body;
    if (produto !== undefined) descricao = especificacao ? `${produto} — ${especificacao}` : produto;
    const { rows } = await db.query(
      `UPDATE orcamento_itens SET
         produto=COALESCE($1,produto), especificacao=COALESCE($2,especificacao),
         descricao=COALESCE($3,descricao), tipo_producao=COALESCE($4,tipo_producao),
         quantidade=COALESCE($5,quantidade), valor_unitario=COALESCE($6,valor_unitario), valor_total=COALESCE($7,valor_total),
         largura_cm=COALESCE($8,largura_cm), altura_cm=COALESCE($9,altura_cm), material_id=COALESCE($10,material_id),
         tem_arte=COALESCE($11,tem_arte)
       WHERE id=$12 AND orcamento_id=$13 RETURNING *`,
      [produto ?? null, especificacao ?? null, descricao ?? null, tipo_producao ?? null,
       quantidade ?? null, valor_unitario ?? null, valor_total ?? null,
       largura_cm ?? null, altura_cm ?? null, material_id ?? null,
       (tem_arte === undefined ? null : !!tem_arte),
       req.params.itemId, req.params.id]
    );
```
Observação: `tem_arte` ausente → `null` → COALESCE preserva; presente (true/false) → grava o booleano. Os índices `$12`/`$13` foram renumerados (antes eram `$11`/`$12`).

- [ ] **Step 3: Verificar sintaxe**

Run: `node --check src/modules/orcamentos/router.js`
Expected: sem saída (exit 0). Se acusar erro, revisar a numeração dos parâmetros.

- [ ] **Step 4: Commit**

```bash
git add src/modules/orcamentos/router.js
git commit -m "feat(orcamentos): aceitar tem_arte no POST/PATCH de item

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Função pura `parseDimensoes` (+ sanity test)

**Files:**
- Modify: `public/dashboard.html` (inserir após `tipoPorProduto`, ~linha 3054)
- Temp test: `tmp_parsedim_test.js` (criar, rodar, apagar)

- [ ] **Step 1: Escrever o sanity test que falha**

Criar `tmp_parsedim_test.js` com a função e as asserções:
```js
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
const assert = require('assert');
assert.deepStrictEqual(parseDimensoes('1,20 x 0,60 m'), { largura_cm: 120, altura_cm: 60 });
assert.deepStrictEqual(parseDimensoes('200x100 cm'), { largura_cm: 200, altura_cm: 100 });
assert.deepStrictEqual(parseDimensoes('40X30'), { largura_cm: 40, altura_cm: 30 });
assert.deepStrictEqual(parseDimensoes('1.5 × 2 m'), { largura_cm: 150, altura_cm: 200 });
assert.strictEqual(parseDimensoes('COUCHÊ 90G'), null);
assert.strictEqual(parseDimensoes(''), null);
assert.strictEqual(parseDimensoes(null), null);
console.log('OK parseDimensoes');
```

- [ ] **Step 2: Rodar o sanity test**

Run: `node tmp_parsedim_test.js`
Expected: imprime `OK parseDimensoes` (exit 0). Se algum assert falhar, corrigir a regex/lógica em `tmp_parsedim_test.js` e rodar de novo até passar.

- [ ] **Step 3: Inserir a função idêntica no dashboard.html**

Logo após a função `tipoPorProduto` (que termina em `}` na ~linha 3054 de `public/dashboard.html`), inserir:
```js
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
```

- [ ] **Step 4: Apagar o temp test e confirmar presença**

```bash
rm tmp_parsedim_test.js
grep -c "function parseDimensoes" public/dashboard.html
```
Expected: `1`.

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(ui): helper parseDimensoes para Comunicação Visual

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Editar Item — pré-preencher Produto/Tipo + CV + toggle arte

**Files:**
- Modify: `public/dashboard.html` — `abrirEditarItemOrc` (1185–1225), `salvarItemOrc` (1227–1247)

- [ ] **Step 1: Adicionar o helper `setArteEi` (perto de `parseDimensoes`)**

Após a função `parseDimensoes` inserida na Task 2, adicionar:
```js
function setArteEi(val) {
  const h = document.getElementById('ei-arte'); if (h) h.value = val ? 'true' : 'false';
  const sim = document.getElementById('ei-arte-sim'), nao = document.getElementById('ei-arte-nao');
  if (sim) sim.className = 'btn ' + (val ? 'btn-primary' : 'btn-outline');
  if (nao) nao.className = 'btn ' + (val ? 'btn-outline' : 'btn-primary');
}
```

- [ ] **Step 2: Inserir o bloco "tem arte" no HTML do modal**

Em `abrirEditarItemOrc`, dentro do template `html`, logo ANTES do botão de salvar (a linha `<button onclick="salvarItemOrc(...)" ...>`), inserir:
```js
    <div style="margin-bottom:10px">
      <label style="font-size:11px;font-weight:600;text-transform:uppercase;color:#555;display:block;margin-bottom:4px">CLIENTE TEM A ARTE?</label>
      <input type="hidden" id="ei-arte" value="false">
      <div style="display:flex;gap:6px">
        <button type="button" id="ei-arte-sim" onclick="setArteEi(true)" class="btn btn-outline" style="flex:1;padding:6px">Sim</button>
        <button type="button" id="ei-arte-nao" onclick="setArteEi(false)" class="btn btn-primary" style="flex:1;padding:6px">Não</button>
      </div>
    </div>
```
(Default visual = "Não" destacado; será ajustado ao carregar o item.)

- [ ] **Step 3: Substituir o pré-preenchimento (produto/tipo/CV/arte)**

Em `abrirEditarItemOrc`, trocar o bloco que vai de `const sel = document.getElementById('ei-produto');` até o fim do `catch`:

Trocar:
```js
  const sel = document.getElementById('ei-produto');
  if (sel && [...sel.options].some(o => o.value === prodGuess)) { sel.value = prodGuess; document.getElementById('ei-tipo').value = tipoPorProduto(prodGuess); }
  // Pre-fill largura/altura/material from the full orçamento detail
  try {
    const detail = await api(`/api/v2/orcamentos/${orcId}`);
    const item = (detail?.itens || []).find(i => String(i.id) === String(itemId));
    if (item) {
      if (item.largura_cm != null) { const el = document.getElementById('ei-larg'); if (el) el.value = item.largura_cm; }
      if (item.altura_cm != null)  { const el = document.getElementById('ei-alt');  if (el) el.value = item.altura_cm; }
      await _popularMateriaisSelect('ei-mat', item.material_id);
    } else { await _popularMateriaisSelect('ei-mat', null); }
  } catch(e) { _popularMateriaisSelect('ei-mat', null); }
}
```
Por:
```js
  const sel = document.getElementById('ei-produto');
  const tipoEl = document.getElementById('ei-tipo');
  // Fallback inicial pelo palpite da string (caso o detalhe não carregue)
  if (sel && [...sel.options].some(o => o.value === prodGuess)) { sel.value = prodGuess; if (tipoEl) tipoEl.value = tipoPorProduto(prodGuess); }
  try {
    const detail = await api(`/api/v2/orcamentos/${orcId}`);
    const item = (detail?.itens || []).find(i => String(i.id) === String(itemId));
    if (item) {
      // Produto: casar item.produto contra as opções sem diferença de maiúsculas
      if (sel && item.produto) {
        const alvo = String(item.produto).toUpperCase();
        const opt = [...sel.options].find(o => String(o.value).toUpperCase() === alvo);
        if (opt) sel.value = opt.value;
      }
      // Tipo de produção: do item, ou derivado do produto selecionado
      if (tipoEl) tipoEl.value = item.tipo_producao || tipoPorProduto(sel ? sel.value : '') || '';
      // Comunicação Visual: usa o salvo; se vazio e for CV, tenta extrair da especificação
      const largEl = document.getElementById('ei-larg');
      const altEl  = document.getElementById('ei-alt');
      if (item.largura_cm != null && largEl) largEl.value = item.largura_cm;
      if (item.altura_cm != null && altEl)  altEl.value = item.altura_cm;
      const ehCV = (tipoEl && tipoEl.value === 'COMUNICAÇÃO VISUAL');
      if (ehCV && item.largura_cm == null && item.altura_cm == null) {
        const dim = parseDimensoes(item.especificacao || especGuess);
        if (dim) { if (largEl) largEl.value = dim.largura_cm; if (altEl) altEl.value = dim.altura_cm; }
      }
      setArteEi(!!item.tem_arte);
      await _popularMateriaisSelect('ei-mat', item.material_id);
    } else { await _popularMateriaisSelect('ei-mat', null); }
  } catch(e) { _popularMateriaisSelect('ei-mat', null); }
}
```

- [ ] **Step 4: Incluir `tem_arte` no PATCH de `salvarItemOrc`**

Em `salvarItemOrc`, no objeto enviado no `body: JSON.stringify({ ... })`, acrescentar `tem_arte`.

Trocar:
```js
      largura_cm: document.getElementById('ei-larg')?.value ? parseFloat(document.getElementById('ei-larg').value) : null,
      altura_cm: document.getElementById('ei-alt')?.value ? parseFloat(document.getElementById('ei-alt').value) : null,
      material_id: document.getElementById('ei-mat')?.value || null })
```
Por:
```js
      largura_cm: document.getElementById('ei-larg')?.value ? parseFloat(document.getElementById('ei-larg').value) : null,
      altura_cm: document.getElementById('ei-alt')?.value ? parseFloat(document.getElementById('ei-alt').value) : null,
      material_id: document.getElementById('ei-mat')?.value || null,
      tem_arte: document.getElementById('ei-arte')?.value === 'true' })
```

- [ ] **Step 5: Sanidade**

```bash
grep -c "setArteEi\|ei-arte\|parseDimensoes(item.especificacao" public/dashboard.html
grep -c "tem_arte: document.getElementById('ei-arte')" public/dashboard.html
```
Expected: primeira ≥ 4; segunda = 1.

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "fix(ui): Editar Item pré-preenche produto/tipo/CV + toggle de arte

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Editar Pedido — chip "Arte" por item

**Files:**
- Modify: `public/dashboard.html` — `carregarItensPedidoEdit` (3167–3185); helpers novos perto dela

- [ ] **Step 1: Adicionar helpers `_arteChip` e `toggleArteItem`**

Imediatamente ANTES de `async function carregarItensPedidoEdit(orcId, orcStatus) {` (~linha 3167), inserir:
```js
function _arteChip(orcId, itemId, val, travado) {
  const cor = val ? '#16a34a' : '#9ca3af';
  const txt = 'Arte: ' + (val ? 'Sim' : 'Não');
  const handler = travado ? '' : `onclick="toggleArteItem('${orcId}','${itemId}',${!val},this)"`;
  const cursor = travado ? 'default' : 'pointer';
  return `<span id="arte-chip-${itemId}" ${handler} style="background:${cor};color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;cursor:${cursor}">${txt}</span>`;
}
async function toggleArteItem(orcId, itemId, novoValor, el) {
  const res = await api(`/api/v2/orcamentos/${orcId}/itens/${itemId}`, { method: 'PATCH', body: JSON.stringify({ tem_arte: novoValor }) });
  if (res && !res.erro) {
    el.outerHTML = _arteChip(orcId, itemId, novoValor, false);
    showToast(novoValor ? '🎨 Cliente tem a arte' : '🎨 Sem arte');
  } else { showToast('❌ Erro ao salvar arte'); }
}
```

- [ ] **Step 2: Inserir o chip na linha do item**

Em `carregarItensPedidoEdit`, no `itens.map(it => ...)`, acrescentar o chip após o `<span>` da quantidade.

Trocar:
```js
  const linhas = itens.map(it => `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #f3f3f3">
      <span style="flex:1">${escHtml(it.descricao||it.produto||'—')}</span>
      <span style="color:#666">${it.quantidade}</span>
      ${travado ? '' : `
```
Por:
```js
  const linhas = itens.map(it => `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #f3f3f3">
      <span style="flex:1">${escHtml(it.descricao||it.produto||'—')}</span>
      ${_arteChip(orcId, it.id, !!it.tem_arte, travado)}
      <span style="color:#666">${it.quantidade}</span>
      ${travado ? '' : `
```

- [ ] **Step 3: Sanidade**

```bash
grep -c "function _arteChip\|async function toggleArteItem\|_arteChip(orcId, it.id" public/dashboard.html
```
Expected: `3`.

- [ ] **Step 4: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(ui): chip de arte editável por item no Editar Pedido

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Deploy + smoke E2E + memória

**Files:**
- Deploy: `src/modules/orcamentos/router.js`, `public/dashboard.html`
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Deploy backend + painel**

```bash
rsync -az src/modules/orcamentos/router.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/router.js
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```
Expected: pm2 mostra `lkl-chatbot` online (status `online`, sem loop de restart).

- [ ] **Step 2: Smoke E2E — PATCH `tem_arte` e GET confirmando**

Escolher um orçamento com item (ex.: o do pedido #25). Rodar no VPS:
```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e '
const db = require(\"./src/db/index\");
(async () => {
  const it = await db.query(\"SELECT id, orcamento_id, tem_arte FROM orcamento_itens ORDER BY id DESC LIMIT 1\");
  const row = it.rows[0]; if (!row) { console.log(\"sem itens\"); process.exit(0); }
  const novo = !row.tem_arte;
  await db.query(\"UPDATE orcamento_itens SET tem_arte=\$1 WHERE id=\$2\", [novo, row.id]);
  const chk = await db.query(\"SELECT tem_arte FROM orcamento_itens WHERE id=\$1\", [row.id]);
  console.log(\"item\", row.id, \"antes\", row.tem_arte, \"depois\", chk.rows[0].tem_arte);
  await db.query(\"UPDATE orcamento_itens SET tem_arte=\$1 WHERE id=\$2\", [row.tem_arte, row.id]);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
'"
```
Expected: imprime `item <id> antes <bool> depois <bool-invertido>` (confirma que a coluna grava e lê). Restaura o valor original ao final.

- [ ] **Step 3: Conferência visual no painel (pedido do chatbot #25)**

No painel (Pedidos → Editar Pedido #25):
- Lista de itens: cada item mostra o chip "Arte: Sim/Não"; clicar alterna a cor/rótulo e um toast confirma; reabrir o modal mantém o valor.
- Editar Item do Cartaz: Produto = "CARTAZ" e Tipo = "OFFSET" pré-selecionados; Largura/Altura **vazios** (não confunde "40X30 CM").
- Editar Item do Banner (CV): Largura ≈ 120 / Altura ≈ 60 pré-preenchidos; toggle de arte reflete o valor salvo.
- Salvar um item e confirmar o toast "✅ Item atualizado", sem erro no console.

Reportar o resultado de cada checagem.

- [ ] **Step 4: Atualizar memória**

Em `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`, registrar:
"UI/entrada de pedido — arte por item + pré-preenchimento do Editar Item: CONCLUÍDO — 2026-06-25. Backend orcamentos/router.js: POST/PATCH de item aceitam tem_arte (COALESCE no PATCH). dashboard.html: parseDimensoes (m/cm/mm→cm) gateado por tipo CV; abrirEditarItemOrc casa produto case-insensitive + deriva tipo + auto-parse CV + toggle arte (setArteEi/ei-arte) salvo em salvarItemOrc; carregarItensPedidoEdit mostra chip 'Arte: Sim/Não' editável (_arteChip/toggleArteItem), só-leitura quando travado. Sem migration (coluna tem_arte já existia). Chatbot não mudou."

- [ ] **Step 5: Sem commit de memória** (fora do git).

---

## Notas de verificação final

- Após Task 1, `node --check src/modules/orcamentos/router.js` deve passar e a numeração de parâmetros do PATCH deve ir até `$13`.
- `parseDimensoes` é idêntica entre o sanity test e o `dashboard.html` (copiar, não reescrever).
- O auto-parse de CV só roda quando `tipoEl.value === 'COMUNICAÇÃO VISUAL'` e o item não tem largura/altura salvas — isso impede que "40X30 CM" (papel offset) preencha medidas de CV.
- Se algo quebrar, reverter é `git revert` do commit correspondente; nenhum dado é alterado de forma destrutiva (o smoke restaura o valor original).
