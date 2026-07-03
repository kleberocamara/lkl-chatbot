# Auto-precificação dos pedidos do chatbot — Design

**Data:** 2026-07-03
**Status:** Aprovado para escrita de plano
**Contexto:** Pedidos criados pelo chatbot (`orders/service.js → criarOrder`) inserem os itens do orçamento com **valor 0** e nunca chamam o motor de precificação — a auto-precificação só existe no caminho do painel (`orcamentos/router`), e mesmo lá só para itens vinculados a um produto do catálogo (`revenda_produto_id`) ou via `regras_preco` (que está vazia). Resultado: um banner pedido pelo bot entra a R$ 0 (visto no orçamento 37). O objetivo é o bot auto-precificar como **rascunho interno** os itens cujos SKUs do catálogo são `interno_m2` ("regra interna LKL", R$30/m²) ou `revenda_matriz` ("manter auto", tabela Graficonauta). O bot **nunca informa preço ao cliente**; o valor preenche o orçamento interno que o analista revisa antes de enviar.

## Objetivo

No `criarOrder`, casar cada item do pedido a um SKU do catálogo (`revenda_produtos`) por aproximação e auto-precificar com o motor existente (`precificarItemRevenda`), gravando `preco_origem='auto'`. Itens sem casamento confiável (ou `manual`) ficam R$ 0 para precificação manual.

## Premissas (do brainstorming)

- Casamento por **aproximação (melhor palpite)** — aceitável porque é rascunho interno revisado pelo analista.
- **Estratégia vem do SKU casado:** `interno_m2` → R$30/m²; `revenda_matriz` → tabela Graficonauta (dados já na base: `revenda_precos` tem 3.945 linhas); `manual` → não precifica.
- Dados de preço já existem; parser de dimensões já corrigido (aceita "1,20m x 1,10m").

## Arquitetura

Sem migration (colunas `revenda_produto_id`, `preco_origem`, `preco_memoria`, `largura_cm`, `altura_cm` já existem em `orcamento_itens`). Reusa `revendaService.precificarItemRevenda` (mesmo motor do painel).

- **`src/modules/revenda/service.js`** (ou um util próximo): função pura de score `pontuarSku(textoPedido, nomeSku)` + `resolverProdutoRevenda({ produto, material, tipo_producao })` (consulta o catálogo e escolhe o melhor).
- **`src/modules/orders/service.js`**: no loop de inserção de `orcamento_itens`, chamar o matcher + `precificarItemRevenda` e gravar o resultado; recalcular o total do orçamento.

## Componente 1 — Matcher

**`pontuarSku(textoPedido, nomeSku)`** (pura, testável): normaliza ambos (upper, sem acento), tokeniza, retorna o número de tokens relevantes de `textoPedido` presentes em `nomeSku` (ignora tokens curtos/genéricos como "de", "g", "cm"). Ex.: `pontuarSku('BANNERS lona 440g brilho', 'Banner | Lona Brilho 300g | 1000x1000')` > `pontuarSku(... , 'Adesivo Vinil Fosco')`.

**`resolverProdutoRevenda({ produto, material, tipo_producao })`** (consulta DB):
```sql
SELECT id, nome, tipo_servico, estrategia, bobina_grupo, preco_m2
FROM revenda_produtos
WHERE ativo = TRUE
  AND ($tipoServico IS NULL OR tipo_servico = $tipoServico)
```
- `$tipoServico` mapeado de `tipo_producao`: `COMUNICAÇÃO VISUAL` → `COMUNICAÇAO VISUAL`; `OFFSET` → `OFFSET`; senão `NULL` (sem filtro).
- Pontua cada candidato com `pontuarSku('${produto} ${material}', nome)`; escolhe o de **maior score**. Empate → prefere `estrategia='interno_m2'` (produção interna LKL); depois menor `nome`.
- **Score 0 → retorna `null`** (nada casou com confiança → item fica manual).

## Componente 2 — Auto-precificação no `criarOrder`

No loop que insere `orcamento_itens` (hoje grava `valor_unitario=0, valor_total=0`), para cada item **antes do INSERT**:
1. `larg`/`alt` já resolvidos (parser); `qtd = it.quantidade`.
2. `let valorUnit = 0, valorTotal = 0, precoOrigem = 'manual', precoMemoria = null, revProdId = null;`
3. `const prod = await resolverProdutoRevenda({ produto: it.produto, material: it.material, tipo_producao: tipo });`
4. Se `prod && prod.estrategia !== 'manual'`:
   ```js
   const calc = await revendaService.precificarItemRevenda({
     revenda_produto_id: prod.id, quantidade: qtd,
     largura_cm: larg, altura_cm: alt, prazo_horas: null, acabamentos: [],
   });
   if (calc && Number(calc.valor_total) > 0) {
     valorUnit = calc.valor_unitario; valorTotal = calc.valor_total;
     precoOrigem = 'auto'; revProdId = prod.id;
     precoMemoria = `${calc.estrategia} · ${prod.nome}` + (calc.memoria ? ` · ${calc.memoria}` : '');
   }
   ```
5. O INSERT grava `valor_unitario=valorUnit, valor_total=valorTotal, preco_origem=precoOrigem, preco_memoria=precoMemoria, revenda_produto_id=revProdId` (além do que já grava).
6. Toda a etapa 3-4 em `try/catch` por item: erro → item fica `manual` (valor 0), pedido segue normalmente.

Após o loop, **recalcular o total do orçamento**: `UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`.

> Nota: os campos exatos retornados por `precificarItemRevenda` (`valor_unitario`, `valor_total`, `memoria`, `estrategia`) devem ser conferidos na implementação; se o nome do campo de memória diferir, ajustar o `precoMemoria` (fallback: só `estrategia · nome`).

## Erros e bordas

- Item sem dimensão para `interno_m2` → `precificarItemRevenda` retorna nulo → item fica manual (não inventa preço).
- `produto`/`material` genérico que não casa nada → `resolverProdutoRevenda` retorna `null` → manual.
- Offset "manual" (cartão/folder sem tabela) → sem casamento útil ou estratégia `manual` → manual (esperado; hoje não há regra automática para eles).
- Falha do motor → `try/catch` isola por item.

## Testes

- **Jest (pura):** `pontuarSku` — banner/lona casa melhor com SKU de lona que com adesivo; tokens genéricos não pontuam; texto vazio → 0.
- **Smoke no VPS:** reprocessar (ou recriar) um item de banner com dimensão e conferir que `resolverProdutoRevenda` acha um SKU `interno_m2` e `precificarItemRevenda` retorna R$30×área; conferir orçamento com `preco_origem='auto'` e total > 0.
- **Backfill do orçamento 37:** após o deploy, reprecificar os itens do orçamento 37 (script pontual ou reprocessamento) para o banner sair de R$ 0.

## Fora de escopo

- Bot mostrar ou confirmar preço ao cliente (mantém a regra de nunca informar valores).
- Matcher "perfeito" por SKU exato (é melhor-palpite; analista revisa).
- Popular `regras_preco` (AO-1) — não é usada aqui; a precificação vem de `revenda_produtos`/`precificarItemRevenda`.
- Auto-precificar Offset "manual" (sem regra automática hoje).

## Dependências

- `revenda_produtos`, `revenda_precos` (populado), `precificarItemRevenda` já existem. Parser de dimensões já corrigido. Sem migration.
