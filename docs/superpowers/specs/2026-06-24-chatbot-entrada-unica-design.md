# Chatbot como canal da entrada única de Pedido — Design

**Data:** 2026-06-24
**Contexto:** O chatbot registrava pedidos fora do fluxo unificado: gerava um número de
sequência próprio e inseria um orçamento "rascunho" solto (sem `orders`), que não aparecia no
painel e quebrava para clientes novos. O painel já tem a entrada única em `orders` (`criarOrder`),
que auto-cria o orçamento em `em_orcamento`. Este projeto faz o chatbot usar essa mesma porta.

## Problemas atuais (diagnosticados)

1. **Cliente novo quebra:** o chatbot insere em `clientes_lkl` sem `tipo_pessoa` (coluna NOT NULL
   sem default) → erro de constraint → o pedido não é criado, mas o bot diz "registrado com
   sucesso". (Ex.: pedido #1020 perdido.)
2. **Orçamento solto e invisível:** quando o cliente já existe, o chatbot cria um orçamento
   `status='rascunho'` direto (sem `orders`), que não tem chip no painel e fica órfão
   (ex.: #26 CAIO "Rascunho (legado)").
3. **Fora do fluxo único:** o chatbot não usa `orders`, então o pedido não cai na aba Pedidos
   nem segue o fluxo padrão.

## Decisão (confirmada com o usuário)

Entrada única = o **Pedido** (`orders`). O chatbot é apenas mais um **canal**
(`origin_channel='chatbot'`). A partir do pedido, segue o fluxo já existente do painel, que
auto-cria o orçamento em `em_orcamento` (aba Orçamentos). O chatbot **não** cria orçamento
direto.

## Fatos do código (verificados)

- `src/modules/orders/service.js` → `criarOrder(dados, userId)`: cria `orders` (`status` vira
  `em_orcamento`), `order_items`, e auto-cria `orcamentos` (`status='em_orcamento'`) +
  `orcamento_itens` ligados via `pedido_id`. Emite `new_order`.
- `dados` aceita: `origin_channel` (CANAIS_VALIDOS inclui `'chatbot'`), `cliente_id`,
  `vendedor_id`, `itens:[{produto,tipo_producao,quantidade,especificacao,tem_arte}]` (ou
  `dados.produto` como fallback), `material`, `acabamento`, `prazo`, `observacoes`, `celular`,
  `email`. Retorna o `order` (com `id`, `numero_os`, `orcamento_id`, `status`).
- `clientes_lkl`: `tipo_pessoa` NOT NULL (sem default); `status` default 'ativo';
  `canal_origem` default 'sisgraph'.
- `src/ai/agent.js` (~linhas 150–234): bloco atual que gera `pedido_seq`, atualiza
  `conversations` e cria o orçamento `[ORC-V2]` rascunho. `agent.js` já faz `require('../db')`.

## Mudança — `src/ai/agent.js`

Substituir o bloco de registro de pedido por:

1. **Resolver o cliente** (find/create por celular):
   - Busca em `clientes_lkl` por `celular LIKE '%<últimos9>'`.
   - Se não existir, INSERT **incluindo `tipo_pessoa`**:
     ```sql
     INSERT INTO clientes_lkl (nome, celular, canal_origem, tipo_pessoa)
     VALUES ($1, $2, 'chatbot', 'PF') RETURNING id
     ```
2. **Montar `dados` e chamar `criarOrder`:**
   ```js
   const ordersService = require('../modules/orders/service');
   const especificacao = [args.dimensoes, args.material].filter(Boolean).join(' · ') || null;
   const dados = {
     origin_channel: 'chatbot',
     cliente_id: clienteId,
     itens: [{
       produto: args.produto || args.tipo_servico || 'Pedido via chatbot',
       quantidade: parseInt(args.quantidade) || 1,
       especificacao,
       tem_arte: !!args.tem_arte,
     }],
     observacoes: [
       args.entrega === 'entrega' ? `Entrega: ${args.endereco_entrega || ''}` : 'Retirada na loja',
       args.observacoes || '',
     ].filter(Boolean).join(' | ') || null,
   };
   const result = await ordersService.criarOrder(dados, null);
   const pedidoNumero = result?.order?.numero_os || result?.numero_os;
   ```
   (Confirmar o formato real do retorno de `criarOrder` — usar `numero_os` do `orders` como
   número informado ao cliente.)
3. **Mensagem ao cliente:** usar `pedidoNumero` no template de encerramento (substituir o
   `{NUMERO_PEDIDO}`).
4. **Atualizar `conversations`** (manter): `status='aguardando_humano'`, `pedido_numero=pedidoNumero`,
   `pedido_status='em_orcamento'`, `needs_details`, `service_type`.
5. **Remover** o bloco `[ORC-V2]` (INSERT do orçamento rascunho) e o uso de `pedido_seq`.
6. **Robustez:** se `criarOrder` retornar `{erro}`, logar e NÃO afirmar "registrado com
   sucesso" — responder que houve um problema e a equipe foi avisada. (Evita o "sucesso
   fantasma".)

## Limpeza de dados

- Remover/cancelar o orçamento órfão legado **#26 (CAIO, `status='rascunho'`, canal chatbot)**:
  `DELETE FROM orcamento_itens WHERE orcamento_id=<id>; DELETE FROM orcamentos WHERE id=<id>;`
  (ou `UPDATE ... SET status='cancelado'`). Decisão: DELETE (é lixo de teste).

## Erros & testes

- Sem postgres local → `node --check` + smoke E2E no VPS.
- Smoke: simular `criarOrder({origin_channel:'chatbot', cliente_id, itens:[...]})` com um cliente
  novo e um existente; confirmar que cria `orders` (canal chatbot) + orçamento `em_orcamento`,
  e que clientes_lkl novo é criado sem erro de `tipo_pessoa`.
- Verificação no painel: pedido aparece na aba Pedidos (Canal=chatbot) e na aba Orçamentos
  (Em orçamento).

## Fora de escopo (YAGNI)

- Qualidade de parsing das dimensões pela IA (ex.: "118,5 m") — ajuste de prompt do chatbot,
  separado.
- Automação do orçamento (precificação automática) — futuro.
- Renumeração/migração de pedidos antigos do chatbot.
