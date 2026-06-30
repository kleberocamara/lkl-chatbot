# AO-1 — Framework de Estratégia de Preço — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calcular automaticamente o preço de cada item do orçamento conforme uma estratégia de preço por produto (manual · fixo · m2 · m2_bobina · faixa · revenda), mantendo o valor como sugestão editável.

**Architecture:** Motor de cálculo em funções puras (`engine.js`, 100% testável) + serviço que carrega a regra do produto e despacha (`service.js`) + router CRUD de regras/bobinas + ponto de preview. Integração no CRUD de item do orçamento auto-preenche o valor e guarda origem/memória. UI nova na aba Preços.

**Tech Stack:** Node.js + Express, PostgreSQL (`pg`), Jest (funções puras), frontend vanilla em `public/dashboard.html`. Auth cookie-session, `requireRole` para escrita admin/gestor.

**Spec:** `docs/superpowers/specs/2026-06-30-ao1-framework-estrategia-preco-design.md`

---

## File Structure

- **Create** `sql/migrations/043_regras_preco.sql` — tabelas `regras_preco`, `regras_preco_faixa`, `material_bobinas`, `precos_revenda` + colunas em `orcamento_itens`.
- **Create** `src/modules/precificacao/engine.js` — funções puras de cálculo (sem banco).
- **Create** `src/modules/precificacao/service.js` — carrega regra/contexto do banco e chama o engine.
- **Create** `src/modules/precificacao/router.js` — CRUD de regras/faixas/bobinas + `POST /preview`.
- **Create** `tests/precificacao.test.js` — testes unitários do engine.
- **Modify** `src/modules/index.js` — registrar `/precificacao`.
- **Modify** `src/modules/orcamentos/router.js` — auto-precificação no POST/PATCH de item.
- **Modify** `public/dashboard.html` — UI de regras/bobinas + auto-fill no item do orçamento.

> **Convenção de banco do projeto:** não há Postgres local; testes de integração (suítes `modules/*`) falham localmente com `AggregateError` — isso é pré-existente e esperado. Validação real = **smoke E2E no VPS** (`2.25.147.243`, app em `/var/www/lkl-chatbot/`, deploy via `rsync` + `pm2 restart lkl-chatbot --update-env`). Apenas a suíte de funções puras (`tests/precificacao.test.js`) roda local e DEVE passar.

> **Migrations:** o runner `src/db/migrate.js` aplica `sql/schema.sql`, não a pasta `sql/migrations/`. Migrations numeradas são aplicadas manualmente no VPS via `psql`. `orcamento_itens` pertence ao user `postgres` (não `lkl_user`); o `ALTER TABLE orcamento_itens` precisa rodar via `sudo -u postgres psql`.

---

## Task 1: Migration 043 — tabelas de regras + colunas no item

**Files:**
- Create: `sql/migrations/043_regras_preco.sql`

- [ ] **Step 1: Escrever a migration**

Criar `sql/migrations/043_regras_preco.sql` com:

```sql
-- 043_regras_preco.sql — AO-1 framework de estratégia de preço
-- ATENÇÃO: rodar a parte de ALTER orcamento_itens via `sudo -u postgres psql` (tabela pertence ao user postgres).

CREATE TABLE IF NOT EXISTS regras_preco (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto         VARCHAR(150) NOT NULL,
  material_id     UUID REFERENCES materiais(id) ON DELETE SET NULL,
  metodo_calculo  VARCHAR(20) NOT NULL
                  CHECK (metodo_calculo IN ('manual','fixo','m2','m2_bobina','faixa','revenda')),
  preco_base      NUMERIC(12,4),
  m2_minimo       NUMERIC(10,4),
  espaco_corte_cm NUMERIC(6,2) DEFAULT 0,
  ativo           BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_regras_preco_ativa
  ON regras_preco (produto, COALESCE(material_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE ativo;

CREATE TABLE IF NOT EXISTS regras_preco_faixa (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  regra_id        UUID NOT NULL REFERENCES regras_preco(id) ON DELETE CASCADE,
  qtd_min         INTEGER NOT NULL DEFAULT 1,
  qtd_max         INTEGER,
  preco_unitario  NUMERIC(12,4) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regras_preco_faixa_regra ON regras_preco_faixa(regra_id);

CREATE TABLE IF NOT EXISTS material_bobinas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id     UUID NOT NULL REFERENCES materiais(id) ON DELETE CASCADE,
  largura_cm      NUMERIC(8,2) NOT NULL,
  ativo           BOOLEAN DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_material_bobinas_material ON material_bobinas(material_id);

CREATE TABLE IF NOT EXISTS precos_revenda (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto         VARCHAR(150) NOT NULL,
  opcoes          JSONB DEFAULT '{}'::jsonb,
  preco_unitario  NUMERIC(12,4) NOT NULL,
  sincronizado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_precos_revenda_produto ON precos_revenda(produto);

-- Rodar via: sudo -u postgres psql -d <DB> -f (apenas estas duas linhas, se preferir separar)
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS preco_origem  VARCHAR(10) DEFAULT 'manual';
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS preco_memoria TEXT;
```

- [ ] **Step 2: Sanidade de sintaxe (sem banco local)**

Não há Postgres local; valide só a sintaxe SQL básica com:
Run: `node -e "const s=require('fs').readFileSync('sql/migrations/043_regras_preco.sql','utf8'); if(!/CREATE TABLE IF NOT EXISTS regras_preco/.test(s)||!/preco_memoria/.test(s)) throw new Error('migration incompleta'); console.log('OK: migration presente e com colunas-chave');"`
Expected: `OK: migration presente e com colunas-chave`

- [ ] **Step 3: Commit**

```bash
git add sql/migrations/043_regras_preco.sql
git commit -m "feat(ao1): migration 043 regras_preco + bobinas + precos_revenda + colunas no item"
```

---

## Task 2: Motor de cálculo (engine.js) — funções puras (TDD)

**Files:**
- Create: `src/modules/precificacao/engine.js`
- Test: `tests/precificacao.test.js`

A função pública é `calcularItem(regra, item, ctx)`:
- `regra = { metodo_calculo, preco_base, m2_minimo, espaco_corte_cm }`
- `item = { quantidade, largura_cm, altura_cm }`
- `ctx = { faixas: [{qtd_min, qtd_max, preco_unitario}], bobinas: [{largura_cm}], precoRevenda: {preco_unitario, sincronizado_em} | null }`
- Retorna `{ valor_unitario, valor_total, memoria }` ou `null` (mantém manual).

Helpers: `round2(x) = Math.round(x*100)/100`; `qtd = Number(item.quantidade) > 0 ? Number(item.quantidade) : 1`.

- [ ] **Step 1: Escrever os testes (falhando)**

Criar `tests/precificacao.test.js`:

```javascript
const { calcularItem, escolherBobina } = require('../src/modules/precificacao/engine');

describe('calcularItem — fixo', () => {
  test('preço fixo × quantidade', () => {
    const r = calcularItem({ metodo_calculo: 'fixo', preco_base: 2.5 }, { quantidade: 4 }, {});
    expect(r.valor_unitario).toBe(2.5);
    expect(r.valor_total).toBe(10);
  });
  test('quantidade ausente vira 1', () => {
    const r = calcularItem({ metodo_calculo: 'fixo', preco_base: 7 }, {}, {});
    expect(r.valor_total).toBe(7);
  });
});

describe('calcularItem — m2', () => {
  test('área simples', () => {
    const r = calcularItem({ metodo_calculo: 'm2', preco_base: 50 },
      { quantidade: 2, largura_cm: 100, altura_cm: 50 }, {});
    // 1.0m × 0.5m = 0.5 m² × 50 = 25/un × 2 = 50
    expect(r.valor_unitario).toBe(25);
    expect(r.valor_total).toBe(50);
  });
  test('aplica m2_minimo', () => {
    const r = calcularItem({ metodo_calculo: 'm2', preco_base: 50, m2_minimo: 1 },
      { quantidade: 1, largura_cm: 50, altura_cm: 50 }, {});
    // área real 0.25, mínimo 1 → 1 × 50 = 50
    expect(r.valor_unitario).toBe(50);
  });
  test('dimensão ausente → null', () => {
    expect(calcularItem({ metodo_calculo: 'm2', preco_base: 50 }, { quantidade: 1 }, {})).toBeNull();
  });
});

describe('escolherBobina', () => {
  test('sem folga: arte 0,50m, bobinas 1,52 e 1,10 → menor largura imputada', () => {
    const b = escolherBobina(50, 0, [{ largura_cm: 152 }, { largura_cm: 110 }]);
    // 1,52: n=floor(152/50)=3 → 152/3=50,67 ; 1,10: n=2 → 110/2=55 → escolhe 1,52
    expect(b.largura_cm).toBe(152);
    expect(b.n).toBe(3);
    expect(b.largura_util_cm).toBeCloseTo(50.6667, 3);
  });
  test('descarta bobina que não comporta a arte', () => {
    const b = escolherBobina(120, 0, [{ largura_cm: 110 }, { largura_cm: 152 }]);
    expect(b.largura_cm).toBe(152);
    expect(b.n).toBe(1);
  });
  test('folga reduz n por largura', () => {
    const b = escolherBobina(50, 2, [{ largura_cm: 152 }]);
    // n = floor((152+2)/(50+2)) = floor(154/52) = 2
    expect(b.n).toBe(2);
    expect(b.largura_util_cm).toBe(76);
  });
  test('nenhuma bobina comporta → null', () => {
    expect(escolherBobina(200, 0, [{ largura_cm: 152 }])).toBeNull();
  });
});

describe('calcularItem — m2_bobina', () => {
  test('cobra largura imputada × altura', () => {
    const r = calcularItem({ metodo_calculo: 'm2_bobina', preco_base: 25, espaco_corte_cm: 0 },
      { quantidade: 1, largura_cm: 50, altura_cm: 100 }, { bobinas: [{ largura_cm: 152 }] });
    // bobina 1,52 n=3 → util 0,5067m × 1,0m = 0,5067 m² × 25 = 12,67
    expect(r.valor_unitario).toBeCloseTo(12.67, 2);
  });
  test('sem bobina que comporte → null', () => {
    const r = calcularItem({ metodo_calculo: 'm2_bobina', preco_base: 25 },
      { quantidade: 1, largura_cm: 200, altura_cm: 100 }, { bobinas: [{ largura_cm: 152 }] });
    expect(r).toBeNull();
  });
  test('dimensão ausente → null', () => {
    const r = calcularItem({ metodo_calculo: 'm2_bobina', preco_base: 25 },
      { quantidade: 1 }, { bobinas: [{ largura_cm: 152 }] });
    expect(r).toBeNull();
  });
});

describe('calcularItem — faixa', () => {
  const faixas = [
    { qtd_min: 1, qtd_max: 99, preco_unitario: 3 },
    { qtd_min: 100, qtd_max: null, preco_unitario: 2 },
  ];
  test('seleciona faixa pela quantidade', () => {
    const r = calcularItem({ metodo_calculo: 'faixa' }, { quantidade: 150 }, { faixas });
    expect(r.valor_unitario).toBe(2);
    expect(r.valor_total).toBe(300);
  });
  test('faixa com teto', () => {
    const r = calcularItem({ metodo_calculo: 'faixa' }, { quantidade: 10 }, { faixas });
    expect(r.valor_unitario).toBe(3);
  });
  test('fora de qualquer faixa → null', () => {
    const r = calcularItem({ metodo_calculo: 'faixa' }, { quantidade: 0 },
      { faixas: [{ qtd_min: 5, qtd_max: 10, preco_unitario: 3 }] });
    expect(r).toBeNull();
  });
});

describe('calcularItem — revenda', () => {
  test('usa preço espelho', () => {
    const r = calcularItem({ metodo_calculo: 'revenda' }, { quantidade: 3 },
      { precoRevenda: { preco_unitario: 9.9, sincronizado_em: '2026-06-30' } });
    expect(r.valor_unitario).toBe(9.9);
    expect(r.valor_total).toBe(29.7);
  });
  test('sem preço sincronizado → null', () => {
    expect(calcularItem({ metodo_calculo: 'revenda' }, { quantidade: 3 }, { precoRevenda: null })).toBeNull();
  });
});

describe('calcularItem — manual', () => {
  test('sempre null', () => {
    expect(calcularItem({ metodo_calculo: 'manual' }, { quantidade: 5 }, {})).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar os testes para confirmar que falham**

Run: `npx jest tests/precificacao.test.js --no-coverage`
Expected: FAIL — `Cannot find module '../src/modules/precificacao/engine'`.

- [ ] **Step 3: Implementar o engine**

Criar `src/modules/precificacao/engine.js`:

```javascript
// Motor de precificação — funções puras (sem acesso a banco).

const round2 = (x) => Math.round(x * 100) / 100;
const qtdOf = (item) => (Number(item.quantidade) > 0 ? Number(item.quantidade) : 1);
const temDims = (item) => Number(item.largura_cm) > 0 && Number(item.altura_cm) > 0;

// Escolhe, entre as bobinas, a mais econômica (menor largura imputada por item),
// descontando a folga de corte g (cm) entre imagens vizinhas.
// Retorna { largura_cm, n, largura_util_cm } ou null se nenhuma comporta a arte.
function escolherBobina(larguraArteCm, g, bobinas) {
  const gap = Number(g) > 0 ? Number(g) : 0;
  let melhor = null;
  for (const b of bobinas || []) {
    const Lb = Number(b.largura_cm);
    if (!(Lb > 0)) continue;
    const n = Math.floor((Lb + gap) / (larguraArteCm + gap));
    if (n < 1) continue; // arte não cabe nem 1 vez
    const larguraUtil = Lb / n;
    if (!melhor || larguraUtil < melhor.largura_util_cm) {
      melhor = { largura_cm: Lb, n, largura_util_cm: larguraUtil };
    }
  }
  return melhor;
}

function calcularItem(regra, item, ctx = {}) {
  const metodo = regra && regra.metodo_calculo;
  const qtd = qtdOf(item);

  if (metodo === 'fixo') {
    const vu = round2(Number(regra.preco_base) || 0);
    const vt = round2(vu * qtd);
    return { valor_unitario: vu, valor_total: vt,
      memoria: `R$ ${vu}/un × ${qtd} = R$ ${vt}` };
  }

  if (metodo === 'm2') {
    if (!temDims(item)) return null;
    let area = (item.largura_cm / 100) * (item.altura_cm / 100);
    if (Number(regra.m2_minimo) > 0) area = Math.max(area, Number(regra.m2_minimo));
    const vu = round2(area * (Number(regra.preco_base) || 0));
    const vt = round2(vu * qtd);
    return { valor_unitario: vu, valor_total: vt,
      memoria: `${item.largura_cm / 100}m × ${item.altura_cm / 100}m = ${round2(area)}m² × R$ ${regra.preco_base}/m² = R$ ${vu}/un × ${qtd} = R$ ${vt}` };
  }

  if (metodo === 'm2_bobina') {
    if (!temDims(item)) return null;
    const b = escolherBobina(Number(item.largura_cm), regra.espaco_corte_cm, ctx.bobinas);
    if (!b) return null;
    const area = (b.largura_util_cm / 100) * (item.altura_cm / 100);
    const vu = round2(area * (Number(regra.preco_base) || 0));
    const vt = round2(vu * qtd);
    return { valor_unitario: vu, valor_total: vt,
      memoria: `Bobina ${b.largura_cm / 100}m (${b.n} por largura, folga ${Number(regra.espaco_corte_cm) || 0}cm) → ${round2(b.largura_util_cm / 100)}m × ${item.altura_cm / 100}m = ${round2(area)}m² × R$ ${regra.preco_base}/m² = R$ ${vu}/un × ${qtd} = R$ ${vt}` };
  }

  if (metodo === 'faixa') {
    const faixa = (ctx.faixas || []).find(
      (f) => qtd >= Number(f.qtd_min) && (f.qtd_max == null || qtd <= Number(f.qtd_max))
    );
    if (!faixa) return null;
    const vu = round2(Number(faixa.preco_unitario));
    const vt = round2(vu * qtd);
    return { valor_unitario: vu, valor_total: vt,
      memoria: `Faixa ${faixa.qtd_min}–${faixa.qtd_max ?? '∞'}: R$ ${vu}/un × ${qtd} = R$ ${vt}` };
  }

  if (metodo === 'revenda') {
    if (!ctx.precoRevenda) return null;
    const vu = round2(Number(ctx.precoRevenda.preco_unitario));
    const vt = round2(vu * qtd);
    return { valor_unitario: vu, valor_total: vt,
      memoria: `Revenda (sinc. ${ctx.precoRevenda.sincronizado_em}): R$ ${vu}/un × ${qtd} = R$ ${vt}` };
  }

  // manual ou método desconhecido
  return null;
}

module.exports = { calcularItem, escolherBobina, round2 };
```

- [ ] **Step 4: Rodar os testes para confirmar que passam**

Run: `npx jest tests/precificacao.test.js --no-coverage`
Expected: PASS — todos os blocos verdes.

- [ ] **Step 5: Commit**

```bash
git add src/modules/precificacao/engine.js tests/precificacao.test.js
git commit -m "feat(ao1): engine de precificacao (fixo/m2/m2_bobina/faixa/revenda) com testes"
```

---

## Task 3: Serviço de precificação (carrega regra + contexto)

**Files:**
- Create: `src/modules/precificacao/service.js`

`precificarItem({ produto, material_id, quantidade, largura_cm, altura_cm })` resolve a regra ativa (prefere regra com o `material_id` do item; senão a regra default `material_id IS NULL`), carrega o contexto conforme o método e chama o engine. Retorna `{ valor_unitario, valor_total, memoria, metodo }` ou `null`.

- [ ] **Step 1: Implementar o service**

Criar `src/modules/precificacao/service.js`:

```javascript
const db = require('../../db');
const engine = require('./engine');

// Resolve a regra ativa do produto: prefere a específica do material, senão a default (material_id IS NULL).
async function regraDoProduto(produto, materialId) {
  const r = await db.query(
    `SELECT * FROM regras_preco
      WHERE ativo = TRUE AND produto = $1
        AND (material_id = $2 OR material_id IS NULL)
      ORDER BY (material_id = $2) DESC
      LIMIT 1`,
    [produto, materialId || null]
  );
  return r.rows[0] || null;
}

async function precificarItem({ produto, material_id, quantidade, largura_cm, altura_cm }) {
  if (!produto) return null;
  const regra = await regraDoProduto(produto, material_id);
  if (!regra || regra.metodo_calculo === 'manual') return null;

  const ctx = {};
  if (regra.metodo_calculo === 'faixa') {
    const f = await db.query(
      'SELECT qtd_min, qtd_max, preco_unitario FROM regras_preco_faixa WHERE regra_id = $1 ORDER BY qtd_min',
      [regra.id]
    );
    ctx.faixas = f.rows;
  }
  if (regra.metodo_calculo === 'm2_bobina') {
    if (!material_id) return null;
    const b = await db.query(
      'SELECT largura_cm FROM material_bobinas WHERE material_id = $1 AND ativo = TRUE',
      [material_id]
    );
    ctx.bobinas = b.rows;
  }
  if (regra.metodo_calculo === 'revenda') {
    const p = await db.query(
      'SELECT preco_unitario, sincronizado_em FROM precos_revenda WHERE produto = $1 ORDER BY sincronizado_em DESC LIMIT 1',
      [produto]
    );
    ctx.precoRevenda = p.rows[0] || null;
  }

  const calc = engine.calcularItem(regra, { quantidade, largura_cm, altura_cm }, ctx);
  if (!calc) return null;
  return { ...calc, metodo: regra.metodo_calculo };
}

// CRUD de regras
async function listarRegras() {
  const r = await db.query(
    `SELECT rp.*, m.nome AS material_nome
       FROM regras_preco rp LEFT JOIN materiais m ON m.id = rp.material_id
      ORDER BY rp.produto, m.nome NULLS FIRST`
  );
  return r.rows;
}
async function criarRegra(d) {
  if (!d.produto || !d.metodo_calculo) return { erro: ['produto e metodo_calculo são obrigatórios'] };
  const r = await db.query(
    `INSERT INTO regras_preco (produto, material_id, metodo_calculo, preco_base, m2_minimo, espaco_corte_cm, ativo)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,TRUE)) RETURNING *`,
    [d.produto, d.material_id || null, d.metodo_calculo, d.preco_base ?? null,
     d.m2_minimo ?? null, d.espaco_corte_cm ?? 0, d.ativo]
  );
  return { item: r.rows[0] };
}
async function atualizarRegra(id, d) {
  const r = await db.query(
    `UPDATE regras_preco SET
       metodo_calculo=COALESCE($1,metodo_calculo), preco_base=$2, m2_minimo=$3,
       espaco_corte_cm=COALESCE($4,espaco_corte_cm), material_id=$5,
       ativo=COALESCE($6,ativo), updated_at=NOW()
     WHERE id=$7 RETURNING *`,
    [d.metodo_calculo ?? null, d.preco_base ?? null, d.m2_minimo ?? null,
     d.espaco_corte_cm ?? null, d.material_id ?? null, d.ativo, id]
  );
  if (!r.rows[0]) return { erro: ['Regra não encontrada'] };
  return { item: r.rows[0] };
}

// Faixas
async function listarFaixas(regraId) {
  const r = await db.query('SELECT * FROM regras_preco_faixa WHERE regra_id=$1 ORDER BY qtd_min', [regraId]);
  return r.rows;
}
async function criarFaixa(regraId, d) {
  if (d.preco_unitario == null) return { erro: ['preco_unitario é obrigatório'] };
  const r = await db.query(
    `INSERT INTO regras_preco_faixa (regra_id, qtd_min, qtd_max, preco_unitario)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [regraId, d.qtd_min ?? 1, d.qtd_max ?? null, d.preco_unitario]
  );
  return { item: r.rows[0] };
}
async function removerFaixa(id) { await db.query('DELETE FROM regras_preco_faixa WHERE id=$1', [id]); return { ok: true }; }

// Bobinas por material
async function listarBobinas(materialId) {
  const r = await db.query('SELECT * FROM material_bobinas WHERE material_id=$1 ORDER BY largura_cm', [materialId]);
  return r.rows;
}
async function criarBobina(materialId, d) {
  if (!(Number(d.largura_cm) > 0)) return { erro: ['largura_cm deve ser > 0'] };
  const r = await db.query(
    `INSERT INTO material_bobinas (material_id, largura_cm, ativo) VALUES ($1,$2,COALESCE($3,TRUE)) RETURNING *`,
    [materialId, d.largura_cm, d.ativo]
  );
  return { item: r.rows[0] };
}
async function removerBobina(id) { await db.query('DELETE FROM material_bobinas WHERE id=$1', [id]); return { ok: true }; }

module.exports = {
  precificarItem, regraDoProduto,
  listarRegras, criarRegra, atualizarRegra,
  listarFaixas, criarFaixa, removerFaixa,
  listarBobinas, criarBobina, removerBobina,
};
```

- [ ] **Step 2: Sanidade — o módulo carrega sem erro de sintaxe**

Run: `node -e "const s=require('./src/modules/precificacao/service'); console.log(Object.keys(s).sort().join(','))"`
Expected: imprime `atualizarRegra,criarBobina,criarFaixa,criarRegra,listarBobinas,listarFaixas,listarRegras,precificarItem,regraDoProduto,removerBobina,removerFaixa` (sem erro de require; o `db` conecta lazy, então só carregar o módulo não abre conexão).

- [ ] **Step 3: Commit**

```bash
git add src/modules/precificacao/service.js
git commit -m "feat(ao1): service de precificacao (resolve regra + contexto + CRUD regras/faixas/bobinas)"
```

---

## Task 4: Router de precificação + registro

**Files:**
- Create: `src/modules/precificacao/router.js`
- Modify: `src/modules/index.js`

- [ ] **Step 1: Implementar o router**

Criar `src/modules/precificacao/router.js` (segue o padrão de `price-table/router.js`):

```javascript
const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();
const adminGestor = requireRole('admin', 'gestor');

// Preview de cálculo (qualquer role autenticada) — não grava nada.
router.post('/preview', async (req, res) => {
  try {
    const { produto, material_id, quantidade, largura_cm, altura_cm } = req.body;
    const r = await service.precificarItem({ produto, material_id, quantidade, largura_cm, altura_cm });
    if (!r) return res.json({ auto: false }); // sem regra/sem cálculo → manual
    res.json({ auto: true, ...r });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// Regras
router.get('/regras', adminGestor, async (req, res) => {
  try { res.json(await service.listarRegras()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
router.post('/regras', adminGestor, async (req, res) => {
  try {
    const r = await service.criarRegra(req.body);
    if (r.erro) return res.status(400).json({ errors: r.erro });
    res.status(201).json(r.item);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
router.put('/regras/:id', adminGestor, async (req, res) => {
  try {
    const r = await service.atualizarRegra(req.params.id, req.body);
    if (r.erro) return res.status(400).json({ errors: r.erro });
    res.json(r.item);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// Faixas
router.get('/regras/:id/faixas', adminGestor, async (req, res) => {
  try { res.json(await service.listarFaixas(req.params.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
router.post('/regras/:id/faixas', adminGestor, async (req, res) => {
  try {
    const r = await service.criarFaixa(req.params.id, req.body);
    if (r.erro) return res.status(400).json({ errors: r.erro });
    res.status(201).json(r.item);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
router.delete('/faixas/:id', adminGestor, async (req, res) => {
  try { res.json(await service.removerFaixa(req.params.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// Bobinas por material
router.get('/materiais/:id/bobinas', adminGestor, async (req, res) => {
  try { res.json(await service.listarBobinas(req.params.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
router.post('/materiais/:id/bobinas', adminGestor, async (req, res) => {
  try {
    const r = await service.criarBobina(req.params.id, req.body);
    if (r.erro) return res.status(400).json({ errors: r.erro });
    res.status(201).json(r.item);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
router.delete('/bobinas/:id', adminGestor, async (req, res) => {
  try { res.json(await service.removerBobina(req.params.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
```

- [ ] **Step 2: Registrar o módulo em `src/modules/index.js`**

Adicionar a linha logo após a de `price-table` (em `src/modules/index.js`, perto da linha 16):

```javascript
router.use('/price-table', requireAuthApi, require('./price-table/router'));
router.use('/precificacao', requireAuthApi, require('./precificacao/router'));
```

- [ ] **Step 3: Sanidade — o app monta as rotas sem erro**

Run: `node -e "const r=require('./src/modules'); console.log('modules router OK:', typeof r)"`
Expected: `modules router OK: function` (carrega o router agregado, que faz require do novo módulo, sem erro).

- [ ] **Step 4: Commit**

```bash
git add src/modules/precificacao/router.js src/modules/index.js
git commit -m "feat(ao1): router /api/v2/precificacao (CRUD regras/faixas/bobinas + preview) + registro"
```

---

## Task 5: Integração — auto-precificação no item do orçamento

**Files:**
- Modify: `src/modules/orcamentos/router.js` (blocos `POST /:id/itens` e `PATCH /:id/itens/:itemId`, ~linhas 383-430)

Regra: se o cliente **não** mandou `valor_unitario`/`valor_total` (ou mandou `recalcular: true`), calcula pela regra e grava com `preco_origem='auto'` + `preco_memoria`. Se mandou valor explícito, respeita e grava `preco_origem='manual'`.

- [ ] **Step 1: Importar o service de precificação no topo do bloco de itens**

Em `src/modules/orcamentos/router.js`, logo abaixo de `const db = require('../../db/index');` (a linha que abre a seção "CRUD de itens", ~linha 381):

```javascript
const precificacao = require('../precificacao/service');
```

- [ ] **Step 2: Auto-precificar no POST de item**

Substituir o corpo do handler `router.post('/:id/itens', ...)` para calcular antes do INSERT e gravar origem/memória:

```javascript
router.post('/:id/itens', requireRole('admin','gestor','atendente'), async (req, res) => {
  try {
    const { produto, tipo_producao, especificacao, quantidade, largura_cm, altura_cm, material_id, tem_arte, recalcular } = req.body;
    let { descricao, valor_unitario, valor_total } = req.body;
    if (produto) descricao = especificacao ? `${produto} — ${especificacao}` : produto;
    if (!descricao || !quantidade) return res.status(400).json({ erro: ['produto/descrição e quantidade são obrigatórios'] });

    // Auto-precificação: só quando não veio valor explícito (ou recalcular=true)
    let preco_origem = 'manual', preco_memoria = null;
    const semValor = (valor_unitario == null && valor_total == null);
    if (semValor || recalcular) {
      const calc = await precificacao.precificarItem({ produto, material_id, quantidade, largura_cm, altura_cm });
      if (calc) {
        valor_unitario = calc.valor_unitario;
        valor_total = calc.valor_total;
        preco_origem = 'auto';
        preco_memoria = calc.memoria;
      }
    }

    const cod = await db.query('SELECT COALESCE(MAX(codigo),0)+1 AS c FROM orcamento_itens WHERE orcamento_id=$1', [req.params.id]);
    const { rows } = await db.query(
      `INSERT INTO orcamento_itens (orcamento_id, codigo, produto, especificacao, descricao, tipo_producao, quantidade, valor_unitario, valor_total, largura_cm, altura_cm, material_id, tem_arte, preco_origem, preco_memoria)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [req.params.id, cod.rows[0].c, produto || null, especificacao || null, descricao, tipo_producao || null,
       quantidade, valor_unitario || 0, valor_total || 0,
       largura_cm || null, altura_cm || null, material_id || null, !!tem_arte, preco_origem, preco_memoria]
    );
    await db.query(`UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`, [req.params.id]);
    await service._rebuildOrderItems(req.params.id);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ erro: [e.message] }); }
});
```

- [ ] **Step 3: Auto-precificar no PATCH de item**

Substituir o corpo do handler `router.patch('/:id/itens/:itemId', ...)` para recalcular quando o valor não veio explícito (ou `recalcular=true`). Quando o usuário manda valor explícito, marca `preco_origem='manual'` e limpa a memória:

```javascript
router.patch('/:id/itens/:itemId', requireRole('admin','gestor','atendente'), async (req, res) => {
  try {
    const { produto, tipo_producao, especificacao, quantidade, largura_cm, altura_cm, material_id, tem_arte, recalcular } = req.body;
    let { descricao, valor_unitario, valor_total } = req.body;
    if (produto !== undefined) descricao = especificacao ? `${produto} — ${especificacao}` : produto;

    let preco_origem = null, preco_memoria = null; // null = COALESCE mantém o atual
    const valorExplicito = (valor_unitario != null || valor_total != null);
    if (valorExplicito) {
      preco_origem = 'manual';
      preco_memoria = null;
    } else if (recalcular) {
      // Carrega o estado atual do item para preencher campos faltantes no cálculo
      const cur = await db.query('SELECT produto, material_id, quantidade, largura_cm, altura_cm FROM orcamento_itens WHERE id=$1 AND orcamento_id=$2', [req.params.itemId, req.params.id]);
      const it = cur.rows[0] || {};
      const calc = await precificacao.precificarItem({
        produto: produto ?? it.produto,
        material_id: material_id ?? it.material_id,
        quantidade: quantidade ?? it.quantidade,
        largura_cm: largura_cm ?? it.largura_cm,
        altura_cm: altura_cm ?? it.altura_cm,
      });
      if (calc) {
        valor_unitario = calc.valor_unitario;
        valor_total = calc.valor_total;
        preco_origem = 'auto';
        preco_memoria = calc.memoria;
      }
    }

    const { rows } = await db.query(
      `UPDATE orcamento_itens SET
         produto=COALESCE($1,produto), especificacao=COALESCE($2,especificacao),
         descricao=COALESCE($3,descricao), tipo_producao=COALESCE($4,tipo_producao),
         quantidade=COALESCE($5,quantidade), valor_unitario=COALESCE($6,valor_unitario), valor_total=COALESCE($7,valor_total),
         largura_cm=COALESCE($8,largura_cm), altura_cm=COALESCE($9,altura_cm), material_id=COALESCE($10,material_id),
         tem_arte=COALESCE($11,tem_arte),
         preco_origem=COALESCE($14,preco_origem),
         preco_memoria=CASE WHEN $14 IS NULL THEN preco_memoria ELSE $15 END
       WHERE id=$12 AND orcamento_id=$13 RETURNING *`,
      [produto ?? null, especificacao ?? null, descricao ?? null, tipo_producao ?? null,
       quantidade ?? null, valor_unitario ?? null, valor_total ?? null,
       largura_cm ?? null, altura_cm ?? null, material_id ?? null,
       (tem_arte === undefined ? null : !!tem_arte),
       req.params.itemId, req.params.id, preco_origem, preco_memoria]
    );
    if (!rows[0]) return res.status(404).json({ erro: ['Item não encontrado'] });
    await db.query(`UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`, [req.params.id]);
    await service._rebuildOrderItems(req.params.id);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ erro: [e.message] }); }
});
```

> Nota: `preco_memoria` usa `$15` apenas dentro do CASE; o parâmetro é sempre passado para manter a numeração consistente, mesmo quando `preco_origem` ($14) é null.

- [ ] **Step 4: Sanidade — o módulo de orçamentos carrega sem erro**

Run: `node -e "require('./src/modules/orcamentos/router'); console.log('orcamentos router OK')"`
Expected: `orcamentos router OK`

- [ ] **Step 5: Commit**

```bash
git add src/modules/orcamentos/router.js
git commit -m "feat(ao1): auto-precificacao no POST/PATCH de item do orcamento (origem auto/manual + memoria)"
```

---

## Task 6: UI — aba Preços (regras + bobinas) + auto-fill no item

**Files:**
- Modify: `public/dashboard.html`

O dashboard usa `api(path, opts)` (cookie-session) e `showModal(titulo, html, largura)` / `closeModal()`. A aba "Preços" já existe no NAV (loader de price-table). Vamos adicionar uma sub-aba de "Regras de preço" e cadastro de bobinas, e plugar o preview no formulário de item do orçamento.

- [ ] **Step 1: Localizar os pontos de ancoragem**

Run: `grep -n "page-precos\|loadPrecos\|PRODUTOS_LKL\|abrirEditarItemOrc\|salvarItemOrc\|function showModal" public/dashboard.html | head -30`
Expected: imprime as linhas do loader de Preços, da lista de produtos do front (`PRODUTOS_LKL`), das funções de item do orçamento (`abrirEditarItemOrc`/`salvarItemOrc`) e de `showModal`. Anote os números de linha para os próximos steps.

- [ ] **Step 2: Adicionar a seção "Regras de preço" na página de Preços**

Dentro do bloco da página de Preços (`#page-precos`), abaixo da tabela de price-table existente, inserir um contêiner e um botão:

```html
<div style="margin-top:24px">
  <div style="display:flex;justify-content:space-between;align-items:center">
    <h3 style="margin:0">Regras de preço (automação do orçamento)</h3>
    <button class="btn" onclick="abrirNovaRegraPreco()">➕ Nova regra</button>
  </div>
  <div id="regras-preco-lista" style="margin-top:12px">Carregando…</div>
</div>
```

- [ ] **Step 3: Funções JS de regras de preço**

Adicionar no `<script>` do dashboard (perto do loader de Preços). `PRODUTOS_LKL` já existe como array de nomes de produto; reusa no select.

```javascript
const METODOS_PRECO = [
  ['manual','Manual (digitar)'], ['fixo','Fixo por unidade'], ['m2','Por m²'],
  ['m2_bobina','Por m² com bobina'], ['faixa','Por faixa de quantidade'], ['revenda','Revenda (sincronizado)'],
];

async function loadRegrasPreco() {
  const host = document.getElementById('regras-preco-lista');
  if (!host) return;
  const regras = await api('/precificacao/regras');
  if (!Array.isArray(regras) || !regras.length) { host.innerHTML = '<p style="color:#888">Nenhuma regra cadastrada — produtos sem regra ficam manuais.</p>'; return; }
  host.innerHTML = '<table class="tbl"><thead><tr><th>Produto</th><th>Material</th><th>Método</th><th>Preço base</th><th>Ações</th></tr></thead><tbody>'
    + regras.map(r => `<tr>
        <td>${r.produto}</td>
        <td>${r.material_nome || '<i>qualquer</i>'}</td>
        <td>${(METODOS_PRECO.find(m=>m[0]===r.metodo_calculo)||[])[1]||r.metodo_calculo}</td>
        <td>${r.preco_base != null ? 'R$ '+Number(r.preco_base).toFixed(2) : '—'}</td>
        <td><button class="btn-sm" onclick="abrirEditarRegraPreco('${r.id}')">editar</button></td>
      </tr>`).join('') + '</tbody></table>';
}

function _formRegraPreco(r) {
  const opts = METODOS_PRECO.map(m => `<option value="${m[0]}" ${r&&r.metodo_calculo===m[0]?'selected':''}>${m[1]}</option>`).join('');
  const prods = (window.PRODUTOS_LKL||[]).map(p => `<option ${r&&r.produto===p?'selected':''}>${p}</option>`).join('');
  return `
    <label>Produto<br><select id="rp-produto">${prods}</select></label><br>
    <label>Método<br><select id="rp-metodo" onchange="_rpToggle()">${opts}</select></label><br>
    <div id="rp-precobase"><label>Preço base (R$/m² ou R$/un)<br><input id="rp-preco" type="number" step="0.0001" value="${r&&r.preco_base!=null?r.preco_base:''}"></label></div>
    <div id="rp-m2min"><label>m² mínimo (opcional)<br><input id="rp-m2min-i" type="number" step="0.0001" value="${r&&r.m2_minimo!=null?r.m2_minimo:''}"></label></div>
    <div id="rp-corte"><label>Folga de corte cm (m² com bobina)<br><input id="rp-corte-i" type="number" step="0.01" value="${r&&r.espaco_corte_cm!=null?r.espaco_corte_cm:0}"></label></div>
    <p style="color:#888;font-size:12px">Faixas e bobinas são cadastradas após salvar a regra.</p>`;
}
function _rpToggle() {
  const m = document.getElementById('rp-metodo').value;
  document.getElementById('rp-precobase').style.display = (m==='fixo'||m==='m2'||m==='m2_bobina') ? '' : 'none';
  document.getElementById('rp-m2min').style.display = (m==='m2'||m==='m2_bobina') ? '' : 'none';
  document.getElementById('rp-corte').style.display = (m==='m2_bobina') ? '' : 'none';
}
function abrirNovaRegraPreco() {
  showModal('Nova regra de preço', _formRegraPreco(null) + `<div style="margin-top:12px"><button class="btn" onclick="salvarRegraPreco()">Salvar</button></div>`, '480px');
  _rpToggle();
}
async function abrirEditarRegraPreco(id) {
  const regras = await api('/precificacao/regras');
  const r = regras.find(x => x.id === id);
  showModal('Editar regra de preço', _formRegraPreco(r) + `<div style="margin-top:12px"><button class="btn" onclick="salvarRegraPreco('${id}')">Salvar</button></div>`, '480px');
  _rpToggle();
}
async function salvarRegraPreco(id) {
  const body = {
    produto: document.getElementById('rp-produto').value,
    metodo_calculo: document.getElementById('rp-metodo').value,
    preco_base: document.getElementById('rp-preco').value || null,
    m2_minimo: document.getElementById('rp-m2min-i').value || null,
    espaco_corte_cm: document.getElementById('rp-corte-i').value || 0,
  };
  if (id) await api('/precificacao/regras/'+id, { method:'PUT', body: JSON.stringify(body) });
  else await api('/precificacao/regras', { method:'POST', body: JSON.stringify(body) });
  closeModal(); loadRegrasPreco();
}
```

- [ ] **Step 4: Chamar `loadRegrasPreco()` ao abrir a página de Preços**

No loader da página de Preços (a função que roda quando `showPage('precos')` é chamada — encontrada no Step 1), adicionar ao final:

```javascript
loadRegrasPreco();
```

- [ ] **Step 5: Auto-fill no formulário de item do orçamento**

No fluxo de adicionar item do orçamento (a função `salvarItemOrc` localizada no Step 1), antes de enviar, **não** force valor: deixe o backend calcular quando o campo de valor estiver vazio. Adicionar um botão "🔄 calcular" ao lado do campo de valor que faz preview e preenche:

```javascript
async function previewPrecoItem() {
  // Lê os campos do form de item (ids reais confirmados no Step 1; abaixo os nomes esperados)
  const produto = document.getElementById('ni-produto')?.value;
  const material_id = document.getElementById('ni-material')?.value || null;
  const quantidade = document.getElementById('ni-qtd')?.value;
  const largura_cm = document.getElementById('ni-larg')?.value || null;
  const altura_cm = document.getElementById('ni-alt')?.value || null;
  const r = await api('/precificacao/preview', { method:'POST',
    body: JSON.stringify({ produto, material_id, quantidade, largura_cm, altura_cm }) });
  const campoVu = document.getElementById('ni-vunit');
  const campoVt = document.getElementById('ni-vtotal');
  const memoria = document.getElementById('ni-memoria');
  if (r && r.auto) {
    if (campoVu) campoVu.value = r.valor_unitario;
    if (campoVt) campoVt.value = r.valor_total;
    if (memoria) memoria.textContent = r.memoria;
  } else {
    if (memoria) memoria.textContent = 'Sem regra automática — preço manual.';
  }
}
```

E no HTML do form de item, ao lado do valor unitário, um botão e um campo de memória:

```html
<button type="button" class="btn-sm" onclick="previewPrecoItem()">🔄 calcular</button>
<small id="ni-memoria" style="display:block;color:#666;margin-top:4px"></small>
```

> Os ids `ni-produto`, `ni-material`, `ni-qtd`, `ni-larg`, `ni-alt`, `ni-vunit`, `ni-vtotal` devem casar com os ids reais do form de item confirmados no Step 1. Se os ids reais forem diferentes (ex.: `ei-*` no Editar Item), replicar a função `previewPrecoItem` com os ids corretos para aquele form.

- [ ] **Step 6: Verificação no preview do navegador (dev server)**

Como `dashboard.html` é servido pelo app, suba o preview e confira que não há erro de JS no console ao abrir a página de Preços. Se o ambiente de preview estiver disponível:
- `preview_start` → abrir o app → navegar para Preços.
- `preview_console_logs` → conferir ausência de `ReferenceError`/`is not defined` das novas funções.

Se não houver preview/login disponível localmente, pular para a validação no VPS (Task 7) — é o padrão do projeto.

- [ ] **Step 7: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(ao1): UI de regras de preco na aba Precos + auto-fill no item do orcamento"
```

---

## Task 7: Deploy no VPS + smoke E2E + memória

**Files:**
- Modify: `~/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md` (registro do AO-1)

- [ ] **Step 1: Aplicar a migration 043 no VPS**

```bash
# Tabelas novas (user padrão do app):
ssh root@2.25.147.243 "psql -U lkl_user -d <DB_NAME> -f /var/www/lkl-chatbot/sql/migrations/043_regras_preco.sql"
# As duas linhas ALTER TABLE orcamento_itens precisam do user postgres:
ssh root@2.25.147.243 "sudo -u postgres psql -d <DB_NAME> -c \"ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS preco_origem VARCHAR(10) DEFAULT 'manual'; ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS preco_memoria TEXT;\""
```
> Primeiro fazer `rsync` do repo (Step 2) para que o arquivo da migration exista no VPS, OU rodar o SQL via stdin. Confirmar `<DB_NAME>` no `.env` do VPS (`DB_NAME`).
Expected: `CREATE TABLE`/`ALTER TABLE` sem erro (ou "already exists" idempotente).

- [ ] **Step 2: Deploy do código**

```bash
rsync -az --exclude node_modules --exclude .git /Users/klebercamara/LKL/ root@2.25.147.243:/var/www/lkl-chatbot/
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
ssh root@2.25.147.243 "pm2 status lkl-chatbot"
```
Expected: processo `online`.

- [ ] **Step 3: Smoke E2E — engine via regra real (no VPS, com .env)**

Rodar no VPS um script que cadastra uma regra `m2`, uma `m2_bobina` com bobina, e confere o cálculo via o service real:

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -e \"
require('dotenv').config();
const db=require('./src/db'); const svc=require('./src/modules/precificacao/service');
(async()=>{
  // material qualquer p/ teste de bobina
  const m=(await db.query(\\\"SELECT id FROM materiais WHERE status='ativo' LIMIT 1\\\")).rows[0];
  const reg=(await db.query(\\\"INSERT INTO regras_preco(produto,metodo_calculo,preco_base,espaco_corte_cm) VALUES('ZZTESTE_BOBINA','m2_bobina',25,0) RETURNING id\\\")).rows[0];
  await db.query('INSERT INTO material_bobinas(material_id,largura_cm) VALUES(\\$1,152)',[m.id]);
  const reg2=(await db.query(\\\"INSERT INTO regras_preco(produto,metodo_calculo,preco_base) VALUES('ZZTESTE_M2','m2',50) RETURNING id\\\")).rows[0];
  const a=await svc.precificarItem({produto:'ZZTESTE_M2',quantidade:2,largura_cm:100,altura_cm:50});
  const b=await svc.precificarItem({produto:'ZZTESTE_BOBINA',material_id:m.id,quantidade:1,largura_cm:50,altura_cm:100});
  console.log('m2:',JSON.stringify(a));
  console.log('m2_bobina:',JSON.stringify(b));
  // limpeza
  await db.query('DELETE FROM regras_preco WHERE id IN(\\$1,\\$2)',[reg.id,reg2.id]);
  await db.query('DELETE FROM material_bobinas WHERE material_id=\\$1 AND largura_cm=152',[m.id]);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
\""
```
Expected: `m2: {"valor_unitario":25,"valor_total":50,...,"metodo":"m2"}` e `m2_bobina: {"valor_unitario":12.67,...,"metodo":"m2_bobina"}`.

- [ ] **Step 4: Smoke — produto sem regra continua manual**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -e \"require('dotenv').config();const svc=require('./src/modules/precificacao/service');svc.precificarItem({produto:'PRODUTO_INEXISTENTE_XYZ',quantidade:3}).then(r=>{console.log('sem regra →',r);process.exit(0)})\""
```
Expected: `sem regra → null`.

- [ ] **Step 5: Atualizar a memória do projeto**

Adicionar ao `project_sprint_status.md` um parágrafo registrando o AO-1 (tabelas 043, módulo precificacao engine/service/router, auto-precificação no item, UI de regras, smoke validado, próximo = AO-2 robô da revenda dependente de prints/URL). Seguir o estilo dos registros existentes (uma linha por entrega com commits).

- [ ] **Step 6: Commit final**

```bash
git add -A
git commit -m "chore(ao1): smoke VPS + registro do AO-1 na memoria do projeto"
```

---

## Self-Review (preenchido pelo autor do plano)

**Cobertura do spec:**
- Tabelas `regras_preco`/`regras_preco_faixa`/`material_bobinas`/`precos_revenda` + colunas no item → Task 1. ✓
- Motor (fixo/m2/m2_bobina/faixa/revenda/manual) + escolha de bobina com folga → Task 2 (testes) + engine. ✓
- Serviço que resolve regra (material específico > default) e carrega contexto → Task 3. ✓
- API CRUD + `/preview` + registro → Task 4. ✓
- Integração POST/PATCH item (auto/manual + memória + recalcular) → Task 5. ✓
- UI de regras + bobinas + auto-fill no item → Task 6. ✓
- Deploy + smoke + memória → Task 7. ✓

**Consistência de tipos/nomes:** `calcularItem(regra, item, ctx)` e `escolherBobina(larguraArte, g, bobinas)` usados igual no engine, nos testes e no service. `precificarItem({produto, material_id, quantidade, largura_cm, altura_cm})` idem no service, router e integração. Colunas `preco_origem`/`preco_memoria` idênticas na migration e nos handlers.

**Notas de execução conhecidas:** sem DB local → só `tests/precificacao.test.js` roda local (deve passar); integração/UI validadas por smoke no VPS (padrão do projeto). Os ids do form de item no dashboard (`ni-*`) devem ser confirmados no Step 1 da Task 6 e ajustados se divergirem.
