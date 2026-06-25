# Melhorar entrada de pedido — arte por item + pré-preenchimento do Editar Item — Design

**Data:** 2026-06-25
**Contexto:** Teste fim a fim da entrada de pedido pelo chatbot. Dois ajustes no painel:
(1) mostrar/editar "tem arte" por item na tela **Editar Pedido**; (2) corrigir o
pré-preenchimento dos campos do modal **Editar Item** (Produto/Serviço, Tipo de Produção,
Largura/Altura/material da Comunicação Visual) — hoje vêm em branco quando o item veio do
chatbot. O chatbot **não muda**: ele já captura `tem_arte` por item.

## Fatos verificados

- `tem_arte` é booleano por item, gravado em `orcamento_itens.tem_arte`
  (`orcamentos/service.js:158`). O agente já o captura (`ai/agent.js:92,109,233`) e a API o
  expõe (`dashboard/api.js:217`).
- `buscarPorId` retorna `SELECT * FROM orcamento_itens` (`orcamentos/service.js:105`) → cada
  item já traz `tem_arte`, `produto`, `tipo_producao`, `largura_cm`, `altura_cm`,
  `material_id`. Nenhuma migration necessária.
- **Lacuna backend:** `POST /:id/itens` e `PATCH /:id/itens/:itemId`
  (`orcamentos/router.js:372–410`) aceitam produto/tipo_producao/especificacao/quantidade/
  valor_*/largura_cm/altura_cm/material_id, mas **não** `tem_arte`. É o único bloqueio para
  gravar a arte na edição.
- **Bug do Editar Item** (`dashboard.html:1185 abrirEditarItemOrc`): o Produto é adivinhado
  pela string da descrição (`descricao.split(' — ')[0]` → "Cartaz") e comparado contra o
  `PRODUTOS_LKL`, que é **maiúsculo** ("CARTAZ"). `"Cartaz" !== "CARTAZ"` → o select fica
  "Selecione..." e o Tipo de Produção fica vazio. O modal **já** busca o detalhe do orçamento
  (`api(/api/v2/orcamentos/:id)`) e lê largura/altura/material de `item`, então `item.produto`
  e `item.tipo_producao` estão disponíveis ali e devem ser a fonte da verdade.
- `tipoPorProduto(nome)` (`dashboard.html:3052`) deriva o tipo a partir do nome exato do
  produto; `PRODUTOS_LKL` lista produtos e seus tipos (OFFSET / COMUNICAÇÃO VISUAL).
- `abrirEditarItemOrc` é usada tanto na lista de itens do orçamento (`dashboard.html:1172`)
  quanto no Editar Pedido (`dashboard.html:3179`) — uma só função beneficia os dois lugares.
- `carregarItensPedidoEdit` (`dashboard.html:3167`) monta as linhas de item do Editar Pedido;
  já esconde os botões editar/excluir quando o orçamento está travado
  (`['enviado','aprovado','reprovado','cancelado']`).
- Deploy: `rsync -az <arquivo> root@2.25.147.243:/var/www/lkl-chatbot/<destino>` +
  `pm2 restart lkl-chatbot --update-env` (apenas para mudança de backend).
- Smoke no VPS: `ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e '<js>'"`.

## Escopo

Três unidades pequenas e independentes:

### 1. Backend — aceitar `tem_arte` no item (`src/modules/orcamentos/router.js`)

- **POST `/:id/itens`** (≈372–388): incluir `tem_arte` na lista de campos do `req.body` e na
  coluna do INSERT (`..., tem_arte)` / `VALUES (..., $N)`), com `!!tem_arte` (default `false`).
- **PATCH `/:id/itens/:itemId`** (≈391–410): incluir `tem_arte` no `req.body` e no UPDATE como
  `tem_arte=COALESCE($N,tem_arte)`, passando `tem_arte ?? null` para não sobrescrever quando o
  cliente não enviar o campo.
- Sem mudança de migration, validação ou permissão (mesmas roles atuais).

### 2. Editar Pedido — toggle "Arte" por item (`public/dashboard.html`)

Em `carregarItensPedidoEdit`, cada linha de item passa a exibir um chip clicável
**"Arte: Sim" / "Arte: Não"** refletindo `it.tem_arte`:

- Sim → fundo verde (`#16a34a`); Não → fundo cinza (`#9ca3af`); texto branco, fonte 11px,
  `border-radius:10px`, `cursor:pointer`.
- Clicar chama o novo helper `toggleArteItem(orcId, itemId, novoValor, btnEl)` que faz
  `PATCH /api/v2/orcamentos/:orcId/itens/:itemId` com `{ tem_arte: novoValor }`, e ao sucesso
  atualiza o texto/cor/`onclick` do próprio chip (sem recarregar a lista). Em erro, `showToast`.
- O chip fica **somente leitura** (sem `onclick`, `cursor:default`) quando o orçamento está
  travado, na mesma condição `travado` que já esconde editar/excluir.
- Posição: entre a descrição (`flex:1`) e a quantidade, ou logo após a quantidade — manter a
  linha legível em largura de modal.

### 3. Editar Item — pré-preencher Produto/Tipo + CV + arte (`public/dashboard.html`)

Em `abrirEditarItemOrc` (e o POST/PATCH em `salvarItemOrc`):

- **Produto/Tipo (corrigir o bug):** após carregar `item` do detalhe, selecionar o produto
  casando `item.produto` contra as opções do select **sem diferença de maiúsculas/minúsculas**
  (comparar `String(o.value).toUpperCase() === String(item.produto||'').toUpperCase()`). Ao
  casar, definir `ei-tipo` = `item.tipo_producao || tipoPorProduto(produtoSelecionado)`. Manter
  o palpite por string como **fallback** apenas se `item.produto` vier vazio.
- **Comunicação Visual (auto-parse + manual):** novo helper puro
  `parseDimensoes(texto)` → `{ largura_cm, altura_cm } | null`. Regra: regex que captura
  `num [x|×|X] num` com decimais por vírgula ou ponto e unidade opcional (`m`, `cm`); se a
  unidade for `m`, multiplicar por 100 (→ cm); se `cm` ou ausente, usar como está. Aplicar o
  parse **apenas** quando o Tipo de Produção for `COMUNICAÇÃO VISUAL` **e** `largura_cm`/
  `altura_cm` do item vierem nulos — assim "40X30 CM" de um Cartaz offset (medida de papel)
  não é confundido com medida de CV. Quando `item.largura_cm`/`item.altura_cm` já existirem,
  usá-los (comportamento atual). Material continua manual (o select já é populado por
  `_popularMateriaisSelect`).
- **Tem arte:** adicionar ao modal um toggle **"Cliente tem a arte? Sim/Não"** (par de botões
  ou um botão que alterna, guardando o estado num elemento com `id="ei-arte"` via
  `dataset.val`), inicializado de `item.tem_arte`. Em `salvarItemOrc`, incluir
  `tem_arte: (ei-arte === 'true')` no corpo do PATCH.

## Fluxo de dados

```
chatbot → ordersService.criarOrder → orcamento_itens (tem_arte, produto, tipo_producao, …)
   │
Editar Pedido (carregarItensPedidoEdit) → chip Arte → toggleArteItem → PATCH item {tem_arte}
   │
Editar Item (abrirEditarItemOrc) → GET orçamento detalhe → preenche produto/tipo/CV/arte
   └ salvarItemOrc → PATCH item {produto, tipo_producao, …, largura_cm, altura_cm, material_id, tem_arte}
```

## Tratamento de erros

- `parseDimensoes` retorna `null` em texto não reconhecido → campos ficam em branco para
  preenchimento manual (sem erro/toast).
- `toggleArteItem`: em falha da API, `showToast('❌ Erro ao salvar arte')` e o chip volta ao
  estado anterior (não atualiza otimisticamente sem confirmação).
- PATCH com `tem_arte` ausente não altera o valor (COALESCE), preservando edições parciais.

## Testes

- **Unit (parseDimensoes):** "1,20 x 0,60 m" → {120,60}; "200x100 cm" → {200,100};
  "40X30" (sem unidade) → {40,30}; "COUCHÊ 90G" → null; "1.5 × 2 m" → {150,200}.
- **Smoke VPS:** `PATCH /api/v2/orcamentos/:id/itens/:itemId` com `{tem_arte:true}` e
  `GET /api/v2/orcamentos/:id` confirmando `tem_arte=true` no item.
- **Visual no painel (pedido #25 do chatbot):**
  - Editar Item do Cartaz → Produto = "CARTAZ" e Tipo = "OFFSET" pré-selecionados; largura/
    altura **vazios** (não confunde "40X30 CM").
  - Editar Item do Banner (CV) → largura 120 / altura 60 pré-preenchidos.
  - Lista do Editar Pedido → chip "Arte: Sim/Não" por item; alternar e ver persistir após
    reabrir.

## Fora de escopo

- Qualidade de interpretação de dimensões pelo chatbot (tuning de prompt) — pendência
  separada já registrada.
- Padronização visual de chips/botões/modais (direção D do enxugamento).
- Edição de `tem_arte` no fluxo de Novo Pedido manual (`npItemRowHtml`) — pode entrar depois;
  aqui o foco é o item já existente (chatbot/orçamento).
