# Tuning do chatbot — padronizar Produto/Material — Design

**Data:** 2026-06-25
**Contexto:** Teste fim a fim. O chatbot captura `produto` e `material` como texto livre, o que prejudica o casamento automático no servidor (derivação de `tipo_producao` e resolução de `material_id`). Foco escolhido pelo usuário: **produto/material padronizado**. Fora de escopo: dimensões ("118,5 m"), separação de itens, tom.

## Problema

- **Produto:** texto livre ("Banner", "placa de pvc"). O servidor já normaliza via `matchProduto` (singular/plural/sem-acento), mas nomes fora do catálogo não casam → `tipo_producao` fica null.
- **Material:** o cadastro tem **106 materiais ativos** em nível de SKU, com gramatura e tamanho de folha no nome (ex.: `COUCHE LISO 90 GR 96X66`). O resolvedor atual (`_resolverMaterialId`) usa `ILIKE %termo%`, que falha para "couchê 90g" porque há "LISO" entre "COUCHE" e "90". Injetar 106 nomes no prompt é inviável (token + o cliente nunca diz "96X66").

## Escopo

### A. Produto travado no schema da tool (`src/ai/agent.js`)

- `produto` e `itens[].produto` na tool `registrar_pedido` passam a ter `enum` com as 28 famílias canônicas da LKL (mesma lista de `src/constants/produtos.js`) + `"OUTROS"`.
- Regra nova no SYSTEM_PROMPT: "Ao registrar, mapeie o produto pedido para o nome mais próximo desta lista: [...]. Se não houver correspondência, use OUTROS e descreva o produto em observações."
- Efeito: `produto` sempre cai num valor que `matchProduto`/`tipoPorProduto` reconhecem → `tipo_producao` deriva certo na origem.

### B. Material — guia no prompt + matcher por tokens no servidor

- **Prompt:** regra para capturar o material como descritor limpo (família + gramatura/acabamento), ex.: "couchê 90g", "lona 440", "vinil fosco", "cartolina 240g". Não inventar; se o cliente não souber, deixar em branco.
- **Servidor (`src/modules/orders/service.js`, `_resolverMaterialId`):** substituir o `ILIKE %termo%` por **match por tokens**:
  1. Normaliza o termo (maiúsculas, sem acento) e quebra em tokens alfanuméricos com 2+ caracteres (ignora "GR", "g", unidades irrelevantes? — manter números como tokens: "90" é discriminante).
  2. Busca materiais ativos cujo `nome` (normalizado) contenha **todos** os tokens (AND de `ILIKE %token%`).
  3. Ordena preferindo o nome **mais curto** (menos específico/mais provável) e retorna o `id` do primeiro; se nenhum casar com todos, faz fallback para o comportamento atual (exato → parcial do termo inteiro); se ainda assim nada, retorna null.
  - Mantém o `console.error` no catch (já existe).
  - Continua best-effort: material não encontrado → null → atendente seleciona no painel.

### C. Lista canônica compartilhada

- O `enum` de produtos no `agent.js` deve usar a lista de `src/constants/produtos.js` (importar `PRODUTOS` e mapear para os nomes) para não duplicar uma terceira cópia. Assim front (`PRODUTOS_LKL`), back-helpers (`produtos.js`) e agente ficam alinhados pela mesma origem no backend.

## Fluxo de dados

```
cliente → agente (produto ∈ enum canônico; material = descritor limpo)
   → registrar_pedido → ordersService.criarOrder
       → tipo_producao = tipoPorProduto(produto)  (casa sempre)
       → material_id = _resolverMaterialId(material)  (match por tokens)
```

## Tratamento de erros

- Produto "OUTROS" → `tipoPorProduto` retorna null (cai como OFFSET genérico no painel; atendente ajusta). Aceitável.
- Material sem match → null (sem erro ao cliente); atendente seleciona.
- Tokens só com ruído (ex.: "não sei") → nenhum material casa → null.

## Testes

- **Unit determinístico** (`tests/resolver-material.test.js` ou similar): a função de match por tokens é extraída como helper puro `matchMaterialNome(nomeCadastro, termo)` ou `tokensDoTermo(termo)` testável SEM banco. Casos:
  - tokens("couchê 90g") inclui "COUCHE" e "90"; NÃO inclui "GR"/"G" isolados irrelevantes (definir regra: descartar tokens de 1 char e a unidade "GR").
  - Dado um conjunto-fixture de nomes (["COUCHE LISO 90 GR 96X66","COUCHE LISO 150 GR 96X66","LONA 440 BRILHO","VINIL FOSCO 1,50X50"]), o seletor escolhe: "couchê 90g"→COUCHE 90; "lona"→LONA 440 BRILHO; "vinil fosco"→VINIL FOSCO; "xyz"→nenhum.
- **Unit produto:** `matchProduto`/`tipoPorProduto` já cobertos (`tests/produtos.test.js`).
- **Smoke no VPS (não determinístico, conferência):** 2–3 diálogos roteirizados via `processMessage`/tool, conferindo que a saída traz `produto` ∈ lista canônica e `material` limpo. Aceitar variação de redação do modelo; validar só os campos estruturados.
- **Smoke do resolvedor real:** rodar `_resolverMaterialId('couchê 90g')` / `'lona'` / `'vinil fosco'` contra o cadastro real no VPS e conferir que retorna um id plausível.

## Fora de escopo

- Dimensões/parse de medidas do chatbot.
- Separação de múltiplos itens (já tratada na regra 12).
- Enxugar tom/quantidade de perguntas.
- Reescrever a base de materiais (SKU-level permanece).
