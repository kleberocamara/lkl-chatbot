# Novo Pedido — seleção de SKU específico do catálogo de revenda

## Contexto

O pedido #41 (balcão, "BANNERS", 1,20 x 0,80) foi criado pela tela "Novo Pedido" do painel administrativo com preço R$0,00 — o item de orçamento correspondente nunca foi precificado automaticamente, e nada avisou o operador. Investigação encontrou a causa raiz e um bug adicional relacionado:

1. **A tela "Novo Pedido" nunca carrega o catálogo de revenda antes de montar o combo de produto.** `abrirNovoPedido()` (`public/dashboard.html:4977`) chama `npAddItem()` (que renderiza `selectProduto()`) sem nunca ter chamado `carregarCatalogoRevenda()` — diferente da tela "Novo Item" (`abrirAdicionarItemOrc`, `dashboard.html:1826-1827`), que carrega o catálogo antes de montar o mesmo combo. Resultado: o grupo "🛰️ Revenda (Graficonauta)" (com os SKUs exatos, ex: "Banner | Lona Fosca 240g") nunca aparece pro atendente em "Novo Pedido" — confirmado em print real do usuário, só aparece a lista genérica (`PRODUTOS_LKL`) + "Serviços".

2. **Mesmo que o catálogo estivesse carregado, a escolha de um SKU específico seria descartada.** `npColetarItens()` (`dashboard.html:4961-4975`) manda o valor bruto do `<select>` (que seria `"revenda:{id}"` se o operador escolhesse um SKU) direto como `produto` pro backend, sem extrair o id. Comparar com `adicionarItemOrc()` (`dashboard.html:1858-1867`), que já faz esse tratamento corretamente na tela "Novo Item".

3. **O backend (`criarOrder`/`_normalizarItens`, `src/modules/orders/service.js`) sempre tenta achar o SKU por matching de texto livre** (`resolverProdutoRevenda`, `src/modules/revenda/service.js:78-99`), mesmo quando um `revenda_produto_id` explícito poderia ter sido informado. Esse matching por texto (`pontuarSku`) compara tokens por igualdade exata sem lidar com plural — confirmado com um script rodando a função real contra o catálogo de produção: de 30 produtos genéricos da lista `PRODUTOS_LKL`, **9 nunca batem com nada no catálogo** (ADESIVOS, BANNERS, CARTOES DE VISITA, ENVELOPES, ETIQUETA ADESIVA, LÂMINAS, NOTAS, RECEITUÁRIOS, TIMBRADOS) — a maioria (5) só por causa do "S" do plural (o singular existe no catálogo), 1 por nome diferente (Cartão vs Cartões), 3 por realmente não ter SKU equivalente cadastrado ainda.

**Decisão explícita do usuário**: não mexer no algoritmo de matching por texto (`pontuarSku`/`tokensMaterial`) — existe um teste (`tests/matcher-revenda.test.js`) que documenta como intencional a recusa de precificar quando não há informação suficiente pra distinguir entre variações de um produto (ex: banner pode ser lona 240g/300g/440g fosco/brilho, preços bem diferentes por m²; adivinhar errado é pior que não precificar). A solução é dar ao operador o caminho pra escolher o SKU certo diretamente, não fazer o sistema advinhar melhor.

## Escopo

- Carregar o catálogo de revenda antes de montar o combo de produto em "Novo Pedido" (mesmo padrão já usado em "Novo Item").
- Capturar o `revenda_produto_id` quando o operador escolhe um SKU específico do combo (grupo "🛰️ Revenda"), em vez de mandar o texto bruto `"revenda:{id}"` como se fosse nome de produto.
- Backend: quando um item vier com `revenda_produto_id`, pular a advinhação por texto (`resolverProdutoRevenda`) e precificar direto por esse id (`precificarItemRevenda`), mesmo caminho que a tela "Novo Item"/`orcamentos/router.js` já usa.
- Quando o item **não** tiver `revenda_produto_id` e a precificação automática por texto falhar (fica com `valor_unitario=0`/`preco_origem='manual'`), mostrar um aviso visível no card do pedido na lista ("⚠️ sem preço automático") — hoje isso fica silencioso, sem nenhuma indicação.
- **Fora de escopo**: mudar o algoritmo de matching por texto (`pontuarSku`/`tokensMaterial`); cadastrar os 3 produtos sem SKU equivalente no catálogo (ETIQUETA ADESIVA, LÂMINAS, NOTAS) — isso é tarefa de cadastro de catálogo, não de código; mudar a tela "Novo Item" (já funciona corretamente, é a referência usada aqui).

## Design técnico

### 1. `abrirNovoPedido()` carrega o catálogo antes de montar o combo — `public/dashboard.html:4977`

Função vira `async`, com `await carregarCatalogoRevenda()` antes da primeira chamada a `npAddItem()`:

```js
async function abrirNovoPedido() {
  _novoPedidoClienteId = null;
  _npItemSeq = 0;
  await carregarCatalogoRevenda();
  document.getElementById('modal-cadastro-title').textContent = 'Novo Pedido';
  document.getElementById('modal-cadastro-body').innerHTML = `...`; // sem mudança no HTML em si
  document.getElementById('modal-cadastro-save').onclick = salvarNovoPedido;
  document.getElementById('modal-cadastro').style.display = 'block';
  npAddItem();
  npAtualizarCamposContato();
}
```

O botão que chama essa função (`onclick="abrirNovoPedido()"`) continua funcionando igual — `onclick` aceita função async normalmente, só não aguarda o retorno (comportamento aceitável aqui, já que a UI não precisa bloquear em nada além do próprio carregamento do combo).

`carregarCatalogoRevenda()` já tem cache (`if (REVENDA_CATALOGO.length) return REVENDA_CATALOGO;`), então chamá-la de novo aqui não duplica a requisição se a tela "Novo Item" já tiver carregado o catálogo antes na mesma sessão.

### 2. `npColetarItens()` extrai `revenda_produto_id` — `public/dashboard.html:4961-4975`

Mesmo padrão de extração já usado em `adicionarItemOrc()` (`dashboard.html:1861-1867`):

```js
function npColetarItens() {
  const itens = [];
  document.querySelectorAll('#np-itens .np-item-row').forEach(row => {
    const i = row.dataset.idx;
    const produtoRaw = document.getElementById('np-produto-' + i)?.value || '';
    if (!produtoRaw) return;
    const revSel = produtoRaw.startsWith('revenda:');
    const revenda_produto_id = revSel ? produtoRaw.slice(8) : null;
    const produto = revSel
      ? (REVENDA_CATALOGO.find(x => String(x.id) === revenda_produto_id)?.nome || 'Revenda')
      : produtoRaw;
    itens.push({
      produto,
      revenda_produto_id,
      tipo_producao: document.getElementById('np-tipo-' + i)?.value || null,
      quantidade: parseInt(document.getElementById('np-qtd-' + i)?.value) || null,
      especificacao: document.getElementById('np-espec-' + i)?.value?.trim() || null,
    });
  });
  return itens;
}
```

Nota: itens com `produto` = `"servico:..."` (grupo "Serviços" do combo) continuam passando como texto bruto — esse caso já é tratado separadamente no backend (linhas de serviço automáticas), não faz parte da precificação de revenda, então não precisa de tratamento aqui.

### 3. `_normalizarItens`/`criarOrder` usam `revenda_produto_id` quando presente — `src/modules/orders/service.js:69-99` e `:172-189`

Em `_normalizarItens` (linha ~69-90), adiciona `revenda_produto_id` ao objeto normalizado de cada item:

```js
function _normalizarItens(dados) {
  let itens = Array.isArray(dados.itens) ? dados.itens : [];
  itens = itens
    .map(it => ({
      produto: (it.produto || '').trim(),
      tipo_producao: it.tipo_producao || null,
      quantidade: parseInt(it.quantidade) || 1,
      especificacao: (it.especificacao || '').trim() || null,
      tem_arte: !!it.tem_arte,
      dimensoes: it.dimensoes || null,
      material: it.material || null,
      largura_cm: it.largura_cm != null ? it.largura_cm : null,
      altura_cm: it.altura_cm != null ? it.altura_cm : null,
      material_id: it.material_id || null,
      revenda_produto_id: it.revenda_produto_id || null,
    }))
    .filter(it => it.produto);
  // ... branch de fallback (dados.produto único) permanece igual, sem revenda_produto_id
  return itens;
}
```

Em `criarOrder`, no trecho de auto-precificação (linhas ~172-189), pula a resolução por texto quando `it.revenda_produto_id` já veio preenchido:

```js
let valorUnit = 0, valorTotal = 0, precoOrigem = 'manual', precoMemoria = null, revProdId = null;
try {
  let prod = null;
  if (it.revenda_produto_id) {
    // Operador escolheu o SKU exato no combo — não precisa advinhar por texto.
    const r = await db.query('SELECT id, nome, estrategia FROM revenda_produtos WHERE id=$1 AND ativo=TRUE', [it.revenda_produto_id]);
    prod = r.rows[0] || null;
  } else {
    prod = await revendaService.resolverProdutoRevenda({ produto: it.produto, material: it.material, tipo_producao: tipo, largura_cm: larg, altura_cm: alt, impressao: it.impressao, especificacao: it.especificacao });
  }
  if (prod && prod.estrategia !== 'manual') {
    const calc = await revendaService.precificarItemRevenda({
      revenda_produto_id: prod.id, quantidade: it.quantidade,
      largura_cm: larg, altura_cm: alt, prazo_horas: null, acabamentos: [], dobras: it.dobras,
    });
    if (calc && Number(calc.valor_total) > 0) {
      valorUnit = calc.valor_unitario; valorTotal = calc.valor_total;
      precoOrigem = 'auto'; revProdId = prod.id;
      precoMemoria = `${calc.estrategia} · ${prod.nome}${calc.memoria ? ` · ${calc.memoria}` : ''}`;
    }
  }
} catch (e) {
  console.warn('[CHATBOT-PRECO] auto-precificação falhou:', e.message);
}
```

Isso preserva 100% do comportamento existente pra itens sem `revenda_produto_id` (continuam passando pelo matching de texto, sem nenhuma mudança de lógica ali) — só adiciona um caminho novo, determinístico, quando o id já é conhecido.

### 4. Aviso visível quando o item fica sem preço automático

Escopo: só a listagem de pedidos no painel (`loadOrders`/render de cards, `public/dashboard.html`) — não mexe no fluxo de criação em si.

Quando `orders.valor_orcamento` for `NULL` (ou, de forma equivalente, quando nenhum item do orçamento vinculado tiver `preco_origem='auto'`), mostrar um badge no card do pedido na listagem: `⚠️ sem preço automático`. Implementação exata (qual endpoint expõe esse dado agregado, onde no template do card entra o badge) fica definida na fase de plano, após localizar a função de render da listagem de pedidos (`loadOrders`) e confirmar se `valor_orcamento` já vem na resposta de `GET /api/v2/orders` ou precisa ser incluído.

## Testes

- `src/modules/orders/service.js` (`_normalizarItens`, `criarOrder`): não existe suíte de testes pra esse arquivo hoje (confirmado — nenhum arquivo em `tests/` referencia `criarOrder`/`_normalizarItens`). Criar `tests/orders-revenda-produto-id.test.js` cobrindo: item com `revenda_produto_id` explícito → não chama `resolverProdutoRevenda`, precifica direto por esse id (mockando `db.query` e `revendaService`); item sem `revenda_produto_id` → comportamento inalterado (continua chamando `resolverProdutoRevenda`, mesmo caminho de hoje).
- `public/dashboard.html` (`npColetarItens`, `abrirNovoPedido`): sem suíte automatizada (mesmo padrão de todo o painel administrativo) — verificação por leitura + checagem de sintaxe do script inline + smoke manual (abrir "Novo Pedido", confirmar que o grupo "🛰️ Revenda" aparece no combo, escolher um SKU específico, salvar, confirmar no banco que o item ficou com `preco_origem='auto'` e valor correto).
- Backfill/correção do pedido 41 e orçamento 47 já feita manualmente em produção nesta sessão (R$28,80, mesmo cálculo do motor real) — não faz parte desta spec, já resolvido.

## Fora de escopo

- Algoritmo de matching por texto (`pontuarSku`/`tokensMaterial`) — decisão explícita de não mexer, para não reintroduzir risco de precificação errada por adivinhação.
- Cadastro dos 3 produtos sem SKU equivalente no catálogo (ETIQUETA ADESIVA, LÂMINAS, NOTAS) — tarefa de cadastro de catálogo, não de código.
- Mudanças na tela "Novo Item" (já funciona corretamente).
