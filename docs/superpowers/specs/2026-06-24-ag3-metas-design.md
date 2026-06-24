# AG-3 — Metas — Design

**Data:** 2026-06-24
**Contexto:** Terceiro dos 4 subprojetos de "Análises Gerenciais". Adiciona o bloco "Metas"
à sub-navegação da aba (DRE | Fluxo de Caixa | Metas), reutilizando o módulo `analises`.

## Objetivo

Cadastrar a meta mensal de faturamento da empresa e acompanhar o realizado (vendas
fechadas) do mês, com percentual atingido.

## Decisões (confirmadas com o usuário)

1. **Escopo:** meta mensal da empresa (uma por mês, sem distinção por vendedor).
2. **Realizado:** vendido = orçamentos aprovados no mês (`aprovado_em`), independentemente
   de pagamento.

## Modelo de dados (migration 039)

```sql
CREATE TABLE IF NOT EXISTS metas (
  id          SERIAL PRIMARY KEY,
  ano         INTEGER NOT NULL,
  mes         INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  valor_meta  NUMERIC(12,2) NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (ano, mes)
);
```
Tabela nova → criável pelo user da app; se houver erro de permissão, aplicar via
`sudo -u postgres psql -d lkl_chatbot`.

## Fonte do realizado (existente, sem alteração)

- `orcamentos`: `total`, `aprovado_em TIMESTAMPTZ` (setado em `aprovar()`), `status`.
- Realizado do mês = `SUM(total)` onde `aprovado_em::date` entre o 1º e o último dia do mês
  e `status NOT IN ('cancelado','reprovado')`.

## Backend — módulo `src/modules/analises/`

**service.js:**
- `salvarMeta({ ano, mes, valor })`:
  - Valida `ano` (inteiro), `mes` (1–12), `valor` (número ≥ 0). Senão `{ erro:[...] }`.
  - Upsert:
    ```sql
    INSERT INTO metas (ano, mes, valor_meta) VALUES ($1,$2,$3)
    ON CONFLICT (ano, mes) DO UPDATE SET valor_meta = EXCLUDED.valor_meta, updated_at = now()
    RETURNING *
    ```
  - Retorna `{ meta: <linha> }`.
- `metaMes({ ano, mes })`:
  - Default = mês corrente se ausente. Valida mes 1–12.
  - `meta` = `valor_meta` do (ano,mes) ou `null`.
  - `realizado`:
    ```sql
    SELECT COALESCE(SUM(total),0) AS realizado FROM orcamentos
    WHERE aprovado_em::date BETWEEN $1 AND $2 AND status NOT IN ('cancelado','reprovado')
    ```
    (datas = 1º e último dia do mês, calculadas no JS).
  - `percentual` = `meta > 0 ? realizado / meta : 0`.
  - Retorna `{ ano, mes, meta, realizado, percentual }`.

**router.js:**
- `GET /analises/metas?ano=&mes=` → `metaMes`.
- `POST /analises/metas` body `{ ano, mes, valor }` → `salvarMeta`.
- Ambas `requireRole('admin','gestor','financeiro')`.

## Frontend — pill "Metas" na aba Análises (dashboard.html)

- Adicionar a pill **Metas** ao sub-menu (`analisesSub('metas')`); nova seção `#ag-metas`.
- Bloco Metas:
  - Seletor de **mês** e **ano** (default mês atual). Ao mudar → `loadMeta()`.
  - Input **Meta (R$)** + botão **Salvar** → `POST /analises/metas`, depois recarrega.
  - Cards (`_kpiCard`): **Meta** · **Realizado (vendido)** · **% atingido** (verde se ≥100%,
    laranja se <100%).
  - **Barra de progresso** (largura = min(100, percentual)) sob os cards.
  - Se não houver meta no mês → cards com Meta "—" e aviso "Defina a meta do mês".

## Tratamento de erros

- `mes` fora de 1–12 ou `valor` inválido → 400 `{errors:[...]}`.
- Mês sem meta → `meta: null`, `percentual: 0`, realizado ainda exibido.

## Testes

- `node --check`.
- Migration verificada no VPS (`\d metas`).
- Smoke no VPS: `salvarMeta({ano,mes,valor:50000})` → `metaMes({ano,mes})` retorna a meta +
  realizado (orçamentos aprovados do mês) + percentual.
- Verificação visual: pill Metas, salvar a meta, ver cards + barra; trocar de mês.

## Fora de escopo (YAGNI)

- Meta por vendedor; metas trimestrais/anuais; histórico/comparativo entre meses; alertas.
