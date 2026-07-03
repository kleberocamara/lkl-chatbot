# Auto-precificação dos pedidos do chatbot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No `criarOrder`, casar cada item do pedido do chatbot a um SKU do catálogo e auto-precificar (rascunho `preco_origem='auto'`) pelo motor existente `precificarItemRevenda`.

**Architecture:** Um matcher (`pontuarSku` puro + `resolverProdutoRevenda` que consulta `revenda_produtos`) escolhe o SKU mais provável; `criarOrder` chama `precificarItemRevenda` (interno_m2 → R$30/m²; revenda_matriz → tabela Graficonauta) e grava valor/origem/memoria/revenda_produto_id, depois recalcula o total do orçamento. Sem migration.

**Tech Stack:** Node.js + PostgreSQL (pg), Jest.

**Design de referência:** `docs/superpowers/specs/2026-07-03-autoprecificacao-chatbot-design.md`

**Convenções:** sem Postgres local (funções puras testadas com Jest; integração via smoke no VPS). DB de produção: **lkl_chatbot**. Deploy: rsync + `pm2 restart lkl-chatbot --update-env` no VPS `2.25.147.243` (`/var/www/lkl-chatbot`). `npm test` = jest --runInBand.

**Contexto de código:**
- `src/constants/produtos.js` exporta `tokensMaterial(termo)` → array de tokens normalizados (upper, sem acento, ignora stopwords tipo G/CM/DE).
- `src/modules/revenda/service.js` exporta `precificarItemRevenda({ revenda_produto_id, quantidade, prazo_horas, acabamentos, largura_cm, altura_cm })` → retorna `{ valor_unitario, valor_total, memoria, estrategia }` ou `null`.
- `revenda_produtos` colunas: `id, nome, tipo_servico, estrategia, bobina_grupo, preco_m2, ativo`. `tipo_servico` na base vem SEM acento em "COMUNICAÇAO VISUAL"; `tipo_producao` do item vem "COMUNICAÇÃO VISUAL" (com Ã) — a comparação normaliza acentos.
- `criarOrder` (`src/modules/orders/service.js`) tem o loop `for (const it of itens)` que insere `orcamento_itens` com `valor_unitario=0, valor_total=0` (VALUES ... 0, 0 ...).

---

## File Structure

- **Modify:** `src/modules/revenda/service.js` — `pontuarSku` (pura) + `resolverProdutoRevenda` (DB) + exports.
- **Create:** `tests/matcher-revenda.test.js` — testes de `pontuarSku`.
- **Modify:** `src/modules/orders/service.js` — auto-precificação no loop de `orcamento_itens` + recálculo do total.
- **Create:** `scripts/reprecificar-orcamento.js` — reprecifica um orçamento existente (backfill do #37).

---

## Task 1: `pontuarSku` (matcher puro) + testes

**Files:**
- Modify: `src/modules/revenda/service.js`
- Test: `tests/matcher-revenda.test.js`

- [ ] **Step 1: Escrever o teste (falha)**

Create `tests/matcher-revenda.test.js`:
```js
const { pontuarSku } = require('../src/modules/revenda/service');

describe('pontuarSku', () => {
  test('banner/lona casa melhor com SKU de lona que com adesivo', () => {
    const alvo = 'BANNERS lona 440g brilho';
    const scoreLona = pontuarSku(alvo, 'Banner | Lona Brilho 300g | 1000x1000');
    const scoreAdesivo = pontuarSku(alvo, 'Adesivo Vinil Fosco');
    expect(scoreLona).toBeGreaterThan(scoreAdesivo);
  });
  test('sem sobreposição → 0', () => {
    expect(pontuarSku('CARTOES couché 300g', 'Lona Fosca 440g')).toBe(0);
  });
  test('texto vazio → 0', () => {
    expect(pontuarSku('', 'Banner Lona')).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `OPENAI_API_KEY=x npx jest tests/matcher-revenda.test.js`
Expected: FAIL — `pontuarSku is not a function`.

- [ ] **Step 3: Implementar `pontuarSku`**

In `src/modules/revenda/service.js`, add near the top (after the existing `require`s) an import of `tokensMaterial`, and the function. If `tokensMaterial` is not yet required, add:
```js
const { tokensMaterial } = require('../../constants/produtos');
```
Then add the function (anywhere at module scope, e.g., before `precificarItemRevenda`):
```js
// Score de aproximação entre o texto do pedido e o nome do SKU: nº de tokens do pedido presentes no SKU.
function pontuarSku(textoPedido, nomeSku) {
  const toks = tokensMaterial(textoPedido);
  if (!toks.length) return 0;
  const setSku = new Set(tokensMaterial(nomeSku));
  return toks.reduce((n, t) => n + (setSku.has(t) ? 1 : 0), 0);
}
```

- [ ] **Step 4: Exportar `pontuarSku`**

In `src/modules/revenda/service.js`, add `pontuarSku` to the `module.exports` object (which currently ends with `precificarItemRevenda,`):
```js
module.exports = {
  listarCategorias, criarCategoria, atualizarCategoria,
  listarProdutos, detalheProduto,
  statusSync, dispararSync,
  getConfig, setConfig,
  precificarItemRevenda, pontuarSku,
};
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `OPENAI_API_KEY=x npx jest tests/matcher-revenda.test.js`
Expected: PASS (3 testes).

- [ ] **Step 6: Commit**

```bash
git add src/modules/revenda/service.js tests/matcher-revenda.test.js
git commit -m "feat(chatbot): pontuarSku (matcher de produto por tokens) + testes"
```

---

## Task 2: `resolverProdutoRevenda` (escolhe o SKU no catálogo)

**Files:**
- Modify: `src/modules/revenda/service.js`

- [ ] **Step 1: Implementar `resolverProdutoRevenda`**

In `src/modules/revenda/service.js`, add this function right after `pontuarSku`:
```js
const _semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

// Casa {produto, material, tipo_producao} ao SKU mais provável do catálogo (ou null).
async function resolverProdutoRevenda({ produto, material, tipo_producao }) {
  const texto = `${produto || ''} ${material || ''}`.trim();
  if (!texto) return null;
  const alvoTipo = _semAcento(tipo_producao); // 'COMUNICACAO VISUAL' | 'OFFSET' | ...
  const filtrarTipo = (alvoTipo === 'COMUNICACAO VISUAL' || alvoTipo === 'OFFSET');
  const { rows } = await db.query(
    `SELECT id, nome, tipo_servico, estrategia, bobina_grupo, preco_m2 FROM revenda_produtos WHERE ativo = TRUE`);
  let best = null, bestScore = 0;
  for (const p of rows) {
    if (filtrarTipo && _semAcento(p.tipo_servico) !== alvoTipo) continue;
    const s = pontuarSku(texto, p.nome);
    if (s > bestScore || (s === bestScore && s > 0 && best && p.estrategia === 'interno_m2' && best.estrategia !== 'interno_m2')) {
      best = p; bestScore = s;
    }
  }
  return bestScore > 0 ? best : null;
}
```

- [ ] **Step 2: Exportar `resolverProdutoRevenda`**

In `src/modules/revenda/service.js`, add `resolverProdutoRevenda` to `module.exports` (junto de `pontuarSku`):
```js
  precificarItemRevenda, pontuarSku, resolverProdutoRevenda,
```

- [ ] **Step 3: Verificar carga do módulo**

Run: `OPENAI_API_KEY=x node -e "const s=require('./src/modules/revenda/service'); console.log(typeof s.resolverProdutoRevenda, typeof s.pontuarSku)"`
Expected: `function function`.

- [ ] **Step 4: Commit**

```bash
git add src/modules/revenda/service.js
git commit -m "feat(chatbot): resolverProdutoRevenda (escolhe SKU do catálogo por score)"
```

---

## Task 3: Auto-precificação no `criarOrder`

**Files:**
- Modify: `src/modules/orders/service.js` (loop de inserção de `orcamento_itens` + recálculo do total)

- [ ] **Step 1: Requerer o revenda service**

In `src/modules/orders/service.js`, near the top requires, add (se ainda não houver):
```js
const revendaService = require('../revenda/service');
```

- [ ] **Step 2: Auto-precificar dentro do loop**

In `src/modules/orders/service.js`, the loop is:
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
Replace the ENTIRE loop with:
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

      // Auto-precificação (rascunho): casa o item a um SKU e usa o motor de preço da revenda.
      let valorUnit = 0, valorTotal = 0, precoOrigem = 'manual', precoMemoria = null, revProdId = null;
      try {
        const prod = await revendaService.resolverProdutoRevenda({ produto: it.produto, material: it.material, tipo_producao: tipo });
        if (prod && prod.estrategia !== 'manual') {
          const calc = await revendaService.precificarItemRevenda({
            revenda_produto_id: prod.id, quantidade: it.quantidade,
            largura_cm: larg, altura_cm: alt, prazo_horas: null, acabamentos: [],
          });
          if (calc && Number(calc.valor_total) > 0) {
            valorUnit = calc.valor_unitario; valorTotal = calc.valor_total;
            precoOrigem = 'auto'; revProdId = prod.id;
            precoMemoria = `${calc.estrategia} · ${prod.nome}${calc.memoria ? ` · ${calc.memoria}` : ''}`;
          }
        }
      } catch (e) {
        console.warn('[CHATBOT-PRECO] auto-precificação falhou:', e.message);
      }

      await db.query(
        `INSERT INTO orcamento_itens (orcamento_id, codigo, produto, especificacao, descricao, quantidade, valor_unitario, valor_total, tem_arte, tipo_producao, largura_cm, altura_cm, material_id, preco_origem, preco_memoria, revenda_produto_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [orcamentoId, codigo++, it.produto, it.especificacao || null, descricao, it.quantidade, valorUnit, valorTotal, it.tem_arte || false, tipo || null, larg != null ? larg : null, alt != null ? alt : null, materialId || null, precoOrigem, precoMemoria, revProdId]
      );
    }
```

- [ ] **Step 3: Recalcular o total do orçamento após o loop**

In `src/modules/orders/service.js`, immediately AFTER the `for` loop closes (before whatever comes next), add:
```js
    await db.query(
      `UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id = $1) WHERE id = $1`,
      [orcamentoId]
    );
```

- [ ] **Step 4: Verificar carga + suíte**

Run: `OPENAI_API_KEY=x node -e "require('./src/modules/orders/service'); console.log('ok')"`
Expected: `ok`.

Run: `OPENAI_API_KEY=x npx jest tests/matcher-revenda.test.js tests/produtos.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/orders/service.js
git commit -m "feat(chatbot): criarOrder auto-precifica itens (SKU + precificarItemRevenda) e recalcula total"
```

---

## Task 4: Script de reprecificação (backfill) + deploy + smoke

**Files:**
- Create: `scripts/reprecificar-orcamento.js`
- Deploy e verificação.

- [ ] **Step 1: Escrever o script de reprecificação**

Create `scripts/reprecificar-orcamento.js`:
```js
// Reprecifica os itens de um orçamento pelo matcher + motor de revenda.
//   node -r dotenv/config scripts/reprecificar-orcamento.js <numero_orcamento>
const db = require('../src/db');
const revenda = require('../src/modules/revenda/service');

async function main() {
  const numero = parseInt(process.argv[2], 10);
  if (!numero) { console.error('uso: node scripts/reprecificar-orcamento.js <numero>'); process.exit(1); }
  const orc = (await db.query('SELECT id FROM orcamentos WHERE numero=$1', [numero])).rows[0];
  if (!orc) { console.error('orçamento não encontrado'); process.exit(1); }
  const itens = (await db.query(
    `SELECT id, produto, especificacao, quantidade, largura_cm, altura_cm, tipo_producao FROM orcamento_itens WHERE orcamento_id=$1`, [orc.id])).rows;
  for (const it of itens) {
    const material = it.especificacao || '';
    const prod = await revenda.resolverProdutoRevenda({ produto: it.produto, material, tipo_producao: it.tipo_producao });
    let vu = 0, vt = 0, origem = 'manual', mem = null, rpid = null;
    if (prod && prod.estrategia !== 'manual') {
      const calc = await revenda.precificarItemRevenda({ revenda_produto_id: prod.id, quantidade: it.quantidade, largura_cm: it.largura_cm, altura_cm: it.altura_cm, prazo_horas: null, acabamentos: [] });
      if (calc && Number(calc.valor_total) > 0) { vu = calc.valor_unitario; vt = calc.valor_total; origem = 'auto'; rpid = prod.id; mem = `${calc.estrategia} · ${prod.nome}${calc.memoria ? ` · ${calc.memoria}` : ''}`; }
    }
    await db.query(
      `UPDATE orcamento_itens SET valor_unitario=$2, valor_total=$3, preco_origem=$4, preco_memoria=$5, revenda_produto_id=$6 WHERE id=$1`,
      [it.id, vu, vt, origem, mem, rpid]);
    console.log(`item ${it.produto}: ${origem} R$ ${vt}`);
  }
  await db.query(`UPDATE orcamentos SET total=(SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`, [orc.id]);
  console.log('total recalculado.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Rsync do código**

```bash
rsync -avz src/modules/revenda/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/revenda/service.js
rsync -avz src/modules/orders/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orders/service.js
rsync -avz scripts/reprecificar-orcamento.js root@2.25.147.243:/var/www/lkl-chatbot/scripts/reprecificar-orcamento.js
```
Expected: transferências sem erro.

- [ ] **Step 3: Restart do app**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1; sleep 2; pm2 list | grep -o 'lkl-chatbot.*online' | head -1"
ssh root@2.25.147.243 "pm2 logs lkl-chatbot --lines 5 --nostream 2>/dev/null | grep -iE 'error|throw' || echo '(sem erros no boot)'"
```
Expected: `online`, sem erros.

- [ ] **Step 4: Smoke do matcher (SKU do banner)**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e \"const r=require('./src/modules/revenda/service'); r.resolverProdutoRevenda({produto:'BANNERS',material:'lona 440g brilho',tipo_producao:'COMUNICAÇÃO VISUAL'}).then(p=>{console.log(p?('SKU: '+p.nome+' ['+p.estrategia+']'):'nenhum'); process.exit(0);})\""
```
Expected: imprime um SKU de lona/banner com estratégia `interno_m2` (ou `revenda_matriz`).

- [ ] **Step 5: Backfill do orçamento 37**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config scripts/reprecificar-orcamento.js 37"
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"SELECT oi.produto, oi.valor_total, oi.preco_origem, oi.preco_memoria FROM orcamento_itens oi JOIN orcamentos o ON o.id=oi.orcamento_id WHERE o.numero=37; SELECT numero, total FROM orcamentos WHERE numero=37;\""
```
Expected: o item **BANNERS** com `valor_total > 0` e `preco_origem='auto'` (memória mostrando `interno_m2 · … · …m² × R$30/m²`); o FOLDER provavelmente fica `manual` (Offset sem regra); `orcamentos.total` reflete a soma.

- [ ] **Step 6: Atualizar a memória do projeto**

Registrar em `project_sprint_status.md`: chatbot passou a AUTO-PRECIFICAR os pedidos. Bug corrigido antes: parseDimensoes aceita "1,20m x 1,10m" (unidade nos 2 números). src/modules/revenda/service.js: `pontuarSku(textoPedido,nomeSku)` (tokens em comum via tokensMaterial; testes tests/matcher-revenda.test.js) + `resolverProdutoRevenda({produto,material,tipo_producao})` (busca revenda_produtos ativo, filtra por tipo_servico normalizado sem acento, maior score, empate→interno_m2; null se score 0). src/modules/orders/service.js criarOrder: no loop de orcamento_itens, resolve SKU + precificarItemRevenda (interno_m2 R$30/m²; revenda_matriz tabela Graficonauta — revenda_precos populado 3945 linhas), grava valor+preco_origem='auto'+preco_memoria+revenda_produto_id (try/catch por item → manual em falha); recalcula orcamentos.total. Offset 'manual'/sem match → R$0 manual. scripts/reprecificar-orcamento.js reprecifica um orçamento (rodou no #37). Sem migration. Commits <SHAs>.

- [ ] **Step 7: Encerrar a branch**

Usar `superpowers:finishing-a-development-branch`.

---

## Self-Review

**1. Spec coverage:**
- `pontuarSku` pura + testes → Task 1. ✓
- `resolverProdutoRevenda` (filtra tipo_servico normalizado, maior score, empate→interno_m2, score 0→null) → Task 2. ✓
- Auto-precificação no criarOrder (resolve SKU, precificarItemRevenda, grava auto/manual, try/catch por item) → Task 3 Step 2. ✓
- Recálculo do total do orçamento → Task 3 Step 3. ✓
- Backfill do orçamento 37 → Task 4 (script + Step 5). ✓
- Estratégia do SKU casado (interno_m2/revenda_matriz/manual) → Task 3 (checa `prod.estrategia !== 'manual'`). ✓
- Deploy + smoke + memória → Task 4. ✓

**2. Placeholder scan:** sem TBD/TODO; todo passo de código traz o código completo. (`<SHAs>` no Step 6 é marcador para os SHAs reais no commit da memória.) ✓

**3. Type consistency:** `pontuarSku(textoPedido, nomeSku)` e `resolverProdutoRevenda({produto,material,tipo_producao})` idênticos entre Task 1/2, Task 3 (criarOrder) e Task 4 (script). Campos de `precificarItemRevenda` (`valor_unitario`, `valor_total`, `memoria`, `estrategia`) usados consistentemente. Colunas do INSERT de `orcamento_itens` (16 colunas / 16 placeholders) conferidas. ✓
