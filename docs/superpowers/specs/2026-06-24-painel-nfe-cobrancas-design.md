# NF-e e Cobranças no Painel Unificado — Design

**Data:** 2026-06-24
**Contexto:** O dashboard unificado (`public/dashboard.html`) tem placeholders para as abas
"NF-e" e "Cobranças / Boletos / PIX". A funcionalidade já existe e funciona em
`public/pwa/admin.html`, ligada a backends prontos. Este projeto porta essas funções para o
painel com interface mais funcional e impactante. (Análises Gerenciais fica para spec própria.)

## Objetivo

Substituir os dois placeholders por abas de **gestão nativas** no dashboard: faixa de KPIs +
lista em cartões com status em pill, ícone de método e ações inline (modais com formulário,
não `prompt()`).

## Decisões (confirmadas com o usuário)

1. **Formato:** lista de gestão + ações por linha (visão gerencial).
2. **Implementação:** porte nativo no `dashboard.html` (mesma UX/cookie-session do painel).
3. **Sem backend novo:** todos os endpoints já existem.
4. **Ordem:** Fase 1 = NF-e · Fase 2 = Cobranças.
5. **KPI extra em Cobranças:** "Recebimentos a vencer" com seletor de horizonte
   (1 / 2 / 5 / 10 / 30 dias), recalculado no front.

## Sem alterações de backend

Endpoints reutilizados (já validados):
- NF-e: `POST /api/v2/nfe/:orcId/emitir`, `GET /api/v2/nfe/danfe/:id`,
  `POST /api/v2/nfe/:nfeId/cancelar`, `POST /api/v2/nfe/:nfeId/corrigir`,
  `POST /api/v2/nfe/inutilizar`, `GET /api/v2/nfe/:orcId`.
- Cobrança: `POST /api/v2/orcamentos/:id/cobrar` (body `{ tipo, dataVencimento, parcelas, intervaloDias }`),
  `POST /api/v2/orcamentos/:id/boleto/cancelar`, `/:id/pix/cancelar`, `/:id/link_mp/cancelar`,
  `POST /:id/boletos/:boletoId/cancelar`.
- Dados: `GET /api/v2/orcamentos` já retorna por orçamento `nfe_status`, `nfe_id`,
  `status_pagamento`, `tipo_cobranca` e `boletos_parcelas[]` (cada parcela com `vencimento`,
  `valor`, `boleto_id`, `linha_digitavel`, `pdf_url`).

## Linguagem visual (ambas as abas)

- **Faixa de KPIs:** cards `--color-background-secondary`, label 13px muted + número 24px/500,
  grid responsivo. Valores calculados no front a partir da lista carregada.
- **Lista em cartões:** cada linha é um card (borda 0.5px, radius-lg) com: círculo de ícone do
  método/tipo, nº + cliente, linha de detalhe, valor à direita, **pill de status** colorida, e
  botões de ação inline conforme o estado.
- **Status em pill:** cores semânticas (warning=aguardando, success=pago/autorizada,
  danger=vencida/cancelada, neutra=sem cobrança/sem NF).
- **Modais com formulário** (não `prompt`), no padrão de modal do dashboard.
- Busca (cliente/nº) + filtro de status no topo.

## Aba "Cobranças / Boletos / PIX" (Fase 2)

**Fonte:** orçamentos aprovados (`status` aprovado) — os que precisam pagar.

**KPIs (calculados no front):**
- A receber — soma de `valor` das parcelas em aberto (status_pagamento ≠ pago).
- Recebido no mês — soma dos orçamentos `pago` com data no mês corrente.
- Vencidas — soma das parcelas em aberto com `vencimento < hoje`.
- **Recebimentos a vencer** — card com `<select>` de horizonte (1/2/5/10/30 dias). Mostra a
  soma das parcelas em aberto com `hoje ≤ vencimento ≤ hoje + N`. Trocar o seletor recalcula
  o valor no front (sem nova requisição).

**Cartão por orçamento:**
- Ícone: boleto (`ti-barcode`), PIX (`ti-pix`), cartão/Link MP (`ti-credit-card`), sem cobrança (`ti-cash`).
- Detalhe: tipo · parcelas · vencimento (ou "Sem cobrança gerada").
- Pill: Aguardando / Pago / Vencida.
- Ações por estado:
  - Sem cobrança → **Boleto** / **PIX** / **Link MP** (abre modal de geração).
  - Aguardando → **Copiar linha digitável** (se boleto) + **Cancelar**.
  - Pago → sem ações.
- **Modal de geração:** campos tipo (já definido pelo botão), nº de parcelas (1–24),
  vencimento (date), intervalo entre parcelas (dias, se parcelas>1); Link MP pede máx. de
  parcelas (1/2/3/6/12). Envia `POST /:id/cobrar`. Substitui os `prompt()` do admin.

## Aba "NF-e" (Fase 1)

**Fonte:** orçamentos concluídos/entregues (faturáveis).

**KPIs (calculados no front):**
- Faturado no mês — soma dos `total` dos orçamentos com NF-e autorizada no mês.
- NF-e emitidas — contagem com `nfe_status = autorizada`.
- A faturar — contagem de concluídos/entregues sem NF.
- Canceladas — contagem de NF-e canceladas (se exposto; senão omitir o card).

**Cartão por orçamento:**
- Ícone `ti-file-invoice`; pill de status NF (Emitida / Sem NF / Cancelada).
- Ações por estado:
  - Sem NF → **Emitir NF-e** (modal: seleção de emitente Factor/LKL + confirmação).
  - Emitida → **DANFE** (abre PDF) · **CC-e** (modal de carta de correção) · **Cancelar** (modal com justificativa).
- Botão no topo: **Inutilizar numeração** (modal com faixa).

## Estrutura no dashboard.html

- Substituir os blocos `#page-cobrancas` e `#page-nfe` (placeholders) pelo HTML das abas.
- Registrar `loadCobrancasMain()` e `loadNfeMain()` no dict `loaders` de `showPage`.
- Reusar helpers existentes: `api`, `showModal`/`closeModal` (`#generic-modal`), `showToast`, `escHtml`.
- KPIs e listas derivam de `GET /api/v2/orcamentos` (uma chamada por aba, filtrando no front).

## Tratamento de erros

- Erros dos endpoints (`{errors}`/`{error}`) viram `showToast`.
- Estados sem dados → mensagem vazia ("Nenhum orçamento a faturar" / "Nenhuma cobrança").
- Ações destrutivas (cancelar NF/boleto, inutilizar) pedem confirmação.

## Testes

- Só HTML/JS (sem `node --check`). Verificação manual no painel em produção:
  - NF-e: lista carrega; emitir NF-e de homologação; abrir DANFE; CC-e; cancelar.
  - Cobranças: lista + KPIs corretos; gerar boleto sandbox (modal); copiar linha; cancelar;
    trocar o horizonte de "Recebimentos a vencer" recalcula o valor.

## Fora de escopo (YAGNI)

- Endpoints de listagem global de NF-e/cobranças (a lista de orçamentos já basta).
- Análises Gerenciais (DRE/Fluxo/Metas/IA) — spec separada na sequência.
- Conciliação bancária / baixa manual de pagamento.
