# Girar a arte quando não couber na bobina — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O motor de precificação interna (m²/bobina) passa a testar a arte nas duas orientações (normal e girada) e escolher a de menor desperdício, permitindo precificar automaticamente banners mais largos que a maior bobina (desde que a menor dimensão caiba).

**Architecture:** Nova função pura `escolherBobinaComRotacao` em `src/modules/precificacao/engine.js` (ao lado da `escolherBobina` existente, que fica intocada); `calcularInternoM2` (`src/modules/revenda/pricer.js`) passa a usá-la.

**Tech Stack:** Node.js, Jest.

**Referência:** `docs/superpowers/specs/2026-07-06-rotacao-bobina-design.md`

**Fatos do código:**
- `src/modules/precificacao/engine.js:10` — `function escolherBobina(larguraArteCm, g, bobinas)`, retorna `{ largura_cm, n, largura_util_cm }` ou `null`. `module.exports` na linha 81 é `{ calcularItem, escolherBobina, round2 }`.
- `src/modules/revenda/pricer.js:1` — `const engine = require('../precificacao/engine');`. Linha 46: `function calcularInternoM2(ctx, item) { const larg = Number(item.largura_cm), alt = Number(item.altura_cm); ...; const b = engine.escolherBobina(larg, ctx.espaco_corte_cm, ctx.bobinas); ...; const area = (b.largura_util_cm / 100) * (alt / 100); ... }`. `module.exports` linha 60: `{ calcularRevenda, round2, calcularInternoM2, custoDobraMilheiro }`.
- Confirmado manualmente em produção: `precificarItemRevenda({revenda_produto_id, quantidade:1, largura_cm:678, altura_cm:230, ...})` → `null`; com `largura_cm:230, altura_cm:678` (giradas) → `{valor_unitario:650.88, valor_total:650.88, memoria:"Bobina 3.2m (1 por largura) → 3.2m × 6.78m = 21.7m² × R$ 30/m² = R$ 650.88/un × 1 = R$ 650.88", bobina_cm:320}`.

---

### Task 1: `escolherBobinaComRotacao` em `engine.js` (TDD)

**Files:**
- Modify: `src/modules/precificacao/engine.js`
- Test: `tests/precificacao.test.js`

- [ ] **Step 1: Escrever o teste que falha**

Em `tests/precificacao.test.js`, adicionar (após o `describe('escolherBobina', ...)` existente, sem alterá-lo):

```javascript
const { escolherBobinaComRotacao } = require('../src/modules/precificacao/engine');

describe('escolherBobinaComRotacao', () => {
  test('cabe normal (sem precisar girar) → usa largura como está', () => {
    const b = escolherBobinaComRotacao(100, 200, 0, [{ largura_cm: 106 }, { largura_cm: 127 }, { largura_cm: 150 }]);
    expect(b.largura_cm).toBe(106);
    expect(b.comprimento_cm).toBe(200);
  });

  test('só cabe girada → usa altura contra a bobina, largura vira comprimento', () => {
    const b = escolherBobinaComRotacao(200, 100, 0, [{ largura_cm: 106 }, { largura_cm: 127 }, { largura_cm: 150 }]);
    expect(b.largura_cm).toBe(106);
    expect(b.comprimento_cm).toBe(200);
  });

  test('cenário real do pedido 33: 678x230 contra bobinas de lona → bobina 320, comprimento 678', () => {
    const b = escolherBobinaComRotacao(678, 230, 0, [{ largura_cm: 160 }, { largura_cm: 220 }, { largura_cm: 320 }]);
    expect(b.largura_cm).toBe(320);
    expect(b.comprimento_cm).toBe(678);
  });

  test('nenhuma orientação cabe → null', () => {
    expect(escolherBobinaComRotacao(200, 180, 0, [{ largura_cm: 150 }])).toBeNull();
  });

  test('ambas orientações cabem com mesmo desperdício → prefere a normal', () => {
    const b = escolherBobinaComRotacao(100, 100, 0, [{ largura_cm: 106 }]);
    expect(b.comprimento_cm).toBe(100);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/precificacao.test.js`
Expected: FAIL — `escolherBobinaComRotacao is not a function`.

- [ ] **Step 3: Implementar**

Em `src/modules/precificacao/engine.js`, adicionar (logo após a função `escolherBobina` existente, antes de `function calcularItem`):

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

Atualizar `module.exports` (linha 81, atualmente `module.exports = { calcularItem, escolherBobina, round2 };`) para:

```javascript
module.exports = { calcularItem, escolherBobina, escolherBobinaComRotacao, round2 };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest tests/precificacao.test.js`
Expected: PASS (testes originais de `escolherBobina`/`calcularItem` + os 5 novos de `escolherBobinaComRotacao`).

- [ ] **Step 5: Commit**

```bash
git add src/modules/precificacao/engine.js tests/precificacao.test.js
git commit -m "feat(precificacao): escolherBobinaComRotacao testa as duas orientações"
```

---

### Task 2: `calcularInternoM2` usa a rotação + atualizar teste existente

**Files:**
- Modify: `src/modules/revenda/pricer.js`
- Modify: `tests/revenda-pricer.test.js`

- [ ] **Step 1: Atualizar o teste que muda de comportamento (esperado, não regressão)**

Em `tests/revenda-pricer.test.js`, localizar o teste:

```javascript
  test('arte mais larga que todas as bobinas → null', () => {
    expect(calcularInternoM2({ bobinas: bobinasAdesivo, preco_m2: 30 },
      { largura_cm: 200, altura_cm: 100, quantidade: 1 })).toBeNull();
  });
```

Substituir por (dimensões que não cabem em **nenhuma** orientação — 200 e 180 ambas maiores que a maior bobina de adesivo, 150):

```javascript
  test('arte mais larga que todas as bobinas em qualquer orientação → null', () => {
    expect(calcularInternoM2({ bobinas: bobinasAdesivo, preco_m2: 30 },
      { largura_cm: 200, altura_cm: 180, quantidade: 1 })).toBeNull();
  });
```

Logo abaixo, adicionar dois testes novos (mesmo `describe('calcularInternoM2', ...)`):

```javascript
  test('só cabe girada (200x100 vira 100x200) → mesmo resultado do 100x200 direto', () => {
    const r = calcularInternoM2({ bobinas: bobinasAdesivo, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 200, altura_cm: 100, quantidade: 1 });
    expect(r.bobina_cm).toBe(106);
    expect(r.valor_total).toBeCloseTo(63.60, 2);
  });

  test('pedido 33: banner 6,78m x 2,30m → gira, bobina 3,20m, R$650,88', () => {
    const r = calcularInternoM2({ bobinas: bobinasLona, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 678, altura_cm: 230, quantidade: 1 });
    expect(r.bobina_cm).toBe(320);
    expect(r.valor_total).toBeCloseTo(650.88, 2);
  });
```

(`bobinasAdesivo` e `bobinasLona` já estão definidas no topo do arquivo, reaproveitar.)

- [ ] **Step 2: Rodar e confirmar que os novos testes falham, o teste atualizado passa por acaso ou falha (implementação ainda não mudou)**

Run: `npx jest tests/revenda-pricer.test.js`
Expected: os 2 novos testes de rotação FALHAM (implementação ainda não gira); o teste renomeado/atualizado (200x180) deve PASSAR (200 e 180 já não cabem em nenhuma bobina de adesivo, mesmo sem rotação implementada — comportamento inalterado para esse caso).

- [ ] **Step 3: Implementar — `calcularInternoM2` usa `escolherBobinaComRotacao`**

Em `src/modules/revenda/pricer.js`, dentro de `calcularInternoM2`, localizar:

```javascript
function calcularInternoM2(ctx, item) {
  const larg = Number(item.largura_cm), alt = Number(item.altura_cm);
  if (!(larg > 0) || !(alt > 0)) return null;
  const b = engine.escolherBobina(larg, ctx.espaco_corte_cm, ctx.bobinas);
  if (!b) return null;
  const qtd = Number(item.quantidade) > 0 ? Number(item.quantidade) : 1;
  const area = (b.largura_util_cm / 100) * (alt / 100);
  const pm2 = Number(ctx.preco_m2) || 0;
  const vu = round2(area * pm2);
  const vt = round2(vu * qtd);
  const memoria = `Bobina ${b.largura_cm / 100}m (${b.n} por largura) → ${round2(b.largura_util_cm / 100)}m × ${alt / 100}m = ${round2(area)}m² × R$ ${pm2}/m² = R$ ${vu}/un × ${qtd} = R$ ${vt}`;
  return { valor_unitario: vu, valor_total: vt, memoria, bobina_cm: b.largura_cm };
}
```

Substituir por:

```javascript
function calcularInternoM2(ctx, item) {
  const larg = Number(item.largura_cm), alt = Number(item.altura_cm);
  if (!(larg > 0) || !(alt > 0)) return null;
  const b = engine.escolherBobinaComRotacao(larg, alt, ctx.espaco_corte_cm, ctx.bobinas);
  if (!b) return null;
  const qtd = Number(item.quantidade) > 0 ? Number(item.quantidade) : 1;
  const comprimento = b.comprimento_cm;
  const area = (b.largura_util_cm / 100) * (comprimento / 100);
  const pm2 = Number(ctx.preco_m2) || 0;
  const vu = round2(area * pm2);
  const vt = round2(vu * qtd);
  const memoria = `Bobina ${b.largura_cm / 100}m (${b.n} por largura) → ${round2(b.largura_util_cm / 100)}m × ${comprimento / 100}m = ${round2(area)}m² × R$ ${pm2}/m² = R$ ${vu}/un × ${qtd} = R$ ${vt}`;
  return { valor_unitario: vu, valor_total: vt, memoria, bobina_cm: b.largura_cm };
}
```

(Única mudança de lógica: `engine.escolherBobina(larg, ...)` → `engine.escolherBobinaComRotacao(larg, alt, ...)`, e a área/memória usam `b.comprimento_cm` em vez de `alt` direto.)

- [ ] **Step 4: Rodar e confirmar que tudo passa**

Run: `npx jest tests/revenda-pricer.test.js`
Expected: PASS (todos os testes de `calcularRevenda` inalterados + `calcularInternoM2` com os 3 antigos + 1 atualizado + 2 novos).

Rodar a suíte toda para garantir que nada mais quebrou:

Run: `npx jest`
Expected: sem novas falhas (testes de integração que dependem de DB real já falham localmente — pré-existente, ignorar).

- [ ] **Step 5: Commit**

```bash
git add src/modules/revenda/pricer.js tests/revenda-pricer.test.js
git commit -m "fix(revenda): calcularInternoM2 gira a arte quando só cabe na orientação alternativa"
```

---

### Task 3: Deploy VPS + smoke com o cenário real do pedido 33 + memória

**Contexto:** `root@2.25.147.243`, app `/var/www/lkl-chatbot`, DB `lkl_chatbot`, pm2 `lkl-chatbot`. **Confirmar com o usuário antes de deployar (produção).**

- [ ] **Step 1: Rsync**

```bash
rsync -R -av src/modules/precificacao/engine.js src/modules/revenda/pricer.js root@2.25.147.243:/var/www/lkl-chatbot/
```

- [ ] **Step 2: Restart**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```
Expected: `online`.

- [ ] **Step 3: Smoke — recriar o pedido 33 de ponta a ponta via `criarOrder`**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e \"
const s=require('./src/modules/orders/service');
(async()=>{
  const r=await s.criarOrder({origin_channel:'chatbot', itens:[{produto:'BANNERS', quantidade:1, tem_arte:false, especificacao:'6,78m x 2,30m · lona 440g', largura_cm:678, altura_cm:230}], entrega:false}, null);
  if(r.erro){console.error('ERRO', r.erro); process.exit(1);}
  const db=require('./src/db');
  const q=await db.query('SELECT produto, valor_unitario, valor_total, preco_origem, preco_memoria FROM orcamento_itens WHERE orcamento_id=\\\$1 ORDER BY codigo', [r.order.orcamento_id]);
  console.table(q.rows);
  await db.query('DELETE FROM orcamento_itens WHERE orcamento_id=\\\$1',[r.order.orcamento_id]);
  await db.query('DELETE FROM order_items WHERE order_id=\\\$1',[r.order.id]);
  await db.query('DELETE FROM orcamentos WHERE id=\\\$1',[r.order.orcamento_id]);
  await db.query('DELETE FROM orders WHERE id=\\\$1',[r.order.id]);
  console.log('teste limpo'); process.exit(0);
})();
\""
```
Expected: linha `BANNERS` com `preco_origem='auto'`, `valor_total='650.88'`, `preco_memoria` mencionando "Bobina 3.2m"; linha `Arte Final` R$30; "teste limpo" ao final, sem erro.

- [ ] **Step 4: Memória**

Anexar entrada em `project_sprint_status.md` (memory/, fora do repo) consolidando os 3 fixes desta investigação (matching por especificação + padronização Banner no catálogo + rotação de bobina) e a cadeia de causas reais do pedido 33/orçamento 39, corrigindo o registro anterior que apontava "regras_preco vazia" como causa (estava errado — o motor real e já configurado é o `interno_m2` em `revenda_produtos`). Criar/atualizar `reference_matching_revenda.md` com o aprendizado.

- [ ] **Step 5: Commit final (se necessário)**

```bash
git add -A && git commit -m "chore(revenda): rotação de bobina deployada e validada com o cenário real do pedido 33" || echo "nada a commitar"
```

---

## Self-Review (checklist do autor)

**Spec coverage:**
- Componente 1 (`escolherBobinaComRotacao`) → Task 1 ✅
- Componente 2 (`calcularInternoM2` usa a rotação) → Task 2 ✅
- Teste existente atualizado (não regressão) → Task 2 Step 1 ✅
- Smoke com o cenário real → Task 3 ✅

**Consistência de nomes:** `escolherBobinaComRotacao`, `comprimento_cm`, `bobina_cm`, `largura_util_cm` usados de forma idêntica em todas as tasks. ✅

**Sem placeholders:** todo passo de código traz o código real, incluindo os valores exatos esperados (R$63,60, R$650,88, bobina 320). ✅
