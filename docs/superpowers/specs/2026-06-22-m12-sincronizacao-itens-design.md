# M12 · Sincronização de Itens Pedido ↔ Orçamento — Design

**Data:** 2026-06-22
**Objetivo:** Eliminar a divergência de itens entre Pedido, Orçamento e OS. Estabelecer o **orçamento como fonte canônica** dos itens, com o **pedido (`order_items`) como espelho automático**, permitindo editar itens a partir das duas telas (pedido e orçamento) com propagação para frente (OS) e para trás (pedido).

---

## Contexto / problema

Hoje os itens existem em **duas cópias**: `order_items` (pedido) e `orcamento_itens` (orçamento). A OS aponta para `orcamento_itens`. Isso gerou divergência real:
- Itens adicionados no orçamento **não refletem no pedido** (`order_items` fica velho).
- O CRUD de item do orçamento **não grava `produto`/`tipo_producao`** → o item some na geração da OS (filtro por `tipo_producao='OFFSET'`/`'COMUNICAÇÃO VISUAL'`).
- A numeração (`codigo`) dos itens adicionados sai alta/inconsistente.

## Decisões travadas com o usuário
1. **Sincronizar nos dois sentidos** — editar no pedido ou no orçamento reflete em ambos (e na OS).
2. **Item do orçamento com combo de produto** — adicionar item passa a exigir produto do catálogo (PRODUTOS_LKL), preenchendo `tipo_producao`.

## Estratégia (robusta, sem diff bidirecional frágil)
- **Canônico:** `orcamento_itens`.
- **Espelho:** `order_items` é **reconstruído** a partir de `orcamento_itens` após qualquer alteração de item.
- **Duas telas de edição** (pedido e orçamento) usam os **mesmos endpoints de item do orçamento** — "editar no pedido" opera no orçamento vinculado.
- **Trava:** edição de itens só enquanto o orçamento **não está aprovado** (status ∉ {enviado, aprovado, reprovado, cancelado}) — já existe e é preservada.

---

## Modelo de dados

### Migração 033 — campos estruturados em `orcamento_itens`
```sql
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS produto       VARCHAR(150);
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS especificacao VARCHAR(255);
```
`descricao` continua existindo e é derivada: `produto — especificacao` (ou só `produto`). `tipo_producao` já existe (migration 025).

---

## Backend (`src/modules/orcamentos`)

### Item CRUD — passar a aceitar produto/tipo/especificação e renumerar
`POST /:id/itens` e `PATCH /:id/itens/:itemId` (router.js): aceitar `produto`, `tipo_producao`, `especificacao`, `quantidade`, `valor_unitario`, `valor_total`. Gravar `produto`, `tipo_producao`, `especificacao` e `descricao = especificacao ? produto + ' — ' + especificacao : produto`. Continuar aceitando `descricao` direto (itens avulsos tipo arte/frete, sem produto).
- `codigo`: ao inserir, usar `COALESCE(MAX(codigo),0)+1` do orçamento (renumeração consistente; corrige o 1007/1008).

### Helper `_rebuildOrderItems(orcamentoId)` (service.js)
Após qualquer mudança de item (add/edit/delete), reconstrói o espelho:
```sql
-- pega o pedido vinculado
SELECT id FROM orders WHERE orcamento_id = $1;  -- se não houver, no-op
DELETE FROM order_items WHERE order_id = <pedido>;
INSERT INTO order_items (order_id, produto, quantidade, especificacao, valor_unitario, valor_total)
  SELECT <pedido>, COALESCE(produto, descricao), quantidade, especificacao, valor_unitario, valor_total
  FROM orcamento_itens WHERE orcamento_id = $1 ORDER BY codigo;
-- atualiza o resumo do pedido (1º item) + tipo
UPDATE orders SET produto = <1º produto/descricao>, quantidade = <1ª qtd>, tipo_producao = <1º tipo>, updated_at=NOW() WHERE id=<pedido>;
```
Chamado em add/edit/delete de item (no service ou router, após o recálculo do total do orçamento).

### Onde chamar
Os três endpoints de item do orçamento, após sucesso, chamam `_rebuildOrderItems(orcamentoId)` (fire-and-forget com log, não bloqueia a resposta).

---

## Frontend — dashboard

### Orçamento: adicionar/editar item com combo de produto
- `abrirAdicionarItemOrc` / `abrirEditarItemOrc`: trocar o campo "descrição" livre por **combo de produto** (`selectProduto` + `tipoPorProduto`) + **especificação** + **quantidade** + **valor unitário**. Manter opção de item avulso (produto = OUTROS/livre) para arte/frete.
- `adicionarItemOrc` / `salvarItemOrc`: enviar `produto`, `tipo_producao`, `especificacao`, `quantidade`, `valor_unitario`, `valor_total`.

### Pedido: editar itens no modal "Editar Pedido"
- O modal de edição do pedido ganha a seção **ITENS** (lista os itens do orçamento vinculado) com **+ / ✏️ / −**, usando os **mesmos endpoints** `/api/v2/orcamentos/:orcId/itens`.
- Só habilita se o orçamento vinculado não estiver travado (status editável). Se travado, mostra aviso "itens bloqueados — orçamento aprovado".
- Precisa do `orcamento_id` do pedido (a listagem de orders já traz `orcamento_id`).

### Exibição
- A lista de Pedidos (coluna Produto + badge "+N") já lê `order_items` via `itens_count` — passa a refletir o orçamento automaticamente (espelho).

---

## Critérios de aceite (M12)
1. Adicionar item no orçamento via combo grava `produto` + `tipo_producao` → o item aparece em "Gerar OS Offset" / gera OS de CV conforme o tipo.
2. Adicionar/editar/remover item no orçamento atualiza o `order_items` do pedido (a aba Pedidos reflete a contagem e o resumo corretos).
3. Editar itens pela tela do **pedido** opera sobre o orçamento e reflete nos dois.
4. Numeração (`codigo`) dos itens fica sequencial (sem 1007/1008).
5. Orçamento aprovado mantém itens bloqueados nas duas telas.
6. Itens avulsos sem produto (arte/frete) continuam possíveis (não geram OS).

## Riscos / atenção
- `_rebuildOrderItems` apaga e recria `order_items` — garantir que roda só para o pedido vinculado e que valores/quantidades batem.
- Não alterar itens de orçamento travado (respeitar status).
- Itens avulsos (sem `produto`) no espelho usam `descricao` como produto.

## Fora de escopo
- Unificar as duas tabelas numa só (refator maior) — mantemos canônico+espelho.
- Reprecificação automática (o valor segue manual no orçamento).
