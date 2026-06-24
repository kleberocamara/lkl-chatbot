# AG-2 — Fluxo de Caixa — Design

**Data:** 2026-06-24
**Contexto:** Segundo dos 4 subprojetos de "Análises Gerenciais". Reutiliza o módulo
`src/modules/analises/` criado no AG-1 (DRE) e adiciona a sub-navegação por blocos na aba.

## Objetivo

Projetar o fluxo de caixa futuro por semana: entradas previstas (parcelas a receber) ×
saídas previstas (contas a pagar), com saldo acumulado a partir de um saldo inicial
informado pelo usuário.

## Decisões (confirmadas com o usuário)

1. **Granularidade:** por semana, horizonte configurável (30/60/90 dias).
2. **Saldo:** saldo inicial informado pelo usuário (default 0); acumulado calculado no front.

## Fontes de dados (existentes, sem migration)

- **A receber:** `orcamento_boletos` — `vencimento DATE`, `valor NUMERIC`, `status`
  ('aguardando'|'pago'|'cancelado'). Abertas = `status='aguardando'`.
- **A pagar:** `contas_pagar` — `vencimento DATE`, `valor NUMERIC`, `status`
  ('pendente'|'agendado'|'pago'|'vencido'|'cancelado'). Abertas = `status IN ('pendente','agendado','vencido')`.

## Backend — `src/modules/analises/`

**service.js — `fluxoCaixa({ dias })`:**
- `dias` = inteiro em {30,60,90}; default 90 se ausente/ inválido.
- Janela: `hoje` (date) até `hoje + dias`.
- **Entradas por semana:** `orcamento_boletos` `status='aguardando'` e `vencimento` na janela.
- **Saídas por semana:** `contas_pagar` `status IN ('pendente','agendado','vencido')` e
  `vencimento` na janela.
- Agrupamento semanal: usar `date_trunc('week', vencimento)` (segunda-feira) como chave; para
  cada semana presente em entradas OU saídas, montar `{ inicio (date_trunc), fim (inicio+6d),
  entradas, saidas, liquido: entradas - saidas }`, ordenado por `inicio`.
- **Atrasados** (resumo, fora da janela futura):
  - `atrasado_receber` = Σ `orcamento_boletos.valor` `status='aguardando'` e `vencimento < hoje`.
  - `atrasado_pagar` = Σ `contas_pagar.valor` `status IN ('pendente','agendado','vencido')` e `vencimento < hoje`.
- Retorna `{ dias, semanas:[...], total_entradas, total_saidas, atrasado_receber, atrasado_pagar }`.
- Implementação: 2 queries agregadas (entradas por semana, saídas por semana) + 2 escalares
  (atrasados). Mesclar as semanas no JS por chave de data.

**router.js:** adicionar `GET /analises/fluxo-caixa?dias=` → `service.fluxoCaixa(...)`,
`requireRole('admin','gestor','financeiro')`.

## Frontend — sub-navegação na aba Análises (dashboard.html)

- `#page-analises` ganha um **sub-menu em pills**: "DRE" e "Fluxo de Caixa" (estrutura para
  receber Metas/Insights depois). O conteúdo atual do DRE passa para a seção `#ag-dre`; nova
  seção `#ag-fluxo`. Uma função `analisesSub(secao)` alterna a exibição e dispara o load da
  seção (DRE = `dreAplicar`/`drePeriodo('mes')`; Fluxo = `loadFluxo`).
- **Bloco Fluxo de Caixa (`#ag-fluxo`):**
  - Controles: select de horizonte (30/60/90 dias) + input "Saldo inicial" (number, default 0),
    ambos recalculam ao mudar.
  - Cards-resumo (`_kpiCard`): Total a receber · Total a pagar · Atrasado a receber · Atrasado a pagar.
  - Tabela por semana: colunas Semana (dd/mm–dd/mm) · Entradas · Saídas · Líquido · Saldo
    acumulado. Saldo acumulado = `saldo_inicial + Σ líquidos até a semana` (verde se ≥0,
    vermelho se <0). Líquido também colorido.
- Trocar horizonte → refaz `GET /fluxo-caixa`. Trocar saldo inicial → só recalcula o acumulado
  no front (sem nova requisição).

## Tratamento de erros

- `dias` fora de {30,60,90} → usa 90.
- Sem dados → `semanas: []`, totais 0; a tabela mostra "Sem lançamentos no período" e o saldo
  acumulado = saldo inicial.

## Testes

- `node --check`.
- Smoke no VPS: `fluxoCaixa({dias:90})` → conferir estrutura `{ semanas, total_entradas,
  total_saidas, atrasado_receber, atrasado_pagar }` (valores podem ser 0 sem dados).
- Verificação visual: alternar DRE/Fluxo pelo sub-menu; trocar horizonte e saldo inicial
  recalcula a tabela e o acumulado.

## Fora de escopo (YAGNI)

- Realizado histórico sobreposto ao previsto.
- Conciliação bancária / saldo bancário real.
- Export (PDF/Excel), gráfico de linha do saldo projetado (v1 usa tabela + barras simples).
