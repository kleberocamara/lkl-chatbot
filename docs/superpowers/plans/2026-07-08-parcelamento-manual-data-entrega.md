# Parcelamento Manual (Data de Entrega + Linhas Explícitas) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the auto-calculated (monthly/equal-division) parcelamento with a fully manual, per-parcela model (vencimento + valor + linha digitável cada), add a "Data de Entrega" field that drives `competencia` (DRE), and support converting an existing single conta into a parcelado group.

**Architecture:** Backend: `criarParcelado` stops calculating installments and instead validates+persists an explicit `parcelas` array sent by the frontend; a new `converterEmParcelado` deletes-and-recreates a conta as N parcelas inside a transaction, blocked when paid or in a C6 batch. Frontend: `dashboard.html`'s Contas a Pagar modal gains a "Data de Entrega" date input (→ `competencia`), and the "Parcelar" section switches from a count+date pair to dynamically-generated per-parcela row groups (vencimento/valor/linha digitável), pre-filled by a client-side suggestion algorithm the user can edit before saving.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), Jest, vanilla JS in `public/dashboard.html`.

---

### Task 1: `criar()` — gravar `competencia` quando enviada

**Files:**
- Modify: `src/modules/contas-pagar/service.js:65-82`
- Test: `tests/contas-pagar-service.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/contas-pagar-service.test.js` (new `describe` block at the end of the file):

```js
describe('criar', () => {
  afterEach(() => jest.clearAllMocks());

  test('sem competencia informada → INSERT não inclui a coluna competencia', async () => {
    db.query = jest.fn().mockResolvedValueOnce({ rows: [{ id: 1 }] });

    await service.criar({
      descricao: 'Conta Light', tipo_despesa_id: 3, valor: 200, vencimento: '2026-08-10',
    });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toContain('competencia');
    expect(params).toHaveLength(14);
  });

  test('com competencia informada → INSERT inclui a coluna e o valor', async () => {
    db.query = jest.fn().mockResolvedValueOnce({ rows: [{ id: 2 }] });

    await service.criar({
      descricao: 'Conta Evolution', tipo_despesa_id: 2, valor: 350, vencimento: '2026-06-24',
      competencia: '2026-05-27',
    });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('competencia');
    expect(params).toContain('2026-05-27');
    expect(params).toHaveLength(15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/contas-pagar-service.test.js -t "criar" -v`
Expected: FAIL — `db.query.mock.calls[0]` sql string never contains `competencia`, second test fails because `params` never contains `'2026-05-27'`.

- [ ] **Step 3: Implement**

Replace `criar()` in `src/modules/contas-pagar/service.js:65-82`:

```js
async function criar({ descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo, linha_digitavel, pix_content, tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao, competencia }) {
  if (!descricao || !tipo_despesa_id || !valor || !vencimento) {
    return { erro: ['descricao, tipo_despesa_id, valor e vencimento são obrigatórios'] };
  }
  const colunas = ['descricao','fornecedor','fornecedor_id','tipo_despesa_id','valor','vencimento','tipo',
                    'linha_digitavel','pix_content','tipo_entrada','recorrente','recorrencia_dia',
                    'recorrencia_valor_fixo','observacao'];
  const valores = [descricao, fornecedor || null, fornecedor_id || null, tipo_despesa_id, valor, vencimento,
                    tipo || 'outro', linha_digitavel || null, pix_content || null,
                    tipo_entrada || 'manual', recorrente || false, recorrencia_dia || null,
                    recorrencia_valor_fixo !== false, observacao || null];
  if (competencia) { colunas.push('competencia'); valores.push(competencia); }

  const placeholders = valores.map((_, i) => `$${i + 1}`).join(',');
  const r = await query(
    `INSERT INTO contas_pagar (${colunas.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    valores
  );
  if (fornecedor_id) await gravarMemoriaFornecedor(fornecedor_id, tipo_despesa_id);
  return r.rows[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/contas-pagar-service.test.js -t "criar" -v`
Expected: PASS

- [ ] **Step 5: Run the full contas-pagar-service suite to check no regressions**

Run: `npx jest tests/contas-pagar-service.test.js -v`
Expected: All PASS (the `criarOuReconciliarContaPagar` tests are unaffected — different function).

- [ ] **Step 6: Commit**

```bash
git add src/modules/contas-pagar/service.js tests/contas-pagar-service.test.js
git commit -m "feat(contas-pagar): criar() grava competencia quando informada"
```

---

### Task 2: Reformular `criarParcelado` — array explícito de parcelas

**Files:**
- Modify: `src/modules/contas-pagar/service.js:173-215`
- Test: `tests/contas-pagar-parcelado.test.js` (full rewrite)

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `tests/contas-pagar-parcelado.test.js`:

```js
const db = require('../src/db');
jest.mock('../src/db', () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));

const service = require('../src/modules/contas-pagar/service');

function mockClient(queryImpl) {
  return { query: jest.fn(queryImpl), release: jest.fn() };
}

describe('criarParcelado', () => {
  afterEach(() => jest.clearAllMocks());

  test('campos obrigatórios faltando → erro, sem abrir transação', async () => {
    const r = await service.criarParcelado({ descricao: 'Compra tintas', tipo_despesa_id: 2 });
    expect(r.erro).toEqual(expect.arrayContaining([expect.stringContaining('obrigat')]));
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('menos de 2 parcelas → erro', async () => {
    const r = await service.criarParcelado({
      descricao: 'Compra tintas', tipo_despesa_id: 2,
      parcelas: [{ vencimento: '2026-08-10', valor: 900 }],
    });
    expect(r.erro).toBeDefined();
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('parcela sem vencimento ou valor → erro', async () => {
    const r = await service.criarParcelado({
      descricao: 'Compra tintas', tipo_despesa_id: 2,
      parcelas: [{ vencimento: '2026-08-10', valor: 350 }, { valor: 350 }],
    });
    expect(r.erro).toEqual(expect.arrayContaining([expect.stringContaining('parcela 2')]));
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('2 parcelas com prazos irregulares (nota Evolution: 28 e 35 dias) → grava exatamente como veio', async () => {
    const linhasInseridas = [];
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        linhasInseridas.push(params);
        return Promise.resolve({ rows: [{ id: linhasInseridas.length }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarParcelado({
      descricao: 'Pedido 26/0471/05/1', fornecedor: 'Evolution Engeplotter', fornecedor_id: null,
      tipo_despesa_id: 2, competencia: '2026-05-27', tipo: 'boleto',
      parcelas: [
        { vencimento: '2026-06-24', valor: 350, linha_digitavel: '00190000090123456789012345678901234567890123' },
        { vencimento: '2026-07-01', valor: 350, linha_digitavel: '00190000090123456789012345678901234567890124' },
      ],
    });

    expect(r.criadas).toHaveLength(2);
    expect(linhasInseridas).toHaveLength(2);
    // [4]=valor [5]=vencimento [7]=linha_digitavel [8]=competencia [9]=parcela_grupo_id
    expect(linhasInseridas[0][5]).toBe('2026-06-24');
    expect(linhasInseridas[0][4]).toBe(350);
    expect(linhasInseridas[0][7]).toBe('00190000090123456789012345678901234567890123');
    expect(linhasInseridas[1][5]).toBe('2026-07-01');
    expect(linhasInseridas[1][7]).toBe('00190000090123456789012345678901234567890124');
    const grupoIds = linhasInseridas.map(p => p[9]);
    expect(new Set(grupoIds).size).toBe(1);
    const competencias = linhasInseridas.map(p => p[8]);
    expect(competencias.every(c => c === '2026-05-27')).toBe(true);
  });

  test('linha_digitavel ausente em uma parcela → grava null, não é obrigatória', async () => {
    const linhasInseridas = [];
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        linhasInseridas.push(params);
        return Promise.resolve({ rows: [{ id: linhasInseridas.length }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarParcelado({
      descricao: 'Compra X', tipo_despesa_id: 1,
      parcelas: [{ vencimento: '2026-08-01', valor: 50 }, { vencimento: '2026-09-01', valor: 50 }],
    });

    expect(r.criadas).toHaveLength(2);
    expect(linhasInseridas[0][7]).toBeNull();
  });

  test('sem competencia informada → usa CURRENT_DATE (data de hoje) como fallback', async () => {
    const linhasInseridas = [];
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        linhasInseridas.push(params);
        return Promise.resolve({ rows: [{ id: linhasInseridas.length }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const { format } = require('date-fns');
    const hoje = format(new Date(), 'yyyy-MM-dd');

    await service.criarParcelado({
      descricao: 'Compra X', tipo_despesa_id: 1,
      parcelas: [{ vencimento: '2026-08-01', valor: 50 }, { vencimento: '2026-09-01', valor: 50 }],
    });

    expect(linhasInseridas[0][8]).toBe(hoje);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/contas-pagar-parcelado.test.js -v`
Expected: FAIL — old `criarParcelado` still expects `valor_total`/`parcelas` (count)/`primeiro_vencimento` and computes monthly cadence; all new assertions fail or throw.

- [ ] **Step 3: Implement**

Replace `criarParcelado` in `src/modules/contas-pagar/service.js:173-215`:

```js
async function criarParcelado({ descricao, fornecedor, fornecedor_id, tipo_despesa_id, competencia, tipo, observacao, parcelas }) {
  if (!descricao || !tipo_despesa_id || !Array.isArray(parcelas) || parcelas.length < 2) {
    return { erro: ['descricao, tipo_despesa_id e parcelas (mínimo 2 itens) são obrigatórios'] };
  }
  for (let i = 0; i < parcelas.length; i++) {
    const p = parcelas[i];
    if (!p.vencimento || !p.valor) {
      return { erro: [`parcela ${i + 1}: vencimento e valor são obrigatórios`] };
    }
  }

  const parcelaGrupoId = crypto.randomUUID();
  const competenciaFinal = competencia || format(new Date(), 'yyyy-MM-dd');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const criadas = [];
    for (let i = 0; i < parcelas.length; i++) {
      const p = parcelas[i];
      const r = await client.query(
        `INSERT INTO contas_pagar
           (descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo, linha_digitavel,
            competencia, parcela_grupo_id, parcela_numero, parcela_total, tipo_entrada, status, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual','pendente',$13)
         RETURNING *`,
        [`${descricao} (${i + 1}/${parcelas.length})`, fornecedor || null, fornecedor_id || null, tipo_despesa_id,
         p.valor, p.vencimento, tipo || 'boleto', p.linha_digitavel || null,
         competenciaFinal, parcelaGrupoId, i + 1, parcelas.length, observacao || null]
      );
      criadas.push(r.rows[0]);
    }
    await client.query('COMMIT');
    if (fornecedor_id) await gravarMemoriaFornecedor(fornecedor_id, tipo_despesa_id);
    return { criadas };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/contas-pagar-parcelado.test.js -v`
Expected: PASS (all 6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/modules/contas-pagar/service.js tests/contas-pagar-parcelado.test.js
git commit -m "feat(contas-pagar): criarParcelado aceita array explicito de parcelas (sem calculo automatico)"
```

---

### Task 3: `converterEmParcelado` — converter conta existente em parcelas

**Files:**
- Modify: `src/modules/contas-pagar/service.js` (add function + export)
- Test: `tests/contas-pagar-parcelado.test.js` (append new `describe` block)

- [ ] **Step 1: Write the failing tests**

Append to `tests/contas-pagar-parcelado.test.js`:

```js
describe('converterEmParcelado', () => {
  afterEach(() => jest.clearAllMocks());

  test('conta não encontrada → erro', async () => {
    db.query = jest.fn().mockResolvedValueOnce({ rows: [] });
    const r = await service.converterEmParcelado(999, { parcelas: [{ vencimento: '2026-08-01', valor: 50 }, { vencimento: '2026-09-01', valor: 50 }] });
    expect(r.erro).toEqual(expect.arrayContaining([expect.stringContaining('não encontrada')]));
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('conta já paga → erro, sem apagar nada', async () => {
    db.query = jest.fn().mockResolvedValueOnce({ rows: [{ id: 5, status: 'pago', c6_group_id: null }] });
    const r = await service.converterEmParcelado(5, { parcelas: [{ vencimento: '2026-08-01', valor: 50 }, { vencimento: '2026-09-01', valor: 50 }] });
    expect(r.erro).toEqual(expect.arrayContaining([expect.stringContaining('não é possível parcelar')]));
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('conta em lote C6 (c6_group_id preenchido) → erro, sem apagar nada', async () => {
    db.query = jest.fn().mockResolvedValueOnce({ rows: [{ id: 6, status: 'agendado', c6_group_id: 'grupo-123' }] });
    const r = await service.converterEmParcelado(6, { parcelas: [{ vencimento: '2026-08-01', valor: 50 }, { vencimento: '2026-09-01', valor: 50 }] });
    expect(r.erro).toEqual(expect.arrayContaining([expect.stringContaining('não é possível parcelar')]));
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('menos de 2 parcelas → erro, sem apagar nada', async () => {
    db.query = jest.fn().mockResolvedValueOnce({ rows: [{ id: 7, status: 'pendente', c6_group_id: null }] });
    const r = await service.converterEmParcelado(7, { parcelas: [{ vencimento: '2026-08-01', valor: 50 }] });
    expect(r.erro).toBeDefined();
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('conta elegível → apaga a original e cria N novas na mesma transação', async () => {
    db.query = jest.fn().mockResolvedValueOnce({
      rows: [{
        id: 8, status: 'pendente', c6_group_id: null, descricao: 'Nota Evolution',
        fornecedor: 'Evolution', fornecedor_id: null, tipo_despesa_id: 2, tipo: 'boleto',
        competencia: '2026-05-27', observacao: null,
      }],
    });
    const queries = [];
    const client = mockClient((sql, params) => {
      queries.push(sql.split('\n')[0].trim());
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('DELETE FROM contas_pagar')) return Promise.resolve({ rowCount: 1 });
      if (sql.startsWith('INSERT INTO contas_pagar')) return Promise.resolve({ rows: [{ id: queries.length }] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.converterEmParcelado(8, {
      parcelas: [
        { vencimento: '2026-06-24', valor: 350 },
        { vencimento: '2026-07-01', valor: 350 },
      ],
    });

    expect(r.criadas).toHaveLength(2);
    const deleteIndex = queries.findIndex(q => q.startsWith('DELETE'));
    const insertIndexes = queries.map((q, i) => q.startsWith('INSERT') ? i : -1).filter(i => i !== -1);
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndexes.every(i => i > deleteIndex)).toBe(true);
  });

  test('falha na criação das novas parcelas → rollback (DELETE não é commitado)', async () => {
    db.query = jest.fn().mockResolvedValueOnce({
      rows: [{
        id: 9, status: 'pendente', c6_group_id: null, descricao: 'Nota X',
        fornecedor: null, fornecedor_id: null, tipo_despesa_id: 2, tipo: 'boleto',
        competencia: '2026-05-27', observacao: null,
      }],
    });
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('DELETE FROM contas_pagar')) return Promise.resolve({ rowCount: 1 });
      if (sql.startsWith('INSERT INTO contas_pagar')) return Promise.reject(new Error('falha simulada de insercao'));
      if (sql.startsWith('ROLLBACK')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await expect(service.converterEmParcelado(9, {
      parcelas: [{ vencimento: '2026-06-24', valor: 175 }, { vencimento: '2026-07-01', valor: 175 }],
    })).rejects.toThrow('falha simulada de insercao');

    expect(client.query.mock.calls.some(c => c[0].startsWith('ROLLBACK'))).toBe(true);
    expect(client.query.mock.calls.some(c => c[0].startsWith('COMMIT'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/contas-pagar-parcelado.test.js -t "converterEmParcelado" -v`
Expected: FAIL — `service.converterEmParcelado` is not a function.

- [ ] **Step 3: Implement**

Add to `src/modules/contas-pagar/service.js`, right after `criarParcelado` (before the `// ─── DDA ───` section):

```js
async function converterEmParcelado(id, { descricao, fornecedor, fornecedor_id, tipo_despesa_id, competencia, tipo, observacao, parcelas }) {
  const conta = await buscarPorId(id);
  if (!conta) return { erro: ['Conta não encontrada'] };
  if (conta.status === 'pago' || conta.c6_group_id) {
    return { erro: ['Conta já paga ou processada em lote C6 — não é possível parcelar'] };
  }
  if (!Array.isArray(parcelas) || parcelas.length < 2) {
    return { erro: ['parcelas (mínimo 2 itens) são obrigatórias'] };
  }
  for (let i = 0; i < parcelas.length; i++) {
    const p = parcelas[i];
    if (!p.vencimento || !p.valor) {
      return { erro: [`parcela ${i + 1}: vencimento e valor são obrigatórios`] };
    }
  }

  const descricaoFinal = descricao || conta.descricao;
  const fornecedorFinal = fornecedor !== undefined ? fornecedor : conta.fornecedor;
  const fornecedorIdFinal = fornecedor_id !== undefined ? fornecedor_id : conta.fornecedor_id;
  const tipoDespesaIdFinal = tipo_despesa_id || conta.tipo_despesa_id;
  const tipoFinal = tipo || conta.tipo;
  const competenciaFinal = competencia || format(new Date(conta.competencia), 'yyyy-MM-dd');
  const observacaoFinal = observacao !== undefined ? observacao : conta.observacao;
  const parcelaGrupoId = crypto.randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM contas_pagar WHERE id = $1', [id]);
    const criadas = [];
    for (let i = 0; i < parcelas.length; i++) {
      const p = parcelas[i];
      const r = await client.query(
        `INSERT INTO contas_pagar
           (descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo, linha_digitavel,
            competencia, parcela_grupo_id, parcela_numero, parcela_total, tipo_entrada, status, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual','pendente',$13)
         RETURNING *`,
        [`${descricaoFinal} (${i + 1}/${parcelas.length})`, fornecedorFinal || null, fornecedorIdFinal || null,
         tipoDespesaIdFinal, p.valor, p.vencimento, tipoFinal || 'boleto', p.linha_digitavel || null,
         competenciaFinal, parcelaGrupoId, i + 1, parcelas.length, observacaoFinal || null]
      );
      criadas.push(r.rows[0]);
    }
    await client.query('COMMIT');
    if (fornecedorIdFinal) await gravarMemoriaFornecedor(fornecedorIdFinal, tipoDespesaIdFinal);
    return { criadas };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

Update `module.exports` at the bottom of the file to include it:

```js
module.exports = {
  listar, buscarPorId, kpis,
  criar, editar, cancelar, pagarManual,
  criarRecorrente, criarParcelado, converterEmParcelado,
  sincronizarDDA,
  listarLotes, criarLoteC6, consultarLoteC6, removerItemLoteC6, submeterLoteC6,
  reconciliar,
  marcarVencidas, contasVencendoEm, atualizarStatusLotesSubmetidos, gerarRecorrentesProximoMes,
  listarTiposDespesa, sugerirTipoDespesa, gravarMemoriaFornecedor, criarOuReconciliarContaPagar,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/contas-pagar-parcelado.test.js -v`
Expected: PASS (all tests in the file, both `criarParcelado` and `converterEmParcelado` blocks)

- [ ] **Step 5: Commit**

```bash
git add src/modules/contas-pagar/service.js tests/contas-pagar-parcelado.test.js
git commit -m "feat(contas-pagar): converterEmParcelado — transforma conta existente em N parcelas"
```

---

### Task 4: Router — `POST /:id/parcelar`

**Files:**
- Modify: `src/modules/contas-pagar/router.js`

- [ ] **Step 1: Implement**

Add to `src/modules/contas-pagar/router.js`, right after the `router.post('/parcelado', ...)` block (after line 64, before the `// Sincronizar DDA` comment):

```js
// Converter conta existente em parcelado
router.post('/:id/parcelar', admin, async (req, res) => {
  try {
    const result = await service.converterEmParcelado(req.params.id, req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.status(201).json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});
```

No test file exists for `router.js` in this module (routes are thin pass-throughs to `service.js`, already covered by the service tests) — matches the existing pattern for `POST /parcelado`, `POST /recorrente`, etc.

- [ ] **Step 2: Sanity-check the route doesn't collide with existing routes**

Run: `grep -n "router\.\(get\|post\|patch\|delete\)" src/modules/contas-pagar/router.js`
Expected: `router.post('/:id/parcelar', ...)` appears once, ordered after `/parcelado` and before `/dda/sync` — no route conflicts with `/:id` (PATCH) or `/:id/pagar` (PATCH) since those are different HTTP methods/paths.

- [ ] **Step 3: Commit**

```bash
git add src/modules/contas-pagar/router.js
git commit -m "feat(contas-pagar): endpoint POST /:id/parcelar"
```

---

### Task 5: Dashboard — campo "Data de Entrega" no modal

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Add the field to the modal HTML**

In `public/dashboard.html`, find this block (around line 663-673):

```html
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Descrição *</label>
          <input type="text" id="cp-f-descricao" placeholder="Ex: Conta Light Janeiro" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
        </div>
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Fornecedor/Credor</label>
          <input type="text" id="cp-f-fornecedor" placeholder="Ex: Light S.A." onblur="cpOnFornecedorBlur()" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
          <input type="hidden" id="cp-f-fornecedor-id">
        </div>
      </div>
```

Replace with (adds a "Data de Entrega" row right after it):

```html
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Descrição *</label>
          <input type="text" id="cp-f-descricao" placeholder="Ex: Conta Light Janeiro" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
        </div>
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Fornecedor/Credor</label>
          <input type="text" id="cp-f-fornecedor" placeholder="Ex: Light S.A." onblur="cpOnFornecedorBlur()" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
          <input type="hidden" id="cp-f-fornecedor-id">
        </div>
      </div>
      <div style="margin-bottom:16px">
        <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Data de Entrega</label>
        <input type="date" id="cp-f-data-entrega" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
        <div style="font-size:12px;color:#888;margin-top:4px">Data em que a mercadoria/serviço foi entregue — define o mês da despesa no DRE. Se vazio, usa a data de hoje.</div>
      </div>
```

- [ ] **Step 2: Map the field in `cpSalvarConta()`**

In `public/dashboard.html`, find `cpSalvarConta()` (around line 2585-2599) and add `competencia` to `body`:

```js
async function cpSalvarConta() {
  const recorrente = document.getElementById('cp-f-recorrente').checked;
  const parcelado = document.getElementById('cp-f-parcelado').checked;
  const competencia = document.getElementById('cp-f-data-entrega').value || null;
  const body = {
    descricao: document.getElementById('cp-f-descricao').value.trim(),
    fornecedor: document.getElementById('cp-f-fornecedor').value.trim() || null,
    fornecedor_id: document.getElementById('cp-f-fornecedor-id').value || null,
    tipo_despesa_id: parseInt(document.getElementById('cp-f-tipo-despesa').value) || null,
    valor: parseFloat(document.getElementById('cp-f-valor').value),
    vencimento: document.getElementById('cp-f-vencimento').value,
    tipo: document.getElementById('cp-f-tipo').value,
    linha_digitavel: document.getElementById('cp-f-linha-digitavel').value.replace(/\D/g,'') || null,
    pix_content: document.getElementById('cp-f-pix-content').value.trim() || null,
    observacao: document.getElementById('cp-f-observacao').value.trim() || null,
    competencia,
  };
```

(The rest of the function body — `if (cpEditandoId) {...}` etc. — stays as-is for this task; it will be rewritten in Task 6.)

- [ ] **Step 3: Reset/populate the field in `cpAbrirModalNova()` and `cpAbrirModalEditar()`**

In `cpAbrirModalNova()` (around line 2524), add `'cp-f-data-entrega'` to the clear list:

```js
  ['cp-f-descricao','cp-f-fornecedor','cp-f-fornecedor-id','cp-f-linha-digitavel','cp-f-pix-content','cp-f-observacao','cp-f-parcelas','cp-f-data-entrega'].forEach(id => document.getElementById(id).value = '');
```

(Note: `'cp-f-primeiro-vencimento'` is dropped from this list here — that field is removed entirely in Task 6.)

In `cpAbrirModalEditar()` (around line 2546-2555), add after the `cp-f-vencimento` line:

```js
  document.getElementById('cp-f-vencimento').value = String(conta.vencimento).substring(0, 10);
  document.getElementById('cp-f-data-entrega').value = conta.competencia ? String(conta.competencia).substring(0, 10) : '';
```

- [ ] **Step 4: Verify no syntax errors**

Run: `node -e "new Function(require('fs').readFileSync('public/dashboard.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"`
Expected: No output (script parses without throwing). If the file has multiple `<script>` tags, adjust the regex to target the main one containing `cpSalvarConta` — check with `grep -n '<script' public/dashboard.html` first.

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(dashboard): campo Data de Entrega no modal de Contas a Pagar"
```

---

### Task 6: Dashboard — linhas dinâmicas de parcela (vencimento/valor/linha digitável)

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Replace the `cp-grupo-parcelado` HTML block**

Find this block (around line 719-732):

```html
      <div style="margin-bottom:16px">
        <label style="font-size:13px;font-weight:600;color:#555"><input type="checkbox" id="cp-f-parcelado" onchange="cpToggleParcelado()"> Parcelar (compra em N vezes)</label>
      </div>
      <div id="cp-grupo-parcelado" style="display:none;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Número de parcelas</label>
          <input type="number" id="cp-f-parcelas" min="2" max="48" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
        </div>
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">1ª parcela vence em</label>
          <input type="date" id="cp-f-primeiro-vencimento" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
        </div>
        <div style="grid-column:1/-1;font-size:12px;color:#888">O campo "Valor (R$)" acima é o valor TOTAL da compra — as parcelas são calculadas automaticamente.</div>
      </div>
```

Replace with:

```html
      <div style="margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <label style="font-size:13px;font-weight:600;color:#555"><input type="checkbox" id="cp-f-parcelado" onchange="cpToggleParcelado()"> Parcelar (compra em N vezes)</label>
        <button type="button" id="cp-btn-parcelar-existente" style="display:none" class="btn btn-outline" onclick="cpIniciarConversaoParcelado()">Parcelar esta conta</button>
      </div>
      <div id="cp-grupo-parcelado" style="display:none;margin-bottom:16px">
        <div style="max-width:200px">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Número de parcelas</label>
          <input type="number" id="cp-f-parcelas" min="2" max="48" oninput="cpGerarLinhasParcelas()" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
        </div>
        <div style="font-size:12px;color:#888;margin-top:6px">O campo "Valor (R$)" acima é usado como sugestão de valor total (dividido igualmente) — cada parcela abaixo é totalmente editável.</div>
        <div id="cp-parcelas-linhas" style="margin-top:12px;display:flex;flex-direction:column;gap:10px"></div>
      </div>
```

- [ ] **Step 2: Add `cpGerarLinhasParcelas()` and update `cpToggleParcelado()`**

Find `cpToggleParcelado()` (around line 2572-2579):

```js
function cpToggleParcelado() {
  const on = document.getElementById('cp-f-parcelado').checked;
  document.getElementById('cp-grupo-parcelado').style.display = on ? 'grid' : 'none';
  if (on) {
    document.getElementById('cp-f-recorrente').checked = false;
    document.getElementById('cp-grupo-recorrente').style.display = 'none';
  }
}
```

Replace with:

```js
function cpToggleParcelado() {
  const on = document.getElementById('cp-f-parcelado').checked;
  document.getElementById('cp-grupo-parcelado').style.display = on ? 'block' : 'none';
  if (on) {
    document.getElementById('cp-f-recorrente').checked = false;
    document.getElementById('cp-grupo-recorrente').style.display = 'none';
    document.getElementById('cp-grupo-linha-digitavel').style.display = 'none';
    cpGerarLinhasParcelas();
  } else {
    document.getElementById('cp-parcelas-linhas').innerHTML = '';
    document.getElementById('cp-f-parcelas').value = '';
    if (document.getElementById('cp-f-tipo').value === 'boleto') {
      document.getElementById('cp-grupo-linha-digitavel').style.display = 'block';
    }
  }
}

function cpGerarLinhasParcelas() {
  const n = parseInt(document.getElementById('cp-f-parcelas').value) || 0;
  const container = document.getElementById('cp-parcelas-linhas');
  if (n < 2) { container.innerHTML = ''; return; }
  const valorTotal = parseFloat(document.getElementById('cp-f-valor').value) || 0;
  const dataBase = document.getElementById('cp-f-data-entrega').value
    || document.getElementById('cp-f-vencimento').value
    || new Date().toISOString().substring(0, 10);
  const valorBase = Math.floor((valorTotal / n) * 100) / 100;
  const ajusteUltima = Math.round((valorTotal - valorBase * (n - 1)) * 100) / 100;

  let html = '';
  for (let i = 0; i < n; i++) {
    const data = new Date(`${dataBase}T00:00:00`);
    data.setMonth(data.getMonth() + i);
    const venc = data.toISOString().substring(0, 10);
    const valor = (i === n - 1 ? ajusteUltima : valorBase).toFixed(2);
    html += `
      <div class="cp-parcela-row" style="border:1px solid var(--border);border-radius:8px;padding:10px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#555">${i + 1}ª parcela — Vencimento</label>
          <input type="date" id="cp-parcela-${i}-vencimento" value="${venc}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#555">Valor (R$)</label>
          <input type="number" step="0.01" id="cp-parcela-${i}-valor" value="${valor}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#555">Linha Digitável</label>
          <input type="text" id="cp-parcela-${i}-linha-digitavel" placeholder="44 dígitos do boleto" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        </div>
      </div>`;
  }
  container.innerHTML = html;
}
```

- [ ] **Step 3: Rewrite `cpSalvarConta()` to assemble the `parcelas` array**

Find the full `cpSalvarConta()` function (after Task 5's edit, roughly line 2585-2630):

```js
async function cpSalvarConta() {
  const recorrente = document.getElementById('cp-f-recorrente').checked;
  const parcelado = document.getElementById('cp-f-parcelado').checked;
  const competencia = document.getElementById('cp-f-data-entrega').value || null;
  const body = {
    descricao: document.getElementById('cp-f-descricao').value.trim(),
    fornecedor: document.getElementById('cp-f-fornecedor').value.trim() || null,
    fornecedor_id: document.getElementById('cp-f-fornecedor-id').value || null,
    tipo_despesa_id: parseInt(document.getElementById('cp-f-tipo-despesa').value) || null,
    valor: parseFloat(document.getElementById('cp-f-valor').value),
    vencimento: document.getElementById('cp-f-vencimento').value,
    tipo: document.getElementById('cp-f-tipo').value,
    linha_digitavel: document.getElementById('cp-f-linha-digitavel').value.replace(/\D/g,'') || null,
    pix_content: document.getElementById('cp-f-pix-content').value.trim() || null,
    observacao: document.getElementById('cp-f-observacao').value.trim() || null,
    competencia,
  };
  if (cpEditandoId) {
    const r = await api(`/api/v2/contas-pagar/${cpEditandoId}`, { method: 'PATCH', body: JSON.stringify(body) });
    if (r && !r.error && !r.erro) { showToast('✅ Conta atualizada'); cpFecharModal(); loadContasPagar(); }
    return;
  }
  if (parcelado) {
    const bodyParcelado = {
      descricao: body.descricao, fornecedor: body.fornecedor, fornecedor_id: body.fornecedor_id,
      tipo_despesa_id: body.tipo_despesa_id, valor_total: body.valor,
      parcelas: parseInt(document.getElementById('cp-f-parcelas').value),
      primeiro_vencimento: document.getElementById('cp-f-primeiro-vencimento').value,
      tipo: body.tipo, observacao: body.observacao,
    };
    const r = await api('/api/v2/contas-pagar/parcelado', { method: 'POST', body: JSON.stringify(bodyParcelado) });
    if (r && !r.error && !r.erro) {
      showToast(`✅ ${r.criadas?.length || 0} parcelas criadas`); cpFecharModal(); loadContasPagar();
    }
    return;
  }
  Object.assign(body, {
    recorrente,
    recorrencia_dia: recorrente ? parseInt(document.getElementById('cp-f-recorrencia-dia').value) : null,
    recorrencia_valor_fixo: recorrente ? document.getElementById('cp-f-recorrencia-valor-fixo').value !== 'false' : true,
  });
  const endpoint = recorrente ? '/api/v2/contas-pagar/recorrente' : '/api/v2/contas-pagar';
  const r = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
  if (r && !r.error && !r.erro) {
    const msg = recorrente ? `✅ ${r.criadas?.length || 0} contas recorrentes criadas` : '✅ Conta criada';
    showToast(msg); cpFecharModal(); loadContasPagar();
  }
}
```

Replace with:

```js
function cpLerLinhasParcelas() {
  const n = parseInt(document.getElementById('cp-f-parcelas').value) || 0;
  const parcelas = [];
  for (let i = 0; i < n; i++) {
    parcelas.push({
      vencimento: document.getElementById(`cp-parcela-${i}-vencimento`).value,
      valor: parseFloat(document.getElementById(`cp-parcela-${i}-valor`).value),
      linha_digitavel: document.getElementById(`cp-parcela-${i}-linha-digitavel`).value.replace(/\D/g,'') || null,
    });
  }
  return parcelas;
}

let cpConvertendoParcelado = false;

async function cpSalvarConta() {
  const recorrente = document.getElementById('cp-f-recorrente').checked;
  const parcelado = document.getElementById('cp-f-parcelado').checked;
  const competencia = document.getElementById('cp-f-data-entrega').value || null;
  const body = {
    descricao: document.getElementById('cp-f-descricao').value.trim(),
    fornecedor: document.getElementById('cp-f-fornecedor').value.trim() || null,
    fornecedor_id: document.getElementById('cp-f-fornecedor-id').value || null,
    tipo_despesa_id: parseInt(document.getElementById('cp-f-tipo-despesa').value) || null,
    valor: parseFloat(document.getElementById('cp-f-valor').value),
    vencimento: document.getElementById('cp-f-vencimento').value,
    tipo: document.getElementById('cp-f-tipo').value,
    linha_digitavel: document.getElementById('cp-f-linha-digitavel').value.replace(/\D/g,'') || null,
    pix_content: document.getElementById('cp-f-pix-content').value.trim() || null,
    observacao: document.getElementById('cp-f-observacao').value.trim() || null,
    competencia,
  };
  if (cpEditandoId) {
    if (cpConvertendoParcelado) {
      const bodyParcelar = {
        descricao: body.descricao, fornecedor: body.fornecedor, fornecedor_id: body.fornecedor_id,
        tipo_despesa_id: body.tipo_despesa_id, competencia,
        tipo: body.tipo, observacao: body.observacao, parcelas: cpLerLinhasParcelas(),
      };
      const r = await api(`/api/v2/contas-pagar/${cpEditandoId}/parcelar`, { method: 'POST', body: JSON.stringify(bodyParcelar) });
      if (r && !r.error && !r.erro) {
        showToast(`✅ Conta convertida em ${r.criadas?.length || 0} parcelas`); cpFecharModal(); loadContasPagar();
      } else if (r?.erro) {
        showToast(`❌ ${r.erro[0]}`);
      }
      return;
    }
    const r = await api(`/api/v2/contas-pagar/${cpEditandoId}`, { method: 'PATCH', body: JSON.stringify(body) });
    if (r && !r.error && !r.erro) { showToast('✅ Conta atualizada'); cpFecharModal(); loadContasPagar(); }
    return;
  }
  if (parcelado) {
    const bodyParcelado = {
      descricao: body.descricao, fornecedor: body.fornecedor, fornecedor_id: body.fornecedor_id,
      tipo_despesa_id: body.tipo_despesa_id, competencia,
      tipo: body.tipo, observacao: body.observacao, parcelas: cpLerLinhasParcelas(),
    };
    const r = await api('/api/v2/contas-pagar/parcelado', { method: 'POST', body: JSON.stringify(bodyParcelado) });
    if (r && !r.error && !r.erro) {
      showToast(`✅ ${r.criadas?.length || 0} parcelas criadas`); cpFecharModal(); loadContasPagar();
    } else if (r?.erro) {
      showToast(`❌ ${r.erro[0]}`);
    }
    return;
  }
  Object.assign(body, {
    recorrente,
    recorrencia_dia: recorrente ? parseInt(document.getElementById('cp-f-recorrencia-dia').value) : null,
    recorrencia_valor_fixo: recorrente ? document.getElementById('cp-f-recorrencia-valor-fixo').value !== 'false' : true,
  });
  const endpoint = recorrente ? '/api/v2/contas-pagar/recorrente' : '/api/v2/contas-pagar';
  const r = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
  if (r && !r.error && !r.erro) {
    const msg = recorrente ? `✅ ${r.criadas?.length || 0} contas recorrentes criadas` : '✅ Conta criada';
    showToast(msg); cpFecharModal(); loadContasPagar();
  }
}
```

- [ ] **Step 4: Update `cpAbrirModalNova()` to reset the new state**

Find `cpAbrirModalNova()` (after Task 5's edit) and update it to also reset the parcelas container and the conversion flag/button:

```js
function cpAbrirModalNova() {
  cpEditandoId = null;
  cpConvertendoParcelado = false;
  document.getElementById('cp-modal-titulo').textContent = 'Nova Conta a Pagar';
  ['cp-f-descricao','cp-f-fornecedor','cp-f-fornecedor-id','cp-f-linha-digitavel','cp-f-pix-content','cp-f-observacao','cp-f-parcelas','cp-f-data-entrega'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('cp-f-tipo-despesa').value = '';
  document.getElementById('cp-f-valor').value = '';
  document.getElementById('cp-f-vencimento').value = '';
  document.getElementById('cp-f-tipo').value = 'boleto';
  document.getElementById('cp-f-recorrente').checked = false;
  document.getElementById('cp-grupo-recorrente').style.display = 'none';
  document.getElementById('cp-f-parcelado').checked = false;
  document.getElementById('cp-grupo-parcelado').style.display = 'none';
  document.getElementById('cp-parcelas-linhas').innerHTML = '';
  document.getElementById('cp-btn-parcelar-existente').style.display = 'none';
  document.getElementById('cp-grupo-linha-digitavel').style.display = 'block';
  document.getElementById('cp-grupo-pix').style.display = 'none';
  document.getElementById('cp-modal').style.display = 'flex';
}
```

- [ ] **Step 5: Update `cpAbrirModalEditar()` and `cpFecharModal()`**

`cpAbrirModalEditar()` — reset the parcelamento-conversion state and hide the parcelas group (editing a single conta shows the normal single-conta fields, not the parcela rows, unless the user clicks "Parcelar esta conta" — wired in Task 7):

```js
async function cpAbrirModalEditar(id) {
  const pendentes = await api('/api/v2/contas-pagar?status=pendente');
  const pendentesClassificar = await api('/api/v2/contas-pagar?status=pendente_classificacao');
  const c = [...(Array.isArray(pendentes) ? pendentes : []), ...(Array.isArray(pendentesClassificar) ? pendentesClassificar : [])];
  const conta = c.find(x => x.id === id);
  if (!conta) { showToast('❌ Conta não encontrada'); return; }
  cpEditandoId = id;
  cpConvertendoParcelado = false;
  document.getElementById('cp-modal-titulo').textContent = 'Editar Conta';
  document.getElementById('cp-f-descricao').value = conta.descricao || '';
  document.getElementById('cp-f-fornecedor').value = conta.fornecedor || '';
  document.getElementById('cp-f-fornecedor-id').value = conta.fornecedor_id || '';
  document.getElementById('cp-f-tipo-despesa').value = conta.tipo_despesa_id || '';
  document.getElementById('cp-f-valor').value = conta.valor || '';
  document.getElementById('cp-f-vencimento').value = String(conta.vencimento).substring(0, 10);
  document.getElementById('cp-f-data-entrega').value = conta.competencia ? String(conta.competencia).substring(0, 10) : '';
  document.getElementById('cp-f-tipo').value = conta.tipo || 'boleto';
  document.getElementById('cp-f-linha-digitavel').value = conta.linha_digitavel || '';
  document.getElementById('cp-f-pix-content').value = conta.pix_content || '';
  document.getElementById('cp-f-observacao').value = conta.observacao || '';
  document.getElementById('cp-f-recorrente').checked = false;
  document.getElementById('cp-grupo-recorrente').style.display = 'none';
  document.getElementById('cp-f-parcelado').checked = false;
  document.getElementById('cp-grupo-parcelado').style.display = 'none';
  document.getElementById('cp-parcelas-linhas').innerHTML = '';
  document.getElementById('cp-grupo-linha-digitavel').style.display = conta.tipo === 'boleto' ? 'block' : 'none';
  document.getElementById('cp-grupo-pix').style.display = conta.tipo === 'pix' ? 'block' : 'none';
  document.getElementById('cp-btn-parcelar-existente').style.display =
    (!conta.parcela_grupo_id && conta.status !== 'pago' && !conta.c6_group_id) ? 'inline-block' : 'none';
  document.getElementById('cp-modal').style.display = 'flex';
}
```

`cpFecharModal()` — reset the conversion flag:

```js
function cpFecharModal() { document.getElementById('cp-modal').style.display = 'none'; cpEditandoId = null; cpConvertendoParcelado = false; }
```

- [ ] **Step 6: Verify no syntax errors**

Run: `node -e "new Function(require('fs').readFileSync('public/dashboard.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"`
Expected: No output.

- [ ] **Step 7: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(dashboard): parcelamento manual — N linhas com vencimento/valor/linha digitavel por parcela"
```

---

### Task 7: Dashboard — botão "Parcelar esta conta" (conversão)

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Implement `cpIniciarConversaoParcelado()`**

Add this function in `public/dashboard.html`, right after `cpGerarLinhasParcelas()` (added in Task 6):

```js
function cpIniciarConversaoParcelado() {
  cpConvertendoParcelado = true;
  document.getElementById('cp-f-parcelado').checked = true;
  document.getElementById('cp-grupo-parcelado').style.display = 'block';
  document.getElementById('cp-grupo-linha-digitavel').style.display = 'none';
  document.getElementById('cp-grupo-pix').style.display = 'none';
  document.getElementById('cp-f-recorrente').checked = false;
  document.getElementById('cp-grupo-recorrente').style.display = 'none';
  document.getElementById('cp-f-parcelas').value = 2;
  cpGerarLinhasParcelas();
  document.getElementById('cp-btn-parcelar-existente').style.display = 'none';
}
```

(The button itself, `#cp-btn-parcelar-existente`, was already added to the modal HTML in Task 6 Step 1, with `onclick="cpIniciarConversaoParcelado()"` wired there. Its visibility is toggled in `cpAbrirModalEditar()`, also from Task 6.)

- [ ] **Step 2: Verify no syntax errors**

Run: `node -e "new Function(require('fs').readFileSync('public/dashboard.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"`
Expected: No output.

- [ ] **Step 3: Manual smoke-test checklist (record results in the commit message body if any step fails and gets fixed)**

Since there's no automated UI test suite (matches existing project pattern), verify manually against a running dev server or the deployed environment after Task 8:
1. Nova Conta → check "Parcelar" → type "2" in Número de parcelas → 2 row-groups appear, pre-filled with today+1month dates and half the value each.
2. Edit the vencimento/valor/linha digitável of row 2 → save → confirm 2 `contas_pagar` rows created with the edited values, same `parcela_grupo_id`.
3. Edit an existing (non-parcelado, pendente) conta → "Parcelar esta conta" button visible → click it → 2 pre-filled rows appear seeded from the conta's current valor/vencimento → save → confirm original conta deleted, 2 new parcela rows created.
4. Edit a conta with `status='pago'` (if any exist) → confirm the "Parcelar esta conta" button does NOT appear (list only fetches pendente/pendente_classificacao, so this may need a direct API check instead — `POST /api/v2/contas-pagar/:id/parcelar` on a paid conta ID returns 400 with the expected error message).
5. "Data de Entrega" field: create a conta with Data de Entrega different from Vencimento → confirm `competencia` in the DB matches Data de Entrega, not Vencimento.

- [ ] **Step 4: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(dashboard): botao Parcelar esta conta — converte conta existente em parcelas"
```

---

### Task 8: Deploy no VPS

**Files:** none (deploy only)

- [ ] **Step 1: Run the full test suite locally**

Run: `npx jest tests/contas-pagar-service.test.js tests/contas-pagar-parcelado.test.js -v`
Expected: All PASS.

Run the broader suite to confirm no unrelated regressions (pre-existing DB-less failures are expected and unrelated — see project history):
Run: `npx jest 2>&1 | tail -30`
Expected: Same baseline failure count as before this change (no new failures introduced by these files).

- [ ] **Step 2: Ask user for deploy confirmation**

This step touches production — confirm with the user (AskUserQuestion) before proceeding, per this project's established practice. No new SQL migration is needed (columns `competencia`/`parcela_grupo_id`/`parcela_numero`/`parcela_total` already exist from migration 053 in the prior session).

- [ ] **Step 3: Deploy**

```bash
rsync -R -av src/modules/contas-pagar/service.js src/modules/contas-pagar/router.js public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```

- [ ] **Step 4: Smoke test in production**

```bash
ssh root@2.25.147.243 "pm2 logs lkl-chatbot --lines 30 --nostream"
```
Expected: No startup errors, process online.

Then manually run through the Step 3 checklist from Task 7 against `https://app.graficalkl.com.br/dashboard`.

- [ ] **Step 5: Commit deploy confirmation (if any hotfix was needed during smoke test)**

Only if changes were required during smoke testing — otherwise no commit needed for this task (deploy itself isn't a code change).

---

## Fora de escopo (do spec, reafirmado)

- `criarRecorrente` não muda.
- Edição pós-criação de uma parcela individual já é possível via `PATCH /:id` normal (cada parcela é uma `contas_pagar` como outra qualquer) — não precisa de endpoint novo.
- Validação de soma "valor total" no backend — não existe mais esse campo separado.
