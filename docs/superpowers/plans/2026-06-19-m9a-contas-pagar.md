# M9-A — Contas a Pagar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Módulo completo de Contas a Pagar com cadastro manual, importação DDA C6 Bank, agendamento de pagamentos em lote, contas recorrentes, alertas WhatsApp de vencimento e reconciliação automática via extrato bancário.

**Architecture:** Tabelas `contas_pagar` + `payment_batches` no PostgreSQL. Extensão do serviço C6 Bank existente com 6 novas funções. Módulo Express com 12 rotas. 6 cron jobs via `node-cron`. PWA com 2 abas (Visão Geral + Lote C6) em `public/pwa/financeiro.html`.

**Tech Stack:** Node.js · Express · PostgreSQL 15 · node-cron · C6 Bank BaaS API (mTLS + OAuth2 já em `src/services/c6bank.js`) · WhatsApp API (já em `src/services/whatsapp.js`)

---

## Codebase Context

Padrões do projeto a seguir:
- DB: `const { query, pool } = require('../../db')` — `query()` para SELECTs, `pool.connect()` para transações
- Routers: `express.Router()`, tratamento de erro com `console.error(err)` + `res.status(500).json({ error: 'Erro interno' })`
- Auth: `requireRole('admin')` de `../../middleware/auth`
- C6 Bank: `getAccessToken()`, `getAgent()`, `authHeaders(token)`, `c6Request(fn)` — todas internas ao service
- WhatsApp: `whatsapp.sendMessage(to, text)` de `src/services/whatsapp.js`
- Variáveis de ambiente: nunca hardcoded — sempre `process.env.NOME`

## File Map

```
sql/migrations/012_contas_pagar.sql          [CREATE]
src/services/c6bank.js                       [MODIFY — adicionar 6 funções + exportar]
src/modules/contas-pagar/service.js          [CREATE]
src/modules/contas-pagar/router.js           [CREATE]
src/modules/index.js                         [MODIFY — registrar rota /contas-pagar]
src/jobs/contas-pagar.js                     [CREATE]
src/app.js                                   [MODIFY — inicializar cron jobs]
public/pwa/financeiro.html                   [CREATE]
```

---

## Task 1: Migration SQL — contas_pagar + payment_batches

**Files:**
- Create: `sql/migrations/012_contas_pagar.sql`

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- sql/migrations/012_contas_pagar.sql
BEGIN;

CREATE TYPE tipo_despesa_enum AS ENUM (
  'ALUGUEL', 'AGUA', 'TARIFA_BANCO', 'FRETE', 'COMBUSTIVEL',
  'TELEFONIA_INTERNET', 'MATERIAL_LIMPEZA', 'MATERIAL_ESCRITORIO',
  'DESPESA_VIAGEM', 'LUZ', 'IMPOSTOS', 'MANUTENCAO', 'COMISSOES',
  'FORNECEDOR', 'SERVICO_TERCEIRIZADO', 'EMPRESTIMO_FINANCIAMENTO',
  'CONTADOR_FOLHA_PAGAMENTO', 'OUTRAS_DESPESAS'
);

CREATE TABLE contas_pagar (
  id                     SERIAL PRIMARY KEY,
  descricao              TEXT NOT NULL,
  fornecedor             TEXT,
  tipo_despesa           tipo_despesa_enum NOT NULL,
  valor                  NUMERIC(10,2) NOT NULL CHECK (valor > 0),
  vencimento             DATE NOT NULL,
  tipo                   VARCHAR(10) NOT NULL DEFAULT 'boleto'
                           CHECK (tipo IN ('boleto','pix','outro')),
  linha_digitavel        TEXT,
  pix_content            TEXT,
  tipo_entrada           VARCHAR(20) NOT NULL DEFAULT 'manual'
                           CHECK (tipo_entrada IN ('manual','dda','importacao_oc')),
  status                 VARCHAR(20) NOT NULL DEFAULT 'pendente'
                           CHECK (status IN ('pendente','agendado','pago','vencido','cancelado')),
  c6_group_id            TEXT,
  c6_item_id             TEXT,
  c6_status              TEXT,
  recorrente             BOOLEAN NOT NULL DEFAULT false,
  recorrencia_dia        SMALLINT CHECK (recorrencia_dia BETWEEN 1 AND 28),
  recorrencia_valor_fixo BOOLEAN DEFAULT true,
  pago_em                TIMESTAMP,
  observacao             TEXT,
  created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contas_pagar_status      ON contas_pagar(status);
CREATE INDEX idx_contas_pagar_vencimento  ON contas_pagar(vencimento);
CREATE INDEX idx_contas_pagar_tipo_desp   ON contas_pagar(tipo_despesa);
CREATE INDEX idx_contas_pagar_c6_group    ON contas_pagar(c6_group_id);
CREATE UNIQUE INDEX idx_contas_pagar_ld   ON contas_pagar(linha_digitavel)
  WHERE linha_digitavel IS NOT NULL AND status != 'cancelado';

CREATE TABLE payment_batches (
  id               SERIAL PRIMARY KEY,
  c6_group_id      TEXT UNIQUE NOT NULL,
  uploader_name    TEXT NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'decodificando'
                     CHECK (status IN ('decodificando','pronto','submetido','aprovado','parcial','erro')),
  valor_total      NUMERIC(10,2),
  quantidade_itens INTEGER,
  submetido_em     TIMESTAMP,
  aprovado_em      TIMESTAMP,
  created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

COMMIT;
```

- [ ] **Step 2: Aplicar a migration**

```bash
psql "$DATABASE_URL" -f sql/migrations/012_contas_pagar.sql
```

Se `DATABASE_URL` não estiver definida localmente, use:
```bash
PGPASSWORD=sua_senha psql -h localhost -U seu_usuario -d seu_banco -f sql/migrations/012_contas_pagar.sql
```

Esperado: `CREATE TYPE`, `CREATE TABLE`, `CREATE INDEX` (7x), `COMMIT`

- [ ] **Step 3: Verificar tabelas criadas**

```bash
psql "$DATABASE_URL" -c "\d contas_pagar" && psql "$DATABASE_URL" -c "\d payment_batches"
```

Esperado: ambas as tabelas com todas as colunas listadas.

- [ ] **Step 4: Commit**

```bash
git add sql/migrations/012_contas_pagar.sql
git commit -m "feat: migration M9-A — contas_pagar + payment_batches"
```

---

## Task 2: Extensão do C6 Bank Service

**Files:**
- Modify: `src/services/c6bank.js`

As funções existentes usam `getAccessToken()`, `getAgent()`, `authHeaders(token)` e `c6Request(fn)` — seguir exatamente o mesmo padrão.

- [ ] **Step 1: Adicionar as 6 novas funções ao final de `src/services/c6bank.js`, antes do `module.exports`**

```javascript
// ─── Agendamento de Pagamentos ────────────────────────────────────────────

async function consultarDDA() {
  const token = await getAccessToken();
  const res = await c6Request(() => axios.get(`${BASE_URL}/v1/schedule_payments/query`, {
    httpsAgent: getAgent(),
    headers: { ...authHeaders(token), 'Content-Type': 'application/x-www-form-urlencoded' },
  }));
  return res.data.items || [];
}

async function criarLote(items) {
  const token = await getAccessToken();
  const res = await c6Request(() => axios.post(`${BASE_URL}/v1/schedule_payments/decode`, { items }, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
  return res.data.group_id;
}

async function consultarLote(groupId) {
  const token = await getAccessToken();
  const res = await c6Request(() => axios.get(`${BASE_URL}/v1/schedule_payments/${groupId}/items`, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
  return res.data.items || [];
}

async function removerItemLote(groupId, itemId) {
  const token = await getAccessToken();
  await c6Request(() => axios.delete(`${BASE_URL}/v1/schedule_payments/${groupId}/items/${itemId}`, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
}

async function submeterLote(groupId, uploaderName) {
  const token = await getAccessToken();
  await c6Request(() => axios.post(`${BASE_URL}/v1/schedule_payments/submit`, {
    group_id: groupId,
    uploader_name: uploaderName,
  }, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
}

async function consultarExtrato(startDate, endDate) {
  const token = await getAccessToken();
  const res = await c6Request(() => axios.get(`${BASE_URL}/v1/statement/`, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
    params: { start_date: startDate, end_date: endDate },
  }));
  return res.data.entries || [];
}
```

- [ ] **Step 2: Atualizar o `module.exports` para incluir as novas funções**

Localizar a linha `module.exports = { emitirBolepix, consultarBoleto, ... }` e adicionar as novas:

```javascript
module.exports = {
  emitirBolepix, consultarBoleto, cancelarBoleto,
  criarPixCobranca, cancelarPixCobranca, registrarWebhookPix,
  consultarDDA, criarLote, consultarLote, removerItemLote, submeterLote, consultarExtrato,
  _getAccessToken: getAccessToken,
  _getAgent: getAgent,
};
```

- [ ] **Step 3: Verificar sintaxe**

```bash
node --check src/services/c6bank.js
```

Esperado: nenhuma saída (sem erros).

- [ ] **Step 4: Commit**

```bash
git add src/services/c6bank.js
git commit -m "feat: c6bank service — DDA, lote pagamentos e extrato"
```

---

## Task 3: Módulo service.js — Contas a Pagar

**Files:**
- Create: `src/modules/contas-pagar/service.js`

- [ ] **Step 1: Criar `src/modules/contas-pagar/service.js`**

```javascript
const { query, pool } = require('../../db');
const c6bank = require('../../services/c6bank');
const { format, subDays } = require('date-fns');

// ─── LEITURA ──────────────────────────────────────────────────────────────

async function listar({ status, tipo_despesa, vencimento_de, vencimento_ate, dias } = {}) {
  const conds = [];
  const params = [];

  if (status) { params.push(status); conds.push(`status = $${params.length}`); }
  if (tipo_despesa) { params.push(tipo_despesa); conds.push(`tipo_despesa = $${params.length}`); }
  if (vencimento_de) { params.push(vencimento_de); conds.push(`vencimento >= $${params.length}`); }
  if (vencimento_ate) { params.push(vencimento_ate); conds.push(`vencimento <= $${params.length}`); }
  if (dias !== undefined) {
    const hoje = format(new Date(), 'yyyy-MM-dd');
    const ate = format(new Date(Date.now() + dias * 86400000), 'yyyy-MM-dd');
    params.push(hoje); conds.push(`vencimento >= $${params.length}`);
    params.push(ate);  conds.push(`vencimento <= $${params.length}`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await query(
    `SELECT * FROM contas_pagar ${where} ORDER BY vencimento ASC, id ASC`,
    params
  );
  return r.rows;
}

async function buscarPorId(id) {
  const r = await query('SELECT * FROM contas_pagar WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// ─── KPIs ─────────────────────────────────────────────────────────────────

async function kpis() {
  const hoje = format(new Date(), 'yyyy-MM-dd');
  const em30  = format(new Date(Date.now() + 30 * 86400000), 'yyyy-MM-dd');
  const inicioMes = format(new Date(new Date().getFullYear(), new Date().getMonth(), 1), 'yyyy-MM-dd');

  const [a30, hoje_, vencidos, pagoMes] = await Promise.all([
    query(`SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar WHERE status IN ('pendente','agendado') AND vencimento BETWEEN $1 AND $2`, [hoje, em30]),
    query(`SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar WHERE status IN ('pendente','agendado','vencido') AND vencimento = $1`, [hoje]),
    query(`SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar WHERE status = 'vencido'`),
    query(`SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar WHERE status = 'pago' AND pago_em >= $1`, [inicioMes]),
  ]);

  return {
    total_30d:    parseFloat(a30.rows[0].total),
    vencendo_hoje: parseFloat(hoje_.rows[0].total),
    vencidos:     parseFloat(vencidos.rows[0].total),
    pago_mes:     parseFloat(pagoMes.rows[0].total),
  };
}

// ─── ESCRITA ──────────────────────────────────────────────────────────────

async function criar({ descricao, fornecedor, tipo_despesa, valor, vencimento, tipo, linha_digitavel, pix_content, tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao }) {
  if (!descricao || !tipo_despesa || !valor || !vencimento) {
    return { erro: ['descricao, tipo_despesa, valor e vencimento são obrigatórios'] };
  }
  const r = await query(
    `INSERT INTO contas_pagar
       (descricao, fornecedor, tipo_despesa, valor, vencimento, tipo, linha_digitavel, pix_content,
        tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [descricao, fornecedor || null, tipo_despesa, valor, vencimento,
     tipo || 'outro', linha_digitavel || null, pix_content || null,
     tipo_entrada || 'manual', recorrente || false, recorrencia_dia || null,
     recorrencia_valor_fixo !== false, observacao || null]
  );
  return r.rows[0];
}

async function editar(id, campos) {
  const conta = await buscarPorId(id);
  if (!conta) return { erro: ['Conta não encontrada'] };
  if (conta.status !== 'pendente') return { erro: ['Só é possível editar contas com status pendente'] };

  const permitidos = ['descricao','fornecedor','tipo_despesa','valor','vencimento','tipo',
                      'linha_digitavel','pix_content','recorrente','recorrencia_dia',
                      'recorrencia_valor_fixo','observacao'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(campos)) {
    if (permitidos.includes(k)) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (!sets.length) return { erro: ['Nenhum campo válido para atualizar'] };
  params.push(id);
  const r = await query(
    `UPDATE contas_pagar SET ${sets.join(', ')}, updated_at=NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  return r.rows[0];
}

async function cancelar(id) {
  const conta = await buscarPorId(id);
  if (!conta) return { erro: ['Conta não encontrada'] };
  if (!['pendente','vencido'].includes(conta.status)) return { erro: ['Só é possível cancelar contas pendentes ou vencidas'] };
  const r = await query(
    `UPDATE contas_pagar SET status='cancelado', updated_at=NOW() WHERE id = $1 RETURNING *`, [id]
  );
  return r.rows[0];
}

async function pagarManual(id) {
  const conta = await buscarPorId(id);
  if (!conta) return { erro: ['Conta não encontrada'] };
  if (conta.status === 'pago') return { erro: ['Conta já está paga'] };
  if (conta.status === 'cancelado') return { erro: ['Conta cancelada não pode ser paga'] };
  const r = await query(
    `UPDATE contas_pagar SET status='pago', pago_em=NOW(), updated_at=NOW() WHERE id = $1 RETURNING *`, [id]
  );
  return r.rows[0];
}

// ─── RECORRENTES ──────────────────────────────────────────────────────────

async function criarRecorrente({ descricao, fornecedor, tipo_despesa, valor, tipo, linha_digitavel, pix_content, recorrencia_dia, recorrencia_valor_fixo, observacao }) {
  if (!descricao || !tipo_despesa || !valor || !recorrencia_dia) {
    return { erro: ['descricao, tipo_despesa, valor e recorrencia_dia são obrigatórios'] };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const criadas = [];
    const hoje = new Date();
    for (let m = 0; m < 12; m++) {
      const data = new Date(hoje.getFullYear(), hoje.getMonth() + m, recorrencia_dia);
      const valorInst = recorrencia_valor_fixo !== false ? valor : 0;
      const r = await client.query(
        `INSERT INTO contas_pagar
           (descricao, fornecedor, tipo_despesa, valor, vencimento, tipo, linha_digitavel, pix_content,
            tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',true,$9,$10,$11) RETURNING *`,
        [descricao, fornecedor || null, tipo_despesa, valorInst,
         format(data, 'yyyy-MM-dd'), tipo || 'outro',
         linha_digitavel || null, pix_content || null,
         recorrencia_dia, recorrencia_valor_fixo !== false, observacao || null]
      );
      criadas.push(r.rows[0]);
    }
    await client.query('COMMIT');
    return { criadas };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── DDA ──────────────────────────────────────────────────────────────────

async function sincronizarDDA() {
  const boletos = await c6bank.consultarDDA();
  let importados = 0;
  let ignorados = 0;
  for (const b of boletos) {
    if (!b.content) { ignorados++; continue; }
    try {
      await query(
        `INSERT INTO contas_pagar
           (descricao, fornecedor, tipo_despesa, valor, vencimento, tipo, linha_digitavel, tipo_entrada, status)
         VALUES ($1,$2,'FORNECEDOR',$3,$4,'boleto',$5,'dda','pendente')
         ON CONFLICT (linha_digitavel) WHERE linha_digitavel IS NOT NULL AND status != 'cancelado'
         DO NOTHING`,
        [
          b.beneficiary_name || 'Boleto DDA',
          b.beneficiary_name || null,
          b.amount,
          b.due_date,
          b.content,
        ]
      );
      importados++;
    } catch (_) { ignorados++; }
  }
  return { total: boletos.length, importados, ignorados };
}

// ─── LOTES C6 ─────────────────────────────────────────────────────────────

async function criarLoteC6(ids, uploaderName) {
  if (!ids || !ids.length) return { erro: ['Informe ao menos um ID de conta'] };
  if (!uploaderName) return { erro: ['uploaderName é obrigatório'] };

  const r = await query(
    `SELECT * FROM contas_pagar WHERE id = ANY($1) AND status IN ('pendente','vencido')`,
    [ids]
  );
  const contas = r.rows;
  if (!contas.length) return { erro: ['Nenhuma conta válida encontrada'] };

  const items = contas.map(c => ({
    content: c.linha_digitavel || c.pix_content,
    amount: parseFloat(c.valor),
    description: `CP-${c.id} ${c.descricao}`.substring(0, 100),
  }));

  const groupId = await c6bank.criarLote(items);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO payment_batches (c6_group_id, uploader_name, valor_total, quantidade_itens)
       VALUES ($1,$2,$3,$4)`,
      [groupId, uploaderName, contas.reduce((s, c) => s + parseFloat(c.valor), 0), contas.length]
    );
    const loteItems = await c6bank.consultarLote(groupId);
    for (const item of loteItems) {
      const conta = contas.find(c => `CP-${c.id}` === (item.description || '').split(' ')[0]);
      if (conta) {
        await client.query(
          `UPDATE contas_pagar SET c6_group_id=$1, c6_item_id=$2, c6_status=$3, status='agendado', updated_at=NOW() WHERE id=$4`,
          [groupId, item.id, item.status, conta.id]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { groupId, quantidade: contas.length };
}

async function consultarLoteC6(groupId) {
  const [batch, items] = await Promise.all([
    query('SELECT * FROM payment_batches WHERE c6_group_id = $1', [groupId]),
    c6bank.consultarLote(groupId),
  ]);
  return { batch: batch.rows[0] || null, items };
}

async function removerItemLoteC6(groupId, itemId) {
  await c6bank.removerItemLote(groupId, itemId);
  await query(
    `UPDATE contas_pagar SET c6_group_id=NULL, c6_item_id=NULL, c6_status=NULL, status='pendente', updated_at=NOW()
     WHERE c6_group_id=$1 AND c6_item_id=$2`,
    [groupId, itemId]
  );
  return { removido: true };
}

async function submeterLoteC6(groupId, uploaderName) {
  await c6bank.submeterLote(groupId, uploaderName || 'Admin LKL');
  await query(
    `UPDATE payment_batches SET status='submetido', submetido_em=NOW(), updated_at=NOW() WHERE c6_group_id=$1`,
    [groupId]
  );
  return { submetido: true };
}

// ─── RECONCILIAÇÃO ────────────────────────────────────────────────────────

async function reconciliar() {
  const hoje = format(new Date(), 'yyyy-MM-dd');
  const ha30 = format(subDays(new Date(), 30), 'yyyy-MM-dd');
  const entradas = await c6bank.consultarExtrato(ha30, hoje);

  const saidas = entradas.filter(e =>
    e.operation_type === 'OUTGOING' && e.transaction_type === 'PAYMENT'
  );

  let atualizadas = 0;
  for (const e of saidas) {
    const match = (e.description || e.title || '').match(/CP-(\d+)/);
    if (!match) continue;
    const contaId = parseInt(match[1]);
    const r = await query(
      `UPDATE contas_pagar SET status='pago', pago_em=NOW(), c6_status='PROCESSED', updated_at=NOW()
       WHERE id=$1 AND status NOT IN ('pago','cancelado') RETURNING id`,
      [contaId]
    );
    if (r.rowCount) atualizadas++;
  }
  return { verificadas: saidas.length, atualizadas };
}

// ─── JOBS (exportados para uso nos cron jobs) ─────────────────────────────

async function marcarVencidas() {
  const r = await query(
    `UPDATE contas_pagar SET status='vencido', updated_at=NOW()
     WHERE status='pendente' AND vencimento < CURRENT_DATE RETURNING id`
  );
  return { atualizadas: r.rowCount };
}

async function contasVencendoEm(dias) {
  const data = format(new Date(Date.now() + dias * 86400000), 'yyyy-MM-dd');
  const r = await query(
    `SELECT * FROM contas_pagar WHERE status IN ('pendente','agendado') AND vencimento = $1`,
    [data]
  );
  return r.rows;
}

async function atualizarStatusLotesSubmetidos() {
  const r = await query(`SELECT c6_group_id FROM payment_batches WHERE status='submetido'`);
  let aprovados = 0;
  for (const batch of r.rows) {
    try {
      const items = await c6bank.consultarLote(batch.c6_group_id);
      const todos = items.length;
      const processados = items.filter(i => i.status === 'PROCESSED').length;
      const erros = items.filter(i => i.status === 'ERROR' || i.status === 'DECODE_ERROR').length;

      let novoStatus = 'submetido';
      if (processados === todos) novoStatus = 'aprovado';
      else if (processados > 0) novoStatus = 'parcial';
      else if (erros === todos) novoStatus = 'erro';

      await query(
        `UPDATE payment_batches SET status=$1, ${novoStatus === 'aprovado' ? 'aprovado_em=NOW(),' : ''} updated_at=NOW() WHERE c6_group_id=$2`,
        [novoStatus, batch.c6_group_id]
      );

      for (const item of items) {
        if (item.status === 'PROCESSED') {
          await query(
            `UPDATE contas_pagar SET status='pago', c6_status='PROCESSED', pago_em=NOW(), updated_at=NOW()
             WHERE c6_group_id=$1 AND c6_item_id=$2 AND status != 'pago'`,
            [batch.c6_group_id, item.id]
          );
          aprovados++;
        }
      }
    } catch (_) { /* continua para próximo lote */ }
  }
  return { aprovados };
}

async function gerarRecorrentesProximoMes() {
  const r = await query(
    `SELECT DISTINCT ON (descricao, recorrencia_dia) * FROM contas_pagar
     WHERE recorrente=true AND status != 'cancelado'
     ORDER BY descricao, recorrencia_dia, created_at DESC`
  );
  const proximo = new Date();
  proximo.setMonth(proximo.getMonth() + 1);
  let geradas = 0;
  for (const c of r.rows) {
    const venc = new Date(proximo.getFullYear(), proximo.getMonth(), c.recorrencia_dia);
    const existe = await query(
      `SELECT 1 FROM contas_pagar WHERE descricao=$1 AND vencimento=$2 AND recorrente=true`,
      [c.descricao, format(venc, 'yyyy-MM-dd')]
    );
    if (existe.rowCount) continue;
    await query(
      `INSERT INTO contas_pagar (descricao, fornecedor, tipo_despesa, valor, vencimento, tipo,
        linha_digitavel, pix_content, tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',true,$9,$10,$11)`,
      [c.descricao, c.fornecedor, c.tipo_despesa,
       c.recorrencia_valor_fixo ? c.valor : 0,
       format(venc, 'yyyy-MM-dd'), c.tipo,
       c.linha_digitavel, c.pix_content, c.recorrencia_dia, c.recorrencia_valor_fixo, c.observacao]
    );
    geradas++;
  }
  return { geradas };
}

module.exports = {
  listar, buscarPorId, kpis,
  criar, editar, cancelar, pagarManual,
  criarRecorrente,
  sincronizarDDA,
  criarLoteC6, consultarLoteC6, removerItemLoteC6, submeterLoteC6,
  reconciliar,
  marcarVencidas, contasVencendoEm, atualizarStatusLotesSubmetidos, gerarRecorrentesProximoMes,
};
```

- [ ] **Step 2: Verificar sintaxe**

```bash
node --check src/modules/contas-pagar/service.js
```

Esperado: nenhuma saída.

- [ ] **Step 3: Commit**

```bash
git add src/modules/contas-pagar/service.js
git commit -m "feat: M9-A service — contas a pagar, DDA, lotes C6, reconciliação"
```

---

## Task 4: Router + Registro no Index

**Files:**
- Create: `src/modules/contas-pagar/router.js`
- Modify: `src/modules/index.js`

- [ ] **Step 1: Criar `src/modules/contas-pagar/router.js`**

```javascript
const express = require('express');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');

const router = express.Router();
const admin = requireRole('admin');

// KPIs
router.get('/kpis', admin, async (req, res) => {
  try { res.json(await service.kpis()); }
  catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Listar
router.get('/', admin, async (req, res) => {
  try {
    const { status, tipo_despesa, vencimento_de, vencimento_ate, dias } = req.query;
    res.json(await service.listar({
      status, tipo_despesa, vencimento_de, vencimento_ate,
      dias: dias !== undefined ? parseInt(dias) : undefined,
    }));
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Criar
router.post('/', admin, async (req, res) => {
  try {
    const result = await service.criar(req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.status(201).json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Criar recorrente
router.post('/recorrente', admin, async (req, res) => {
  try {
    const result = await service.criarRecorrente(req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.status(201).json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Sincronizar DDA
router.get('/dda/sync', admin, async (req, res) => {
  try { res.json(await service.sincronizarDDA()); }
  catch (err) { console.error('[CONTAS-PAGAR-DDA]', err); res.status(500).json({ error: 'Erro ao sincronizar DDA' }); }
});

// Criar lote C6
router.post('/lote', admin, async (req, res) => {
  try {
    const { ids, uploaderName } = req.body;
    const result = await service.criarLoteC6(ids, uploaderName);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.status(201).json(result);
  } catch (err) { console.error('[CONTAS-PAGAR-LOTE]', err); res.status(500).json({ error: 'Erro ao criar lote' }); }
});

// Consultar lote
router.get('/lote/:groupId', admin, async (req, res) => {
  try { res.json(await service.consultarLoteC6(req.params.groupId)); }
  catch (err) { console.error('[CONTAS-PAGAR-LOTE]', err); res.status(500).json({ error: 'Erro ao consultar lote' }); }
});

// Remover item do lote
router.delete('/lote/:groupId/item/:itemId', admin, async (req, res) => {
  try {
    const result = await service.removerItemLoteC6(req.params.groupId, req.params.itemId);
    res.json(result);
  } catch (err) { console.error('[CONTAS-PAGAR-LOTE]', err); res.status(500).json({ error: 'Erro ao remover item' }); }
});

// Submeter lote
router.post('/lote/:groupId/submeter', admin, async (req, res) => {
  try {
    const result = await service.submeterLoteC6(req.params.groupId, req.body.uploaderName);
    res.json(result);
  } catch (err) { console.error('[CONTAS-PAGAR-LOTE]', err); res.status(500).json({ error: 'Erro ao submeter lote' }); }
});

// Reconciliar manual
router.post('/reconciliar', admin, async (req, res) => {
  try { res.json(await service.reconciliar()); }
  catch (err) { console.error('[CONTAS-PAGAR-RECONCILIAR]', err); res.status(500).json({ error: 'Erro ao reconciliar' }); }
});

// Editar
router.patch('/:id', admin, async (req, res) => {
  try {
    const result = await service.editar(req.params.id, req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Pagar manualmente
router.patch('/:id/pagar', admin, async (req, res) => {
  try {
    const result = await service.pagarManual(req.params.id);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Cancelar
router.delete('/:id', admin, async (req, res) => {
  try {
    const result = await service.cancelar(req.params.id);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
```

- [ ] **Step 2: Registrar em `src/modules/index.js`**

Adicionar logo após a linha `router.use('/nfe', ...)`:

```javascript
router.use('/contas-pagar', requireAuthApi, require('./contas-pagar/router'));
```

- [ ] **Step 3: Verificar sintaxe de ambos os arquivos**

```bash
node --check src/modules/contas-pagar/router.js && node --check src/modules/index.js
```

- [ ] **Step 4: Testar endpoints básicos com servidor local**

```bash
npm run dev &
sleep 3

# Criar conta de teste
curl -s -X POST http://localhost:3000/api/v2/contas-pagar \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SEU_TOKEN_ADMIN" \
  -d '{"descricao":"Conta Light Jan","tipo_despesa":"LUZ","valor":350.00,"vencimento":"2026-07-10","tipo":"boleto"}' | jq .

# Listar
curl -s http://localhost:3000/api/v2/contas-pagar \
  -H "Authorization: Bearer SEU_TOKEN_ADMIN" | jq '.[] | {id, descricao, status}'
```

Esperado: conta criada com `id`, `status: "pendente"`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/contas-pagar/router.js src/modules/index.js
git commit -m "feat: M9-A router e registro — 12 endpoints contas a pagar"
```

---

## Task 5: Cron Jobs

**Files:**
- Create: `src/jobs/contas-pagar.js`
- Modify: `src/app.js`

- [ ] **Step 1: Instalar node-cron (verificar se já existe primeiro)**

```bash
grep -r "node-cron" package.json || npm install node-cron
```

- [ ] **Step 2: Criar `src/jobs/contas-pagar.js`**

```javascript
const cron = require('node-cron');
const service = require('../modules/contas-pagar/service');
const whatsapp = require('../services/whatsapp');
const { format } = require('date-fns');

function log(msg) { console.log(`[CRON-CONTAS-PAGAR] ${new Date().toISOString()} ${msg}`); }

// 07h00 — Importar boletos DDA
cron.schedule('0 7 * * *', async () => {
  try {
    const r = await service.sincronizarDDA();
    log(`DDA sync: ${r.importados} importados, ${r.ignorados} ignorados`);
  } catch (err) { log(`ERRO sync_dda: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });

// 07h30 — Reconciliar extrato C6
cron.schedule('30 7 * * *', async () => {
  try {
    const r = await service.reconciliar();
    log(`Reconciliação: ${r.atualizadas} contas marcadas como pagas`);
  } catch (err) { log(`ERRO reconciliar_extrato: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });

// 08h00 — Marcar vencidas
cron.schedule('0 8 * * *', async () => {
  try {
    const r = await service.marcarVencidas();
    log(`check_overdue: ${r.atualizadas} contas marcadas como vencidas`);
  } catch (err) { log(`ERRO check_overdue: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });

// 09h00 — Alertar vencimentos em 2 dias
cron.schedule('0 9 * * *', async () => {
  const ownerWpp = process.env.OWNER_WHATSAPP;
  if (!ownerWpp) { log('OWNER_WHATSAPP não configurado — alerta pulado'); return; }
  try {
    const contas = await service.contasVencendoEm(2);
    if (!contas.length) return;
    const total = contas.reduce((s, c) => s + parseFloat(c.valor), 0);
    const lista = contas.map(c => `• ${c.descricao} — R$${parseFloat(c.valor).toFixed(2)}`).join('\n');
    const msg = `⚠️ *Contas a Pagar — Vencimento em 2 dias*\n\n${lista}\n\n*Total: R$${total.toFixed(2)}*\n\nAcesse o painel para agendar o pagamento.`;
    await whatsapp.sendMessage(ownerWpp, msg);
    log(`alert_vencendo: ${contas.length} contas notificadas`);
  } catch (err) { log(`ERRO alert_vencendo: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });

// A cada 2h (07h–21h, seg–sex) — Verificar status dos lotes submetidos
cron.schedule('0 7,9,11,13,15,17,19,21 * * 1-5', async () => {
  try {
    const r = await service.atualizarStatusLotesSubmetidos();
    if (r.aprovados) log(`check_batch_status: ${r.aprovados} itens aprovados`);
  } catch (err) { log(`ERRO check_batch_status: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });

// Dia 25 às 09h — Gerar contas recorrentes do próximo mês
cron.schedule('0 9 25 * *', async () => {
  try {
    const r = await service.gerarRecorrentesProximoMes();
    log(`generate_recurrent: ${r.geradas} contas geradas para o próximo mês`);
  } catch (err) { log(`ERRO generate_recurrent: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });

log('Cron jobs de contas a pagar inicializados');
```

- [ ] **Step 3: Registrar os cron jobs em `src/app.js`**

Após a linha `global.io = io;` (por volta da linha 19), adicionar:

```javascript
// Cron jobs
require('./jobs/contas-pagar');
```

- [ ] **Step 4: Verificar sintaxe**

```bash
node --check src/jobs/contas-pagar.js && node --check src/app.js
```

- [ ] **Step 5: Commit**

```bash
git add src/jobs/contas-pagar.js src/app.js
git commit -m "feat: M9-A cron jobs — DDA, overdue, alertas WhatsApp, batch status, recorrentes"
```

---

## Task 6: PWA financeiro.html

**Files:**
- Create: `public/pwa/financeiro.html`

- [ ] **Step 1: Criar `public/pwa/financeiro.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Financeiro — LKL Gráfica</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; color: #1a1a2e; }
    header { background: #1a1a2e; color: #fff; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
    header h1 { font-size: 18px; }
    .btn-sair { background: transparent; border: 1px solid rgba(255,255,255,.3); color: #fff; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    .tabs { display: flex; background: #fff; border-bottom: 2px solid #e5e7eb; padding: 0 24px; }
    .tab { padding: 14px 20px; font-size: 14px; font-weight: 600; cursor: pointer; border-bottom: 3px solid transparent; margin-bottom: -2px; color: #666; }
    .tab.active { color: #1a1a2e; border-bottom-color: #1a1a2e; }
    .tab-content { display: none; padding: 24px; }
    .tab-content.active { display: block; }

    /* KPI cards */
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .kpi { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
    .kpi .label { font-size: 12px; color: #888; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .5px; }
    .kpi .value { font-size: 24px; font-weight: 700; }
    .kpi.red .value { color: #dc2626; }
    .kpi.orange .value { color: #ea580c; }

    /* Filtros rápidos */
    .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
    .chip { padding: 6px 14px; border-radius: 20px; border: 1px solid #d1d5db; background: #fff; font-size: 13px; cursor: pointer; font-weight: 500; }
    .chip.active { background: #1a1a2e; color: #fff; border-color: #1a1a2e; }

    /* Toolbar */
    .toolbar { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
    .btn { padding: 9px 16px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 600; }
    .btn-primary { background: #1a1a2e; color: #fff; }
    .btn-secondary { background: #fff; color: #1a1a2e; border: 1px solid #d1d5db; }
    .btn-green { background: #16a34a; color: #fff; }
    .btn-red { background: #dc2626; color: #fff; }
    .btn:disabled { opacity: .5; cursor: not-allowed; }

    /* Tabela */
    .table-wrap { background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(0,0,0,.06); overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { background: #f8f9fa; padding: 12px 14px; text-align: left; font-weight: 600; color: #555; border-bottom: 1px solid #e5e7eb; white-space: nowrap; }
    td { padding: 12px 14px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafafa; }

    /* Badges */
    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; }
    .badge-verde { background: #dcfce7; color: #16a34a; }
    .badge-amarelo { background: #fef9c3; color: #ca8a04; }
    .badge-laranja { background: #ffedd5; color: #ea580c; }
    .badge-vermelho { background: #fee2e2; color: #dc2626; }
    .badge-cinza { background: #f1f5f9; color: #64748b; }
    .badge-azul { background: #dbeafe; color: #1d4ed8; }

    /* Modal */
    .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 100; align-items: center; justify-content: center; }
    .modal-bg.open { display: flex; }
    .modal { background: #fff; border-radius: 14px; padding: 28px; width: 90%; max-width: 520px; max-height: 90vh; overflow-y: auto; }
    .modal h2 { font-size: 18px; margin-bottom: 20px; }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 5px; color: #555; }
    .form-group input, .form-group select, .form-group textarea {
      width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; outline: none;
    }
    .form-group input:focus, .form-group select:focus { border-color: #1a1a2e; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .modal-footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }

    /* Toast */
    #toast { position: fixed; bottom: 24px; right: 24px; background: #1a1a2e; color: #fff; padding: 14px 20px; border-radius: 10px; font-size: 14px; display: none; z-index: 999; max-width: 340px; }

    /* Step indicator */
    .steps { display: flex; gap: 0; margin-bottom: 24px; }
    .step { flex: 1; padding: 10px; text-align: center; font-size: 12px; font-weight: 600; color: #888; border-bottom: 3px solid #e5e7eb; }
    .step.done { color: #16a34a; border-bottom-color: #16a34a; }
    .step.active { color: #1a1a2e; border-bottom-color: #1a1a2e; }

    /* Lote carrinho */
    .lote-layout { display: grid; grid-template-columns: 1fr 320px; gap: 20px; }
    .carrinho { background: #fff; border-radius: 12px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.06); position: sticky; top: 20px; }
    .carrinho h3 { font-size: 15px; margin-bottom: 14px; }
    .carrinho-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
    .carrinho-total { display: flex; justify-content: space-between; font-weight: 700; font-size: 16px; padding-top: 12px; margin-top: 4px; }

    @media (max-width: 768px) {
      .lote-layout { grid-template-columns: 1fr; }
      .form-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
<header>
  <h1>💰 Contas a Pagar</h1>
  <button class="btn-sair" onclick="sair()">Sair</button>
</header>

<div class="tabs">
  <div class="tab active" onclick="trocarAba('visao-geral')">Visão Geral</div>
  <div class="tab" onclick="trocarAba('lote-c6')">Lote C6 Bank</div>
</div>

<!-- ABA 1: VISÃO GERAL -->
<div id="tab-visao-geral" class="tab-content active">
  <div class="kpis">
    <div class="kpi"><div class="label">A Pagar (30 dias)</div><div class="value" id="kpi-30d">—</div></div>
    <div class="kpi red"><div class="label">Vencendo Hoje</div><div class="value" id="kpi-hoje">—</div></div>
    <div class="kpi red"><div class="label">Vencidos</div><div class="value" id="kpi-vencidos">—</div></div>
    <div class="kpi"><div class="label">Pago este Mês</div><div class="value" id="kpi-mes">—</div></div>
  </div>

  <div class="chips" id="chips-prazo">
    <div class="chip active" data-dias="" onclick="filtrarDias(this)">Todos</div>
    <div class="chip" data-status="vencido" onclick="filtrarStatus(this)">Vencidos</div>
    <div class="chip" data-dias="0" onclick="filtrarDias(this)">Hoje</div>
    <div class="chip" data-dias="1" onclick="filtrarDias(this)">Amanhã</div>
    <div class="chip" data-dias="2" onclick="filtrarDias(this)">2 dias</div>
    <div class="chip" data-dias="7" onclick="filtrarDias(this)">7 dias</div>
    <div class="chip" data-dias="15" onclick="filtrarDias(this)">15 dias</div>
    <div class="chip" data-dias="30" onclick="filtrarDias(this)">30 dias</div>
  </div>

  <div class="toolbar">
    <button class="btn btn-primary" onclick="abrirModalNova()">+ Nova Conta</button>
    <button class="btn btn-secondary" onclick="sincronizarDDA()">🔄 Sincronizar DDA</button>
    <button class="btn btn-secondary" onclick="reconciliar()">⚡ Reconciliar</button>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th><input type="checkbox" id="check-all" onchange="toggleTodos(this)"></th>
          <th>Vencimento</th>
          <th>Descrição</th>
          <th>Fornecedor</th>
          <th>Tipo Despesa</th>
          <th>Valor</th>
          <th>Status</th>
          <th>Origem</th>
          <th>Ações</th>
        </tr>
      </thead>
      <tbody id="tabela-contas"></tbody>
    </table>
  </div>
  <div id="rodape-selecao" style="display:none; margin-top:16px; padding:12px 16px; background:#fff; border-radius:8px; display:flex; align-items:center; gap:16px;">
    <span id="label-selecionados">0 selecionadas — R$ 0,00</span>
    <button class="btn btn-primary" onclick="adicionarAoLote()">Adicionar ao Lote C6</button>
  </div>
</div>

<!-- ABA 2: LOTE C6 -->
<div id="tab-lote-c6" class="tab-content">
  <div class="steps">
    <div class="step active" id="step-1">1. Selecionar</div>
    <div class="step" id="step-2">2. Validar</div>
    <div class="step" id="step-3">3. Revisar</div>
    <div class="step" id="step-4">4. Submeter</div>
  </div>

  <div class="lote-layout">
    <div>
      <div class="toolbar">
        <input type="text" id="lote-busca" placeholder="Buscar por descrição..." style="padding:9px 14px; border:1px solid #d1d5db; border-radius:8px; font-size:13px; width:220px;" oninput="filtrarLote()">
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th><input type="checkbox" id="check-lote-all" onchange="toggleTodosLote(this)"></th>
              <th>Vencimento</th>
              <th>Descrição</th>
              <th>Valor</th>
              <th>Tipo</th>
              <th>Status C6</th>
            </tr>
          </thead>
          <tbody id="tabela-lote"></tbody>
        </table>
      </div>
    </div>

    <div class="carrinho">
      <h3>🛒 Lote de Pagamento</h3>
      <div id="carrinho-itens"><p style="color:#888;font-size:13px;">Nenhuma conta selecionada</p></div>
      <div class="carrinho-total" id="carrinho-total" style="display:none">
        <span>Total</span><span id="total-lote">R$ 0,00</span>
      </div>
      <div style="margin-top:16px;">
        <div class="form-group">
          <label>Seu nome (responsável)</label>
          <input type="text" id="uploader-name" placeholder="Ex: Maria Admin">
        </div>
        <div class="form-group">
          <label>Data de pagamento (opcional)</label>
          <input type="date" id="data-transacao">
        </div>
        <button class="btn btn-primary" style="width:100%" id="btn-montar-lote" onclick="montarLote()" disabled>
          Montar Lote C6
        </button>
        <button class="btn btn-green" style="width:100%; margin-top:8px; display:none" id="btn-submeter-lote" onclick="submeterLote()">
          ✅ Enviar para Aprovação no C6
        </button>
      </div>

      <div id="lote-status" style="margin-top:16px; font-size:13px; display:none;">
        <strong>group_id:</strong> <span id="lote-group-id" style="font-family:monospace; font-size:11px; word-break:break-all;"></span>
        <div id="lote-status-badge" style="margin-top:8px;"></div>
      </div>
    </div>
  </div>

  <!-- Histórico de lotes -->
  <h3 style="margin: 24px 0 12px; font-size:16px;">Histórico de Lotes</h3>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>group_id</th><th>Responsável</th><th>Itens</th><th>Total</th><th>Status</th><th>Submetido em</th></tr>
      </thead>
      <tbody id="tabela-historico-lotes"></tbody>
    </table>
  </div>
</div>

<!-- MODAL NOVA CONTA -->
<div class="modal-bg" id="modal-nova">
  <div class="modal">
    <h2>Nova Conta a Pagar</h2>
    <div class="form-row">
      <div class="form-group">
        <label>Descrição *</label>
        <input type="text" id="f-descricao" placeholder="Ex: Conta Light Janeiro">
      </div>
      <div class="form-group">
        <label>Fornecedor/Credor</label>
        <input type="text" id="f-fornecedor" placeholder="Ex: Light S.A.">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Tipo de Despesa *</label>
        <select id="f-tipo-despesa">
          <option value="">Selecione...</option>
          <option value="ALUGUEL">Aluguel</option>
          <option value="AGUA">Água</option>
          <option value="LUZ">Luz</option>
          <option value="TELEFONIA_INTERNET">Telefonia / Internet</option>
          <option value="TARIFA_BANCO">Tarifa Bancária</option>
          <option value="FRETE">Frete</option>
          <option value="COMBUSTIVEL">Combustível</option>
          <option value="MATERIAL_LIMPEZA">Material de Limpeza</option>
          <option value="MATERIAL_ESCRITORIO">Material de Escritório</option>
          <option value="DESPESA_VIAGEM">Despesa de Viagem</option>
          <option value="IMPOSTOS">Impostos</option>
          <option value="MANUTENCAO">Manutenção</option>
          <option value="COMISSOES">Comissões</option>
          <option value="FORNECEDOR">Fornecedor</option>
          <option value="SERVICO_TERCEIRIZADO">Serviço Terceirizado</option>
          <option value="EMPRESTIMO_FINANCIAMENTO">Empréstimo / Financiamento</option>
          <option value="CONTADOR_FOLHA_PAGAMENTO">Contador / Folha Pagamento</option>
          <option value="OUTRAS_DESPESAS">Outras Despesas</option>
        </select>
      </div>
      <div class="form-group">
        <label>Valor (R$) *</label>
        <input type="number" id="f-valor" step="0.01" min="0.01" placeholder="0,00">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Vencimento *</label>
        <input type="date" id="f-vencimento">
      </div>
      <div class="form-group">
        <label>Tipo de Pagamento</label>
        <select id="f-tipo">
          <option value="boleto">Boleto</option>
          <option value="pix">PIX</option>
          <option value="outro">Outro</option>
        </select>
      </div>
    </div>
    <div class="form-group" id="grupo-linha-digitavel">
      <label>Linha Digitável (44 dígitos)</label>
      <input type="text" id="f-linha-digitavel" placeholder="00000.00000 00000.000000 00000.000000 0 00000000000000" maxlength="60">
    </div>
    <div class="form-group" id="grupo-pix" style="display:none">
      <label>Chave PIX ou BR Code</label>
      <input type="text" id="f-pix-content" placeholder="CPF, CNPJ, e-mail, telefone ou brcode">
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="f-recorrente" onchange="toggleRecorrente()"> Conta Recorrente</label>
    </div>
    <div id="grupo-recorrente" style="display:none">
      <div class="form-row">
        <div class="form-group">
          <label>Dia do vencimento (1–28)</label>
          <input type="number" id="f-recorrencia-dia" min="1" max="28">
        </div>
        <div class="form-group">
          <label>Valor</label>
          <select id="f-recorrencia-valor-fixo">
            <option value="true">Fixo (aluguel, assinatura)</option>
            <option value="false">Variável (água, luz)</option>
          </select>
        </div>
      </div>
    </div>
    <div class="form-group">
      <label>Observação</label>
      <textarea id="f-observacao" rows="2" style="resize:vertical"></textarea>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="fecharModal()">Cancelar</button>
      <button class="btn btn-primary" onclick="salvarConta()">Salvar Conta</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
  const TOKEN_KEY = 'lkl_token';
  let contasSelecionadas = new Set();
  let loteItens = [];
  let currentGroupId = null;
  let filtroAtivo = { dias: undefined, status: undefined };

  // ─── AUTH ──────────────────────────────────────────────────────────────
  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
  }
  function sair() { localStorage.removeItem(TOKEN_KEY); window.location.href = '/pwa/login.html'; }

  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch('/api/v2' + path, opts);
    if (r.status === 401) { sair(); return null; }
    return r.ok ? r.json() : r.json().then(e => { showToast('❌ ' + (e.erro?.[0] || e.error || 'Erro')); return null; });
  }

  function fmt(v) { return 'R$ ' + parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }
  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 4000);
  }

  // ─── ABAS ──────────────────────────────────────────────────────────────
  function trocarAba(aba) {
    document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', ['visao-geral','lote-c6'][i] === aba));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-' + aba).classList.add('active');
    if (aba === 'lote-c6') carregarLote();
  }

  // ─── KPIs ──────────────────────────────────────────────────────────────
  async function carregarKPIs() {
    const d = await api('GET', '/contas-pagar/kpis');
    if (!d) return;
    document.getElementById('kpi-30d').textContent = fmt(d.total_30d);
    document.getElementById('kpi-hoje').textContent = fmt(d.vencendo_hoje);
    document.getElementById('kpi-vencidos').textContent = fmt(d.vencidos);
    document.getElementById('kpi-mes').textContent = fmt(d.pago_mes);
  }

  // ─── TABELA PRINCIPAL ──────────────────────────────────────────────────
  async function carregarContas() {
    const params = new URLSearchParams();
    if (filtroAtivo.dias !== undefined) params.set('dias', filtroAtivo.dias);
    if (filtroAtivo.status) params.set('status', filtroAtivo.status);
    const contas = await api('GET', '/contas-pagar?' + params);
    if (!contas) return;
    renderTabela(contas);
  }

  function badgeVencimento(venc) {
    const hoje = new Date(); hoje.setHours(0,0,0,0);
    const d = new Date(venc + 'T00:00:00');
    const diff = Math.ceil((d - hoje) / 86400000);
    if (diff < 0) return `<span class="badge badge-vermelho">Vencido ${Math.abs(diff)}d</span>`;
    if (diff === 0) return `<span class="badge badge-vermelho">Hoje</span>`;
    if (diff === 1) return `<span class="badge badge-laranja">Amanhã</span>`;
    if (diff <= 3) return `<span class="badge badge-laranja">${diff}d</span>`;
    if (diff <= 7) return `<span class="badge badge-amarelo">${diff}d</span>`;
    return `<span class="badge badge-verde">${d.toLocaleDateString('pt-BR')}</span>`;
  }

  function badgeStatus(s) {
    const m = { pendente: 'badge-cinza', agendado: 'badge-azul', pago: 'badge-verde', vencido: 'badge-vermelho', cancelado: 'badge-cinza' };
    return `<span class="badge ${m[s] || 'badge-cinza'}">${s}</span>`;
  }

  function badgeOrigem(t) {
    const m = { manual: '✏️', dda: '🏦', importacao_oc: '📦' };
    return m[t] || '—';
  }

  function renderTabela(contas) {
    const tbody = document.getElementById('tabela-contas');
    if (!contas.length) { tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#888;padding:32px">Nenhuma conta encontrada</td></tr>'; return; }
    tbody.innerHTML = contas.map(c => `
      <tr>
        <td><input type="checkbox" class="check-conta" value="${c.id}" onchange="toggleSelecao(this, ${c.valor})" ${contasSelecionadas.has(c.id) ? 'checked' : ''}></td>
        <td>${badgeVencimento(c.vencimento)}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${c.descricao}">${c.descricao}</td>
        <td>${c.fornecedor || '—'}</td>
        <td style="font-size:11px">${c.tipo_despesa.replace(/_/g,' ')}</td>
        <td style="font-weight:600">${fmt(c.valor)}</td>
        <td>${badgeStatus(c.status)}</td>
        <td>${badgeOrigem(c.tipo_entrada)}</td>
        <td style="white-space:nowrap">
          ${c.status !== 'pago' && c.status !== 'cancelado' ? `<button class="btn btn-secondary" style="padding:4px 10px;font-size:11px" onclick="pagarManual(${c.id})">Pagar</button>` : ''}
          ${c.status === 'pendente' || c.status === 'vencido' ? `<button class="btn btn-red" style="padding:4px 10px;font-size:11px;margin-left:4px" onclick="cancelarConta(${c.id})">✕</button>` : ''}
        </td>
      </tr>`).join('');
  }

  function filtrarDias(el) {
    document.querySelectorAll('#chips-prazo .chip').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    const dias = el.dataset.dias;
    filtroAtivo = { dias: dias !== '' ? parseInt(dias) : undefined, status: undefined };
    carregarContas();
  }
  function filtrarStatus(el) {
    document.querySelectorAll('#chips-prazo .chip').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    filtroAtivo = { status: el.dataset.status, dias: undefined };
    carregarContas();
  }

  function toggleSelecao(cb, valor) {
    const id = parseInt(cb.value);
    if (cb.checked) contasSelecionadas.add(id); else contasSelecionadas.delete(id);
    atualizarRodape();
  }
  function toggleTodos(cb) {
    document.querySelectorAll('.check-conta').forEach(c => {
      c.checked = cb.checked;
      const id = parseInt(c.value);
      if (cb.checked) contasSelecionadas.add(id); else contasSelecionadas.delete(id);
    });
    atualizarRodape();
  }
  function atualizarRodape() {
    const rod = document.getElementById('rodape-selecao');
    const lbl = document.getElementById('label-selecionados');
    const n = contasSelecionadas.size;
    rod.style.display = n ? 'flex' : 'none';
    lbl.textContent = `${n} selecionada${n>1?'s':''} — calculando...`;
  }

  function adicionarAoLote() {
    if (!contasSelecionadas.size) return;
    trocarAba('lote-c6');
    // ids já prontos para montar lote
    showToast('✅ Contas adicionadas. Monte o lote abaixo.');
  }

  // ─── AÇÕES TABELA ──────────────────────────────────────────────────────
  async function pagarManual(id) {
    if (!confirm('Marcar esta conta como paga manualmente?')) return;
    const r = await api('PATCH', `/contas-pagar/${id}/pagar`);
    if (r) { showToast('✅ Conta marcada como paga'); carregarContas(); carregarKPIs(); }
  }
  async function cancelarConta(id) {
    if (!confirm('Cancelar esta conta? Esta ação não pode ser desfeita.')) return;
    const r = await api('DELETE', `/contas-pagar/${id}`);
    if (r) { showToast('✅ Conta cancelada'); carregarContas(); carregarKPIs(); }
  }

  // ─── DDA / RECONCILIAR ─────────────────────────────────────────────────
  async function sincronizarDDA() {
    showToast('🔄 Sincronizando DDA...');
    const r = await api('GET', '/contas-pagar/dda/sync');
    if (r) { showToast(`✅ DDA: ${r.importados} boletos importados`); carregarContas(); carregarKPIs(); }
  }
  async function reconciliar() {
    showToast('⚡ Reconciliando com extrato C6...');
    const r = await api('POST', '/contas-pagar/reconciliar');
    if (r) { showToast(`✅ ${r.atualizadas} contas marcadas como pagas`); carregarContas(); carregarKPIs(); }
  }

  // ─── MODAL NOVA CONTA ──────────────────────────────────────────────────
  function abrirModalNova() { document.getElementById('modal-nova').classList.add('open'); }
  function fecharModal() { document.getElementById('modal-nova').classList.remove('open'); }
  function toggleRecorrente() {
    const on = document.getElementById('f-recorrente').checked;
    document.getElementById('grupo-recorrente').style.display = on ? 'block' : 'none';
  }
  document.getElementById('f-tipo').addEventListener('change', function() {
    document.getElementById('grupo-linha-digitavel').style.display = this.value === 'boleto' ? 'block' : 'none';
    document.getElementById('grupo-pix').style.display = this.value === 'pix' ? 'block' : 'none';
  });

  async function salvarConta() {
    const recorrente = document.getElementById('f-recorrente').checked;
    const body = {
      descricao: document.getElementById('f-descricao').value.trim(),
      fornecedor: document.getElementById('f-fornecedor').value.trim() || null,
      tipo_despesa: document.getElementById('f-tipo-despesa').value,
      valor: parseFloat(document.getElementById('f-valor').value),
      vencimento: document.getElementById('f-vencimento').value,
      tipo: document.getElementById('f-tipo').value,
      linha_digitavel: document.getElementById('f-linha-digitavel').value.replace(/\D/g,'') || null,
      pix_content: document.getElementById('f-pix-content').value.trim() || null,
      recorrente,
      recorrencia_dia: recorrente ? parseInt(document.getElementById('f-recorrencia-dia').value) : null,
      recorrencia_valor_fixo: recorrente ? document.getElementById('f-recorrencia-valor-fixo').value !== 'false' : true,
      observacao: document.getElementById('f-observacao').value.trim() || null,
    };
    const endpoint = recorrente ? '/contas-pagar/recorrente' : '/contas-pagar';
    const r = await api('POST', endpoint, body);
    if (r) {
      const msg = recorrente ? `✅ ${r.criadas?.length || 0} contas recorrentes criadas` : '✅ Conta criada';
      showToast(msg); fecharModal(); carregarContas(); carregarKPIs();
    }
  }

  // ─── LOTE C6 ───────────────────────────────────────────────────────────
  async function carregarLote() {
    const contas = await api('GET', '/contas-pagar?status=pendente');
    if (!contas) return;
    loteItens = contas.filter(c => c.linha_digitavel || c.pix_content);
    renderTabelaLote(loteItens);
  }

  function renderTabelaLote(contas) {
    const tbody = document.getElementById('tabela-lote');
    if (!contas.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;padding:32px">Nenhuma conta com linha digitável ou chave PIX pendente</td></tr>'; return; }
    tbody.innerHTML = contas.map(c => `
      <tr>
        <td><input type="checkbox" class="check-lote" value="${c.id}" data-valor="${c.valor}" data-descricao="${c.descricao}" onchange="atualizarCarrinho()"></td>
        <td>${badgeVencimento(c.vencimento)}</td>
        <td>${c.descricao}</td>
        <td style="font-weight:600">${fmt(c.valor)}</td>
        <td>${c.tipo.toUpperCase()}</td>
        <td>${c.c6_status ? `<span class="badge badge-azul" style="font-size:10px">${c.c6_status}</span>` : '—'}</td>
      </tr>`).join('');
  }

  function filtrarLote() {
    const q = document.getElementById('lote-busca').value.toLowerCase();
    renderTabelaLote(loteItens.filter(c => c.descricao.toLowerCase().includes(q)));
  }
  function toggleTodosLote(cb) { document.querySelectorAll('.check-lote').forEach(c => { c.checked = cb.checked; }); atualizarCarrinho(); }

  function atualizarCarrinho() {
    const checks = [...document.querySelectorAll('.check-lote:checked')];
    const itensDiv = document.getElementById('carrinho-itens');
    const totalDiv = document.getElementById('carrinho-total');
    const btnMontar = document.getElementById('btn-montar-lote');
    if (!checks.length) {
      itensDiv.innerHTML = '<p style="color:#888;font-size:13px;">Nenhuma conta selecionada</p>';
      totalDiv.style.display = 'none'; btnMontar.disabled = true; return;
    }
    let total = 0;
    itensDiv.innerHTML = checks.map(c => {
      total += parseFloat(c.dataset.valor);
      return `<div class="carrinho-item"><span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.dataset.descricao}</span><span style="font-weight:600">${fmt(c.dataset.valor)}</span></div>`;
    }).join('');
    document.getElementById('total-lote').textContent = fmt(total);
    totalDiv.style.display = 'flex'; btnMontar.disabled = false;
  }

  async function montarLote() {
    const ids = [...document.querySelectorAll('.check-lote:checked')].map(c => parseInt(c.value));
    const uploaderName = document.getElementById('uploader-name').value.trim();
    if (!uploaderName) { showToast('❌ Informe seu nome como responsável'); return; }
    if (!ids.length) { showToast('❌ Selecione ao menos uma conta'); return; }
    if (!confirm(`Montar lote com ${ids.length} conta(s) e enviar para validação no C6?`)) return;
    showToast('⏳ Validando no C6 Bank...');
    const r = await api('POST', '/contas-pagar/lote', { ids, uploaderName });
    if (!r) return;
    currentGroupId = r.groupId;
    document.getElementById('lote-group-id').textContent = r.groupId;
    document.getElementById('lote-status').style.display = 'block';
    document.getElementById('btn-submeter-lote').style.display = 'block';
    setStep(3);
    showToast(`✅ Lote criado: ${r.quantidade} item(s). Revise e submeta.`);
    await carregarHistoricoLotes();
  }

  async function submeterLote() {
    if (!currentGroupId) { showToast('❌ Nenhum lote ativo'); return; }
    const uploaderName = document.getElementById('uploader-name').value.trim();
    if (!confirm('Enviar este lote para aprovação no C6 Bank? O pagamento só será realizado após aprovação manual no web banking.')) return;
    const r = await api('POST', `/contas-pagar/lote/${currentGroupId}/submeter`, { uploaderName });
    if (r) { showToast('✅ Lote enviado para aprovação no C6 Bank'); setStep(4); await carregarHistoricoLotes(); }
  }

  function setStep(n) {
    for (let i = 1; i <= 4; i++) {
      const s = document.getElementById(`step-${i}`);
      s.classList.toggle('done', i < n);
      s.classList.toggle('active', i === n);
    }
  }

  async function carregarHistoricoLotes() {
    // Busca contas agendadas para obter group_ids únicos
    const contas = await api('GET', '/contas-pagar?status=agendado');
    if (!contas) return;
    const grupos = [...new Set(contas.map(c => c.c6_group_id).filter(Boolean))];
    const tbody = document.getElementById('tabela-historico-lotes');
    if (!grupos.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888;padding:24px">Nenhum lote ainda</td></tr>'; return; }
    tbody.innerHTML = grupos.map(g => {
      const itens = contas.filter(c => c.c6_group_id === g);
      const total = itens.reduce((s, c) => s + parseFloat(c.valor), 0);
      return `<tr>
        <td style="font-family:monospace;font-size:11px">${g.substring(0,20)}...</td>
        <td>—</td>
        <td>${itens.length}</td>
        <td>${fmt(total)}</td>
        <td><span class="badge badge-azul">submetido</span></td>
        <td>—</td>
      </tr>`;
    }).join('');
  }

  // ─── INIT ──────────────────────────────────────────────────────────────
  if (!getToken()) window.location.href = '/pwa/login.html';
  carregarKPIs();
  carregarContas();
</script>
</body>
</html>
```

- [ ] **Step 2: Verificar que o arquivo está bem formado**

```bash
grep -c "</html>" public/pwa/financeiro.html
```

Esperado: `1`

- [ ] **Step 3: Commit**

```bash
git add public/pwa/financeiro.html
git commit -m "feat: M9-A PWA financeiro.html — visão geral e lote C6"
```

---

## Task 7: Deploy VPS

**Files:** Todos os arquivos modificados acima.

- [ ] **Step 1: Verificar se node-cron está no package.json**

```bash
grep "node-cron" package.json || npm install node-cron && npm install
```

- [ ] **Step 2: Commitar package.json se alterado**

```bash
git add package.json package-lock.json 2>/dev/null; git diff --cached --quiet || git commit -m "chore: adicionar node-cron"
```

- [ ] **Step 3: Sincronizar código com VPS**

```bash
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='.env' \
  /Users/klebercamara/LKL/ root@2.25.147.243:/var/www/lkl-chatbot/
```

- [ ] **Step 4: Aplicar migration no banco do VPS**

```bash
ssh root@2.25.147.243 'cd /var/www/lkl-chatbot && node -e "
const { Pool } = require(\"pg\");
const fs = require(\"fs\");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(fs.readFileSync(\"sql/migrations/012_contas_pagar.sql\",\"utf8\"))
  .then(() => { console.log(\"OK\"); pool.end(); })
  .catch(e => { console.error(e.message); pool.end(); });
" --env-file .env'
```

Esperado: `OK`

- [ ] **Step 5: Instalar dependências e configurar OWNER_WHATSAPP**

```bash
ssh root@2.25.147.243 'cd /var/www/lkl-chatbot && npm install'

# Verificar se OWNER_WHATSAPP está no .env
ssh root@2.25.147.243 'grep OWNER_WHATSAPP /var/www/lkl-chatbot/.env || echo "OWNER_WHATSAPP=5521XXXXXXXXX" >> /var/www/lkl-chatbot/.env'
```

Editar o número correto:
```bash
ssh root@2.25.147.243 'nano /var/www/lkl-chatbot/.env'
# Trocar OWNER_WHATSAPP=5521XXXXXXXXX pelo número real do dono
```

- [ ] **Step 6: Reiniciar PM2 com update-env**

```bash
ssh root@2.25.147.243 'pm2 restart lkl-chatbot --update-env && sleep 3 && pm2 status lkl-chatbot'
```

Esperado: status `online`.

- [ ] **Step 7: Verificar logs de inicialização**

```bash
ssh root@2.25.147.243 'pm2 logs lkl-chatbot --lines 20 --nostream | grep -E "CRON|Cron|contas"'
```

Esperado: `[CRON-CONTAS-PAGAR] ... Cron jobs de contas a pagar inicializados`

- [ ] **Step 8: Testar endpoints no VPS**

```bash
# Obter token (ajustar credenciais)
TOKEN=$(curl -s -X POST https://chatbot.klebercamaraconsultoria.cloud/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@lkl.com","password":"SUA_SENHA"}' | jq -r .token)

# KPIs
curl -s https://chatbot.klebercamaraconsultoria.cloud/api/v2/contas-pagar/kpis \
  -H "Authorization: Bearer $TOKEN" | jq .

# Criar conta de teste
curl -s -X POST https://chatbot.klebercamaraconsultoria.cloud/api/v2/contas-pagar \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"descricao":"Teste Conta Luz","tipo_despesa":"LUZ","valor":250.00,"vencimento":"2026-07-15","tipo":"boleto"}' | jq .
```

Esperado: KPIs com valores zerados (banco novo), conta criada com `id` e `status: "pendente"`.

- [ ] **Step 9: Acessar a PWA no browser**

Abrir: `https://chatbot.klebercamaraconsultoria.cloud/pwa/financeiro.html`

Verificar: página carrega, KPI cards aparecem, tabela vazia ou com contas de teste.

- [ ] **Step 10: Commit final**

```bash
git add -A
git commit -m "feat: M9-A deploy — migration, cron jobs e PWA financeiro no VPS"
```

---

## Self-Review

**Cobertura da spec:**
- ✅ Migration com ENUM + contas_pagar + payment_batches (Task 1)
- ✅ 6 funções C6: consultarDDA, criarLote, consultarLote, removerItemLote, submeterLote, consultarExtrato (Task 2)
- ✅ 12 rotas incluindo KPIs, DDA sync, lote C6, reconciliar, recorrentes (Tasks 3+4)
- ✅ 6 cron jobs: sync_dda, reconciliar_extrato, check_overdue, alert_vencendo, check_batch_status, generate_recurrent (Task 5)
- ✅ PWA com Aba 1 (KPIs, filtros, tabela, modal nova conta, recorrente toggle) e Aba 2 (lote C6 com step indicator, carrinho, histórico) (Task 6)
- ✅ Deploy com migration no VPS + OWNER_WHATSAPP (Task 7)

**Placeholder scan:** nenhum TBD, TODO ou "similar ao task N" encontrado.

**Consistência de tipos:**
- `service.js` exporta: `listar, buscarPorId, kpis, criar, editar, cancelar, pagarManual, criarRecorrente, sincronizarDDA, criarLoteC6, consultarLoteC6, removerItemLoteC6, submeterLoteC6, reconciliar, marcarVencidas, contasVencendoEm, atualizarStatusLotesSubmetidos, gerarRecorrentesProximoMes`
- `router.js` consome os mesmos nomes ✅
- `jobs/contas-pagar.js` chama `service.sincronizarDDA()`, `service.reconciliar()`, `service.marcarVencidas()`, `service.contasVencendoEm(2)`, `service.atualizarStatusLotesSubmetidos()`, `service.gerarRecorrentesProximoMes()` — todos exportados ✅
- `c6bank.js` exporta: `consultarDDA, criarLote, consultarLote, removerItemLote, submeterLote, consultarExtrato` — todos usados no service com os mesmos nomes ✅
