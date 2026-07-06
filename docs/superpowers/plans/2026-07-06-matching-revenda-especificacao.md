# Casamento de item ↔ produto de revenda usando especificação + padronização "Banner" na lona — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir o casamento de item↔produto de revenda para considerar a especificação do item, e padronizar o catálogo de lona para todos os nomes conterem "Banner", fechando o caso do pedido 33/orçamento 39 (banner sem precificação automática).

**Architecture:** `resolverProdutoRevenda` ganha o parâmetro `especificacao` e o inclui no texto de matching; `criarOrder` passa a enviá-lo. Um script one-time renomeia os produtos do grupo de bobina `lona` no catálogo.

**Tech Stack:** Node.js, PostgreSQL (pg), Jest.

**Referência:** `docs/superpowers/specs/2026-07-06-matching-revenda-especificacao-design.md`

**Fatos do código:**
- `src/modules/revenda/service.js` requer `db` como `const db = require('../../db')`. A partir de `tests/`, o caminho equivalente é `require('../src/db')`.
- `resolverProdutoRevenda({ produto, material, tipo_producao, largura_cm, altura_cm, impressao })` (linha ~78) monta `texto = \`${produto || ''} ${material || ''}\`.trim()` e pontua contra `SELECT id, nome, tipo_servico, estrategia, bobina_grupo, preco_m2 FROM revenda_produtos WHERE ativo = TRUE` via `pontuarSku`.
- Único chamador: `src/modules/orders/service.js`, dentro de `criarOrder`, no loop de itens (linha ~175): `revendaService.resolverProdutoRevenda({ produto: it.produto, material: it.material, tipo_producao: tipo, largura_cm: larg, altura_cm: alt, impressao: it.impressao })`.
- `module.exports` de `revenda/service.js` já inclui `resolverProdutoRevenda` e `pontuarSku` (usados por `tests/matcher-revenda.test.js`).

---

### Task 1: `resolverProdutoRevenda` considera `especificacao` (TDD)

**Files:**
- Modify: `src/modules/revenda/service.js`
- Test: `tests/matcher-revenda.test.js` (adicionar ao arquivo existente)

- [ ] **Step 1: Escrever o teste que falha**

Em `tests/matcher-revenda.test.js`, adicionar (após o `describe('pontuarSku', ...)` existente, mantendo-o intacto):

```javascript
const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { resolverProdutoRevenda } = require('../src/modules/revenda/service');

describe('resolverProdutoRevenda com especificacao', () => {
  afterEach(() => jest.clearAllMocks());

  test('produto="BANNERS" sem material, com especificacao "lona 440g" → casa com SKU de lona', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'sku-lona-440', nome: 'Banner | Lona Fosca 440g', tipo_servico: 'COMUNICAÇÃO VISUAL', estrategia: 'interno_m2', bobina_grupo: 'lona', preco_m2: 30 },
        { id: 'sku-adesivo', nome: 'Adesivo Vinil Fosco', tipo_servico: 'COMUNICAÇÃO VISUAL', estrategia: 'interno_m2', bobina_grupo: 'adesivo', preco_m2: 30 },
      ],
    });
    const prod = await resolverProdutoRevenda({
      produto: 'BANNERS',
      material: null,
      tipo_producao: 'COMUNICAÇÃO VISUAL',
      largura_cm: 678, altura_cm: 230,
      especificacao: '6,78m x 2,30m · lona 440g',
    });
    expect(prod).not.toBeNull();
    expect(prod.id).toBe('sku-lona-440');
  });

  test('sem especificacao, produto isolado sem overlap → null (comportamento anterior preservado)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'sku-lona', nome: 'Banner | Lona Fosca 440g', tipo_servico: 'COMUNICAÇÃO VISUAL', estrategia: 'interno_m2', bobina_grupo: 'lona', preco_m2: 30 },
      ],
    });
    const prod = await resolverProdutoRevenda({
      produto: 'BANNERS',
      material: null,
      tipo_producao: 'COMUNICAÇÃO VISUAL',
      largura_cm: 678, altura_cm: 230,
    });
    expect(prod).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/matcher-revenda.test.js`
Expected: FAIL no primeiro teste novo (`prod` é `null` porque `especificacao` ainda não é usado no texto).

- [ ] **Step 3: Implementar**

Em `src/modules/revenda/service.js`, na função `resolverProdutoRevenda`, alterar a assinatura e a linha do texto:

```javascript
async function resolverProdutoRevenda({ produto, material, tipo_producao, largura_cm, altura_cm, impressao, especificacao }) {
  // Família folheto/flyer/folder: casa por gramatura+tamanho+impressão.
  if (/FOLDER|FOLHETO|FLYER/.test(_semAcento(produto)) && Number(largura_cm) > 0 && Number(altura_cm) > 0) {
    const f = await resolverFolheto({ material, largura_cm, altura_cm, impressao });
    if (f) return f;
  }
  const texto = `${produto || ''} ${material || ''} ${especificacao || ''}`.trim();
  if (!texto) return null;
  // ...resto da função inalterado...
```

(Só as duas linhas mudam: a assinatura ganha `especificacao`, e a linha `const texto = ...` passa a incluir `${especificacao || ''}`. Nada mais na função muda.)

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest tests/matcher-revenda.test.js`
Expected: PASS (5 testes: os 3 originais de `pontuarSku` + os 2 novos).

- [ ] **Step 5: Commit**

```bash
git add src/modules/revenda/service.js tests/matcher-revenda.test.js
git commit -m "fix(revenda): resolverProdutoRevenda considera especificacao no matching"
```

---

### Task 2: `criarOrder` passa a enviar `especificacao`

**Files:**
- Modify: `src/modules/orders/service.js` (chamada a `resolverProdutoRevenda` dentro de `criarOrder`)

- [ ] **Step 1: Acrescentar o campo na chamada**

Em `src/modules/orders/service.js`, localizar (dentro de `criarOrder`, no loop de itens):

```javascript
        const prod = await revendaService.resolverProdutoRevenda({ produto: it.produto, material: it.material, tipo_producao: tipo, largura_cm: larg, altura_cm: alt, impressao: it.impressao });
```

Substituir por:

```javascript
        const prod = await revendaService.resolverProdutoRevenda({ produto: it.produto, material: it.material, tipo_producao: tipo, largura_cm: larg, altura_cm: alt, impressao: it.impressao, especificacao: it.especificacao });
```

- [ ] **Step 2: Checar sintaxe**

Run: `node -e "require('./src/modules/orders/service.js'); console.log('parse OK')"`
Expected: `parse OK`.

- [ ] **Step 3: Commit**

```bash
git add src/modules/orders/service.js
git commit -m "fix(orcamentos): criarOrder passa especificacao para resolverProdutoRevenda"
```

---

### Task 3: Script de padronização do catálogo (grupo lona)

**Files:**
- Create: `scripts/padronizar-nome-lona.js`

- [ ] **Step 1: Escrever o script**

Criar `scripts/padronizar-nome-lona.js` (seguir o estilo de `scripts/backfill-status-pedido.js` para o require do db):

```javascript
// Padroniza o catálogo do grupo de bobina 'lona' para todo nome conter "Banner",
// garantindo que itens de pedido chamados "Banner" casem com qualquer SKU de lona.
// Rodar uma vez: node -r dotenv/config scripts/padronizar-nome-lona.js
const db = require('../src/db');

(async () => {
  const before = await db.query(
    `SELECT id, nome FROM revenda_produtos WHERE bobina_grupo='lona' ORDER BY nome`
  );
  console.log(`Total no grupo 'lona': ${before.rows.length}`);

  const r = await db.query(
    `UPDATE revenda_produtos
     SET nome = 'Banner | ' || nome
     WHERE bobina_grupo = 'lona' AND nome NOT ILIKE 'Banner |%'
     RETURNING id, nome`
  );
  console.log(`Renomeados: ${r.rows.length}`);
  r.rows.forEach(row => console.log(`  -> ${row.nome}`));

  const semBanner = await db.query(
    `SELECT COUNT(*) FROM revenda_produtos WHERE bobina_grupo='lona' AND nome NOT ILIKE '%Banner%'`
  );
  console.log(`Itens do grupo lona ainda sem "Banner" no nome: ${semBanner.rows[0].count}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Checar sintaxe**

Run: `node --check scripts/padronizar-nome-lona.js`
Expected: sem saída (OK).

- [ ] **Step 3: Commit**

```bash
git add scripts/padronizar-nome-lona.js
git commit -m "chore(revenda): script de padronização do nome dos produtos de lona (Banner)"
```

---

### Task 4: Deploy VPS + rodar script + smoke + memória

**Contexto:** `root@2.25.147.243`, app `/var/www/lkl-chatbot`, DB `lkl_chatbot`, pm2 `lkl-chatbot`. **Confirmar com o usuário antes de deployar (produção) e antes de rodar o UPDATE no catálogo.**

- [ ] **Step 1: Rsync**

```bash
rsync -R -av src/modules/revenda/service.js src/modules/orders/service.js scripts/padronizar-nome-lona.js root@2.25.147.243:/var/www/lkl-chatbot/
```

- [ ] **Step 2: Restart**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```
Expected: `online`.

- [ ] **Step 3: Rodar o script de padronização (uma vez)**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config scripts/padronizar-nome-lona.js"
```
Expected: "Total no grupo 'lona': 27", "Renomeados: 22" (17 puros + 5 Faixa), lista dos novos nomes, "Itens do grupo lona ainda sem \"Banner\" no nome: 0".

- [ ] **Step 4: Smoke — recriar o cenário do pedido 33 e conferir precificação automática**

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
Expected: linha do item BANNERS com `preco_origem='auto'` e `preco_memoria` mencionando `interno_m2` e a bobina escolhida (uma das 1,60/2,20/3,20m); "teste limpo" ao final, sem erro de FK.

- [ ] **Step 5: Memória**

Anexar entrada em `project_sprint_status.md` (memory/, fora do repo) descrevendo: causa raiz real do pedido 33 (matching não incluía especificação; catálogo com nomes inconsistentes), a correção (especificacao no texto de matching + padronização "Banner" no grupo lona), e que a hipótese inicial de "regras_preco vazia" estava **errada** — o motor real é o `interno_m2` em `revenda_produtos`/`revenda_bobina_grupos`, que já estava configurado corretamente. Atualizar/criar `reference_matching_revenda.md` com esse aprendizado para não repetir o engano.

- [ ] **Step 6: Commit final (se necessário)**

```bash
git add -A && git commit -m "chore(revenda): matching por especificacao + padronização Banner deployado e validado" || echo "nada a commitar"
```

---

## Self-Review (checklist do autor)

**Spec coverage:**
- Componente 1 (especificacao no matching) → Task 1 + Task 2 ✅
- Componente 2 (padronização Banner) → Task 3 + execução Task 4 ✅
- Testes unit + smoke → Task 1 + Task 4 ✅

**Consistência de nomes:** `resolverProdutoRevenda`, `especificacao`, `it.especificacao`, `preco_origem`, `preco_memoria` usados de forma idêntica em todas as tasks. ✅

**Sem placeholders:** todo passo de código traz o código real; a query SQL de padronização é exibida por completo. ✅
