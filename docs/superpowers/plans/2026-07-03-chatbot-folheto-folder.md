# Chatbot folheto/flyer/folder + dobra — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O bot coleta tamanho + impressão (folheto/flyer/folder) e nº de dobras (folder); a precificação casa o SKU de folheto certo e cobra a dobra pela regra da Graficonauta (R$10 + R$5 por dobra adicional, por milheiro).

**Architecture:** `pricer.calcularRevenda` passa a somar o custo da dobra (por milheiro, sobre a quantidade da faixa, antes do markup). `precificarItemRevenda` lê a tarifa em `settings` e repassa `dobras`. Um resolver especializado (`resolverFolheto`/`escolherFolheto`) casa o SKU de folheto por gramatura+tamanho(≥)+impressão. `agent.js` pergunta tamanho/impressão/dobras e envia nos campos `impressao`/`dobras`. Sem migration.

**Tech Stack:** Node.js + PostgreSQL (pg), OpenAI, Jest.

**Design de referência:** `docs/superpowers/specs/2026-07-03-chatbot-folheto-folder-design.md`

**Convenções:** sem Postgres local (funções puras testadas com Jest; integração via smoke no VPS). DB de produção: **lkl_chatbot**. Deploy: rsync + `pm2 restart lkl-chatbot --update-env` no VPS `2.25.147.243`. `npm test` = jest --runInBand.

**Contexto de código:**
- `src/modules/revenda/pricer.js`: `calcularRevenda(ctx, opts)` — `ctx={faixas,acabamentos,markup_percent}`, `opts={quantidade,prazo_horas,selecionados}`; escolhe `faixa` (menor `quantidade >= qtd`), `base=faixa.preco_total`, soma acabamentos selecionados, `total=(base+acab)*(1+markup/100)`. Exporta `{ calcularRevenda, round2, calcularInternoM2 }`.
- `src/modules/revenda/service.js`: `precificarItemRevenda({revenda_produto_id, quantidade, prazo_horas, acabamentos, largura_cm, altura_cm})`; branch revenda_matriz chama `pricer.calcularRevenda`. `resolverProdutoRevenda({produto,material,tipo_producao})` + `pontuarSku` já existem. `_semAcento` helper existe.
- settings key-value: `SELECT value FROM settings WHERE key=$1`.
- SKUs: `Folheto <g>g | <L>x<A>cm | <4/0|4/4>` (`revenda_matriz`). Enum de produto tem `FOLDER` (folheto/flyer mapeiam para FOLDER).
- `src/ai/agent.js`: tool `registrar_pedido` (properties achatadas + `itens[]`); monta `itensDados` no handler; chama `ordersService.criarOrder`.
- `src/modules/orders/service.js` `criarOrder`: no loop, chama `resolverProdutoRevenda` + `precificarItemRevenda`.

---

## File Structure

- **Modify:** `src/modules/revenda/pricer.js` — `custoDobraMilheiro` (pura) + `calcularRevenda` soma a dobra + export.
- **Modify:** `src/modules/revenda/service.js` — `precificarItemRevenda` lê tarifa da dobra (settings) e repassa `dobras`; `escolherFolheto`(pura)+`resolverFolheto`(DB); `resolverProdutoRevenda` aceita `largura_cm/altura_cm/impressao` e usa `resolverFolheto` para a família folheto; exports.
- **Modify:** `src/ai/agent.js` — regra de prompt folheto/folder + campos `impressao`/`dobras` no tool + `itensDados`.
- **Modify:** `src/modules/orders/service.js` — passa `largura_cm/altura_cm/impressao` ao resolver e `dobras` ao precificar.
- **Create:** `tests/dobra-folheto.test.js` — testes de `custoDobraMilheiro` e `escolherFolheto`.

---

## Task 1: Custo da dobra por milheiro no `calcularRevenda`

**Files:**
- Modify: `src/modules/revenda/pricer.js`
- Test: `tests/dobra-folheto.test.js`

- [ ] **Step 1: Escrever o teste (falha)**

Create `tests/dobra-folheto.test.js`:
```js
const { custoDobraMilheiro, calcularRevenda } = require('../src/modules/revenda/pricer');

describe('custoDobraMilheiro', () => {
  test('1 dobra / 1000un = R$10', () => {
    expect(custoDobraMilheiro({ dobras: 1, quantidade: 1000, base: 10, adicional: 5 })).toBe(10);
  });
  test('2 dobras / 1000un = R$15', () => {
    expect(custoDobraMilheiro({ dobras: 2, quantidade: 1000, base: 10, adicional: 5 })).toBe(15);
  });
  test('3 dobras / 2000un = R$40', () => {
    expect(custoDobraMilheiro({ dobras: 3, quantidade: 2000, base: 10, adicional: 5 })).toBe(40);
  });
  test('0 dobras = 0', () => {
    expect(custoDobraMilheiro({ dobras: 0, quantidade: 1000, base: 10, adicional: 5 })).toBe(0);
  });
});

describe('calcularRevenda com dobra', () => {
  const ctx = {
    faixas: [{ quantidade: 1000, prazo_horas: 24, preco_total: 120 }],
    acabamentos: [], markup_percent: 0, dobra_base: 10, dobra_adicional: 5,
  };
  test('inclui a dobra na conta (sem markup)', () => {
    const r = calcularRevenda(ctx, { quantidade: 1000, prazo_horas: 24, selecionados: [], dobras: 1 });
    expect(r.valor_total).toBe(130); // 120 + 10
  });
  test('sem dobra não altera', () => {
    const r = calcularRevenda(ctx, { quantidade: 1000, prazo_horas: 24, selecionados: [], dobras: 0 });
    expect(r.valor_total).toBe(120);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/dobra-folheto.test.js`
Expected: FAIL — `custoDobraMilheiro is not a function` / dobra ignorada.

- [ ] **Step 3: Implementar `custoDobraMilheiro` e somar no `calcularRevenda`**

In `src/modules/revenda/pricer.js`, add the pure function (after `round4`):
```js
// Custo da dobra pela regra da Graficonauta: (base + adicional*(dobras-1)) por MILHEIRO.
function custoDobraMilheiro({ dobras, quantidade, base, adicional }) {
  const d = Number(dobras) || 0;
  if (d < 1) return 0;
  const tarifa = Number(base) + Number(adicional) * (d - 1);
  return round2(tarifa * (Number(quantidade) / 1000));
}
```
Then modify `calcularRevenda`. Replace the tail of the function (from `const markup = ...` through the `return`) with:
```js
  const markup = Number(ctx.markup_percent) || 0;
  const dobra = custoDobraMilheiro({
    dobras: opts.dobras, quantidade: faixa.quantidade,
    base: ctx.dobra_base != null ? ctx.dobra_base : 10,
    adicional: ctx.dobra_adicional != null ? ctx.dobra_adicional : 5,
  });
  const total = round2((base + acab + dobra) * (1 + markup / 100));
  const valor_unitario = round4(total / qtd);
  const memoria = `Faixa ${faixa.quantidade}un/${prazo}h R$ ${round2(base)}`
    + (acab ? ` + acab R$ ${round2(acab)}` : '')
    + (dobra ? ` + dobra R$ ${round2(dobra)}` : '')
    + ` ×(1+${markup}%) = R$ ${total} (un R$ ${valor_unitario})`;

  return { valor_unitario, valor_total: total, memoria, faixa_usada: faixa.quantidade };
```

- [ ] **Step 4: Exportar `custoDobraMilheiro`**

In `src/modules/revenda/pricer.js`, change `module.exports = { calcularRevenda, round2, calcularInternoM2 };` to:
```js
module.exports = { calcularRevenda, round2, calcularInternoM2, custoDobraMilheiro };
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx jest tests/dobra-folheto.test.js`
Expected: PASS (custoDobraMilheiro + calcularRevenda com dobra).

- [ ] **Step 6: Commit**

```bash
git add src/modules/revenda/pricer.js tests/dobra-folheto.test.js
git commit -m "feat(chatbot): custo da dobra por milheiro no calcularRevenda + testes"
```

---

## Task 2: `precificarItemRevenda` lê a tarifa (settings) e repassa `dobras`

**Files:**
- Modify: `src/modules/revenda/service.js`

- [ ] **Step 1: Aceitar `dobras` e ler a tarifa da dobra**

In `src/modules/revenda/service.js`, change the `precificarItemRevenda` signature to include `dobras`:
```js
async function precificarItemRevenda({ revenda_produto_id, quantidade, prazo_horas, acabamentos, largura_cm, altura_cm, dobras }) {
```
Then, in the `// revenda_matriz (default)` branch, right before the `const calc = pricer.calcularRevenda(` call, add:
```js
  const _sget = async (k, def) => {
    const r = await db.query('SELECT value FROM settings WHERE key=$1', [k]);
    const v = Number(r.rows[0]?.value);
    return Number.isFinite(v) ? v : def;
  };
  const dobraBase = await _sget('revenda_dobra_base_milheiro', 10);
  const dobraAdic = await _sget('revenda_dobra_adicional_milheiro', 5);
```
And change the `pricer.calcularRevenda(...)` call to pass the dobra config + `dobras`:
```js
  const calc = pricer.calcularRevenda(
    { faixas, acabamentos: acabs, markup_percent: cfg.markup_percent, dobra_base: dobraBase, dobra_adicional: dobraAdic },
    { quantidade, prazo_horas: prazo, selecionados: Array.isArray(acabamentos) ? acabamentos.map((a) => (typeof a === 'string' ? a : a.nome)) : [], dobras: Number(dobras) || 0 }
  );
```

- [ ] **Step 2: Verificar carga do módulo**

Run: `OPENAI_API_KEY=x node -e "require('./src/modules/revenda/service'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add src/modules/revenda/service.js
git commit -m "feat(chatbot): precificarItemRevenda cobra dobra (tarifa em settings, defaults 10/5)"
```

---

## Task 3: `escolherFolheto` (pura) + `resolverFolheto` + integração

**Files:**
- Modify: `src/modules/revenda/service.js`
- Test: `tests/dobra-folheto.test.js` (adicionar bloco)

- [ ] **Step 1: Adicionar o teste de `escolherFolheto`**

In `tests/dobra-folheto.test.js`, add at the end:
```js
const { escolherFolheto } = require('../src/modules/revenda/service');

describe('escolherFolheto', () => {
  const skus = [
    { id: 'a', gramatura: 115, larg_cm: 10, alt_cm: 14, impressao: '4/4' },
    { id: 'b', gramatura: 115, larg_cm: 10, alt_cm: 21, impressao: '4/4' },
    { id: 'c', gramatura: 115, larg_cm: 10, alt_cm: 28, impressao: '4/4' },
    { id: 'd', gramatura: 150, larg_cm: 10, alt_cm: 21, impressao: '4/4' },
    { id: 'e', gramatura: 115, larg_cm: 10, alt_cm: 21, impressao: '4/0' },
  ];
  test('menor tamanho >= pedido, impressão e gramatura corretas', () => {
    const r = escolherFolheto(skus, { gramatura: 115, largura_cm: 10, altura_cm: 20, impressao: '4/4' });
    expect(r.id).toBe('b'); // 10x21 é o menor >= 10x20
  });
  test('respeita a impressão', () => {
    const r = escolherFolheto(skus, { gramatura: 115, largura_cm: 10, altura_cm: 21, impressao: '4/0' });
    expect(r.id).toBe('e');
  });
  test('gramatura mais próxima', () => {
    const r = escolherFolheto(skus, { gramatura: 140, largura_cm: 10, altura_cm: 21, impressao: '4/4' });
    expect(r.id).toBe('d'); // 150 mais próximo de 140 que 115
  });
  test('nada serve → null', () => {
    expect(escolherFolheto(skus, { gramatura: 115, largura_cm: 50, altura_cm: 50, impressao: '4/4' })).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `OPENAI_API_KEY=x npx jest tests/dobra-folheto.test.js`
Expected: FAIL — `escolherFolheto is not a function`.

- [ ] **Step 3: Implementar `escolherFolheto` + `resolverFolheto`**

In `src/modules/revenda/service.js`, add after `resolverProdutoRevenda` (uses `_semAcento` already defined):
```js
// Escolha pura: menor tamanho >= pedido (nas 2 orientações), impressão exata, gramatura mais próxima.
function escolherFolheto(skus, { gramatura, largura_cm, altura_cm, impressao }) {
  const imp = (impressao === '4/0' || impressao === '4/4') ? impressao : '4/4';
  const pl = Number(largura_cm), pa = Number(altura_cm);
  const cabe = (s) => {
    const okAB = s.larg_cm >= pl && s.alt_cm >= pa;
    const okBA = s.larg_cm >= pa && s.alt_cm >= pl;
    return okAB || okBA;
  };
  let cands = skus.filter((s) => s.impressao === imp && cabe(s));
  if (!cands.length) return null;
  if (Number.isFinite(gramatura)) {
    let melhorG = null;
    for (const s of cands) { const d = Math.abs(s.gramatura - gramatura); if (melhorG == null || d < melhorG) melhorG = d; }
    cands = cands.filter((s) => Math.abs(s.gramatura - gramatura) === melhorG);
  }
  cands.sort((a, b) => (a.larg_cm * a.alt_cm) - (b.larg_cm * b.alt_cm));
  return cands[0] || null;
}

// Casa a família folheto/flyer/folder ao SKU certo (gramatura+tamanho+impressão). Retorna a linha ou null.
async function resolverFolheto({ material, largura_cm, altura_cm, impressao }) {
  const { rows } = await db.query(
    `SELECT id, nome FROM revenda_produtos WHERE ativo=TRUE AND estrategia='revenda_matriz' AND nome ILIKE 'Folheto %'`);
  const parsed = [];
  for (const r of rows) {
    const m = r.nome.match(/Folheto\s+(\d+)g\s*\|\s*(\d+)\s*x\s*(\d+)\s*cm\s*\|\s*(4\/0|4\/4)/i);
    if (!m) continue;
    parsed.push({ id: r.id, nome: r.nome, gramatura: Number(m[1]), larg_cm: Number(m[2]), alt_cm: Number(m[3]), impressao: m[4] });
  }
  const g = (String(material || '').match(/(\d+)\s*g/i) || [])[1];
  const escolhido = escolherFolheto(parsed, { gramatura: g ? Number(g) : NaN, largura_cm, altura_cm, impressao });
  if (!escolhido) return null;
  return { id: escolhido.id, nome: escolhido.nome, estrategia: 'revenda_matriz' };
}
```

- [ ] **Step 4: Integrar no `resolverProdutoRevenda` (aceitar tamanho/impressão + família folheto)**

In `src/modules/revenda/service.js`, replace the `resolverProdutoRevenda` signature line and add the folheto branch at the START of its body. Change:
```js
async function resolverProdutoRevenda({ produto, material, tipo_producao }) {
  const texto = `${produto || ''} ${material || ''}`.trim();
  if (!texto) return null;
```
to:
```js
async function resolverProdutoRevenda({ produto, material, tipo_producao, largura_cm, altura_cm, impressao }) {
  // Família folheto/flyer/folder: casa por gramatura+tamanho+impressão.
  if (/FOLDER|FOLHETO|FLYER/.test(_semAcento(produto)) && Number(largura_cm) > 0 && Number(altura_cm) > 0) {
    const f = await resolverFolheto({ material, largura_cm, altura_cm, impressao });
    if (f) return f;
  }
  const texto = `${produto || ''} ${material || ''}`.trim();
  if (!texto) return null;
```

- [ ] **Step 5: Exportar `escolherFolheto` e `resolverFolheto`**

In `src/modules/revenda/service.js`, add both to `module.exports` (junto de `resolverProdutoRevenda`):
```js
  precificarItemRevenda, pontuarSku, resolverProdutoRevenda, escolherFolheto, resolverFolheto,
```

- [ ] **Step 6: Rodar os testes**

Run: `OPENAI_API_KEY=x npx jest tests/dobra-folheto.test.js`
Expected: PASS (custoDobraMilheiro + calcularRevenda + escolherFolheto).

- [ ] **Step 7: Commit**

```bash
git add src/modules/revenda/service.js tests/dobra-folheto.test.js
git commit -m "feat(chatbot): resolverFolheto (gramatura+tamanho+impressão) + integração no matcher"
```

---

## Task 4: Prompt + campos impressao/dobras no `registrar_pedido`

**Files:**
- Modify: `src/ai/agent.js`

- [ ] **Step 1: Regra de prompt para folheto/flyer/folder**

In `src/ai/agent.js`, the `SYSTEM_PROMPT` ends with rule 15 (UNIDADE PADRÃO = METRO). Insert a new rule 16 right before the closing backtick of the template literal (after the rule 15 text):
```
16. FOLHETO / FLYER / FOLDER — colete para orçar certo (mesmo serviço-base; folder = folheto + dobra):
   - SEMPRE pergunte o TAMANHO (em metros/cm) — não registre sem tamanho.
   - SEMPRE pergunte a IMPRESSÃO: só frente (4/0) ou frente e verso (4/4). Ex.: "É impresso só na frente ou frente e verso? 😊"
   - Se for FOLDER, pergunte também o Nº DE DOBRAS (1, 2 ou 3). Folheto/flyer não têm dobra.
   - Ao chamar registrar_pedido, preencha "impressao" ("4/0" ou "4/4") e "dobras" (0 para folheto/flyer; 1–3 para folder) no item.
```

- [ ] **Step 2: Adicionar `impressao` e `dobras` ao tool `registrar_pedido`**

In `src/ai/agent.js`, in the `TOOLS` array, add to the top-level `properties` (near `material`, `dimensoes`):
```js
          impressao:     { type: 'string', enum: ['4/0', '4/4'], description: 'Impressão: 4/0 (só frente) ou 4/4 (frente e verso). Para folheto/flyer/folder.' },
          dobras:        { type: 'number', description: 'Nº de dobras (folder): 1–3; 0 para folheto/flyer.' },
```
And in the `itens[].items.properties` object, add:
```js
                impressao:  { type: 'string', enum: ['4/0', '4/4'] },
                dobras:     { type: 'number' },
```

- [ ] **Step 3: Repassar `impressao`/`dobras` em `itensDados`**

In `src/ai/agent.js`, find the `itensDados` map (in the `registrar_pedido` handler). It currently maps `produto, quantidade, especificacao, tem_arte, dimensoes, material`. Add `impressao` and `dobras`, and inclua-os na `especificacao`. Replace the `itensDados` map with:
```js
        const itensDados = itensBrutos.map(it => ({
          produto: (it.produto || args.tipo_servico || 'Pedido via chatbot'),
          quantidade: parseInt(it.quantidade) || 1,
          especificacao: [it.dimensoes, it.material, it.impressao, (Number(it.dobras) > 0 ? `${it.dobras} dobra(s)` : null)].filter(Boolean).join(' · ') || null,
          tem_arte: !!it.tem_arte,
          dimensoes: it.dimensoes || null,
          material: it.material || null,
          impressao: it.impressao || args.impressao || null,
          dobras: Number(it.dobras || args.dobras) || 0,
        }));
```

- [ ] **Step 4: Verificar carga + testes**

Run: `OPENAI_API_KEY=x node -e "const {SYSTEM_PROMPT}=require('./src/ai/agent'); console.log(/FOLHETO \/ FLYER \/ FOLDER/.test(SYSTEM_PROMPT) ? 'ok' : 'faltando')"`
Expected: `ok`.

Run: `OPENAI_API_KEY=x npx jest tests/agent-prompt.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/agent.js
git commit -m "feat(chatbot): bot pergunta tamanho/impressão/dobras (folheto/flyer/folder)"
```

---

## Task 5: `criarOrder` repassa tamanho/impressão/dobras à precificação

**Files:**
- Modify: `src/modules/orders/service.js`

- [ ] **Step 1: Passar os campos ao resolver e ao precificar**

In `src/modules/orders/service.js`, in the auto-pricing block inside the loop, change the two calls. Replace:
```js
        const prod = await revendaService.resolverProdutoRevenda({ produto: it.produto, material: it.material, tipo_producao: tipo });
        if (prod && prod.estrategia !== 'manual') {
          const calc = await revendaService.precificarItemRevenda({
            revenda_produto_id: prod.id, quantidade: it.quantidade,
            largura_cm: larg, altura_cm: alt, prazo_horas: null, acabamentos: [],
          });
```
with:
```js
        const prod = await revendaService.resolverProdutoRevenda({ produto: it.produto, material: it.material, tipo_producao: tipo, largura_cm: larg, altura_cm: alt, impressao: it.impressao });
        if (prod && prod.estrategia !== 'manual') {
          const calc = await revendaService.precificarItemRevenda({
            revenda_produto_id: prod.id, quantidade: it.quantidade,
            largura_cm: larg, altura_cm: alt, prazo_horas: null, acabamentos: [], dobras: it.dobras,
          });
```

- [ ] **Step 2: Verificar carga + suíte**

Run: `OPENAI_API_KEY=x node -e "require('./src/modules/orders/service'); console.log('ok')"`
Expected: `ok`.

Run: `OPENAI_API_KEY=x npx jest tests/dobra-folheto.test.js tests/matcher-revenda.test.js tests/produtos.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/modules/orders/service.js
git commit -m "feat(chatbot): criarOrder passa tamanho/impressão à resolução e dobras à precificação"
```

---

## Task 6: Deploy VPS + smoke + memória

**Files:** nenhum código novo — deploy e verificação.

- [ ] **Step 1: Rsync do código**

```bash
rsync -avz src/modules/revenda/pricer.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/revenda/pricer.js
rsync -avz src/modules/revenda/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/revenda/service.js
rsync -avz src/ai/agent.js root@2.25.147.243:/var/www/lkl-chatbot/src/ai/agent.js
rsync -avz src/modules/orders/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orders/service.js
```
Expected: transferências sem erro.

- [ ] **Step 2: (Opcional) Ajustar a tarifa da dobra em settings**

Os defaults 10/5 já valem sem nada no banco. Para deixar explícito/editável:
```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"INSERT INTO settings(key,value) VALUES('revenda_dobra_base_milheiro','10'),('revenda_dobra_adicional_milheiro','5') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;\""
```
Expected: `INSERT 0 2` (ou UPDATE). (Se a tabela `settings` tiver colunas diferentes de `key,value`, ajustar — conferir com `\d settings`.)

- [ ] **Step 3: Restart do app**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1; sleep 2; pm2 list | grep -o 'lkl-chatbot.*online' | head -1; pm2 logs lkl-chatbot --lines 5 --nostream 2>/dev/null | grep -iE 'error|throw' || echo '(sem erros no boot)'"
```
Expected: `online`, sem erros.

- [ ] **Step 4: Smoke — resolverFolheto + preço com dobra**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e \"const r=require('./src/modules/revenda/service'); (async()=>{ const f=await r.resolverFolheto({material:'couché 115g',largura_cm:10,altura_cm:20,impressao:'4/4'}); console.log('SKU:', f && f.nome); if(f){ const c=await r.precificarItemRevenda({revenda_produto_id:f.id, quantidade:1000, prazo_horas:null, acabamentos:[], dobras:2}); console.log('preço 2 dobras:', c && c.memoria); } process.exit(0); })()\""
```
Expected: um SKU `Folheto 115g | 10x21cm | 4/4` (menor ≥ 10x20) e a memória mostrando `+ dobra R$ 15` (2 dobras × 1000un).

- [ ] **Step 5: Atualizar a memória do projeto**

Registrar em `project_sprint_status.md`: chatbot folheto/flyer/folder — bot pergunta tamanho + impressão (4/0|4/4) para os três e nº de dobras no folder (regra 16 do SYSTEM_PROMPT; campos `impressao`/`dobras` no registrar_pedido e em itensDados). Precificação: `src/modules/revenda/service.js` `escolherFolheto`(pura: menor tamanho ≥ pedido nas 2 orientações + impressão exata + gramatura mais próxima; tests/dobra-folheto.test.js) + `resolverFolheto` (SELECT Folheto% revenda_matriz, parse `Folheto Ng | LxAcm | 4/x`, gramatura do material) chamado por `resolverProdutoRevenda` quando produto∈FOLDER/FOLHETO/FLYER e tem tamanho. Dobra: `pricer.custoDobraMilheiro` (tarifa=base+adicional×(dobras−1), POR MILHEIRO sobre a quantidade da FAIXA; base=10/adicional=5 editáveis em settings revenda_dobra_base_milheiro/revenda_dobra_adicional_milheiro), somada à base ANTES do markup em `calcularRevenda`. `precificarItemRevenda` aceita `dobras`; `criarOrder` passa largura/altura/impressao ao resolver e dobras ao precificar. Sem migration. Commits <SHAs>.

- [ ] **Step 6: Encerrar a branch**

Usar `superpowers:finishing-a-development-branch`.

---

## Self-Review

**1. Spec coverage:**
- Bot pergunta tamanho + impressão (folheto/flyer/folder) + dobras (folder) → Task 4. ✓
- Campos `impressao`/`dobras` no tool + itensDados → Task 4. ✓
- `resolverFolheto`/`escolherFolheto` (gramatura+tamanho≥+impressão) → Task 3. ✓
- Integração no `resolverProdutoRevenda` (família folheto) → Task 3 Step 4. ✓
- Dobra por milheiro (base+adicional×(n−1), sobre a faixa, antes do markup) → Task 1. ✓
- Tarifa editável em `settings` (defaults 10/5) → Task 2 + Task 6 Step 2. ✓
- `precificarItemRevenda` aceita `dobras` → Task 2. ✓
- `criarOrder` repassa tamanho/impressão/dobras → Task 5. ✓
- Testes puros (custoDobraMilheiro, escolherFolheto) → Tasks 1, 3. ✓
- Deploy + smoke → Task 6. ✓

**2. Placeholder scan:** sem TBD/TODO; código completo em cada passo. (`<SHAs>` no Step 5 = marcador.) ✓

**3. Type consistency:** `custoDobraMilheiro({dobras,quantidade,base,adicional})` idêntico entre Task 1 (pricer/teste) e uso em `calcularRevenda`. `escolherFolheto(skus, {gramatura,largura_cm,altura_cm,impressao})` idêntico entre Task 3 (teste/impl) e `resolverFolheto`. `dobra_base`/`dobra_adicional` no ctx (Task 1) alimentados por `precificarItemRevenda` (Task 2). `resolverProdutoRevenda({...,largura_cm,altura_cm,impressao})` e `precificarItemRevenda({...,dobras})` consistentes entre service (Tasks 2/3) e `criarOrder` (Task 5). ✓
