# AG-1 — DRE (Demonstração de Resultado) — Design

**Data:** 2026-06-24
**Contexto:** Primeiro dos 4 subprojetos de "Análises Gerenciais" (aba `#page-analises`,
hoje placeholder). Ordem: **AG-1 DRE** → AG-2 Fluxo de Caixa → AG-3 Metas → AG-4 Insights IA.
O DRE estabelece a camada de agregação financeira reutilizada pelos seguintes.

## Objetivo

Mostrar o resultado do período (lucro/prejuízo) por **regime de caixa**: receita
efetivamente recebida menos despesas efetivamente pagas, com as despesas detalhadas por
categoria.

## Decisões (confirmadas com o usuário)

1. **Decomposição:** 4 subprojetos; começar pelo DRE.
2. **Regime:** caixa — receita = orçamentos pagos (`pago_em`); despesa = contas pagas (`pago_em`).
3. **Escopo de linhas:** Receita − Despesas operacionais por categoria = Resultado. **Sem CMV**
   (custo de material) nesta versão.

## Fontes de dados (existentes, sem migration)

- **Receita:** `orcamentos` — colunas `total`, `pago` (boolean), `pago_em` (TIMESTAMPTZ),
  `status_pagamento`.
- **Despesas:** `contas_pagar` — `valor`, `tipo_despesa` (enum: ALUGUEL, AGUA, TARIFA_BANCO,
  FRETE, COMBUSTIVEL, TELEFONIA_INTERNET, MATERIAL_LIMPEZA, MATERIAL_ESCRITORIO,
  DESPESA_VIAGEM, LUZ, IMPOSTOS, MANUTENCAO, COMISSOES, …), `status`, `pago_em`, `vencimento`.

## Backend — novo módulo `src/modules/analises/`

**service.js — `dre({ inicio, fim })`:**
- Valida `inicio`/`fim` (YYYY-MM-DD); se ausentes, default = mês corrente.
- **Receita realizada:**
  ```sql
  SELECT COALESCE(SUM(total),0) AS receita
  FROM orcamentos
  WHERE pago = true AND pago_em::date BETWEEN $1 AND $2
  ```
- **Despesas por categoria:**
  ```sql
  SELECT tipo_despesa AS categoria, COALESCE(SUM(valor),0) AS valor
  FROM contas_pagar
  WHERE status = 'pago' AND pago_em::date BETWEEN $1 AND $2
  GROUP BY tipo_despesa
  ORDER BY valor DESC
  ```
- Calcula `total_despesas = Σ despesas`, `resultado = receita − total_despesas`,
  `margem = receita > 0 ? resultado / receita : 0`.
- Retorna `{ periodo: { inicio, fim }, receita, despesas: [{categoria, valor}],
  total_despesas, resultado, margem }`.

**router.js:**
- `GET /api/v2/analises/dre?inicio=&fim=` → `service.dre(...)`. `requireRole('admin','gestor','financeiro')`.
- Registrar em `src/modules/index.js` como `/api/v2/analises`.

## Frontend — bloco DRE em `#page-analises` (dashboard.html)

- Substituir o placeholder por um container com:
  - **Seletor de período:** botões Mês atual / Mês anterior / Ano + 2 inputs date (Personalizado)
    com botão Aplicar. Default: mês atual.
  - **Faixa de KPIs** (`_kpiCard` reutilizável): Receita · Despesas · **Resultado**
    (verde se ≥0, vermelho se <0) · Margem %.
  - **Despesas por categoria:** lista ordenada por valor; cada linha = categoria · valor ·
    barra proporcional (% do total de despesas).
  - Linha-resumo: "Receita − Despesas = Resultado".
- `loadAnalisesMain()` registrado no dict `loaders` de `showPage`; chama
  `GET /api/v2/analises/dre` com o período selecionado e renderiza.
- Helpers reutilizados: `api`, `escHtml`, `_kpiCard`, formatação `toLocaleString('pt-BR',{minimumFractionDigits:2})`.

## Tratamento de erros

- Período inválido (datas mal formadas, fim < início) → 400 `{erro:[...]}`.
- Sem dados no período → todos os valores 0, margem 0 (não quebra a UI).

## Testes

- `node --check` nos arquivos novos.
- Smoke no VPS: `GET`/chamada de service `dre({inicio,fim})` para o mês atual; conferir
  `receita`, `despesas` por categoria e `resultado` contra os dados reais.
- Verificação visual: bloco DRE no painel com o seletor de período recalculando os KPIs.

## Fora de escopo (YAGNI)

- CMV / custo de material consumido.
- Regime de competência.
- Comparativo entre períodos, gráficos avançados, export (PDF/Excel).
- Os demais blocos (Fluxo de Caixa, Metas, Insights IA) — specs próprias.
