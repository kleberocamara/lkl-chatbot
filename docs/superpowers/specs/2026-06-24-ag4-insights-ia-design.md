# AG-4 — Insights IA — Design

**Data:** 2026-06-24
**Contexto:** Quarto e último subprojeto de "Análises Gerenciais". Adiciona o bloco "Insights"
à sub-navegação da aba (DRE | Fluxo de Caixa | Metas | Insights), gerando uma análise
narrativa dos números financeiros via Claude API.

## Objetivo

Gerar, sob demanda, uma análise textual (situação + pontos de atenção + recomendações) a
partir dos dados de DRE, Fluxo de Caixa e Metas do período, e guardar o último resultado.

## Decisões (confirmadas com o usuário)

1. **Gatilho:** botão sob demanda (gera só quando o usuário clica) — controla o custo.
2. **Persistência:** salvar o último insight gerado (com data); reabrir mostra o salvo sem
   nova chamada. Botão "Gerar nova análise" refaz.
3. **Modelo:** `claude-haiku-4-5` (rápido/barato).

## Pré-requisito (já configurado)

- `ANTHROPIC_API_KEY` no `.env` do VPS (validada). A chamada usa `fetch` nativo para
  `https://api.anthropic.com/v1/messages` com header `anthropic-version: 2023-06-01` e
  `x-api-key`. Sem SDK novo.

## Modelo de dados (migration 040)

```sql
CREATE TABLE IF NOT EXISTS insights_financeiros (
  id         SERIAL PRIMARY KEY,
  gerado_em  TIMESTAMPTZ DEFAULT now(),
  periodo    VARCHAR(7),
  conteudo   TEXT NOT NULL,
  contexto   JSONB
);
```
Tabela nova → criável pelo user da app; se erro de permissão, `sudo -u postgres psql -d lkl_chatbot`.

## Backend — módulo `src/modules/analises/`

**Helper de IA — `_chamarClaude(system, user)`:**
- Lê `process.env.ANTHROPIC_API_KEY`; se ausente → lança erro "ANTHROPIC_API_KEY não configurada".
- `fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{ 'x-api-key', 'anthropic-version':'2023-06-01', 'content-type':'application/json' }, body: JSON.stringify({ model:'claude-haiku-4-5', max_tokens:900, system, messages:[{role:'user', content:user}] }) })`.
- Trata erro da API (`json.error`) e retorna `json.content[0].text`.

**`gerarInsight()`:**
- Coleta `dre({})` (mês atual), `fluxoCaixa({dias:90})`, `metaMes({})` (mês atual).
- Monta `system` (papel: analista financeiro de uma gráfica; responda em PT-BR, conciso) e
  `user` com os números formatados + instrução: "Analise e responda em 3 blocos curtos —
  1) Situação atual, 2) Pontos de atenção, 3) Recomendações práticas."
- Chama `_chamarClaude`, grava em `insights_financeiros` (`periodo` = `YYYY-MM` do mês atual,
  `conteudo` = texto, `contexto` = JSON dos dados), retorna `{ conteudo, gerado_em, periodo }`.

**`ultimoInsight()`:**
- `SELECT * FROM insights_financeiros ORDER BY gerado_em DESC LIMIT 1` → `{ conteudo, gerado_em, periodo }` ou `null`.

**Rotas (router.js):**
- `GET /analises/insights` → `ultimoInsight()` — `requireRole('admin','gestor','financeiro')`.
- `POST /analises/insights` → `gerarInsight()` — `requireRole('admin','gestor')` (custa).

## Frontend — pill "Insights" na aba Análises (dashboard.html)

- Adicionar a pill **Insights** à sub-nav (`analisesSub('insights')`); nova seção `#ag-insights`.
- Ao abrir: `GET /analises/insights` → mostra o último (texto + "gerado em DD/MM/AAAA HH:mm")
  ou estado vazio ("Nenhuma análise ainda — gere a primeira").
- Botão **✨ Gerar nova análise**: ao clicar, mostra "Analisando…" e faz `POST`; ao retornar,
  renderiza o `conteudo`. Render simples preservando quebras de linha (e markdown básico:
  `**negrito**` → `<strong>`, listas com `-`).
- Erros → `showToast` com a mensagem.

## Tratamento de erros

- Sem `ANTHROPIC_API_KEY` ou erro da API → resposta 400/500 com mensagem; a aba mostra o erro
  via toast e mantém o último insight salvo (se houver).
- `gerarInsight` é tolerante a dados zerados (gera análise mesmo com números baixos).

## Testes

- `node --check`.
- Migration verificada no VPS (`\d insights_financeiros`).
- Smoke no VPS: `gerarInsight()` (chamada real à IA — custa centavos) retorna `conteudo` não
  vazio e grava a linha; `ultimoInsight()` retorna o mesmo. Conferir que sem a env var o erro
  é claro.
- Verificação visual: pill Insights → "Gerar nova análise" → texto aparece; reabrir mostra o
  último com data.

## Fora de escopo (YAGNI)

- Histórico de insights (mantém só o último visível), insights por vendedor, geração agendada,
  streaming da resposta.
