# Auto-inclusão de Arte/Entrega no orçamento do chatbot — Design

**Data:** 2026-07-06
**Autor:** Kleber + Claude

## Problema

Quando o pedido nasce pelo chatbot, o orçamento é auto-criado só com linhas de **produto**. O chatbot capta que o cliente **não tem arte** (`tem_arte=false` por item) e se quer **entrega**, mas nada disso vira valor no orçamento. Ex.: orçamento 39 (pedido 33) — item BANNERS `tem_arte=false`, e **nenhuma** linha de serviço; o "valor do serviço" nunca foi calculado porque o serviço não foi adicionado.

## Objetivo

Na montagem do orçamento pelo chatbot, acrescentar automaticamente:
- **Arte Final** — R$ 30,00 por item sem arte.
- **Entrega** — R$ 15,00 (quando o cliente pede entrega, não retirada).

## Decisões (do brainstorming)

- **R$30 por item sem arte** (quantidade = nº de itens com `tem_arte=false`).
- **R$15 de entrega**, uma vez, quando `entrega` (não retirada).
- **Valores fixos no código** (constantes), configuráveis no futuro se preciso.
- **Só no chatbot** (`origin_channel === 'chatbot'`). O "Novo Pedido" manual do painel segue como hoje (vendedor adiciona serviços à mão).

## Contexto do código

- `criarOrder(dados, userId)` em `src/modules/orders/service.js` cria o pedido e **auto-cria o orçamento** (linhas ~132-192), inserindo cada item de produto em `orcamento_itens` (colunas: `orcamento_id, codigo, produto, especificacao, descricao, quantidade, valor_unitario, valor_total, tem_arte, tipo_producao, largura_cm, altura_cm, material_id, preco_origem, preco_memoria, revenda_produto_id`), depois `UPDATE orcamentos SET total = SUM(...)`.
- O chatbot (`src/ai/agent.js`, ~336-355) monta `itensDados` (com `tem_arte` por item) e `dados` (com `observacoes`), e chama `ordersService.criarOrder(dados, null)`. `args.entrega` (`"retirada"|"entrega"`) existe no agente mas **não** é passado a `criarOrder`.
- Itens de serviço: `tipo_producao='SERVICO'`, `tem_arte=false`, sem dims/material; não geram OS (o gate de criação de OS exige `tipo_producao IN ('OFFSET','COMUNICAÇÃO VISUAL') AND arte_status='aprovada'`). Nomes do catálogo: `Arte Final`, `Entrega`.

## Arquitetura

### Componente 1 — Função pura `linhasServicoAuto(itens, entrega)`

Em `src/modules/orders/service.js` (perto do topo), com constantes:

```javascript
const SERVICO_ARTE_VALOR = 30;
const SERVICO_ENTREGA_VALOR = 15;

function linhasServicoAuto(itens, entrega) {
  const linhas = [];
  const semArte = (itens || []).filter(it => !it.tem_arte).length;
  if (semArte > 0) {
    linhas.push({ produto: 'Arte Final', quantidade: semArte,
      valor_unitario: SERVICO_ARTE_VALOR, valor_total: SERVICO_ARTE_VALOR * semArte });
  }
  if (entrega) {
    linhas.push({ produto: 'Entrega', quantidade: 1,
      valor_unitario: SERVICO_ENTREGA_VALOR, valor_total: SERVICO_ENTREGA_VALOR });
  }
  return linhas;
}
```

Exportada para teste unitário.

### Componente 2 — Inserção no `criarOrder` (gated a chatbot)

Após o loop que insere as linhas de produto (antes do `UPDATE orcamentos SET total`), e **somente quando `dados.origin_channel === 'chatbot'`**, inserir as linhas de serviço:

```javascript
if (dados.origin_channel === 'chatbot') {
  for (const s of linhasServicoAuto(itens, dados.entrega)) {
    await db.query(
      `INSERT INTO orcamento_itens (orcamento_id, codigo, produto, especificacao, descricao, quantidade, valor_unitario, valor_total, tem_arte, tipo_producao, largura_cm, altura_cm, material_id, preco_origem, preco_memoria, revenda_produto_id)
       VALUES ($1, $2, $3, NULL, $3, $4, $5, $6, false, 'SERVICO', NULL, NULL, NULL, 'auto', 'Serviço fixo', NULL)`,
      [orcamentoId, codigo++, s.produto, s.quantidade, s.valor_unitario, s.valor_total]
    );
  }
}
```

(`codigo` continua a numeração do loop de produtos; `descricao = produto`.) O `UPDATE total` seguinte soma as novas linhas automaticamente.

### Componente 3 — Passar `entrega` do chatbot

Em `src/ai/agent.js`, no objeto `dados` passado a `criarOrder`, acrescentar:

```javascript
  entrega: args.entrega === 'entrega',
```

## Fluxo de dados

1. Cliente conclui o pedido no chatbot; informa se tem arte (por item) e retirada/entrega.
2. `agent.js` chama `criarOrder(dados)` com `origin_channel='chatbot'`, `itens[].tem_arte` e `entrega`.
3. `criarOrder` cria as linhas de produto e, sendo chatbot, acrescenta `Arte Final` (R$30 × nº itens sem arte) e/ou `Entrega` (R$15).
4. `total` do orçamento passa a incluir os serviços; o vendedor vê as linhas na aba Orçamentos e pode editar/remover.
5. Serviços não geram OS nem entram na esteira.

## Tratamento de erro / bordas

- Todos os itens com arte + retirada → nenhuma linha extra (comportamento atual).
- Pedido manual do painel (`origin_channel !== 'chatbot'`) → nenhuma linha automática.
- `itens` vazio já é barrado antes (erro "ao menos um item").
- Falha ao inserir serviço não deve derrubar a criação do pedido: a auto-criação do orçamento já está em `try/catch` (`[ORDER->ORC]`); as inserções de serviço ficam dentro do mesmo bloco.

## Testes

- **Unit** (`tests/`): `linhasServicoAuto` — (a) 2 itens sem arte, 1 com arte → linha Arte qtd 2 valor 60; (b) todos com arte → sem linha de arte; (c) `entrega=true` → linha Entrega 15; (d) `entrega=false` → sem entrega; (e) nenhum item sem arte + retirada → array vazio.
- **Smoke no VPS:** simular um pedido chatbot (via `criarOrder` com `origin_channel='chatbot'`, um item `tem_arte:false`, `entrega:true`) e conferir no orçamento as linhas `Arte Final` (R$30) e `Entrega` (R$15) somadas ao total; limpar o pedido de teste depois.

## Fora de escopo

- Tornar os valores configuráveis (tabela de preços).
- Aplicar no "Novo Pedido" manual do painel.
- Tratamento fiscal dos serviços (segue a diretriz de diluir no produto na NF-e).
- Precificação automática do produto em si (banner 0,00 é a precificação manual do vendedor — assunto à parte).
