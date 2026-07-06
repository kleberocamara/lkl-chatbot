# Girar a arte quando não couber na bobina (rotação largura↔altura) — Design

**Data:** 2026-07-06
**Autor:** Kleber + Claude

## Problema

Mesmo após corrigir o matching (especificação no texto) e padronizar o catálogo (nomes com "Banner"), o pedido 33 (banner 6,78m × 2,30m) continuou sem precificação automática. Causa: `calcularInternoM2` (`src/modules/revenda/pricer.js`) só testa `largura_cm` contra as larguras de bobina disponíveis — nunca tenta a orientação girada. Como uma bobina é um rolo contínuo (largura fixa 1,60/2,20/3,20m, comprimento livre), uma arte de 6,78×2,30m **cabe perfeitamente girada** (2,30m contra a bobina de 3,20m; os 6,78m correm no comprimento do rolo) — mas o motor rejeita porque 6,78m > todas as larguras de bobina.

Confirmado manualmente em produção: com `largura_cm=678, altura_cm=230` → `null`; com `largura_cm=230, altura_cm=678` (giradas) → `R$650,88, bobina 3,20m`.

## Objetivo

O motor de precificação interna (m²/bobina) passa a testar as duas orientações (normal e girada) e escolhe a de menor desperdício entre as que couberem.

## Contexto do código

- `src/modules/revenda/pricer.js`: `calcularInternoM2(ctx, item)` chama `engine.escolherBobina(larg, ctx.espaco_corte_cm, ctx.bobinas)` (só largura), calcula área com a altura original.
- `src/modules/precificacao/engine.js`: `escolherBobina(larguraArteCm, g, bobinas)` — função pura existente, escolhe a bobina de menor desperdício para uma única dimensão testada. Também usada por `precificacao/engine.js` próprio `calcularItem` (método `m2_bobina`) — **motor diferente, não conectado ao `criarOrder`**; não será tocado.
- `src/modules/revenda/service.js`: `precificarItemRevenda` chama `pricer.calcularInternoM2` para `estrategia==='interno_m2'` — é o caminho real usado pelo chatbot.
- Teste existente `tests/revenda-pricer.test.js`: `'arte mais larga que todas as bobinas → null'` usa 200×100cm contra bobinas de adesivo (máx 150cm) — com rotação, 100cm cabe girado na bobina 106cm, então esse teste **precisa mudar de expectativa** (não é regressão, é a correção esperada).

## Arquitetura

### Componente 1 — `escolherBobinaComRotacao` em `engine.js`

```javascript
// Tenta as duas orientações (normal e girada) e escolhe a de menor desperdício
// entre as que couberem. Empate → prefere a orientação original (normal).
// Retorna { largura_cm, n, largura_util_cm, comprimento_cm } ou null.
function escolherBobinaComRotacao(largura_cm, altura_cm, g, bobinas) {
  const normal = escolherBobina(Number(largura_cm), g, bobinas);
  const girada = escolherBobina(Number(altura_cm), g, bobinas);
  if (normal && girada) {
    return girada.largura_util_cm < normal.largura_util_cm
      ? { ...girada, comprimento_cm: Number(largura_cm) }
      : { ...normal, comprimento_cm: Number(altura_cm) };
  }
  if (normal) return { ...normal, comprimento_cm: Number(altura_cm) };
  if (girada) return { ...girada, comprimento_cm: Number(largura_cm) };
  return null;
}
```

Exportada junto de `escolherBobina` (que permanece inalterada, usada por `calcularItem`).

### Componente 2 — `calcularInternoM2` usa a nova função

Em `pricer.js`, trocar a chamada de `engine.escolherBobina(larg, ...)` por `engine.escolherBobinaComRotacao(larg, alt, ...)`, e usar `b.comprimento_cm` (não mais a variável `alt` direta) no cálculo da área.

## Fluxo de dados

1. `precificarItemRevenda` (estrategia `interno_m2`) chama `calcularInternoM2({bobinas, preco_m2, espaco_corte_cm}, {largura_cm, altura_cm, quantidade})`.
2. `calcularInternoM2` chama `escolherBobinaComRotacao(largura_cm, altura_cm, gap, bobinas)`.
3. Se a orientação normal couber, usa ela; se só a girada couber, usa a girada; se nenhuma, `null` (item cai em manual, como hoje).
4. Área = bobina escolhida (`largura_util_cm`) × `comprimento_cm` (a dimensão não casada contra a bobina).

## Tratamento de erro / bordas

- Nenhuma orientação cabe → `null` (comportamento atual preservado para casos genuinamente maiores que qualquer bobina nas duas orientações).
- Ambas orientações cabem com o mesmo desperdício → prefere a normal (determinístico).
- Dimensões ausentes/inválidas → já tratado antes de chamar (guarda existente em `calcularInternoM2`).

## Testes

- **Unit** (`tests/revenda-pricer.test.js`):
  - Atualizar `'arte mais larga que todas as bobinas → null'` para dimensões que não cabem em **nenhuma** orientação (ex.: 200×180 contra bobinas de adesivo, máx 150).
  - Novo teste: 200×100 contra bobinas de adesivo → agora casa girado, bobina 106, mesmo resultado do teste already-existing de 100×200 (R$63,60).
  - Novo teste: reproduzir o pedido 33 — 678×230 contra bobinas de lona [160,220,320] → bobina 320, R$650,88.
  - Novo teste em `engine.js`/`precificacao.test.js` (opcional, se aplicável) não é necessário — `escolherBobina` em si não muda; só a nova função `escolherBobinaComRotacao` precisa de cobertura, testada via `calcularInternoM2` (suficiente, evita duplicar cobertura).
- **Smoke no VPS:** recriar o pedido 33 (banner 678×230) via `criarOrder` e confirmar que agora sai com `preco_origem='auto'`, valor R$650,88, `preco_memoria` mencionando bobina 3,20m.

## Fora de escopo

- `precificacao/engine.js`'s `escolherBobina`/`calcularItem` (motor não conectado ao `criarOrder`) — sem mudança.
- Emenda de bobinas (unir duas larguras para artes maiores que qualquer bobina em ambas orientações) — não pedido, fica de fora.
