# Casamento de item ↔ produto de revenda usando especificação + padronização "Banner" na lona — Design

**Data:** 2026-07-06
**Autor:** Kleber + Claude

## Problema

O pedido 33 (orçamento 39) tinha um item `BANNERS` (lona 440g, 6,78×2,30m) que saiu **sem precificação automática** (valor 0,00, manual), enquanto um item de Adesivo (orçamento 38) casou corretamente com a regra interna (`interno_m2`, R$30/m², bobina de menor desperdício).

**Causa raiz:** `resolverProdutoRevenda` (`src/modules/revenda/service.js`) monta o texto de matching como `produto + material` — **não** inclui `especificacao`. No item de Adesivo, o campo `material` trazia "vinil brilho" (palavra "BRILHO" batia com o nome do SKU). No banner, a informação "lona 440g" só existia dentro de `especificacao` (`"6,78m x 2,30m · lona 440g"`), então o texto de matching acabou sendo só `"BANNERS"` — que não bate com nenhum SKU nomeado com "Banner" (singular) no catálogo, pois a tokenização (`tokensMaterial`) não trata plural. Resultado: pontuação zero, nenhum SKU casado, item cai em manual/0,00.

Adicionalmente, o catálogo de lona tem nomes inconsistentes: alguns já têm prefixo `Banner |` ou `Faixa |`, outros são só `Lona ...`. Isso torna o casamento dependente de coincidências de gramatura/acabamento em vez de um token confiável comum.

## Objetivo

1. `resolverProdutoRevenda` passa a considerar a especificação do item no matching, não só produto+material.
2. Todo item do grupo de bobina `lona` no catálogo passa a conter a palavra "Banner" no nome, garantindo que qualquer item chamado "Banner" no pedido compartilhe esse token com o catálogo.

## Contexto do código

- `src/modules/revenda/service.js`: `resolverProdutoRevenda({ produto, material, tipo_producao, largura_cm, altura_cm, impressao })` monta `texto = \`${produto || ''} ${material || ''}\`.trim()` e pontua contra `revenda_produtos.nome` via `pontuarSku(texto, nomeSku)` (interseção de tokens, `tokensMaterial` em `src/constants/produtos.js`).
- Único chamador: `src/modules/orders/service.js`, dentro de `criarOrder`, no loop de itens: `revendaService.resolverProdutoRevenda({ produto: it.produto, material: it.material, tipo_producao: tipo, largura_cm: larg, altura_cm: alt, impressao: it.impressao })`. `it.especificacao` já existe no escopo (mesmo item).
- `resolverFolheto` (família Folder/Folheto/Flyer) roda **antes** e usa critério próprio (gramatura+tamanho+impressão) — não afetado por esta mudança.
- Catálogo `revenda_produtos` com `estrategia='interno_m2'` e `bobina_grupo='lona'` é gerido internamente pela LKL — **não** é sobrescrito pelo scraper (`src/modules/revenda/scraper.js` só busca páginas HTML da Graficonauta para produtos `revenda_matriz`; não escreve em `revenda_produtos.nome`).
- Já existe teste (`tests/matcher-revenda.test.js`) que testa `pontuarSku` isoladamente com um texto que já inclui "lona 440g brilho" — prova que o scorer funciona; o gap está em quem monta o texto.

## Arquitetura

### Componente 1 — Incluir especificação no matching

Em `src/modules/revenda/service.js`, `resolverProdutoRevenda` ganha o parâmetro `especificacao` e o inclui no texto:

```javascript
async function resolverProdutoRevenda({ produto, material, tipo_producao, largura_cm, altura_cm, impressao, especificacao }) {
  // ...(família folheto inalterada)...
  const texto = `${produto || ''} ${material || ''} ${especificacao || ''}`.trim();
  // ...resto inalterado...
}
```

Em `src/modules/orders/service.js`, a chamada em `criarOrder` passa a enviar `especificacao: it.especificacao`.

### Componente 2 — Padronizar nomes do catálogo (grupo lona)

Script one-time (`scripts/padronizar-nome-lona.js`) que roda:

```sql
UPDATE revenda_produtos
SET nome = 'Banner | ' || nome
WHERE bobina_grupo = 'lona' AND nome NOT ILIKE 'Banner |%';
```

Efeito: os 5 itens já `Banner | ...` ficam intocados (filtro `NOT ILIKE`); os 5 `Faixa | Lona ...` viram `Banner | Faixa | Lona ...`; os 17 `Lona ...` puros viram `Banner | Lona ...`. Todos os 27 itens do grupo `lona` passam a compartilhar o token "BANNER".

## Fluxo de dados

1. Chatbot captura um item (ex.: produto="BANNERS", especificação="6,78m x 2,30m · lona 440g").
2. `criarOrder` chama `resolverProdutoRevenda` com produto+material+especificacao.
3. O texto de matching agora contém "BANNERS ... LONA 440G" — bate com qualquer SKU do grupo lona (todos têm "BANNER" e muitos têm "LONA"/"440"), com boa pontuação.
4. O item é precificado via `interno_m2`: escolhe a bobina de menor desperdício entre 1,60/2,20/3,20m, calcula R$/m² × área.

## Tratamento de erro / bordas

- `especificacao` ausente/null → texto igual ao comportamento atual (sem regressão).
- Itens de Folheto/Flyer/Folder continuam usando `resolverFolheto`, que roda antes e não é afetado.
- A renomeação do catálogo é idempotente (`NOT ILIKE 'Banner |%'` evita rodar duas vezes / duplicar prefixo).

## Testes

- **Unit:** `pontuarSku`/`resolverProdutoRevenda` — reproduzir o caso real: produto="BANNERS", material=null, especificacao="6,78m x 2,30m · lona 440g" → deve encontrar um SKU do grupo lona com pontuação > 0 (mockando `db.query` para retornar os produtos do catálogo).
- **Smoke no VPS:** recriar um pedido chatbot equivalente ao 33 (produto BANNERS, especificacao com "lona 440g", sem material) e conferir que o item sai com `preco_origem='auto'`, `preco_memoria` mencionando `interno_m2`/bobina; rodar o script de padronização e conferir a contagem de nomes atualizados (~22) e que os 5 já-Banner não mudaram.

## Fora de escopo

- Tratar plural na tokenização (`tokensMaterial`) — decisão explícita de não mexer nisso agora.
- Padronizar outros grupos de bobina (adesivo, etc.) — só o grupo `lona` foi pedido.
- Qualquer mudança na UI/CRUD de catálogo (não existe tela de edição de `revenda_produtos.nome` hoje; fora de escopo criar uma).
