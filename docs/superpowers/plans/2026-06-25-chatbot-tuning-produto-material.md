# Tuning do chatbot — padronizar Produto/Material — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forçar `produto` do chatbot a um enum canônico (deriva tipo certo) e resolver `material_id` por match de tokens (ex.: "couchê 90g" → "COUCHE LISO 90 GR 96X66").

**Architecture:** Helpers puros novos em `src/constants/produtos.js` (`tokensMaterial`, `selecionarMaterialId`) com testes. `orders/service.js` passa a usar `selecionarMaterialId` (busca todos os materiais ativos e seleciona em JS). `ai/agent.js` ganha `enum` de produto na tool (da mesma lista `PRODUTOS`) + regra de padronização no prompt.

**Tech Stack:** Node/Express, PostgreSQL, Jest.

**Decisões (2026-06-25):** foco só em produto/material; validação por casos automatizados. Dimensões/itens/tom fora de escopo.

**Fatos verificados:**
- `src/constants/produtos.js` exporta `PRODUTOS` (28 famílias + OUTROS/OFFSET), `matchProduto`, `tipoPorProduto`, `parseDimensoes`. Tem `_norm` interno (uppercase+NFD).
- `orders/service.js:5` `_resolverMaterialId(nome)` faz `ILIKE %termo%` (falha em "couchê 90g" pois cadastro é "COUCHE LISO 90 GR 96X66"). Import no topo: `const { tipoPorProduto, parseDimensoes } = require('../../constants/produtos');`.
- `materiais`: 106 ativos, nível SKU (gramatura + folha no nome). Colunas `id`, `nome`, `status`.
- `ai/agent.js`: `SYSTEM_PROMPT` (template literal, linhas 8–74); `TOOLS` (76–120) com `produto` (87) e `itens[].produto` (105) string livre; `getSetting('agent_prompt')` (142) sobrepõe o SYSTEM_PROMPT só se preenchido (hoje vazio). O enum na tool vale SEMPRE (independe do prompt custom).
- Deploy backend: rsync + `pm2 restart lkl-chatbot --update-env`. Smoke: `ssh ... node -r dotenv/config -e '...'`.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:**
- Modify: `src/constants/produtos.js` (+ `tokensMaterial`, `selecionarMaterialId`).
- Test: `tests/produtos.test.js` (acrescentar casos).
- Modify: `src/modules/orders/service.js` (`_resolverMaterialId`).
- Modify: `src/ai/agent.js` (enum de produto + prompt).

---

### Task 1: Helpers de material por tokens (+ testes)

**Files:**
- Modify: `src/constants/produtos.js`
- Test: `tests/produtos.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar ao final de `tests/produtos.test.js` (antes de nenhum — apenas adicionar novos `describe`):
```js
const { tokensMaterial, selecionarMaterialId } = require('../src/constants/produtos');

describe('tokensMaterial', () => {
  test('separa número da unidade de gramatura', () => {
    expect(tokensMaterial('couchê 90g')).toEqual(['COUCHE', '90']);
  });
  test('descarta unidades e mantém palavras', () => {
    expect(tokensMaterial('vinil fosco')).toEqual(['VINIL', 'FOSCO']);
  });
  test('vazio', () => { expect(tokensMaterial('')).toEqual([]); });
});

describe('selecionarMaterialId', () => {
  const fix = [
    { id: 'a', nome: 'COUCHE LISO 90 GR 96X66' },
    { id: 'b', nome: 'COUCHE LISO 150 GR 96X66' },
    { id: 'c', nome: 'LONA 440 BRILHO' },
    { id: 'd', nome: 'VINIL FOSCO 1,50X50' },
  ];
  test('couchê 90g -> COUCHE 90', () => { expect(selecionarMaterialId(fix, 'couchê 90g')).toBe('a'); });
  test('lona -> LONA 440', () => { expect(selecionarMaterialId(fix, 'lona')).toBe('c'); });
  test('vinil fosco -> VINIL FOSCO', () => { expect(selecionarMaterialId(fix, 'vinil fosco')).toBe('d'); });
  test('sem correspondência -> null', () => { expect(selecionarMaterialId(fix, 'xyz')).toBeNull(); });
  test('termo vazio -> null', () => { expect(selecionarMaterialId(fix, '')).toBeNull(); });
  test('prefere o nome mais curto', () => {
    const f2 = [{ id: 'x', nome: 'COUCHE 90' }, { id: 'y', nome: 'COUCHE LISO 90 GR 96X66' }];
    expect(selecionarMaterialId(f2, 'couchê 90g')).toBe('x');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest tests/produtos.test.js`
Expected: FAIL (`tokensMaterial`/`selecionarMaterialId` não exportados).

- [ ] **Step 3: Implementar os helpers**

Em `src/constants/produtos.js`, ANTES de `module.exports`, adicionar:
```js
function _normTexto(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
const _STOP_MAT = new Set(['GR', 'G', 'GRS', 'KG', 'CM', 'MM', 'M', 'UN', 'UND', 'UNID', 'DE', 'DA', 'DO', 'COM', 'SEM']);
function tokensMaterial(termo) {
  const raw = _normTexto(termo).match(/[A-Z]+|[0-9]+/g) || [];
  return raw.filter(t => /[0-9]/.test(t) ? true : (t.length >= 2 && !_STOP_MAT.has(t)));
}
function selecionarMaterialId(materiais, termo) {
  const toks = tokensMaterial(termo);
  if (!toks.length) return null;
  const cand = (materiais || []).filter(m => {
    const n = _normTexto(m.nome);
    return toks.every(t => n.includes(t));
  });
  if (!cand.length) return null;
  cand.sort((a, b) => String(a.nome || '').length - String(b.nome || '').length);
  return cand[0].id;
}
```
E trocar a linha de export:
```js
module.exports = { PRODUTOS, matchProduto, tipoPorProduto, parseDimensoes };
```
Por:
```js
module.exports = { PRODUTOS, matchProduto, tipoPorProduto, parseDimensoes, tokensMaterial, selecionarMaterialId };
```
(Observação: o `[̀-ͯ]` é o range de combining marks U+0300–U+036F — pode escrever como `/[̀-ͯ]/g` para legibilidade.)

- [ ] **Step 4: Rodar e ver passar**

Run: `npx jest tests/produtos.test.js`
Expected: PASS (todos, incluindo os anteriores).

- [ ] **Step 5: Commit**

```bash
git add src/constants/produtos.js tests/produtos.test.js
git commit -m "feat(constants): tokensMaterial + selecionarMaterialId (match de material por tokens)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `_resolverMaterialId` usa match por tokens

**Files:**
- Modify: `src/modules/orders/service.js`

- [ ] **Step 1: Importar o seletor**

No topo, trocar:
```js
const { tipoPorProduto, parseDimensoes } = require('../../constants/produtos');
```
Por:
```js
const { tipoPorProduto, parseDimensoes, selecionarMaterialId } = require('../../constants/produtos');
```

- [ ] **Step 2: Reescrever `_resolverMaterialId`**

Substituir a função inteira por:
```js
async function _resolverMaterialId(nome) {
  const termo = String(nome || '').trim();
  if (!termo) return null;
  try {
    const todos = await db.query('SELECT id, nome FROM materiais WHERE status=$1', ['ativo']);
    const porTokens = selecionarMaterialId(todos.rows, termo);
    if (porTokens) return porTokens;
    const exato = await db.query('SELECT id FROM materiais WHERE status=$1 AND nome ILIKE $2 ORDER BY nome LIMIT 1', ['ativo', termo]);
    if (exato.rows[0]) return exato.rows[0].id;
    const parcial = await db.query('SELECT id FROM materiais WHERE status=$1 AND nome ILIKE $2 ORDER BY nome LIMIT 1', ['ativo', `%${termo}%`]);
    return parcial.rows[0] ? parcial.rows[0].id : null;
  } catch (e) { console.error('[MATERIAL-RESOLVE] Falha ao resolver material_id:', e.message); return null; }
}
```

- [ ] **Step 3: Sintaxe**

Run: `node --check src/modules/orders/service.js`
Expected: sem saída.

- [ ] **Step 4: Commit**

```bash
git add src/modules/orders/service.js
git commit -m "feat(orders): resolver material_id por match de tokens (fallback ILIKE)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Produto enum na tool + regra de padronização no prompt

**Files:**
- Modify: `src/ai/agent.js`

- [ ] **Step 1: Importar PRODUTOS e montar o enum (antes do SYSTEM_PROMPT)**

No topo do `src/ai/agent.js`, ANTES da linha `const SYSTEM_PROMPT = ...` (linha 8), inserir:
```js
const { PRODUTOS } = require('../constants/produtos');
const PRODUTO_ENUM = PRODUTOS.map(p => p.produto).concat('OUTROS');
```
(Se já houver um `require` de db etc. acima da linha 8, inserir logo após eles.)

- [ ] **Step 2: Acrescentar a regra 13 ao SYSTEM_PROMPT**

No template `SYSTEM_PROMPT`, imediatamente ANTES do crase de fechamento (logo após a regra 12, que termina em `NUNCA junte produtos diferentes num único item.`), inserir:
```js

13. PRODUTO E MATERIAL — PADRONIZAÇÃO (só para a função registrar_pedido; NÃO muda como você fala com o cliente):
   - Ao chamar registrar_pedido, o campo "produto" (e o "produto" de cada item em "itens") DEVE ser exatamente um dos valores desta lista oficial: ${PRODUTO_ENUM.join(', ')}. Mapeie o que o cliente pediu para o nome MAIS PRÓXIMO da lista. Se nada se encaixar, use "OUTROS" e descreva o produto em "observacoes".
   - O campo "material" deve ser um descritor limpo: família + gramatura/acabamento. Ex.: "couchê 90g", "lona 440", "vinil fosco", "cartolina 240g". Não invente material; se o cliente não souber, deixe em branco.
```
(Atenção: o SYSTEM_PROMPT é um template literal com crases; a interpolação `${PRODUTO_ENUM.join(', ')}` funciona porque `PRODUTO_ENUM` está definido antes. Garanta que a regra fique DENTRO das crases do template.)

- [ ] **Step 3: Pôr o enum no schema da tool**

No objeto `TOOLS`, no campo `produto` de nível superior:
```js
          produto:       { type: 'string' },
```
Trocar por:
```js
          produto:       { type: 'string', enum: PRODUTO_ENUM, description: 'Um dos valores da lista oficial de produtos LKL (ou OUTROS).' },
```
E no item do array `itens`:
```js
                produto:    { type: 'string' },
```
Trocar por:
```js
                produto:    { type: 'string', enum: PRODUTO_ENUM },
```

- [ ] **Step 4: Sintaxe + sanidade**

```bash
cd /Users/klebercamara/LKL
node --check src/ai/agent.js
node -e "const a=require('./src/ai/agent'); " 2>/dev/null; echo "require ok? $?"
grep -c "PRODUTO_ENUM" src/ai/agent.js
```
Expected: `node --check` sem saída; grep `PRODUTO_ENUM` ≥ 3 (definição + regra + 2 no schema = pode ser 4).

- [ ] **Step 5: Commit**

```bash
git add src/ai/agent.js
git commit -m "feat(chatbot): produto enum canônico na tool + regra de padronização produto/material

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Deploy + smoke (resolver real + diálogo) + memória

**Files:**
- Deploy: `src/constants/produtos.js`, `src/modules/orders/service.js`, `src/ai/agent.js`
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Deploy**

```bash
cd /Users/klebercamara/LKL
rsync -az src/constants/produtos.js root@2.25.147.243:/var/www/lkl-chatbot/src/constants/produtos.js
rsync -az src/modules/orders/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orders/service.js
rsync -az src/ai/agent.js root@2.25.147.243:/var/www/lkl-chatbot/src/ai/agent.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && sleep 2 && pm2 jlist | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const a=JSON.parse(d);const p=a.find(x=>x.name===\"lkl-chatbot\");console.log(\"status:\",p?.pm2_env?.status)})'"
```
Expected: `status: online`.

- [ ] **Step 2: Smoke do resolvedor real (cadastro de 106 materiais)**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e '
const db = require(\"./src/db/index\");
const { selecionarMaterialId } = require(\"./src/constants/produtos\");
(async () => {
  const todos = (await db.query(\"SELECT id, nome FROM materiais WHERE status=\$1\", [\"ativo\"])).rows;
  for (const termo of [\"couchê 90g\", \"lona\", \"vinil fosco\", \"cartolina 240g\", \"xyz\"]) {
    const id = selecionarMaterialId(todos, termo);
    const nome = id ? todos.find(m=>m.id===id).nome : null;
    console.log(termo, \"->\", nome || \"(nenhum)\");
  }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
'"
```
Expected: "couchê 90g"→um COUCHE 90; "lona"→uma LONA; "vinil fosco"→um VINIL FOSCO; "cartolina 240g"→CARTOLINA 240; "xyz"→(nenhum). Reportar a saída real.

- [ ] **Step 3: Smoke de diálogo (não determinístico — conferência)**

Rodar um diálogo roteirizado curto contra o agente e inspecionar os args da tool. No VPS:
```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e '
const { PRODUTOS } = require(\"./src/constants/produtos\");
const enumP = PRODUTOS.map(p=>p.produto).concat(\"OUTROS\");
console.log(\"PRODUTO_ENUM len:\", enumP.length, \"inclui CARTAZ?\", enumP.includes(\"CARTAZ\"), \"inclui OUTROS?\", enumP.includes(\"OUTROS\"));
const fs = require(\"fs\");
const src = fs.readFileSync(\"./src/ai/agent.js\",\"utf8\");
console.log(\"schema enum no produto?\", /produto:\s*\{\s*type:\s*.string., enum:/.test(src));
process.exit(0);
'"
```
Expected: enum com 29 itens, inclui CARTAZ e OUTROS; schema com enum no produto. (O teste de diálogo real com o modelo é feito pelo usuário no WhatsApp; aqui validamos que o enum/lista estão corretos e carregam.)

- [ ] **Step 4: Conferência manual (usuário)**

Pelo WhatsApp, pedir 2 produtos com material (ex.: "1000 cartazes 40x30 couchê 90g" + "1 banner 1,20x0,60 lona"). Conferir no painel: itens com Produto canônico (CARTAZ/BANNERS), Tipo correto, e material pré-selecionado quando houver correspondência. Reportar.

- [ ] **Step 5: Atualizar memória**

Em `project_sprint_status.md`, registrar:
"Chatbot tuning produto/material — CONCLUÍDO 2026-06-25. produtos.js: tokensMaterial + selecionarMaterialId (match por tokens, número separado da unidade, prefere nome mais curto; testes). orders/service.js _resolverMaterialId usa selecionarMaterialId (busca todos materiais ativos) com fallback ILIKE. agent.js: tool.produto e itens[].produto com enum=PRODUTOS+OUTROS; regra 13 no SYSTEM_PROMPT (produto∈lista oficial, material descritor limpo). Enum vale mesmo se agent_prompt custom estiver setado. Fora de escopo: dimensões/itens/tom. Smoke resolvedor: couchê 90g→COUCHE 90 etc."

- [ ] **Step 6: Sem commit de memória** (fora do git).

---

## Notas de verificação final

- `selecionarMaterialId` é puro e testado; `_resolverMaterialId` só o alimenta com as linhas do cadastro — o seletor não toca no banco.
- O `enum` na tool é a garantia forte (vale para qualquer prompt); a regra 13 ajuda o modelo a escolher bem e a manter o material limpo.
- Token numérico usa `includes` (substring), então "90" casa "90 GR" e também "190"/"290" se existirem — o desempate por nome mais curto mitiga; é best-effort aceitável para 106 SKUs.
- Reverter: `git revert` do commit correspondente. Nenhuma migração/dado alterado.
