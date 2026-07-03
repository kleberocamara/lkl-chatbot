# AO-4c — Lançar conta a pagar da compra na revenda — Design

**Data:** 2026-07-02
**Status:** Aprovado para escrita de plano
**Contexto:** Fecha o lado financeiro da revenda. AO-4b organizou a **compra** dos itens terceirizados no Graficonauta (registro do pedido → recebimento → entrega). Este sub-projeto lança automaticamente a **conta a pagar** correspondente — o que a LKL deve ao Graficonauta por essa compra — já integrando ao fluxo financeiro existente (M9-A / C6 / DDA).

## Objetivo

Ao registrar uma compra na revenda (pedido feito no Graficonauta), lançar automaticamente uma **conta a pagar** com **valor e vencimento digitados pelo operador**, vinculada à compra, entrando no fluxo financeiro existente.

## Premissas e decisões (do brainstorming)

- **Valor:** digitado pelo operador (o valor real que o Graficonauta cobrou) — não derivado do orçamento, evitando divergências de markup/acabamentos/prazo.
- **Quando:** no `criarCompra` — mesmo modal em que se registra o nº do pedido Graficonauta (a Graficonauta cobra no ato / pré-pago).
- **`tipo_despesa`:** fixo `SERVICO_TERCEIRIZADO` (impressão terceirizada).
- **`vencimento`:** digitado pelo operador, default hoje, editável (cobre pré-pago à vista e boleto com prazo).

## Arquitetura

Sem módulo novo. Estende o módulo `revenda-compras` (AO-4b) e grava direto na tabela `contas_pagar` (M9-A) dentro da transação existente.

- **`sql/migrations/048_revenda_compra_conta_pagar.sql`** — 2 colunas em `revenda_compras`.
- **`src/modules/revenda-compras/service.js`** — `criarCompra` ganha `valor_compra` + `vencimento`; dentro da transação (`client`) já existente, faz `INSERT INTO contas_pagar` e grava `conta_pagar_id`.
- **`src/modules/revenda-compras/router.js`** — a rota `POST /` aceita os 2 novos campos (sem rota nova).
- **`public/dashboard.html`** — modal "Criar compra" ganha 2 campos; a lista de compras mostra valor + selo "conta a pagar lançada".
- Reuso: tabela `contas_pagar` (M9-A).

> **Atomicidade:** `contasPagar.criar()` (M9-A) usa `query()` com conexão própria do pool, fora da transação do chamador. Para garantir "compra e conta nascem juntas ou nenhuma", o AO-4c faz o `INSERT INTO contas_pagar` com o **mesmo `client`** da transação de `criarCompra` (espelhando o INSERT de `criar()`), em vez de chamar `criar()`.

## Modelo de dados (migration 048)

```sql
ALTER TABLE revenda_compras
  ADD COLUMN IF NOT EXISTS valor_compra   NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS conta_pagar_id INTEGER
    REFERENCES contas_pagar(id) ON DELETE SET NULL;
```

> `contas_pagar.id` é `SERIAL` (INTEGER) — daí o tipo de `conta_pagar_id`. `conta_pagar_id` dá rastreabilidade e evita duplicar a conta. Próxima migration livre: **048**.

## Regras (service)

**`criarCompra({ item_ids, pedido_graficonauta, previsao_entrega, observacao, valor_compra, vencimento }, userId)`**:
- Valida obrigatoriedade/validade de `valor_compra` (> 0) e `vencimento` (presente) **antes** de abrir a transação → erro amigável 400.
- Dentro da mesma transação já existente (`client`, que cria `revenda_compras` + `revenda_compra_itens`):
  1. Inclui `valor_compra` no INSERT de `revenda_compras`.
  2. `INSERT INTO contas_pagar` com o mesmo `client`:
     ```js
     const contaR = await client.query(
       `INSERT INTO contas_pagar
          (descricao, fornecedor, tipo_despesa, valor, vencimento, tipo, tipo_entrada, observacao)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id`,
       [`Compra revenda #${numero} — pedido Graficonauta ${pedido_graficonauta || 's/nº'}`,
        'Graficonauta', 'SERVICO_TERCEIRIZADO', valor_compra, vencimento,
        'boleto', 'manual', `Gerada automaticamente da compra revenda #${numero}`]
     );
     ```
  3. `UPDATE revenda_compras SET conta_pagar_id=$1 WHERE id=$2` (ou grava no mesmo INSERT via `RETURNING` + segundo passo).
- Qualquer falha → `ROLLBACK` da transação inteira: compra e conta nascem juntas ou nenhuma.

**`receber()`** — inalterado (a conta já existe desde o pedido).

**`listar()` / `detalhe()`** — passam a retornar `valor_compra` e `conta_pagar_id` para a UI.

## API (`/api/v2/revenda-compras`)

- `POST /` — passa a aceitar `valor_compra` e `vencimento` no corpo (além de `item_ids`, `pedido_graficonauta`, `previsao_entrega`, `observacao`). Sem rota nova. Auth/`requireRole` inalterados.

## UI (aba "Compras Revenda")

- **Modal "Criar compra":** dois campos novos:
  - **Valor da compra (R$)** — `rc-valor`, obrigatório.
  - **Vencimento** — `rc-venc`, `type="date"`, obrigatório, default = hoje.
- **Lista de compras:** cada card mostra o **valor** e um selo **"conta a pagar lançada"** (com nº da conta), confirmando que o financeiro foi gerado.

## Erros e bordas

- `criarCompra` sem `valor_compra`/`vencimento` (ou valor ≤ 0) → 400 com mensagem amigável, antes de abrir transação.
- Falha no `INSERT INTO contas_pagar` → `ROLLBACK` total (compra não é criada).
- Compra criada em AO-4b (antes desta migration) tem `valor_compra`/`conta_pagar_id` NULL — a UI trata a ausência do selo graciosamente.

## Testes

- **Unitário (Jest):** validação pura de `valor_compra > 0` e `vencimento` presente em `criarCompra` (sem banco).
- **Teste de rota leve:** o router carrega sem erro.
- **Smoke E2E no VPS:** criar compra com `valor_compra`+`vencimento` → conferir `revenda_compras.conta_pagar_id` preenchido e linha em `contas_pagar` com `fornecedor='Graficonauta'`, `tipo_despesa='SERVICO_TERCEIRIZADO'`, `valor`/`vencimento` corretos; conferir que aparece no financeiro (DDA/board M9-A); cleanup.

## Fora de escopo (AO-4c)

- Baixa/conciliação automática do pagamento (fica no fluxo C6/DDA existente).
- Rateio do valor por item da compra (conta única, valor total digitado).
- Editar/estornar a conta a partir da tela de compras (usa-se o financeiro).

## Dependências

- AO-4b concluído (`revenda_compras` + `criarCompra`). M9-A concluído (`contas_pagar` + `criar()`). Nenhuma dependência externa nova.
