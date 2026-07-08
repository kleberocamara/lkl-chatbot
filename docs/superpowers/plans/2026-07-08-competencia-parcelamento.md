# Competência e Parcelamento Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar parcelamento de despesas (N contas a pagar vinculadas, cada uma com seu próprio vencimento/boleto) reconhecidas no DRE como uma despesa única no mês da compra, e migrar o DRE de regime de caixa pra regime de competência (despesas por `competencia`, receita pela última entrega do pedido).

**Architecture:** `contas_pagar` ganha 4 colunas (`competencia`, `parcela_grupo_id`, `parcela_numero`, `parcela_total`). Nova função `criarParcelado` (mesmo padrão transacional de `criarRecorrente`, já existente) cria N linhas com valores/vencimentos calculados. `analises.dre()` troca as duas queries: despesas somam por `competencia` sem exigir pagamento; receita passa a somar `orcamentos.total` pela data da última OS entregue de cada pedido (via `os_historico`). `fluxoCaixa()` não muda — já agrupa por `vencimento`.

**Tech Stack:** Node.js/Express/PostgreSQL, date-fns, Jest.

---

## Mapa de arquivos

```
sql/migrations/053_competencia_parcelamento.sql   [CREATE]
src/modules/contas-pagar/service.js               [MODIFY]
src/modules/contas-pagar/router.js                [MODIFY]
src/modules/analises/service.js                   [MODIFY]
public/dashboard.html                              [MODIFY]
tests/contas-pagar-parcelado.test.js               [CREATE]
tests/analises-dre.test.js                          [CREATE]
```

---

### Task 1: Migration 053 — colunas de competência e parcelamento

**Files:**
- Create: `sql/migrations/053_competencia_parcelamento.sql`

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- sql/migrations/053_competencia_parcelamento.sql
-- Adiciona regime de competência (DRE) e parcelamento de despesas a contas_pagar.
-- competencia: mês/data em que a despesa é reconhecida no DRE, independente de já
-- ter sido paga. parcela_grupo_id/numero/total: só preenchidos quando a conta faz
-- parte de uma compra parcelada em N contas a pagar distintas.

BEGIN;

ALTER TABLE contas_pagar ADD COLUMN competencia DATE;
ALTER TABLE contas_pagar ADD COLUMN parcela_grupo_id UUID;
ALTER TABLE contas_pagar ADD COLUMN parcela_numero SMALLINT;
ALTER TABLE contas_pagar ADD COLUMN parcela_total SMALLINT;

-- Backfill: contas já existentes usam a data de criação como competência
-- (correto inclusive para recorrentes: cada mês de aluguel É uma despesa nova naquele mês).
UPDATE contas_pagar SET competencia = created_at::date WHERE competencia IS NULL;

ALTER TABLE contas_pagar ALTER COLUMN competencia SET NOT NULL;
ALTER TABLE contas_pagar ALTER COLUMN competencia SET DEFAULT CURRENT_DATE;

CREATE INDEX idx_contas_pagar_competencia ON contas_pagar(competencia);
CREATE INDEX idx_contas_pagar_parcela_grupo ON contas_pagar(parcela_grupo_id) WHERE parcela_grupo_id IS NOT NULL;

COMMIT;
```

- [ ] **Step 2: Aplicar a migration no banco local/dev (se houver banco acessível)**

```bash
psql "$DATABASE_URL" -f sql/migrations/053_competencia_parcelamento.sql
```

Expected: `COMMIT` sem erros. Se não houver banco acessível no ambiente, crie e commite o arquivo mesmo assim, documentando isso no relatório — a aplicação real acontece no deploy (Task 7).

- [ ] **Step 3: Verificar (se aplicou)**

```bash
psql "$DATABASE_URL" -c "\d contas_pagar" | grep -E "competencia|parcela_"
psql "$DATABASE_URL" -c "SELECT id, competencia FROM contas_pagar LIMIT 3;"
```

Expected: as 4 colunas aparecem; contas existentes têm `competencia` preenchida (não nula).

- [ ] **Step 4: Commit**

```bash
git add sql/migrations/053_competencia_parcelamento.sql
git commit -m "feat(contas-pagar): migration 053 — competência (DRE) e parcelamento de despesas"
```

---

### Task 2: `service.js` — `criarParcelado` + `competencia` editável

**Files:**
- Modify: `src/modules/contas-pagar/service.js`
- Test: `tests/contas-pagar-parcelado.test.js`

**Contexto:** `src/modules/contas-pagar/service.js` já tem `criarRecorrente({ descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, tipo, linha_digitavel, pix_content, recorrencia_dia, recorrencia_valor_fixo, observacao })`, que roda numa transação (`pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK`) inserindo 12 linhas em loop. `criarParcelado` segue exatamente esse padrão, mas insere N linhas (não 12 fixas) com valores que somam o total da compra.

- [ ] **Step 1: Escrever os testes**

```js
// tests/contas-pagar-parcelado.test.js
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
    const r = await service.criarParcelado({ descricao: 'Compra tintas', tipo_despesa_id: 2, valor_total: 900 });
    expect(r.erro).toEqual(expect.arrayContaining([expect.stringContaining('obrigat')]));
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('parcelas < 2 → erro', async () => {
    const r = await service.criarParcelado({
      descricao: 'Compra tintas', tipo_despesa_id: 2, valor_total: 900, parcelas: 1, primeiro_vencimento: '2026-08-10',
    });
    expect(r.erro).toBeDefined();
  });

  test('3 parcelas de R$300 → 3 linhas, mesma competência e parcela_grupo_id, vencimentos mensais', async () => {
    const linhasInseridas = [];
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        linhasInseridas.push(params);
        return Promise.resolve({ rows: [{ id: linhasInseridas.length, valor: params[4], vencimento: params[5] }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarParcelado({
      descricao: 'Compra de tintas e solventes', fornecedor: 'Evolution', fornecedor_id: null,
      tipo_despesa_id: 2, valor_total: 900, parcelas: 3, primeiro_vencimento: '2026-08-10', tipo: 'boleto',
    });

    expect(r.criadas).toHaveLength(3);
    expect(linhasInseridas).toHaveLength(3);
    const somaParcelas = linhasInseridas.reduce((s, p) => s + p[4], 0);
    expect(somaParcelas).toBeCloseTo(900, 2);
    const grupoIds = linhasInseridas.map(p => p[8]);
    expect(new Set(grupoIds).size).toBe(1); // mesmo parcela_grupo_id
    const competencias = linhasInseridas.map(p => p[7]);
    expect(new Set(competencias).size).toBe(1); // mesma competência
    expect(linhasInseridas[0][5]).toBe('2026-08-10');
    expect(linhasInseridas[1][5]).toBe('2026-09-10');
    expect(linhasInseridas[2][5]).toBe('2026-10-10');
  });

  test('valor não divisível igualmente → ajuste de centavos fica na última parcela, soma bate exato', async () => {
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

    await service.criarParcelado({
      descricao: 'Compra X', tipo_despesa_id: 1, valor_total: 100, parcelas: 3, primeiro_vencimento: '2026-08-01',
    });

    const soma = linhasInseridas.reduce((s, p) => s + p[4], 0);
    expect(Math.round(soma * 100) / 100).toBe(100);
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

```bash
cd /Users/klebercamara/LKL && npx jest tests/contas-pagar-parcelado.test.js
```

Expected: FAIL — `criarParcelado is not a function`.

- [ ] **Step 3: Adicionar o require de `crypto` no topo de `service.js`**

Local: hoje o topo do arquivo é:
```js
const { query, pool } = require('../../db');
const c6bank = require('../../services/c6bank');
const { format, subDays } = require('date-fns');
const fornecedorMatcher = require('./fornecedor-matcher');
const classificador = require('./classificador');
```
Trocar por:
```js
const { query, pool } = require('../../db');
const c6bank = require('../../services/c6bank');
const { format, subDays } = require('date-fns');
const crypto = require('crypto');
const fornecedorMatcher = require('./fornecedor-matcher');
const classificador = require('./classificador');
```

- [ ] **Step 4: Adicionar `criarParcelado` logo depois de `criarRecorrente`**

```js
async function criarParcelado({ descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor_total, parcelas, primeiro_vencimento, tipo, observacao }) {
  if (!descricao || !tipo_despesa_id || !valor_total || !parcelas || !primeiro_vencimento) {
    return { erro: ['descricao, tipo_despesa_id, valor_total, parcelas e primeiro_vencimento são obrigatórios'] };
  }
  if (parcelas < 2) {
    return { erro: ['parcelas deve ser no mínimo 2 (compra à vista não precisa de parcelamento)'] };
  }

  const parcelaGrupoId = crypto.randomUUID();
  const competencia = format(new Date(`${primeiro_vencimento}T00:00:00`), 'yyyy-MM-dd');
  const valorParcela = Math.floor((valor_total / parcelas) * 100) / 100;
  const ajusteUltima = Math.round((valor_total - valorParcela * (parcelas - 1)) * 100) / 100;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const criadas = [];
    for (let i = 0; i < parcelas; i++) {
      const data = new Date(`${primeiro_vencimento}T00:00:00`);
      data.setMonth(data.getMonth() + i);
      const valorInst = i === parcelas - 1 ? ajusteUltima : valorParcela;
      const r = await client.query(
        `INSERT INTO contas_pagar
           (descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo,
            competencia, parcela_grupo_id, parcela_numero, parcela_total, tipo_entrada, status, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual','pendente',$12)
         RETURNING *`,
        [`${descricao} (${i + 1}/${parcelas})`, fornecedor || null, fornecedor_id || null, tipo_despesa_id,
         valorInst, format(data, 'yyyy-MM-dd'), tipo || 'boleto',
         competencia, parcelaGrupoId, i + 1, parcelas, observacao || null]
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

**Importante para o teste passar**: no INSERT acima, a ordem dos parâmetros é `[descricao(0), fornecedor(1), fornecedor_id(2), tipo_despesa_id(3), valorInst(4), vencimento(5), tipo(6), competencia(7), parcelaGrupoId(8), parcela_numero(9), parcela_total(10), observacao(11)]` — os testes do Step 1 acessam `params[4]` (valor), `params[5]` (vencimento), `params[7]` (competência) e `params[8]` (parcela_grupo_id), que precisam bater exatamente com essas posições.

- [ ] **Step 5: Adicionar `competencia` à lista de campos editáveis em `editar()`**

Local: dentro da função `editar`, hoje:
```js
  const permitidos = ['descricao','fornecedor','fornecedor_id','tipo_despesa_id','valor','vencimento','tipo',
                      'linha_digitavel','pix_content','recorrente','recorrencia_dia',
                      'recorrencia_valor_fixo','observacao'];
```
Trocar por:
```js
  const permitidos = ['descricao','fornecedor','fornecedor_id','tipo_despesa_id','valor','vencimento','tipo',
                      'linha_digitavel','pix_content','recorrente','recorrencia_dia',
                      'recorrencia_valor_fixo','observacao','competencia'];
```

- [ ] **Step 6: Atualizar o `module.exports` final**

Local: hoje:
```js
module.exports = {
  listar, buscarPorId, kpis,
  criar, editar, cancelar, pagarManual,
  criarRecorrente,
  sincronizarDDA,
  listarLotes, criarLoteC6, consultarLoteC6, removerItemLoteC6, submeterLoteC6,
  reconciliar,
  marcarVencidas, contasVencendoEm, atualizarStatusLotesSubmetidos, gerarRecorrentesProximoMes,
  listarTiposDespesa, sugerirTipoDespesa, gravarMemoriaFornecedor, criarOuReconciliarContaPagar,
};
```
Trocar por:
```js
module.exports = {
  listar, buscarPorId, kpis,
  criar, editar, cancelar, pagarManual,
  criarRecorrente, criarParcelado,
  sincronizarDDA,
  listarLotes, criarLoteC6, consultarLoteC6, removerItemLoteC6, submeterLoteC6,
  reconciliar,
  marcarVencidas, contasVencendoEm, atualizarStatusLotesSubmetidos, gerarRecorrentesProximoMes,
  listarTiposDespesa, sugerirTipoDespesa, gravarMemoriaFornecedor, criarOuReconciliarContaPagar,
};
```

- [ ] **Step 7: Rodar os testes**

```bash
npx jest tests/contas-pagar-parcelado.test.js
```

Expected: PASS — 4 testes.

- [ ] **Step 8: Rodar a suíte completa**

```bash
npm test -- --forceExit
```

Expected: mesmas ~22 falhas pré-existentes por falta de banco real, nenhuma nova.

- [ ] **Step 9: Commit**

```bash
git add src/modules/contas-pagar/service.js tests/contas-pagar-parcelado.test.js
git commit -m "feat(contas-pagar): criarParcelado — compra em N parcelas com competência única"
```

---

### Task 3: `router.js` — endpoint `POST /parcelado`

**Files:**
- Modify: `src/modules/contas-pagar/router.js`

- [ ] **Step 1: Adicionar a rota nova, logo depois de `POST /recorrente`**

Local: hoje:
```js
// Criar recorrente
router.post('/recorrente', admin, async (req, res) => {
  try {
    const result = await service.criarRecorrente(req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.status(201).json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});
```
Adicionar logo depois:
```js
// Criar parcelado
router.post('/parcelado', admin, async (req, res) => {
  try {
    const result = await service.criarParcelado(req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.status(201).json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});
```

- [ ] **Step 2: Verificar que o arquivo carrega sem erro**

```bash
cd /Users/klebercamara/LKL && node -e "require('./src/modules/contas-pagar/router.js'); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 3: Rodar a suíte completa**

```bash
npm test -- --forceExit
```

Expected: mesma baseline, sem regressão.

- [ ] **Step 4: Commit**

```bash
git add src/modules/contas-pagar/router.js
git commit -m "feat(contas-pagar): endpoint POST /parcelado"
```

---

### Task 4: `analises/service.js` — DRE por competência

**Files:**
- Modify: `src/modules/analises/service.js`
- Test: `tests/analises-dre.test.js`

**Contexto:** `dre({ inicio, fim })` hoje soma receita por `orcamentos.pago_em` e despesas por `contas_pagar.pago_em`, ambas exigindo `status`/`status_pagamento`='pago'. Vamos trocar as duas queries. `fluxoCaixa()`, `salvarMeta()`, `metaMes()`, `gerarInsight()`, `ultimoInsight()` **não mudam**.

- [ ] **Step 1: Escrever os testes**

```js
// tests/analises-dre.test.js
const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { dre } = require('../src/modules/analises/service');

describe('dre — despesas por competência', () => {
  afterEach(() => jest.clearAllMocks());

  test('despesa pendente (não paga) dentro da competência do período conta', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ receita: 0 }] })
      .mockResolvedValueOnce({ rows: [{ categoria: 'CUSTOS DE PRODUÇÃO (CPV)', valor: 900 }] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(r.total_despesas).toBe(900);
    const despesasSql = db.query.mock.calls[1][0];
    expect(despesasSql).toMatch(/cp\.competencia BETWEEN/);
    expect(despesasSql).not.toMatch(/pago_em/);
    expect(despesasSql).toMatch(/status != 'cancelado'/);
  });
});

describe('dre — receita pela última entrega do pedido', () => {
  afterEach(() => jest.clearAllMocks());

  test('usa a query de entregas (não mais pago_em de orçamentos)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ receita: 5000 }] })
      .mockResolvedValueOnce({ rows: [] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(r.receita).toBe(5000);
    const receitaSql = db.query.mock.calls[0][0];
    expect(receitaSql).toMatch(/os_historico/);
    expect(receitaSql).toMatch(/para_status = 'entregue'/);
    expect(receitaSql).toMatch(/total_os = e\.os_entregues/);
    expect(receitaSql).not.toMatch(/status_pagamento/);
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

```bash
cd /Users/klebercamara/LKL && npx jest tests/analises-dre.test.js
```

Expected: FAIL — as queries antigas não batem com os `toMatch` esperados (`pago_em`/`status_pagamento` ainda presentes, `competencia`/`os_historico` ausentes).

- [ ] **Step 3: Substituir a função `dre()` inteira**

Local: em `src/modules/analises/service.js`, hoje:
```js
async function dre({ inicio, fim } = {}) {
  if (!inicio || !fim) { const m = _mesCorrente(); inicio = inicio || m.inicio; fim = fim || m.fim; }
  if (!DATE_RE.test(inicio) || !DATE_RE.test(fim)) return { erro: ['Datas inválidas (use YYYY-MM-DD)'] };
  if (fim < inicio) return { erro: ['Data final menor que a inicial'] };

  const recR = await db.query(
    `SELECT COALESCE(SUM(total),0) AS receita
     FROM orcamentos WHERE status_pagamento = 'pago' AND pago_em::date BETWEEN $1 AND $2`,
    [inicio, fim]);
  const receita = Number(recR.rows[0].receita);

  const despR = await db.query(
    `SELECT td.categoria_dre AS categoria, COALESCE(SUM(cp.valor),0) AS valor
     FROM contas_pagar cp
     JOIN tipos_despesa td ON td.id = cp.tipo_despesa_id
     WHERE cp.status = 'pago' AND cp.pago_em::date BETWEEN $1 AND $2
     GROUP BY td.categoria_dre ORDER BY valor DESC`,
    [inicio, fim]);
  const despesas = despR.rows.map(r => ({ categoria: r.categoria, valor: Number(r.valor) }));
  const total_despesas = despesas.reduce((s, d) => s + d.valor, 0);

  const resultado = receita - total_despesas;
  const margem = receita > 0 ? resultado / receita : 0;

  return { periodo: { inicio, fim }, receita, despesas, total_despesas, resultado, margem };
}
```
Trocar por:
```js
async function dre({ inicio, fim } = {}) {
  if (!inicio || !fim) { const m = _mesCorrente(); inicio = inicio || m.inicio; fim = fim || m.fim; }
  if (!DATE_RE.test(inicio) || !DATE_RE.test(fim)) return { erro: ['Datas inválidas (use YYYY-MM-DD)'] };
  if (fim < inicio) return { erro: ['Data final menor que a inicial'] };

  // Receita por competência: um orçamento só conta no mês em que TODAS as suas
  // OSs foram entregues (última entrega define o mês), não quando o cliente pagou.
  const recR = await db.query(
    `WITH entregas AS (
       SELECT os.orcamento_id,
              COUNT(*) AS total_os,
              COUNT(*) FILTER (WHERE os.status = 'entregue') AS os_entregues,
              MAX(h.em) AS ultima_entrega
       FROM ordens_servico os
       LEFT JOIN LATERAL (
         SELECT em FROM os_historico h WHERE h.os_id = os.id AND h.para_status = 'entregue' ORDER BY h.em DESC LIMIT 1
       ) h ON true
       GROUP BY os.orcamento_id
     )
     SELECT COALESCE(SUM(o.total),0) AS receita
     FROM orcamentos o
     JOIN entregas e ON e.orcamento_id = o.id
     WHERE e.total_os = e.os_entregues AND e.ultima_entrega::date BETWEEN $1 AND $2`,
    [inicio, fim]);
  const receita = Number(recR.rows[0].receita);

  // Despesa por competência: conta assim que lançada/incorrida, esteja paga ou não.
  // Só exclui canceladas (nunca aconteceram de verdade).
  const despR = await db.query(
    `SELECT td.categoria_dre AS categoria, COALESCE(SUM(cp.valor),0) AS valor
     FROM contas_pagar cp
     JOIN tipos_despesa td ON td.id = cp.tipo_despesa_id
     WHERE cp.status != 'cancelado' AND cp.competencia BETWEEN $1 AND $2
     GROUP BY td.categoria_dre ORDER BY valor DESC`,
    [inicio, fim]);
  const despesas = despR.rows.map(r => ({ categoria: r.categoria, valor: Number(r.valor) }));
  const total_despesas = despesas.reduce((s, d) => s + d.valor, 0);

  const resultado = receita - total_despesas;
  const margem = receita > 0 ? resultado / receita : 0;

  return { periodo: { inicio, fim }, receita, despesas, total_despesas, resultado, margem };
}
```

**Não altere** `fluxoCaixa()`, `_intervaloMes()`, `salvarMeta()`, `metaMes()`, `gerarInsight()`, `ultimoInsight()` — continuam iguais. `gerarInsight()` chama `dre({})` internamente e usa `d.receita`/`d.despesas`/`d.total_despesas`/`d.resultado`/`d.margem` — o formato de retorno de `dre()` não mudou (mesmos campos), só a fonte dos números, então `gerarInsight()` não precisa de nenhuma mudança. Se quiser, ajuste só o texto do prompt em `gerarInsight()` que hoje diz `"DRE (regime de caixa):"` para `"DRE (regime de competência):"` — isso é cosmético (não afeta teste nem comportamento), faça se for rápido, não é bloqueante.

- [ ] **Step 4: Rodar os testes**

```bash
npx jest tests/analises-dre.test.js
```

Expected: PASS — 2 testes.

- [ ] **Step 5: Verificar que o arquivo carrega sem erro**

```bash
node -e "require('./src/modules/analises/service.js'); console.log('OK')"
```

- [ ] **Step 6: Rodar a suíte completa**

```bash
npm test -- --forceExit
```

Expected: mesma baseline, sem regressão.

- [ ] **Step 7: Commit**

```bash
git add src/modules/analises/service.js tests/analises-dre.test.js
git commit -m "feat(analises): DRE por regime de competência — despesa por competencia, receita pela última entrega"
```

---

### Task 5: `dashboard.html` — checkbox "Parcelar" no modal Nova Conta

**Files:**
- Modify: `public/dashboard.html`

**Contexto:** O modal `#cp-modal` (dentro de `page-contas_pagar`, migrado na sessão anterior) já tem um checkbox "Conta Recorrente" (`#cp-f-recorrente`) com campos condicionais em `#cp-grupo-recorrente`. Vamos adicionar um checkbox irmão "Parcelar" com seus próprios campos condicionais, mutuamente exclusivo com "Recorrente".

- [ ] **Step 1: Ler o arquivo e localizar o bloco atual do checkbox recorrente**

```bash
grep -n 'cp-f-recorrente\|cp-grupo-recorrente' /Users/klebercamara/LKL/public/dashboard.html
```

- [ ] **Step 2: Adicionar o checkbox "Parcelar" logo depois do bloco "Conta Recorrente"**

Local: dentro do modal `#cp-modal`, hoje o bloco é:
```html
      <div style="margin-bottom:16px">
        <label style="font-size:13px;font-weight:600;color:#555"><input type="checkbox" id="cp-f-recorrente" onchange="cpToggleRecorrente()"> Conta Recorrente</label>
      </div>
      <div id="cp-grupo-recorrente" style="display:none;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Dia do vencimento (1–28)</label>
          <input type="number" id="cp-f-recorrencia-dia" min="1" max="28" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
        </div>
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Tipo de valor</label>
          <select id="cp-f-recorrencia-valor-fixo" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
            <option value="true">Fixo (aluguel, assinatura)</option><option value="false">Variável (água, luz)</option>
          </select>
        </div>
      </div>
```
Trocar por (mantém o bloco recorrente igual, adiciona o de parcelar logo depois):
```html
      <div style="margin-bottom:16px">
        <label style="font-size:13px;font-weight:600;color:#555"><input type="checkbox" id="cp-f-recorrente" onchange="cpToggleRecorrente()"> Conta Recorrente</label>
      </div>
      <div id="cp-grupo-recorrente" style="display:none;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Dia do vencimento (1–28)</label>
          <input type="number" id="cp-f-recorrencia-dia" min="1" max="28" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
        </div>
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Tipo de valor</label>
          <select id="cp-f-recorrencia-valor-fixo" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
            <option value="true">Fixo (aluguel, assinatura)</option><option value="false">Variável (água, luz)</option>
          </select>
        </div>
      </div>
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

- [ ] **Step 3: Adicionar `cpToggleParcelado()` logo depois de `cpToggleRecorrente()`**

Local: hoje:
```js
function cpToggleRecorrente() {
  const on = document.getElementById('cp-f-recorrente').checked;
  document.getElementById('cp-grupo-recorrente').style.display = on ? 'grid' : 'none';
}
```
Trocar por (adiciona a função nova logo depois, e faz os dois checkboxes se desmarcarem mutuamente):
```js
function cpToggleRecorrente() {
  const on = document.getElementById('cp-f-recorrente').checked;
  document.getElementById('cp-grupo-recorrente').style.display = on ? 'grid' : 'none';
  if (on) {
    document.getElementById('cp-f-parcelado').checked = false;
    document.getElementById('cp-grupo-parcelado').style.display = 'none';
  }
}
function cpToggleParcelado() {
  const on = document.getElementById('cp-f-parcelado').checked;
  document.getElementById('cp-grupo-parcelado').style.display = on ? 'grid' : 'none';
  if (on) {
    document.getElementById('cp-f-recorrente').checked = false;
    document.getElementById('cp-grupo-recorrente').style.display = 'none';
  }
}
```

- [ ] **Step 4: Atualizar `cpAbrirModalNova()` pra resetar o checkbox/campos novos**

Local: hoje:
```js
function cpAbrirModalNova() {
  cpEditandoId = null;
  document.getElementById('cp-modal-titulo').textContent = 'Nova Conta a Pagar';
  ['cp-f-descricao','cp-f-fornecedor','cp-f-fornecedor-id','cp-f-linha-digitavel','cp-f-pix-content','cp-f-observacao'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('cp-f-tipo-despesa').value = '';
  document.getElementById('cp-f-valor').value = '';
  document.getElementById('cp-f-vencimento').value = '';
  document.getElementById('cp-f-tipo').value = 'boleto';
  document.getElementById('cp-f-recorrente').checked = false;
  document.getElementById('cp-grupo-recorrente').style.display = 'none';
  document.getElementById('cp-grupo-linha-digitavel').style.display = 'block';
  document.getElementById('cp-grupo-pix').style.display = 'none';
  document.getElementById('cp-modal').style.display = 'flex';
}
```
Trocar por:
```js
function cpAbrirModalNova() {
  cpEditandoId = null;
  document.getElementById('cp-modal-titulo').textContent = 'Nova Conta a Pagar';
  ['cp-f-descricao','cp-f-fornecedor','cp-f-fornecedor-id','cp-f-linha-digitavel','cp-f-pix-content','cp-f-observacao','cp-f-parcelas','cp-f-primeiro-vencimento'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('cp-f-tipo-despesa').value = '';
  document.getElementById('cp-f-valor').value = '';
  document.getElementById('cp-f-vencimento').value = '';
  document.getElementById('cp-f-tipo').value = 'boleto';
  document.getElementById('cp-f-recorrente').checked = false;
  document.getElementById('cp-grupo-recorrente').style.display = 'none';
  document.getElementById('cp-f-parcelado').checked = false;
  document.getElementById('cp-grupo-parcelado').style.display = 'none';
  document.getElementById('cp-grupo-linha-digitavel').style.display = 'block';
  document.getElementById('cp-grupo-pix').style.display = 'none';
  document.getElementById('cp-modal').style.display = 'flex';
}
```

- [ ] **Step 5: Atualizar `cpSalvarConta()` pra chamar o endpoint de parcelado quando marcado**

Local: hoje:
```js
async function cpSalvarConta() {
  const recorrente = document.getElementById('cp-f-recorrente').checked;
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
  };
  if (cpEditandoId) {
    const r = await api(`/api/v2/contas-pagar/${cpEditandoId}`, { method: 'PATCH', body: JSON.stringify(body) });
    if (r && !r.error && !r.erro) { showToast('✅ Conta atualizada'); cpFecharModal(); loadContasPagar(); }
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
Trocar por:
```js
async function cpSalvarConta() {
  const recorrente = document.getElementById('cp-f-recorrente').checked;
  const parcelado = document.getElementById('cp-f-parcelado').checked;
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

- [ ] **Step 6: Parse check de sintaxe JS**

```bash
cd /Users/klebercamara/LKL && node -e "
const fs = require('fs');
const html = fs.readFileSync('public/dashboard.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
scripts.forEach((m,i) => { try { new Function(m[1]); } catch(e) { console.error('erro', i, e.message); process.exit(1); } });
console.log('JS sintaticamente válido');
"
```

Expected: `JS sintaticamente válido`.

- [ ] **Step 7: Confirmar que nenhum ID novo colide com algum já existente**

```bash
grep -oE 'id="cp-[a-zA-Z0-9-]+"' /Users/klebercamara/LKL/public/dashboard.html | sort | uniq -c | sort -rn | awk '$1>1'
```

Expected: nenhuma saída (sem duplicatas).

- [ ] **Step 8: Rodar a suíte completa**

```bash
npm test -- --forceExit
```

Expected: mesma baseline, sem regressão (não há teste automatizado pra HTML/JS de UI neste projeto).

- [ ] **Step 9: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(dashboard): checkbox Parcelar no modal Nova Conta — compra em N parcelas"
```

---

### Task 6: Deploy no VPS

**Files:** nenhum (operação de deploy)

- [ ] **Step 1: Rodar a suíte completa localmente antes do deploy**

```bash
cd /Users/klebercamara/LKL && npm test -- --forceExit
```

Expected: mesma baseline de falhas pré-existentes (banco real ausente no sandbox), todos os testes novos desta feature passando.

- [ ] **Step 2: Enviar os arquivos alterados/criados pro VPS**

```bash
rsync -R -av \
  sql/migrations/053_competencia_parcelamento.sql \
  src/modules/contas-pagar/service.js \
  src/modules/contas-pagar/router.js \
  src/modules/analises/service.js \
  public/dashboard.html \
  root@2.25.147.243:/var/www/lkl-chatbot/
```

- [ ] **Step 3: Confirmar o nome real de qualquer constraint relevante e aplicar a migration**

Esta migration só faz `ADD COLUMN`/`CREATE INDEX`, sem `DROP CONSTRAINT` — não precisa da checagem de nome de constraint que as migrations anteriores (051/052) exigiam. Aplicar direto:

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && sudo -u postgres psql -d lkl_chatbot -f sql/migrations/053_competencia_parcelamento.sql"
```

Expected: `BEGIN` / `ALTER TABLE` (x4) / `UPDATE N` / `ALTER TABLE` (x2) / `CREATE INDEX` (x2) / `COMMIT`, sem erros.

- [ ] **Step 4: Verificar a migration no banco de produção**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"SELECT COUNT(*) FROM contas_pagar WHERE competencia IS NULL;\""
```

Expected: `count` = 0 (nenhuma conta ficou sem competência após o backfill).

- [ ] **Step 5: Confirmar permissão de `lkl_user`, o usuário real da aplicação, nas colunas novas**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"SELECT has_column_privilege('lkl_user','contas_pagar','competencia','SELECT, UPDATE') AS ok;\""
```

Expected: `ok` = `t`. Se vier `f`, rodar (como postgres) `GRANT SELECT, UPDATE, INSERT ON contas_pagar TO lkl_user;` antes de prosseguir — mesma causa raiz já vista na migration 051 (tabelas criadas pelo usuário `postgres` não repassam automaticamente privilégio de coluna nova pra `lkl_user`, mesmo que `lkl_user` já tivesse acesso à tabela antes).

- [ ] **Step 6: Reiniciar o processo**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```

- [ ] **Step 7: Smoke test**

```bash
sleep 3
ssh root@2.25.147.243 "pm2 logs lkl-chatbot --lines 30 --nostream" 2>&1 | grep -iE "error|erro" | grep -v "already\|pré-exist"
curl -s -o /dev/null -w "%{http_code}\n" https://chatbot.klebercamaraconsultoria.cloud/dashboard.html
```

Expected: nenhum erro novo nos logs; `200` no dashboard.

No painel, abrir Contas a Pagar → Nova Conta → marcar "Parcelar", preencher valor total, número de parcelas e data da 1ª parcela → salvar → confirmar que aparecem N linhas na lista, cada uma com seu vencimento. Depois abrir a aba **Análises Gerenciais** (se existir link no dashboard; senão via `GET /api/v2/analises/dre`) e confirmar que a despesa parcelada aparece inteira no mês da compra, não dividida.

- [ ] **Step 8: Atualizar a memória do projeto**

Registrar em `project_sprint_status.md` (memória fora do repositório): migration 053 aplicada, DRE migrado pra regime de competência (despesa por `competencia`, receita pela última OS entregue), parcelamento de despesas disponível no modal Nova Conta.

---

## Self-Review

**1. Cobertura do spec:**
- Seção 1 (colunas novas + parcelamento) → Task 1, Task 2.
- Seção 2 (`criarParcelado`) → Task 2.
- Seção 3 (UI "Parcelar") → Task 5.
- Seção 4 (DRE despesas por competência) → Task 4.
- Seção 5 (DRE receita por última entrega) → Task 4.
- Seção 6 (`fluxoCaixa()` sem mudança) → confirmado explicitamente no Task 4 (instrução de não alterar).
- Endpoint novo → Task 3.
- Deploy → Task 6.

**2. Placeholder scan:** nenhum "TBD"/"similar à Task N" — todo código está completo em cada step.

**3. Consistência de tipos:**
- `criarParcelado({ descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor_total, parcelas, primeiro_vencimento, tipo, observacao })` — mesmos nomes de campo usados no `router.js` (`service.criarParcelado(req.body)`, passthrough direto) e no `dashboard.html` (`bodyParcelado` monta exatamente esses campos).
- `service.js` exporta `criarParcelado` — usado em `router.js` via `service.criarParcelado`.
- Índice dos parâmetros do INSERT em `criarParcelado` (`params[4]`=valor, `params[5]`=vencimento, `params[7]`=competência, `params[8]`=parcela_grupo_id) bate com a ordem exata da query `VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,...)` mostrada na Task 2 — os testes do Task 2 dependem dessa ordem.
- `dre()` mantém a mesma assinatura de retorno (`{ periodo, receita, despesas, total_despesas, resultado, margem }`) — `gerarInsight()`, que consome esses campos, não precisa de nenhuma mudança de código.
