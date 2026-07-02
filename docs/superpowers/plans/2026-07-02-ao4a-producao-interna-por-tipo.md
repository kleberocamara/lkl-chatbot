# AO-4a — Produção Interna por Tipo de Serviço — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Itens de revenda produzidos internamente pela LKL (interno_m2 / manual) recebem o `tipo_producao` correto (OFFSET/CV) e passam a gerar OS pelo fluxo existente; terceirizados (revenda_matriz) ficam de fora.

**Architecture:** Uma função pura de mapeamento `tipoProducaoDoItemRevenda(estrategia, tipo_servico)` + gravar esse valor no POST/PATCH de item (em vez do fixo 'REVENDA'). Nenhuma mudança no módulo de OS — as criações de OS existentes (CV automática / offset manual) já filtram por tipo_producao OFFSET/CV.

**Tech Stack:** Node.js + Express, PostgreSQL (`pg`), Jest (função pura).

**Spec:** `docs/superpowers/specs/2026-07-02-ao4a-producao-interna-por-tipo-design.md`

---

## File Structure

- **Modify** `src/constants/produtos.js` — nova função pura `tipoProducaoDoItemRevenda(estrategia, tipo_servico)`.
- **Test** `tests/produtos.test.js` — testes da função.
- **Modify** `src/modules/orcamentos/router.js` — POST e PATCH de item gravam `tipo_producao` mapeado quando o item é de revenda.
- **Backfill + deploy** — UPDATE único no VPS + smoke.

> **Convenções:** só a suíte pura (`tests/produtos.test.js`) roda local (deve passar); integração via smoke no VPS. Deploy = `rsync` + `pm2 restart lkl-chatbot --update-env`. Nenhuma migration (o backfill é um comando único). O módulo de OS **não é tocado**.

---

## Task 1: Função pura `tipoProducaoDoItemRevenda` (TDD)

**Files:**
- Modify: `src/constants/produtos.js`
- Test: `tests/produtos.test.js`

Mapeia a estratégia + tipo de serviço do produto de revenda para o `tipo_producao` do item do orçamento:
- `interno_m2` → `'COMUNICAÇÃO VISUAL'` (sempre CV)
- `manual` → do tipo_servico: `'OFFSET'`→`'OFFSET'`; `'COMUNICAÇÃO VISUAL'`→`'COMUNICAÇÃO VISUAL'`; qualquer outro (ex.: `'IMP. DIGITAL'`) → `'REVENDA'`
- qualquer outra estratégia (`revenda_matriz`, nula) → `'REVENDA'`

- [ ] **Step 1: Acrescentar os testes** ao final de `tests/produtos.test.js`:

```javascript
const { tipoProducaoDoItemRevenda } = require('../src/constants/produtos');

describe('tipoProducaoDoItemRevenda', () => {
  test('interno_m2 é sempre COMUNICAÇÃO VISUAL', () => {
    expect(tipoProducaoDoItemRevenda('interno_m2', 'COMUNICAÇÃO VISUAL')).toBe('COMUNICAÇÃO VISUAL');
    expect(tipoProducaoDoItemRevenda('interno_m2', 'OFFSET')).toBe('COMUNICAÇÃO VISUAL');
  });
  test('manual OFFSET → OFFSET', () => {
    expect(tipoProducaoDoItemRevenda('manual', 'OFFSET')).toBe('OFFSET');
  });
  test('manual CV → COMUNICAÇÃO VISUAL', () => {
    expect(tipoProducaoDoItemRevenda('manual', 'COMUNICAÇÃO VISUAL')).toBe('COMUNICAÇÃO VISUAL');
  });
  test('manual IMP. DIGITAL → REVENDA (fora da produção interna)', () => {
    expect(tipoProducaoDoItemRevenda('manual', 'IMP. DIGITAL')).toBe('REVENDA');
  });
  test('revenda_matriz → REVENDA', () => {
    expect(tipoProducaoDoItemRevenda('revenda_matriz', 'OFFSET')).toBe('REVENDA');
    expect(tipoProducaoDoItemRevenda('revenda_matriz', 'COMUNICAÇÃO VISUAL')).toBe('REVENDA');
  });
  test('estrategia/tipo ausentes → REVENDA', () => {
    expect(tipoProducaoDoItemRevenda(null, null)).toBe('REVENDA');
    expect(tipoProducaoDoItemRevenda(undefined, undefined)).toBe('REVENDA');
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

Run: `npx jest tests/produtos.test.js --no-coverage -t tipoProducaoDoItemRevenda`
Expected: FAIL — `tipoProducaoDoItemRevenda is not a function`.

- [ ] **Step 3: Implementar** em `src/constants/produtos.js` (acrescentar antes do `module.exports`):

```javascript
// AO-4a: tipo_producao do item de revenda conforme a estratégia do produto do catálogo.
// interno_m2 = produção CV interna; manual = pelo tipo de serviço; revenda_matriz/IMP.DIGITAL = terceirizado (REVENDA).
function tipoProducaoDoItemRevenda(estrategia, tipo_servico) {
  if (estrategia === 'interno_m2') return 'COMUNICAÇÃO VISUAL';
  if (estrategia === 'manual') {
    if (tipo_servico === 'OFFSET') return 'OFFSET';
    if (tipo_servico === 'COMUNICAÇÃO VISUAL') return 'COMUNICAÇÃO VISUAL';
    return 'REVENDA';
  }
  return 'REVENDA';
}
```
E incluir `tipoProducaoDoItemRevenda` no `module.exports` (junto de `PRODUTOS, matchProduto, tipoPorProduto, parseDimensoes, tokensMaterial, selecionarMaterialId`).

- [ ] **Step 4: Rodar — deve passar**

Run: `npx jest tests/produtos.test.js --no-coverage`
Expected: PASS — todos verdes (existentes + os 6 novos).

- [ ] **Step 5: Commit**

```bash
git add src/constants/produtos.js tests/produtos.test.js
git commit -m "feat(ao4a): tipoProducaoDoItemRevenda (mapeia estrategia/tipo_servico -> tipo_producao) com testes"
```

---

## Task 2: Gravar tipo_producao no POST/PATCH de item de revenda

**Files:**
- Modify: `src/modules/orcamentos/router.js`

Hoje o POST faz `if (revenda_produto_id) tp = 'REVENDA';` **dentro** do bloco de preço (não roda quando o cálculo é null, ex.: item manual). Corrigir: para qualquer item de revenda, buscar `estrategia`/`tipo_servico` do produto e mapear com a função pura — independente do preço.

- [ ] **Step 1: Importar a função pura**

No topo de `src/modules/orcamentos/router.js`, onde já há requires, garantir o import (o arquivo já pode importar de `produtos`; se não, adicionar):
```javascript
const { tipoProducaoDoItemRevenda } = require('../../constants/produtos');
```

- [ ] **Step 2: POST — setar `tp` fora do bloco de preço**

No handler `router.post('/:id/itens', ...)`, **remover** a linha `if (revenda_produto_id) tp = 'REVENDA';` (que está dentro do `if (calc) {`) e, logo **após** a linha `let tp = tipo_producao || null;`, inserir:
```javascript
    if (revenda_produto_id) {
      const rp = (await db.query('SELECT estrategia, tipo_servico FROM revenda_produtos WHERE id=$1', [revenda_produto_id])).rows[0];
      tp = tipoProducaoDoItemRevenda(rp?.estrategia, rp?.tipo_servico);
    }
```
(O `tp` já é usado como `tipo_producao` no INSERT — nada mais muda no INSERT.)

- [ ] **Step 3: PATCH — mapear `tipo_producao` para item de revenda**

No handler `router.patch('/:id/itens/:itemId', ...)`, o `UPDATE` grava `tipo_producao=COALESCE($4,tipo_producao)` com o parâmetro `tipo_producao ?? null`. Precisamos sobrescrever quando o item é de revenda. Logo após o `const { produto, tipo_producao, ... } = req.body;` (início do handler), calcular o tipo efetivo:
```javascript
    let tpPatch = tipo_producao ?? null;
    const revIdPatch = revenda_produto_id !== undefined ? revenda_produto_id : null;
    if (revIdPatch) {
      const rp = (await db.query('SELECT estrategia, tipo_servico FROM revenda_produtos WHERE id=$1', [revIdPatch])).rows[0];
      tpPatch = tipoProducaoDoItemRevenda(rp?.estrategia, rp?.tipo_servico);
    }
```
E no array de parâmetros do `UPDATE`, trocar o valor de `tipo_producao ?? null` (o 4º parâmetro, `$4`) por `tpPatch`.
> Atenção: só troque o **4º elemento** do array de params (o que corresponde a `tipo_producao=COALESCE($4,...)`). Os demais parâmetros e a numeração `$n` permanecem idênticos. Se `revenda_produto_id` não veio no PATCH (edição de campos não-revenda), `revIdPatch` é null → `tpPatch = tipo_producao ?? null` (comportamento atual preservado).

- [ ] **Step 4: Sanidade — módulo carrega**

Run: `node -e "require('./src/modules/orcamentos/router'); console.log('orcamentos router OK')"`
Expected: `orcamentos router OK`

- [ ] **Step 5: Commit**

```bash
git add src/modules/orcamentos/router.js
git commit -m "feat(ao4a): item de revenda interno grava tipo_producao OFFSET/CV (entra na producao); terceirizado fica REVENDA"
```

---

## Task 3: Deploy VPS + backfill + smoke + memória

**Files:**
- Modify: `~/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Deploy**

```bash
rsync -az --exclude node_modules --exclude .git --exclude backups --exclude 'tests/fixtures/revenda' /Users/klebercamara/LKL/ root@2.25.147.243:/var/www/lkl-chatbot/
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1; pm2 status lkl-chatbot | grep -oE 'online|errored'"
```
Expected: `online`.

- [ ] **Step 2: Backfill dos itens internos já lançados**

```bash
ssh root@2.25.147.243 'set -a; . /var/www/lkl-chatbot/.env; set +a; PGPASSWORD="$DB_PASSWORD" psql -h localhost -U "$DB_USER" -d "$DB_NAME" -c "
UPDATE orcamento_itens oi
SET tipo_producao = CASE
  WHEN rp.estrategia = '"'"'interno_m2'"'"' THEN '"'"'COMUNICAÇÃO VISUAL'"'"'
  WHEN rp.estrategia = '"'"'manual'"'"' AND rp.tipo_servico = '"'"'OFFSET'"'"' THEN '"'"'OFFSET'"'"'
  WHEN rp.estrategia = '"'"'manual'"'"' AND rp.tipo_servico = '"'"'COMUNICAÇÃO VISUAL'"'"' THEN '"'"'COMUNICAÇÃO VISUAL'"'"'
  ELSE oi.tipo_producao END
FROM revenda_produtos rp
WHERE oi.revenda_produto_id = rp.id
  AND rp.estrategia IN ('"'"'interno_m2'"'"','"'"'manual'"'"')
  AND oi.tipo_producao = '"'"'REVENDA'"'"';"'
```
Expected: `UPDATE N` (N = itens internos já existentes; pode ser 0 se ainda não houver itens de revenda lançados).

- [ ] **Step 3: Smoke — mapeamento e criação de OS**

```bash
ssh root@2.25.147.243 'cd /var/www/lkl-chatbot && node -e "
require(\"dotenv\").config();
const { tipoProducaoDoItemRevenda } = require(\"./src/constants/produtos\");
console.log(\"interno_m2/CV =>\", tipoProducaoDoItemRevenda(\"interno_m2\",\"COMUNICAÇÃO VISUAL\"));
console.log(\"manual/OFFSET =>\", tipoProducaoDoItemRevenda(\"manual\",\"OFFSET\"));
console.log(\"revenda_matriz =>\", tipoProducaoDoItemRevenda(\"revenda_matriz\",\"OFFSET\"));
process.exit(0);
"'
```
Expected: `interno_m2/CV => COMUNICAÇÃO VISUAL`, `manual/OFFSET => OFFSET`, `revenda_matriz => REVENDA`.

> **Validação funcional (usuário, no painel):** adicionar um item interno_m2 num orçamento, enviar+aprovar a arte, e confirmar que nasce uma OS de Comunicação Visual com o item; adicionar um item manual OFFSET e confirmar que aparece em "Gerar OS Offset"; item revenda_matriz não gera OS. (Requer sessão logada — fica com o usuário.)

- [ ] **Step 4: Atualizar memória**

Acrescentar ao `project_sprint_status.md`: AO-4a concluído — função pura tipoProducaoDoItemRevenda (interno_m2→CV; manual→OFFSET/CV pelo tipo_servico; revenda_matriz/IMP.DIGITAL→REVENDA); POST/PATCH de item de revenda gravam tipo_producao mapeado (fora do bloco de preço, vale p/ item manual sem preço); módulo de OS inalterado (criarOSComunicacaoVisual/itensOffsetDisponiveis já pegam por tipo_producao OFFSET/CV + arte aprovada). Backfill rodado. Itens internos (interno_m2/manual) agora geram OS pelo fluxo existente; terceirizados (revenda_matriz) ficam fora. Commits <preencher>. FORA DE ESCOPO: AO-4b (terceirização dos revenda_matriz: enviar arte ao Graficonauta + acompanhar pedido); baixa de estoque dos interno_m2 (usam bobina_grupo, não material_id).

- [ ] **Step 5: Commit final**

```bash
git add -A
git commit -m "chore(ao4a): backfill + smoke VPS + memoria (producao interna por tipo)"
```

---

## Self-Review (autor do plano)

**Cobertura do spec:** função de mapeamento → Task 1 ✓; gravar tipo_producao no POST e PATCH → Task 2 ✓; reuso do módulo de OS (nada a fazer) ✓; backfill → Task 3 Step 2 ✓; smoke + memória → Task 3 ✓; fora de escopo (AO-4b, baixa m²) documentado ✓.

**Consistência:** `tipoProducaoDoItemRevenda(estrategia, tipo_servico)` idêntico em produtos.js, testes, POST e PATCH. Valores de `tipo_producao` ('OFFSET'/'COMUNICAÇÃO VISUAL'/'REVENDA') batem com os filtros de `os/service.js` (`criarOSComunicacaoVisual`/`itensOffsetDisponiveis` usam exatamente essas strings). O backfill usa a mesma lógica da função pura.

**Notas:** só `tests/produtos.test.js` roda local (deve passar). A Task 2 mexe num handler já modificado por AO-1/2b/3 — o implementador deve LER o handler atual e preservar a numeração `$n` do UPDATE (trocar apenas o valor do 4º parâmetro no PATCH). A validação funcional de criação de OS é do usuário no painel (requer login).
