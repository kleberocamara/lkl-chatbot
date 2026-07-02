# AO-4b — Terceirização: Compras na Revenda (rastreio assistido) — Design

**Data:** 2026-07-02
**Status:** Aprovado para escrita de plano
**Contexto:** Fecha o ciclo da revenda. AO-4a fez os itens **internos** gerarem OS; os itens **terceirizados** (`revenda_matriz`, incl. IMP. DIGITAL) ficaram fora da produção. Este sub-projeto organiza a **compra desses itens no Graficonauta** e a entrega ao cliente — sem automatizar o checkout.

## Objetivo

Dar ao operador uma trilha para **comprar no Graficonauta** os itens terceirizados de orçamentos aprovados: listar o que comprar, agrupar numa **compra** (= 1 pedido no site, registrado manualmente com o nº), acompanhar até **receber**, e então **entregar ao cliente** pelo fluxo de entrega existente.

## Premissas e decisões (do brainstorming)

- **Rastreio assistido** — o operador faz o pedido no Graficonauta **manualmente**; o sistema só organiza/rastreia. **Sem checkout/pagamento automatizado** (risco deixado de fora).
- **Gatilho:** item vira "a comprar" quando o orçamento está **aprovado** E a **arte do item aprovada** (mesmo gatilho das OS internas).
- **Agrupamento:** o operador seleciona vários itens "a comprar" e cria **uma compra** (= 1 pedido no Graficonauta), registrando **1 nº de pedido** para o conjunto. Espelha o "Gerar OS Offset".
- **Status da compra:** `pedido_feito` (criada com o nº do pedido) → `recebido`.
- **Entrega:** ao `recebido`, o item entra no **fluxo de entrega existente** (board do motorista + `entregar()`).

## Arquitetura

Módulo novo, isolado, seguindo o padrão dos demais (`service` + `router`), reusando o fluxo de OS só para a entrega.

- **`src/modules/revenda-compras/service.js`** — regras de compra.
- **`src/modules/revenda-compras/router.js`** — `/api/v2/revenda-compras`.
- **`src/modules/index.js`** — registrar o módulo.
- **`public/dashboard.html`** — aba "Compras Revenda".
- Reuso: o módulo de OS (`entregar`, board do motorista) para a etapa de entrega; `orcamento_itens.arte_arquivo_url` para exibir a arte.

## Modelo de dados (migration 047)

```sql
CREATE SEQUENCE IF NOT EXISTS revenda_compra_seq START 1;

CREATE TABLE IF NOT EXISTS revenda_compras (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero                INTEGER NOT NULL DEFAULT nextval('revenda_compra_seq'),
  status                VARCHAR(20) NOT NULL DEFAULT 'pedido_feito'
                        CHECK (status IN ('pedido_feito','recebido')),
  pedido_graficonauta   VARCHAR(60),          -- nº do pedido no site (registrado pelo operador)
  cliente_id            UUID REFERENCES clientes_lkl(id) ON DELETE SET NULL,
  previsao_entrega      DATE,
  observacao            TEXT,
  responsavel_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  os_entrega_id         UUID REFERENCES ordens_servico(id) ON DELETE SET NULL, -- OS de entrega gerada ao receber
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  recebido_em           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS revenda_compra_itens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id         UUID NOT NULL REFERENCES revenda_compras(id) ON DELETE CASCADE,
  orcamento_item_id UUID NOT NULL REFERENCES orcamento_itens(id) ON DELETE CASCADE,
  UNIQUE (orcamento_item_id)  -- um item só entra numa compra
);
```

> Tabelas novas criadas como `lkl_user`. Próxima migration livre: **047**. `clientes_lkl`/`users`/`ordens_servico`/`orcamento_itens` já existem.

## Regras (service)

**"A comprar"** (`itensACompra()`):
```sql
SELECT oi.id, oi.descricao, oi.quantidade, oi.arte_arquivo_url,
       oi.revenda_prazo_horas, orc.numero AS numero_orcamento,
       cl.id AS cliente_id, cl.nome AS cliente_nome, rp.ref, rp.nome AS produto_revenda
FROM orcamento_itens oi
JOIN orcamentos orc ON orc.id = oi.orcamento_id
LEFT JOIN clientes_lkl cl ON cl.id = orc.cliente_id
LEFT JOIN revenda_produtos rp ON rp.id = oi.revenda_produto_id
WHERE orc.status = 'aprovado'
  AND oi.tipo_producao = 'REVENDA'
  AND oi.arte_status = 'aprovada'
  AND NOT EXISTS (SELECT 1 FROM revenda_compra_itens rci WHERE rci.orcamento_item_id = oi.id)
ORDER BY cl.nome, orc.numero, oi.codigo;
```

**`criarCompra({ item_ids, pedido_graficonauta, previsao_entrega, observacao }, userId)`**:
- Valida que todos os `item_ids` são elegíveis (REVENDA, orçamento aprovado, arte aprovada, fora de compra).
- Cria `revenda_compras` (`status='pedido_feito'`, grava `pedido_graficonauta`, cliente do 1º item, responsavel_id) + `revenda_compra_itens`.
- Retorna a compra + numero.

**`receber(compraId, userId)`**:
- Marca `status='recebido'`, `recebido_em=NOW()`.
- **Gera a entrega:** cria uma `ordens_servico` (`status='entrega'`, `tipo_servico='revenda'`, `cliente_id`, `quantidade`=soma) e vincula os `os_itens` (orcamento_item_id de cada item da compra); grava `os_historico`; guarda `os_entrega_id` na compra. A OS aparece no board do motorista e é fechada por `entregar()` (reuso total — `entregar` opera por `status='entrega'`, independente do `tipo_servico`).

**`listar({ status })`** — compras com itens e cliente, para a UI.

## API (`/api/v2/revenda-compras`)

- `GET /a-comprar` — itens elegíveis (admin/gestor/atendente).
- `POST /` — cria compra `{ item_ids, pedido_graficonauta, previsao_entrega, observacao }` (admin/gestor/atendente).
- `GET /` — lista compras (`?status=`).
- `GET /:id` — detalhe (itens + arte).
- `PATCH /:id/receber` — marca recebido + gera entrega (admin/gestor/atendente).

Auth cookie-session; `requireRole` para escrita.

## UI (aba "Compras Revenda")

- **Bloco "A comprar":** tabela dos itens elegíveis (cliente · pedido/orçamento · produto/Ref · tiragem · prazo · miniatura da arte) com seleção múltipla; botão **"Criar compra"** abre modal pedindo o **nº do pedido Graficonauta** (+ previsão/observação) e cria a compra com os itens marcados.
- **Bloco "Compras":** lista por status (`pedido_feito` / `recebido`), cada uma com nº interno, nº do pedido Graficonauta, cliente, itens (com arte), e botão **"marcar recebido"** (nas `pedido_feito`). Ao receber, some da lista de pendentes e a entrega aparece pro motorista.

## Erros e bordas

- `criarCompra` com item já em outra compra / não elegível → 400 com a lista de inválidos (a `UNIQUE(orcamento_item_id)` também protege no banco).
- `receber` numa compra já `recebido` → no-op/erro amigável.
- Item de compra cujo orçamento foi cancelado depois → o item some de "a comprar"; compras já feitas mantêm o histórico (FK ON DELETE CASCADE só dispara se o item for deletado).

## Testes

- **Unitário (TDD):** uma função pura pequena de validação de elegibilidade não faz sentido isolada (é SQL); então o foco é **smoke E2E no VPS**: criar um cenário (orçamento aprovado + item revenda_matriz + arte aprovada), conferir que aparece em `a-comprar`; `criarCompra` agrupa 2 itens; `receber` gera a OS de entrega em `status='entrega'` (aparece pro motorista) e marca a compra `recebido`.
- Teste de rota leve (carrega o router sem erro).

## Fora de escopo (AO-4b)

- **Compra automática** no Graficonauta (robô monta carrinho/paga) — decisão de risco deixada de fora.
- **Lançar conta a pagar** automática a partir da compra (integração financeira) — passo futuro.
- Sincronizar status real do pedido a partir do site do Graficonauta (o status é registrado manualmente).

## Dependências

- AO-4a concluído (itens terceirizados com `tipo_producao='REVENDA'`). Gate de arte por item (já existe). Nenhuma dependência externa nova.
