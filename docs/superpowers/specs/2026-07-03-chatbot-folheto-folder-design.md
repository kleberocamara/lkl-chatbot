# Chatbot — folheto/flyer/folder: tamanho, impressão e dobras — Design

**Data:** 2026-07-03
**Status:** Aprovado para escrita de plano
**Contexto:** No orçamento 37 o item FOLDER foi auto-precificado casando um SKU de tamanho fixo ("Folheto 115g | 10x28cm | 4/0") sem o bot ter perguntado o tamanho real, a impressão (frente/verso) nem o nº de dobras. Folheto, flyer e folder são o **mesmo serviço-base** (impressão em couché); o **folder** apenas agrega o serviço de **dobra**. Para precificar com precisão, o bot precisa coletar tamanho + impressão (todos) e nº de dobras (folder), e o matcher precisa casar o SKU por esses atributos, aplicando a dobra como acabamento.

## Objetivo

(A) O bot passa a perguntar **tamanho** e **impressão (4/0 ou 4/4)** para folheto/flyer/folder, e **nº de dobras** para folder. (B) A precificação casa o SKU de folheto certo (gramatura mais próxima + menor tamanho ≥ pedido + impressão) e soma a **dobra** como acabamento.

## Premissas (do brainstorming)

- Perguntar impressão frente/verso (4/0 vs 4/4) — sim.
- Tamanho: usar o **menor SKU cujo tamanho ≥ o pedido** (arredonda pra cima; nunca cota abaixo).
- Folder = folheto + acabamento de dobra ("1 Dobra"/"2 Dobras"/"3 Dobras" já existem no catálogo).
- Gramatura vem do material; casa a **mais próxima** disponível.
- Auto-preço é rascunho interno; bot nunca informa preço ao cliente.

## Dados do catálogo (confirmados)

- SKUs `Folheto <gram>g | <L>x<A>cm | <4/0|4/4>` (`revenda_matriz`). Ex.: `Folheto 115g | 10x21cm | 4/4`.
- Acabamentos `1 Dobra`, `2 Dobras`, `3 Dobras` em `revenda_acabamentos`.
- `precificarItemRevenda({ ..., acabamentos: ['2 Dobras'] })` soma o custo do acabamento (casa por `nome`).

## Parte A — Coleta no bot (`src/ai/agent.js`)

### Regra nova no `SYSTEM_PROMPT`

Seção para a **família folheto/flyer/folder**:
- **Sempre** perguntar o **tamanho** (em metros, como já padronizado) — não registrar sem tamanho.
- **Sempre** perguntar a **impressão**: só frente (`4/0`) ou frente e verso (`4/4`). Ex.: *"É impresso só na frente ou frente e verso? 😊"*
- **Se for folder**, perguntar também o **nº de dobras** (1, 2 ou 3). Folheto/flyer não têm dobra (`dobras=0`).
- Gramatura continua do material (guia de materiais).

### Campos novos na função `registrar_pedido` (tool)

Adicionar, no item (achatado e em `itens[]`):
- `impressao`: string enum `'4/0' | '4/4'` (default ausente → tratado como `'4/4'` na precificação, o mais comum).
- `dobras`: number `0..3` (default 0).

O agente também inclui esses dados no texto da `especificacao` (ex.: `"0,10m x 0,21m · couché 150g · 4/4 · 2 dobras"`) para exibição. Os valores `impressao`/`dobras` são repassados no objeto do item para o `criarOrder` (usados na precificação em memória — sem migration).

### Repasse no `agent.js` (montagem de `itensDados`)

`itensDados` de cada item passa a incluir `impressao` e `dobras` (além de produto/dimensoes/material/tem_arte já existentes), para chegarem ao `criarOrder`.

## Parte B — Matcher e precificação da família folheto

### `resolverFolheto({ material, largura_cm, altura_cm, impressao })` (novo, `src/modules/revenda/service.js`)

Função de resolução por atributos (pura na escolha; a consulta ao catálogo é feita antes e passada, para testabilidade — ver "Testes"):
1. Considera só SKUs cujo `nome` casa `/^Folheto /i` e `estrategia='revenda_matriz'`.
2. **Parse do nome** de cada SKU → `{ gramatura, larg_cm, alt_cm, impressao }` (regex sobre `Folheto (\d+)g \| (\d+)x(\d+)cm \| (4/0|4/4)`).
3. **Impressão:** filtra pelos que batem `impressao` do pedido (default `4/4`).
4. **Gramatura:** entre os restantes, escolhe a gramatura com menor `|gram_sku − gram_pedido|` (gramatura do pedido extraída do material, ex.: "couché 150g" → 150; se ausente, usa a gramatura mais comum/qualquer).
5. **Tamanho:** dos SKUs dessa gramatura+impressão, pega o **menor** cujo `larg_cm ≥ pedido_larg` **e** `alt_cm ≥ pedido_alt` (considerar as duas orientações: comparar (L,A) e (A,L)). "Menor" = menor área. Nenhum serve → retorna `null`.
6. Retorna a linha do SKU escolhido (ou `null`).

### Integração no `resolverProdutoRevenda`

Quando `produto` é da família folheto (mapeia para `FOLDER`/`FOLHETO`/`FLYER`), tenta `resolverFolheto` primeiro; se retornar SKU, usa-o; senão cai no score genérico atual.

### Dobras no `criarOrder`

Ao precificar, montar os acabamentos a partir de `it.dobras`:
```js
const acab = (Number(it.dobras) > 0) ? [`${it.dobras} ${Number(it.dobras) === 1 ? 'Dobra' : 'Dobras'}`] : [];
```
e passar `acabamentos: acab` para `precificarItemRevenda`. A impressão (`it.impressao`) entra no `resolverFolheto`.

## Erros e bordas

- Sem tamanho (bot não coletou) → `resolverFolheto` não tem como casar tamanho → cai no genérico/manual (mas o prompt exige tamanho, então raro).
- Impressão ausente → assume `4/4`.
- Gramatura ausente → usa a mais próxima de um default (couché 150g) entre os SKUs.
- Dobras > 3 ou acabamento inexistente → `precificarItemRevenda` ignora o acabamento não encontrado (preço do folheto sem a dobra); analista ajusta.
- Pedido maior que o maior SKU do catálogo → `resolverFolheto` retorna `null` → manual.

## Testes

- **Jest (pura):** `escolherFolheto(skus, { gramatura, largura_cm, altura_cm, impressao })` — dado um array de SKUs parseados: escolhe menor tamanho ≥ pedido; respeita impressão; gramatura mais próxima; retorna null quando nada serve. (A função de escolha recebe a lista já carregada — testável sem DB; `resolverFolheto` faz a query e delega a ela.)
- **Smoke no VPS:** precificar um folheto `10x21cm 4/4 couché 115g` (casa o SKU certo) e um folder `10x21 4/4 com 2 dobras` (soma acabamento "2 Dobras" ao preço).

## Fora de escopo

- Outros produtos Offset (cartão, cartaz etc.) — mantêm o matcher genérico.
- Colunas novas em `orcamento_itens` para impressão/dobras (ficam na `especificacao` e no fluxo de criação; sem migration).
- Bot informar preço ao cliente (mantém a regra).

## Dependências

- `revenda_produtos` (SKUs folheto), `revenda_acabamentos` (dobras), `precificarItemRevenda` (aceita `acabamentos`) já existem. Depende do matcher AO recém-entregue (`resolverProdutoRevenda`, `pontuarSku`). Sem migration.
