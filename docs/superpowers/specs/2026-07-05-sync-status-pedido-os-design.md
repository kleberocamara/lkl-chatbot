# Sincronizar status do pedido com a OS (visão Produção / Pagamento) — Design

**Data:** 2026-07-05
**Autor:** Kleber + Claude

## Problema

`orders.status` e `ordens_servico.status` são trilhos **independentes**: `os/service.js` nunca escreve em `orders.status`. Resultado: um pedido produzido e entregue (OS `entregue`) continua mostrando o status antigo na aba Pedidos (ex.: pedido 31 ficou "Aguard. pagamento" mesmo entregue). Além disso, `orders.status` é um campo único que mistura **pagamento** (`aguardando_pagamento`, `pago`) e **produção** (`em_producao`, `concluido`, `entregue`) — as duas dimensões brigam pelo mesmo campo e uma esconde a outra.

## Objetivo

O status do pedido deve refletir a esteira da respectiva OS **e** o pagamento, exibidos juntos como duas dimensões: `Produção / Pagamento` (ex.: "Concluído / Pago", "Entregue / Aguard. pagamento").

## Decisões (do brainstorming)

- **Mapa completo:** produção do pedido reflete `Em produção → Concluído → Entregue` (não só entregue).
- **Produção manda no campo `orders.status`; pagamento vive à parte** em `orcamento.status_pagamento` (já existe, já é badge). O card compõe as duas.
- **`orders.status` passa a ser só a trilha de produção/ciclo** — deixa de guardar pagamento.

## Duas dimensões

### Dimensão Produção (fonte: OS → `orders.status`)

Função pura `pedidoStatusDaOS(statuses)` recebe os status de todas as OS **não canceladas** de um orçamento e devolve o alvo:

| Estado agregado das OS | Alvo |
|---|---|
| Nenhuma OS (ou todas canceladas) | `null` (no-op) |
| Pelo menos uma em `corte`/`impressao`/`acabamento` | `em_producao` |
| Todas em `entrega`/`entregue`, mas nem todas `entregue` | `concluido` |
| Todas `entregue` | `entregue` |

**Guarda "só avança, nunca regride":** ranking de produção `em_producao(1) < concluido(2) < entregue(3)`. O sync só aplica o alvo se:
- o status atual do pedido for pré-produção/pagamento (`novo`, `em_orcamento`, `aguardando_aprovacao`, `aprovado`, `aguardando_pagamento`, `pago`), **ou**
- o rank do alvo for **maior** que o rank do status de produção atual.

Nunca sobrescreve `cancelado` nem `reprovado`. Nunca regride (`entregue`→`em_producao` ao reabrir OS é ignorado).

### Dimensão Pagamento (fonte: `orcamento.status_pagamento`)

Valores relevantes: `aguardando_pagamento`, `pago`. Já mantida pelo webhook do MP e pelo `confirmarPagamento` do C6. Sem mudança de lógica aqui.

### Composição no card (aba Pedidos)

| | Aguard. pagamento | Pago |
|---|---|---|
| **Em produção** | Em produção / Aguard. pagamento | Em produção / Pago |
| **Concluído** | Concluído / Aguard. pagamento | Concluído / Pago |
| **Entregue** | Entregue / Aguard. pagamento | Entregue / Pago |

Antes de haver cobrança (pré-aprovação), mostra só a produção (ex.: "Aprovado", "Em orçamento", "Aguard. aprovação").

## Arquitetura

### Componente 1 — Função pura de mapeamento

Em `src/constants/fluxoProducao.js` (junto de `proximaFase`):
- `pedidoStatusDaOS(statuses)` → alvo ou `null` (tabela acima).
- `podeAvancarPedido(atual, alvo)` → boolean (guarda "só avança").

Ambas puras → testes unitários.

### Componente 2 — Helper de sincronização

Em `src/modules/os/service.js`:
- `sincronizarPedidoDaOS(orcamentoId)`:
  1. `SELECT status FROM ordens_servico WHERE orcamento_id=$1 AND status != 'cancelado'`.
  2. `alvo = pedidoStatusDaOS(statuses)`; se `null`, retorna.
  3. `SELECT id, status FROM orders WHERE orcamento_id=$1`.
  4. Se `podeAvancarPedido(order.status, alvo)`: `UPDATE orders SET status=$alvo, updated_at=NOW()` + `global.io.emit('order_status_update', { orderId, status: alvo })`.
- Chamado **fire-and-forget** (`.catch(warn)`) ao final de: `avancarFase`, `atualizarStatus`, `entregar`/`marcarEntregue`. **Sem FCM** (essas funções já disparam push da OS).

### Componente 3 — Webhook MP (reverter escrita em orders)

Em `src/webhook/mercadopago.js`: remover o `UPDATE orders SET status='pago' ...` adicionado em 2026-07-05. Mantém `UPDATE orcamentos SET status_pagamento='pago'` e `UPDATE ordens_servico SET pago=true`.

### Componente 4 — Frontend (aba Pedidos)

- `src/modules/orders/service.js` `listar`: adicionar `orc.status_pagamento AS pagamento_status` ao SELECT.
- `public/dashboard.html`: onde renderiza o card do pedido, compor `Produção / Pagamento`. Produção = label de `o.status`; Pagamento = label de `o.pagamento_status` quando presente (`aguardando_pagamento`→"Aguard. pagamento", `pago`→"Pago"). Sem pagamento, só produção.

### Componente 5 — Migração de dados (one-time, sem coluna nova)

Script/SQL rodado uma vez no VPS:
- Pedidos **com** OS não cancelada: `orders.status = pedidoStatusDaOS(...)` (recalcula do estado atual).
- Pedidos **sem** OS hoje em `pago`/`aguardando_pagamento`: `orders.status = 'aprovado'` (tira o pagamento do campo; badge assume).
- Efeito colateral: pedido 31 volta a `entregue` por regra, não na mão.

## Fluxo de dados

1. Operador/motorista avança uma OS (corte→…→entregue).
2. A função de OS grava a fase, dispara os efeitos atuais (FCM, histórico), e chama `sincronizarPedidoDaOS(orcamentoId)`.
3. O helper recalcula o alvo de produção do pedido e, se avança, atualiza `orders.status` + emite socket.
4. A aba Pedidos, ao vivo (socket) ou no reload, compõe `Produção / Pagamento`.
5. Pagamento muda por via própria (webhook MP / C6) atualizando `status_pagamento` — o badge acompanha, independente da produção.

## Tratamento de erro / bordas

- Sync em `try/catch`/`.catch` do chamador — nunca derruba a mudança de fase da OS.
- Multi-OS parcial: só `concluido` quando **todas** as não canceladas passaram de produção; só `entregue` quando **todas** entregues.
- Todas as OS canceladas → `null` → no-op (não marca entregue).
- Reabertura de OS (regressão de fase) → guarda impede regredir o pedido.
- Pedido `cancelado`/`reprovado` → nunca tocado pelo sync.

## Testes

- **Unitários** (`tests/`): `pedidoStatusDaOS` e `podeAvancarPedido` — cenários: OS única em cada fase; multi-OS parcial (uma em acabamento, outra entregue → `em_producao`); todas em `entrega` → `concluido`; todas `entregue` → `entregue`; uma cancelada + resto entregue → `entregue`; nenhuma OS → `null`; guarda não regride `entregue`→`em_producao`; guarda avança a partir de `pago`/`aguardando_pagamento`.
- **Smoke no VPS:** criar/avançar uma OS fase a fase e conferir `orders.status`; confirmar que o webhook do MP não escreve mais em `orders.status`; conferir o rótulo composto na aba Pedidos.

## Fora de escopo

- PWAs (motorista/produção/vendedor) — mantêm telas atuais; visão de duas dimensões só na aba Pedidos do dashboard.
- Coluna dedicada de pagamento em `orders` (usa-se `orcamento.status_pagamento`).
- Pedidos de revenda sem OS — ficam em `aprovado` na produção; sem rastreio de entrega (não têm OS).
