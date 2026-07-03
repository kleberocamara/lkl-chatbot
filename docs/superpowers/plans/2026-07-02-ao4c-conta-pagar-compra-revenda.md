# AO-4c — Lançar conta a pagar da compra na revenda — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ao registrar uma compra na revenda, lançar automaticamente uma conta a pagar (valor e vencimento digitados pelo operador), na mesma transação, vinculada à compra.

**Architecture:** Estende o módulo `revenda-compras` (AO-4b). `criarCompra` passa a receber `valor_compra` + `vencimento`, valida-os por uma função pura, e dentro da transação existente faz `INSERT INTO contas_pagar` (mesmo `client`) e grava `conta_pagar_id`. UI ganha 2 campos no modal e mostra valor/selo na lista.

**Tech Stack:** Node.js + Express + PostgreSQL (pg), Jest, vanilla-JS `public/dashboard.html`.

**Design de referência:** `docs/superpowers/specs/2026-07-02-ao4c-conta-pagar-compra-revenda-design.md`

**Convenções do projeto:**
- Sem Postgres local — funções puras testadas com Jest; integração validada por smoke no VPS.
- Migrations numeradas em `sql/migrations/`, aplicadas manualmente no VPS. Próxima livre: **048**.
- Deploy: rsync + `pm2 restart lkl-chatbot --update-env` no VPS `2.25.147.243` (`/var/www/lkl-chatbot`).
- Testes rodam com `npm test` (jest --runInBand). Testes ficam em `tests/`.

---

## File Structure

- **Create:** `sql/migrations/048_revenda_compra_conta_pagar.sql` — 2 colunas em `revenda_compras`.
- **Create:** `tests/revenda-compras-validacao.test.js` — teste unitário da função pura de validação.
- **Modify:** `src/modules/revenda-compras/service.js` — função pura `validarDadosConta`, e `criarCompra` (valida + INSERT contas_pagar + conta_pagar_id); `listar`/`detalhe` já retornam `c.*`/`*`, então `valor_compra` e `conta_pagar_id` vêm automaticamente.
- **Modify:** `public/dashboard.html` — modal `criarCompraRevenda` (2 campos), `salvarCompraRevenda` (envia campos), `loadComprasLista` (mostra valor + selo).
- **Sem alteração:** `src/modules/revenda-compras/router.js` — a rota `POST /` já repassa `req.body` inteiro a `criarCompra`.

---

## Task 1: Migration 048 — colunas valor_compra + conta_pagar_id

**Files:**
- Create: `sql/migrations/048_revenda_compra_conta_pagar.sql`

- [ ] **Step 1: Escrever a migration**

Create `sql/migrations/048_revenda_compra_conta_pagar.sql`:

```sql
-- AO-4c: vincula a compra na revenda à conta a pagar gerada.
BEGIN;

ALTER TABLE revenda_compras
  ADD COLUMN IF NOT EXISTS valor_compra   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS conta_pagar_id INTEGER
    REFERENCES contas_pagar(id) ON DELETE SET NULL;

COMMIT;
```

- [ ] **Step 2: Conferir sintaxe SQL**

Run: `grep -c "ADD COLUMN IF NOT EXISTS" sql/migrations/048_revenda_compra_conta_pagar.sql`
Expected: `2`

- [ ] **Step 3: Commit**

```bash
git add sql/migrations/048_revenda_compra_conta_pagar.sql
git commit -m "feat(ao4c): migration 048 revenda_compras.valor_compra + conta_pagar_id"
```

> A migration é aplicada manualmente no VPS na Task 4 (deploy). Não há Postgres local.

---

## Task 2: Função pura de validação + teste unitário

**Files:**
- Modify: `src/modules/revenda-compras/service.js:24` (adicionar `validarDadosConta` antes de `criarCompra`)
- Create: `tests/revenda-compras-validacao.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Create `tests/revenda-compras-validacao.test.js`:

```js
const { validarDadosConta } = require('../src/modules/revenda-compras/service');

describe('validarDadosConta', () => {
  test('aceita valor positivo e vencimento presente', () => {
    expect(validarDadosConta({ valor_compra: 150.5, vencimento: '2026-07-10' })).toEqual([]);
  });
  test('rejeita valor ausente', () => {
    expect(validarDadosConta({ vencimento: '2026-07-10' })).toContain('Informe o valor da compra (maior que zero)');
  });
  test('rejeita valor zero ou negativo', () => {
    expect(validarDadosConta({ valor_compra: 0, vencimento: '2026-07-10' })).toContain('Informe o valor da compra (maior que zero)');
    expect(validarDadosConta({ valor_compra: -5, vencimento: '2026-07-10' })).toContain('Informe o valor da compra (maior que zero)');
  });
  test('rejeita valor não numérico', () => {
    expect(validarDadosConta({ valor_compra: 'abc', vencimento: '2026-07-10' })).toContain('Informe o valor da compra (maior que zero)');
  });
  test('rejeita vencimento ausente', () => {
    expect(validarDadosConta({ valor_compra: 10 })).toContain('Informe o vencimento da conta a pagar');
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx jest tests/revenda-compras-validacao.test.js`
Expected: FAIL — `validarDadosConta is not a function`.

- [ ] **Step 3: Implementar a função pura**

In `src/modules/revenda-compras/service.js`, add right after the `itensACompra` function (before `criarCompra`, around line 23):

```js
// Valida os dados da conta a pagar informados pelo operador (função pura, testável sem banco).
function validarDadosConta({ valor_compra, vencimento }) {
  const erros = [];
  const v = Number(valor_compra);
  if (!Number.isFinite(v) || v <= 0) erros.push('Informe o valor da compra (maior que zero)');
  if (!vencimento) erros.push('Informe o vencimento da conta a pagar');
  return erros;
}
```

- [ ] **Step 4: Exportar a função**

In `src/modules/revenda-compras/service.js`, change the last line (`module.exports = { itensACompra, criarCompra, receber, listar, detalhe };`) to:

```js
module.exports = { itensACompra, criarCompra, receber, listar, detalhe, validarDadosConta };
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `npx jest tests/revenda-compras-validacao.test.js`
Expected: PASS (5 testes).

- [ ] **Step 6: Commit**

```bash
git add src/modules/revenda-compras/service.js tests/revenda-compras-validacao.test.js
git commit -m "feat(ao4c): validarDadosConta (valor/vencimento) + testes"
```

---

## Task 3: criarCompra lança a conta a pagar na transação

**Files:**
- Modify: `src/modules/revenda-compras/service.js:24-58` (`criarCompra`)

- [ ] **Step 1: Substituir a função `criarCompra`**

In `src/modules/revenda-compras/service.js`, replace the entire `criarCompra` function (lines 24–58) with:

```js
async function criarCompra({ item_ids, pedido_graficonauta, previsao_entrega, observacao, valor_compra, vencimento }, userId) {
  if (!Array.isArray(item_ids) || !item_ids.length) return { erro: ['Selecione ao menos um item'] };
  const errosConta = validarDadosConta({ valor_compra, vencimento });
  if (errosConta.length) return { erro: errosConta };
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const val = await client.query(
      `SELECT oi.id, orc.cliente_id
       FROM orcamento_itens oi JOIN orcamentos orc ON orc.id = oi.orcamento_id
       WHERE oi.id = ANY($1) AND orc.status='aprovado' AND oi.tipo_producao='REVENDA' AND oi.arte_status='aprovada'
         AND NOT EXISTS (SELECT 1 FROM revenda_compra_itens rci WHERE rci.orcamento_item_id = oi.id)`,
      [item_ids]
    );
    if (val.rows.length !== item_ids.length) {
      await client.query('ROLLBACK');
      return { erro: ['Um ou mais itens não são elegíveis (não são revenda aprovada com arte, ou já estão em outra compra)'] };
    }
    const clienteId = val.rows[0].cliente_id || null;
    const compraR = await client.query(
      `INSERT INTO revenda_compras (status, pedido_graficonauta, cliente_id, previsao_entrega, observacao, responsavel_id, valor_compra)
       VALUES ('pedido_feito', $1, $2, $3, $4, $5, $6) RETURNING id, numero`,
      [pedido_graficonauta || null, clienteId, previsao_entrega || null, observacao || null, userId || null, valor_compra]
    );
    const compraId = compraR.rows[0].id;
    const numero = compraR.rows[0].numero;
    for (const it of val.rows) {
      await client.query('INSERT INTO revenda_compra_itens (compra_id, orcamento_item_id) VALUES ($1,$2)', [compraId, it.id]);
    }
    const contaR = await client.query(
      `INSERT INTO contas_pagar
         (descricao, fornecedor, tipo_despesa, valor, vencimento, tipo, tipo_entrada, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [`Compra revenda #${numero} — pedido Graficonauta ${pedido_graficonauta || 's/nº'}`,
       'Graficonauta', 'SERVICO_TERCEIRIZADO', valor_compra, vencimento,
       'boleto', 'manual', `Gerada automaticamente da compra revenda #${numero}`]
    );
    await client.query('UPDATE revenda_compras SET conta_pagar_id=$1 WHERE id=$2', [contaR.rows[0].id, compraId]);
    await client.query('COMMIT');
    return { item: { id: compraId, numero, conta_pagar_id: contaR.rows[0].id } };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 2: Verificar que o router não precisa mudar**

Run: `grep -n "service.criarCompra(req.body" src/modules/revenda-compras/router.js`
Expected: uma linha — o router já repassa `req.body` inteiro, então `valor_compra`/`vencimento` chegam automaticamente. Nenhuma alteração no router.

- [ ] **Step 3: Rodar a suíte para garantir que nada quebrou**

Run: `npm test`
Expected: PASS (inclui os 5 testes de `validarDadosConta`; nenhum teste existente quebra).

- [ ] **Step 4: Commit**

```bash
git add src/modules/revenda-compras/service.js
git commit -m "feat(ao4c): criarCompra grava valor_compra e lança conta a pagar na transacao"
```

---

## Task 4: UI — modal com valor/vencimento e selo na lista

**Files:**
- Modify: `public/dashboard.html:3603-3633` (`criarCompraRevenda`, `salvarCompraRevenda`, `loadComprasLista`)

- [ ] **Step 1: Adicionar os 2 campos no modal**

In `public/dashboard.html`, replace the body of `criarCompraRevenda` (lines 3606–3611, the `showModal(...)` call) so it includes valor + vencimento. Replace:

```js
  showModal('Criar compra na revenda', `
    <p style="font-size:13px;color:#666">${ids.length} item(ns) selecionado(s).</p>
    <label style="font-size:13px">Nº do pedido no Graficonauta<br><input id="rc-pedido" placeholder="ex.: 123456" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px"></label>
    <label style="font-size:13px">Previsão de entrega (opcional)<br><input id="rc-prev" type="date" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px"></label>
    <label style="font-size:13px">Observação (opcional)<br><input id="rc-obs" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px"></label>
    <button class="btn btn-primary" style="width:100%;margin-top:10px" onclick='salvarCompraRevenda(${JSON.stringify(ids)})'>Criar compra</button>`);
```

with:

```js
  const hoje = new Date().toISOString().slice(0, 10);
  showModal('Criar compra na revenda', `
    <p style="font-size:13px;color:#666">${ids.length} item(ns) selecionado(s).</p>
    <label style="font-size:13px">Nº do pedido no Graficonauta<br><input id="rc-pedido" placeholder="ex.: 123456" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px"></label>
    <label style="font-size:13px">Valor da compra (R$)<br><input id="rc-valor" type="number" step="0.01" min="0" placeholder="ex.: 150.00" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px"></label>
    <label style="font-size:13px">Vencimento<br><input id="rc-venc" type="date" value="${hoje}" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px"></label>
    <label style="font-size:13px">Previsão de entrega (opcional)<br><input id="rc-prev" type="date" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px"></label>
    <label style="font-size:13px">Observação (opcional)<br><input id="rc-obs" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px"></label>
    <button class="btn btn-primary" style="width:100%;margin-top:10px" onclick='salvarCompraRevenda(${JSON.stringify(ids)})'>Criar compra</button>`);
```

- [ ] **Step 2: Enviar os campos no `salvarCompraRevenda`**

In `public/dashboard.html`, replace the `body` object in `salvarCompraRevenda` (lines 3614–3615):

```js
  const body = { item_ids: ids, pedido_graficonauta: document.getElementById('rc-pedido').value || null,
    previsao_entrega: document.getElementById('rc-prev').value || null, observacao: document.getElementById('rc-obs').value || null };
```

with:

```js
  const body = { item_ids: ids, pedido_graficonauta: document.getElementById('rc-pedido').value || null,
    valor_compra: document.getElementById('rc-valor').value || null,
    vencimento: document.getElementById('rc-venc').value || null,
    previsao_entrega: document.getElementById('rc-prev').value || null, observacao: document.getElementById('rc-obs').value || null };
```

- [ ] **Step 3: Mostrar valor + selo na lista de compras**

In `public/dashboard.html`, in `loadComprasLista`, replace the inner line that renders `num_itens` / pedido / status (line 3627–3629):

```js
          <div><b>Compra #${c.numero}</b> · ${escHtml(c.cliente_nome || '-')} · ${c.num_itens} item(ns)
            ${c.pedido_graficonauta ? '· pedido ' + escHtml(c.pedido_graficonauta) : ''}
            <span style="padding:2px 8px;border-radius:10px;font-size:11px;background:${c.status === 'recebido' ? '#e8f5e9' : '#fff3e0'}">${c.status}</span></div>
```

with:

```js
          <div><b>Compra #${c.numero}</b> · ${escHtml(c.cliente_nome || '-')} · ${c.num_itens} item(ns)
            ${c.pedido_graficonauta ? '· pedido ' + escHtml(c.pedido_graficonauta) : ''}
            ${c.valor_compra != null ? '· R$ ' + Number(c.valor_compra).toFixed(2) : ''}
            <span style="padding:2px 8px;border-radius:10px;font-size:11px;background:${c.status === 'recebido' ? '#e8f5e9' : '#fff3e0'}">${c.status}</span>
            ${c.conta_pagar_id ? '<span style="padding:2px 8px;border-radius:10px;font-size:11px;background:#e3f2fd;margin-left:4px">💰 conta a pagar #' + c.conta_pagar_id + '</span>' : ''}</div>
```

- [ ] **Step 4: Verificar as edições**

Run: `grep -n "rc-valor\|rc-venc\|conta a pagar #" public/dashboard.html`
Expected: linhas do modal (rc-valor, rc-venc), do body (rc-valor, rc-venc) e do selo na lista.

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(ao4c): UI compra revenda com valor/vencimento e selo conta a pagar"
```

---

## Task 5: Deploy VPS + smoke E2E + memória

**Files:** nenhum código novo — deploy e verificação.

- [ ] **Step 1: Aplicar a migration 048 no VPS**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl -f -" < sql/migrations/048_revenda_compra_conta_pagar.sql
```

Expected: `ALTER TABLE` (sem erro). Conferir:

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl -c \"\\d revenda_compras\"" | grep -E "valor_compra|conta_pagar_id"
```
Expected: as 2 colunas listadas.

- [ ] **Step 2: Rsync do código para o VPS**

```bash
rsync -avz --exclude node_modules --exclude .git \
  src/modules/revenda-compras/service.js \
  root@2.25.147.243:/var/www/lkl-chatbot/src/modules/revenda-compras/service.js
rsync -avz public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```

Expected: transferência sem erro.

- [ ] **Step 3: Restart do app**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```

Expected: status `online`. Conferir:
```bash
ssh root@2.25.147.243 "pm2 list | grep lkl-chatbot"
```

- [ ] **Step 4: Smoke E2E (via SQL direto no VPS)**

Criar cenário sintético e chamar `criarCompra` pelo service não é possível via curl sem um item elegível real; então valida-se em duas partes:

(a) **Conferir que a rota está viva:**
```bash
ssh root@2.25.147.243 "curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v2/revenda-compras/a-comprar"
```
Expected: `401` (sem cookie) — confirma que a rota responde e exige auth.

(b) **Teste transacional com item real:** se houver um item elegível em `a-comprar` (orçamento aprovado + REVENDA + arte aprovada), criar uma compra pela UI com valor `1.00` e vencimento hoje, depois conferir no banco:
```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl -c \"SELECT rc.numero, rc.valor_compra, rc.conta_pagar_id, cp.fornecedor, cp.tipo_despesa, cp.valor, cp.vencimento FROM revenda_compras rc JOIN contas_pagar cp ON cp.id = rc.conta_pagar_id ORDER BY rc.created_at DESC LIMIT 1;\""
```
Expected: linha com `conta_pagar_id` preenchido, `fornecedor='Graficonauta'`, `tipo_despesa='SERVICO_TERCEIRIZADO'`, `valor=1.00`, `vencimento` = hoje.

(c) **Cleanup do teste (se criado em (b)):**
```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl -c \"DELETE FROM contas_pagar WHERE id IN (SELECT conta_pagar_id FROM revenda_compras WHERE valor_compra=1.00); DELETE FROM revenda_compra_itens WHERE compra_id IN (SELECT id FROM revenda_compras WHERE valor_compra=1.00); DELETE FROM revenda_compras WHERE valor_compra=1.00;\""
```

- [ ] **Step 5: Atualizar a memória do projeto**

Update `project_sprint_status.md` (via memory) marcando AO-4c como concluído e deployado, com a nota: "compra na revenda lança conta a pagar (SERVICO_TERCEIRIZADO, valor/vencimento digitados) na mesma transação; `revenda_compras.conta_pagar_id`."

- [ ] **Step 6: Commit final (se houver ajustes) e encerrar a branch**

Usar `superpowers:finishing-a-development-branch`.

---

## Self-Review

**1. Spec coverage:**
- Valor digitado pelo operador → Task 4 (campo `rc-valor`), Task 3 (grava `valor_compra`). ✓
- Conta criada no `criarCompra` → Task 3. ✓
- `tipo_despesa` fixo `SERVICO_TERCEIRIZADO` → Task 3 INSERT. ✓
- Vencimento digitado (default hoje) → Task 4 (`rc-venc` value=hoje), Task 3 usa `vencimento`. ✓
- Migration 048 (2 colunas) → Task 1. ✓
- Atomicidade (mesmo `client`) → Task 3 (INSERT contas_pagar com `client`). ✓
- Validação valor>0 / vencimento presente → Task 2 (função pura + testes) + Task 3 (chamada). ✓
- Router sem rota nova → Task 3 Step 2 confirma. ✓
- UI selo "conta a pagar lançada" → Task 4 Step 3. ✓
- `listar`/`detalhe` retornam novos campos → automático (`c.*` / `*`), sem tarefa extra. ✓
- Smoke E2E + memória → Task 5. ✓

**2. Placeholder scan:** nenhum TBD/TODO; todos os steps de código têm o código completo. ✓

**3. Type consistency:** `validarDadosConta({ valor_compra, vencimento })` usada igual em Task 2 e Task 3; `conta_pagar_id`, `valor_compra`, `rc-valor`, `rc-venc` consistentes entre tasks. ✓
