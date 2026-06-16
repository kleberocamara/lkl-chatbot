# Sprint 2 — Orçamentos + Ordens de Serviço

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar o fluxo completo de orçamento → aprovação → geração automática de OSs, com PDF no padrão LKL, PWA para vendedor e admin, e notificações WhatsApp.

**Architecture:**
- Orçamento (documento comercial externo) com N itens → aprovado pelo cliente → sistema gera 1 OS por item automaticamente
- OS é documento interno de produção; cada uma segue sua própria esteira de status
- Status do Serviço (OS) = CONCLUÍDO apenas quando todas as OSs do orçamento chegarem em `entregue`
- PDF gerado server-side com pdfkit, servido como download ou enviado por WhatsApp

**Tech Stack:** Node.js 20 + Express 4 + PostgreSQL 15 + CommonJS + pdfkit + whatsapp.js + fcm.js

---

## Modelo de Dados

```
orcamentos (1)
  └── orcamento_itens (N)
        └── ordens_servico (1 por item, geradas na aprovação)
```

**Status Orçamento:** `rascunho → enviado → aprovado → cancelado`
**Status OS:** `aguardando → arte_final → impressao → acabamento → embalagem → pronto → entregue`

---

## Arquivos

| Arquivo | Ação |
|---------|------|
| `sql/migrations/003_sprint2_orcamentos.sql` | Create |
| `src/modules/orcamentos/service.js` | Create |
| `src/modules/orcamentos/router.js` | Create |
| `src/modules/os/service.js` | Create |
| `src/modules/os/router.js` | Create |
| `src/modules/index.js` | Modify — adicionar rotas |
| `src/services/pdf.js` | Create — gerador PDF pdfkit |
| `public/pwa/orcamentos.html` | Create |
| `public/pwa/admin.html` | Create |
| `public/pwa/app.js` | Modify — funções compartilhadas |
| `tests/modules/orcamentos.test.js` | Create |
| `tests/modules/os.test.js` | Create |

---

## Task 1: Migration — orcamentos + orcamento_itens + ordens_servico

**Files:**
- Create: `sql/migrations/003_sprint2_orcamentos.sql`

- [ ] **Step 1: Escrever a migration**

```sql
BEGIN;

-- Sequência para número do orçamento (ORC-XXXXX)
CREATE SEQUENCE IF NOT EXISTS orcamento_numero_seq START 1;

CREATE TABLE IF NOT EXISTS orcamentos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero        INTEGER NOT NULL DEFAULT nextval('orcamento_numero_seq') UNIQUE,
  cliente_id    UUID REFERENCES clientes_lkl(id),
  vendedor_id   UUID REFERENCES users(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'rascunho'
                CHECK (status IN ('rascunho','enviado','aprovado','cancelado')),
  condicao_pagamento TEXT,
  validade_dias  INTEGER DEFAULT 35,
  prazo_entrega  TEXT,
  observacao     TEXT,
  aprovado_em    TIMESTAMPTZ,
  aprovado_via   VARCHAR(30), -- 'whatsapp', 'email', 'sistema'
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Sequência para número do item dentro do orçamento (código como 1061, 1062...)
CREATE SEQUENCE IF NOT EXISTS orcamento_item_codigo_seq START 1000;

CREATE TABLE IF NOT EXISTS orcamento_itens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  orcamento_id    UUID NOT NULL REFERENCES orcamentos(id) ON DELETE CASCADE,
  codigo          INTEGER NOT NULL DEFAULT nextval('orcamento_item_codigo_seq'),
  descricao       TEXT NOT NULL,
  -- Especificação técnica
  tipo_insumo     VARCHAR(50),  -- papel, envelope, lona, adesivo...
  formato_papel   VARCHAR(50),  -- ex: 66x96
  gramatura       VARCHAR(20),
  cores           VARCHAR(20),  -- CMYK, 4/4, 4/0, 1/0...
  impressao       VARCHAR(30),  -- 'frente', 'frente_verso'
  acabamentos     TEXT[],       -- ['corte','vinco','laminacao_brilho',...]
  quantidade      INTEGER NOT NULL,
  -- Preços (preenchidos pelo dono)
  valor_unitario  NUMERIC(12,2),
  valor_total     NUMERIC(12,2),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Sequência para número da OS (OS-XXXXX)
CREATE SEQUENCE IF NOT EXISTS os_numero_seq START 1;

CREATE TABLE IF NOT EXISTS ordens_servico (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_os         INTEGER NOT NULL DEFAULT nextval('os_numero_seq') UNIQUE,
  orcamento_id      UUID NOT NULL REFERENCES orcamentos(id),
  orcamento_item_id UUID NOT NULL REFERENCES orcamento_itens(id),
  status            VARCHAR(30) NOT NULL DEFAULT 'aguardando'
                    CHECK (status IN (
                      'aguardando','arte_final','impressao',
                      'acabamento','embalagem','pronto','entregue','cancelado'
                    )),
  responsavel_id    UUID REFERENCES users(id),
  observacao_interna TEXT,
  data_inicio       TIMESTAMPTZ,
  data_conclusao    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orcamentos_cliente     ON orcamentos(cliente_id);
CREATE INDEX IF NOT EXISTS idx_orcamentos_vendedor    ON orcamentos(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_orcamentos_status      ON orcamentos(status);
CREATE INDEX IF NOT EXISTS idx_orcamento_itens_orc    ON orcamento_itens(orcamento_id);
CREATE INDEX IF NOT EXISTS idx_os_orcamento           ON ordens_servico(orcamento_id);
CREATE INDEX IF NOT EXISTS idx_os_status              ON ordens_servico(status);

COMMIT;
```

- [ ] **Step 2: Aplicar no banco de desenvolvimento (local ou VPS)**

```bash
# Local (se tiver banco local):
psql -U postgres -d lkl_chatbot -f sql/migrations/003_sprint2_orcamentos.sql

# VPS:
scp sql/migrations/003_sprint2_orcamentos.sql root@2.25.147.243:/tmp/
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -f /tmp/003_sprint2_orcamentos.sql"
```

Saída esperada: `CREATE SEQUENCE`, `CREATE TABLE` (x3), `CREATE INDEX` (x6), `COMMIT`

- [ ] **Step 3: Commit**

```bash
git add sql/migrations/003_sprint2_orcamentos.sql
git commit -m "feat: migration sprint2 — orcamentos, orcamento_itens, ordens_servico"
```

---

## Task 2: Instalar pdfkit

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Instalar**

```bash
npm install pdfkit
```

- [ ] **Step 2: Verificar instalação**

```bash
node -e "const PDFDocument = require('pdfkit'); console.log('pdfkit OK', PDFDocument.version || 'loaded')"
```

Saída esperada: `pdfkit OK loaded` (sem erro)

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add pdfkit for PDF generation"
```

---

## Task 3: Service de Orçamentos

**Files:**
- Create: `src/modules/orcamentos/service.js`
- Create: `tests/modules/orcamentos.test.js`

- [ ] **Step 1: Escrever os testes (TDD)**

Criar `tests/modules/orcamentos.test.js`:

```js
const request = require('supertest');
const { app } = require('../../src/app');
const db = require('../../src/db');
const jwt = require('jsonwebtoken');

function token(role = 'vendedor', id = '00000000-0000-0000-0000-000000000001') {
  return 'Bearer ' + jwt.sign({ id, name: 'Test', email: 't@t.com', role }, process.env.JWT_SECRET);
}
const adminToken = () => token('admin', '00000000-0000-0000-0000-000000000002');

afterAll(() => db.pool.end());

describe('POST /api/orcamentos', () => {
  it('cria orçamento rascunho com itens', async () => {
    const res = await request(app)
      .post('/api/orcamentos')
      .set('Authorization', token())
      .send({
        condicao_pagamento: 'MEDIANTE APROVAÇÃO',
        validade_dias: 35,
        itens: [
          { descricao: 'FOLDER A5', tipo_insumo: 'papel', quantidade: 500, cores: '4/4' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.orcamento.status).toBe('rascunho');
    expect(res.body.itens).toHaveLength(1);
  });

  it('rejeita sem itens', async () => {
    const res = await request(app)
      .post('/api/orcamentos')
      .set('Authorization', token())
      .send({ condicao_pagamento: 'teste', itens: [] });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/orcamentos/:id/precificar', () => {
  it('permite admin preencher preços', async () => {
    // Criar orçamento primeiro
    const cr = await request(app)
      .post('/api/orcamentos')
      .set('Authorization', token())
      .send({ itens: [{ descricao: 'CARTÃO', quantidade: 1000 }] });
    const itemId = cr.body.itens[0].id;

    const res = await request(app)
      .patch(`/api/orcamentos/${cr.body.orcamento.id}/precificar`)
      .set('Authorization', adminToken())
      .send({ itens: [{ id: itemId, valor_unitario: 0.50, valor_total: 500.00 }] });
    expect(res.status).toBe(200);
  });

  it('bloqueia vendedor de precificar', async () => {
    const cr = await request(app)
      .post('/api/orcamentos')
      .set('Authorization', token())
      .send({ itens: [{ descricao: 'X', quantidade: 100 }] });
    const res = await request(app)
      .patch(`/api/orcamentos/${cr.body.orcamento.id}/precificar`)
      .set('Authorization', token())
      .send({ itens: [] });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/orcamentos/:id/enviar', () => {
  it('muda status para enviado (só admin)', async () => {
    const cr = await request(app)
      .post('/api/orcamentos')
      .set('Authorization', token())
      .send({ itens: [{ descricao: 'X', quantidade: 100 }] });
    const res = await request(app)
      .patch(`/api/orcamentos/${cr.body.orcamento.id}/enviar`)
      .set('Authorization', adminToken());
    expect(res.status).toBe(200);
    expect(res.body.orcamento.status).toBe('enviado');
  });
});

describe('PATCH /api/orcamentos/:id/aprovar', () => {
  it('aprova e gera OSs automaticamente', async () => {
    const cr = await request(app)
      .post('/api/orcamentos')
      .set('Authorization', token())
      .send({ itens: [{ descricao: 'A', quantidade: 100 }, { descricao: 'B', quantidade: 200 }] });
    // Enviar primeiro
    await request(app)
      .patch(`/api/orcamentos/${cr.body.orcamento.id}/enviar`)
      .set('Authorization', adminToken());
    // Aprovar
    const res = await request(app)
      .patch(`/api/orcamentos/${cr.body.orcamento.id}/aprovar`)
      .set('Authorization', adminToken())
      .send({ aprovado_via: 'whatsapp' });
    expect(res.status).toBe(200);
    expect(res.body.ordens_servico).toHaveLength(2);
    expect(res.body.ordens_servico[0].status).toBe('aguardando');
  });
});
```

- [ ] **Step 2: Rodar testes — devem FALHAR**

```bash
npm test -- --testPathPattern=orcamentos
```

Saída esperada: FAIL (rota não existe)

- [ ] **Step 3: Implementar `src/modules/orcamentos/service.js`**

```js
const db = require('../../db');

const STATUS_VALIDOS = ['rascunho', 'enviado', 'aprovado', 'cancelado'];

async function criar({ cliente_id, vendedor_id, condicao_pagamento, validade_dias, prazo_entrega, observacao, itens }) {
  if (!itens || itens.length === 0) return { erro: ['itens é obrigatório e deve ter ao menos 1 item'] };

  const r = await db.query(
    `INSERT INTO orcamentos (cliente_id, vendedor_id, condicao_pagamento, validade_dias, prazo_entrega, observacao)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [cliente_id || null, vendedor_id, condicao_pagamento || null,
     validade_dias || 35, prazo_entrega || null, observacao || null]
  );
  const orcamento = r.rows[0];

  const itensInseridos = [];
  for (const item of itens) {
    const ir = await db.query(
      `INSERT INTO orcamento_itens
       (orcamento_id, descricao, tipo_insumo, formato_papel, gramatura, cores, impressao, acabamentos, quantidade)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [orcamento.id, item.descricao, item.tipo_insumo || null, item.formato_papel || null,
       item.gramatura || null, item.cores || null, item.impressao || null,
       item.acabamentos || null, item.quantidade]
    );
    itensInseridos.push(ir.rows[0]);
  }

  return { orcamento, itens: itensInseridos };
}

async function precificar(id, itensPrecos) {
  for (const item of itensPrecos) {
    await db.query(
      'UPDATE orcamento_itens SET valor_unitario=$1, valor_total=$2 WHERE id=$3 AND orcamento_id=$4',
      [item.valor_unitario, item.valor_total, item.id, id]
    );
  }
  return buscarPorId(id);
}

async function mudarStatus(id, novoStatus, extra = {}) {
  if (!STATUS_VALIDOS.includes(novoStatus)) return { erro: [`Status inválido: ${novoStatus}`] };
  const campos = ['status=$1', 'updated_at=NOW()'];
  const params = [novoStatus];
  if (extra.aprovado_via) { params.push(extra.aprovado_via); campos.push(`aprovado_via=$${params.length}`); }
  if (novoStatus === 'aprovado') campos.push('aprovado_em=NOW()');
  params.push(id);
  const r = await db.query(
    `UPDATE orcamentos SET ${campos.join(',')} WHERE id=$${params.length} RETURNING *`,
    params
  );
  if (!r.rows[0]) return { erro: ['Orçamento não encontrado'] };
  return { orcamento: r.rows[0] };
}

async function aprovar(id, aprovado_via) {
  const orc = await db.query('SELECT * FROM orcamentos WHERE id=$1', [id]);
  if (!orc.rows[0]) return { erro: ['Orçamento não encontrado'] };
  if (orc.rows[0].status !== 'enviado') return { erro: ['Orçamento precisa estar no status "enviado" para aprovar'] };

  await mudarStatus(id, 'aprovado', { aprovado_via });

  // Gerar 1 OS por item
  const itens = await db.query('SELECT * FROM orcamento_itens WHERE orcamento_id=$1', [id]);
  const oss = [];
  for (const item of itens.rows) {
    const r = await db.query(
      `INSERT INTO ordens_servico (orcamento_id, orcamento_item_id)
       VALUES ($1,$2) RETURNING *`,
      [id, item.id]
    );
    oss.push(r.rows[0]);
  }

  if (global.io) global.io.emit('orcamento_aprovado', { orcamento_id: id, os_count: oss.length });
  return { orcamento: orc.rows[0], ordens_servico: oss };
}

async function buscarPorId(id) {
  const [orc, itens, oss] = await Promise.all([
    db.query(
      `SELECT o.*, c.nome as cliente_nome, c.celular as cliente_celular,
              u.name as vendedor_nome
       FROM orcamentos o
       LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
       LEFT JOIN users u ON u.id = o.vendedor_id
       WHERE o.id = $1`,
      [id]
    ),
    db.query('SELECT * FROM orcamento_itens WHERE orcamento_id=$1 ORDER BY codigo', [id]),
    db.query('SELECT * FROM ordens_servico WHERE orcamento_id=$1 ORDER BY created_at', [id]),
  ]);
  if (!orc.rows[0]) return null;
  return { ...orc.rows[0], itens: itens.rows, ordens_servico: oss.rows };
}

async function listar({ page = 1, limit = 20, status, vendedor_id, cliente_id } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';
  if (status)      { params.push(status);      where += ` AND o.status=$${params.length}`; }
  if (vendedor_id) { params.push(vendedor_id); where += ` AND o.vendedor_id=$${params.length}`; }
  if (cliente_id)  { params.push(cliente_id);  where += ` AND o.cliente_id=$${params.length}`; }
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT o.*, c.nome as cliente_nome, u.name as vendedor_nome
       FROM orcamentos o
       LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
       LEFT JOIN users u ON u.id = o.vendedor_id
       ${where} ORDER BY o.created_at DESC
       LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) FROM orcamentos o ${where}`, params),
  ]);
  return { data: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

module.exports = { criar, precificar, mudarStatus, aprovar, buscarPorId, listar };
```

- [ ] **Step 4: Implementar `src/modules/orcamentos/router.js`**

```js
const express = require('express');
const router = express.Router();
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const soAdmin = requireRole('admin');

// Vendedor ou admin cria orçamento
router.post('/', async (req, res) => {
  const result = await service.criar({ ...req.body, vendedor_id: req.user.id });
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.status(201).json(result);
});

// Listar (admin vê todos, vendedor vê os seus)
router.get('/', async (req, res) => {
  const filtros = { ...req.query };
  if (req.user.role === 'vendedor') filtros.vendedor_id = req.user.id;
  const result = await service.listar(filtros);
  res.json(result);
});

// Detalhar
router.get('/:id', async (req, res) => {
  const orc = await service.buscarPorId(req.params.id);
  if (!orc) return res.status(404).json({ error: 'Orçamento não encontrado' });
  res.json(orc);
});

// Admin precifica itens
router.patch('/:id/precificar', soAdmin, async (req, res) => {
  const result = await service.precificar(req.params.id, req.body.itens || []);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.json(result);
});

// Admin envia ao cliente
router.patch('/:id/enviar', soAdmin, async (req, res) => {
  const result = await service.mudarStatus(req.params.id, 'enviado');
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.json(result);
});

// Admin registra aprovação do cliente → gera OSs
router.patch('/:id/aprovar', soAdmin, async (req, res) => {
  const result = await service.aprovar(req.params.id, req.body.aprovado_via || 'sistema');
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.json(result);
});

// Admin cancela
router.patch('/:id/cancelar', soAdmin, async (req, res) => {
  const result = await service.mudarStatus(req.params.id, 'cancelado');
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.json(result);
});

module.exports = router;
```

- [ ] **Step 5: Registrar rota em `src/modules/index.js`**

Adicionar após a linha do `orders`:

```js
router.use('/orcamentos', requireAuthApi, require('./orcamentos/router'));
```

- [ ] **Step 6: Rodar testes — devem PASSAR**

```bash
npm test -- --testPathPattern=orcamentos
```

Saída esperada: PASS — 6 testes

- [ ] **Step 7: Commit**

```bash
git add src/modules/orcamentos/ src/modules/index.js tests/modules/orcamentos.test.js
git commit -m "feat: API de orçamentos — CRUD, precificação e aprovação com geração de OSs"
```

---

## Task 4: Service de Ordens de Serviço (OS)

**Files:**
- Create: `src/modules/os/service.js`
- Create: `src/modules/os/router.js`
- Create: `tests/modules/os.test.js`

- [ ] **Step 1: Escrever testes**

Criar `tests/modules/os.test.js`:

```js
const request = require('supertest');
const { app } = require('../../src/app');
const db = require('../../src/db');
const jwt = require('jsonwebtoken');

function token(role = 'admin') {
  return 'Bearer ' + jwt.sign({ id: '00000000-0000-0000-0000-000000000002', name: 'Admin', email: 'a@a.com', role }, process.env.JWT_SECRET);
}
function vendedorToken() {
  return 'Bearer ' + jwt.sign({ id: '00000000-0000-0000-0000-000000000001', name: 'V', email: 'v@v.com', role: 'vendedor' }, process.env.JWT_SECRET);
}

afterAll(() => db.pool.end());

async function criarOrcamentoAprovado() {
  const cr = await request(app)
    .post('/api/orcamentos')
    .set('Authorization', token())
    .send({ itens: [{ descricao: 'FOLDER', quantidade: 100 }] });
  await request(app).patch(`/api/orcamentos/${cr.body.orcamento.id}/enviar`).set('Authorization', token());
  const apr = await request(app)
    .patch(`/api/orcamentos/${cr.body.orcamento.id}/aprovar`)
    .set('Authorization', token())
    .send({ aprovado_via: 'email' });
  return apr.body.ordens_servico[0];
}

describe('GET /api/os', () => {
  it('lista OSs', async () => {
    await criarOrcamentoAprovado();
    const res = await request(app).get('/api/os').set('Authorization', token());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('PATCH /api/os/:id/status', () => {
  it('atualiza status da OS', async () => {
    const os = await criarOrcamentoAprovado();
    const res = await request(app)
      .patch(`/api/os/${os.id}/status`)
      .set('Authorization', token())
      .send({ status: 'impressao' });
    expect(res.status).toBe(200);
    expect(res.body.os.status).toBe('impressao');
  });

  it('rejeita status inválido', async () => {
    const os = await criarOrcamentoAprovado();
    const res = await request(app)
      .patch(`/api/os/${os.id}/status`)
      .set('Authorization', token())
      .send({ status: 'voando' });
    expect(res.status).toBe(400);
  });

  it('bloqueia vendedor de alterar status', async () => {
    const os = await criarOrcamentoAprovado();
    const res = await request(app)
      .patch(`/api/os/${os.id}/status`)
      .set('Authorization', vendedorToken())
      .send({ status: 'impressao' });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Rodar — deve FALHAR**

```bash
npm test -- --testPathPattern=os.test
```

- [ ] **Step 3: Implementar `src/modules/os/service.js`**

```js
const db = require('../../db');
const fcm = require('../../services/fcm');

const STATUS_VALIDOS = ['aguardando','arte_final','impressao','acabamento','embalagem','pronto','entregue','cancelado'];

async function listar({ page = 1, limit = 20, status, orcamento_id } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';
  if (status)       { params.push(status);       where += ` AND os.status=$${params.length}`; }
  if (orcamento_id) { params.push(orcamento_id); where += ` AND os.orcamento_id=$${params.length}`; }
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT os.*, oi.descricao as item_descricao, oi.quantidade,
              o.numero as numero_orcamento,
              c.nome as cliente_nome,
              u.name as responsavel_nome
       FROM ordens_servico os
       JOIN orcamento_itens oi ON oi.id = os.orcamento_item_id
       JOIN orcamentos o ON o.id = os.orcamento_id
       LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
       LEFT JOIN users u ON u.id = os.responsavel_id
       ${where} ORDER BY os.created_at DESC
       LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) FROM ordens_servico os ${where}`, params),
  ]);
  return { data: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

async function buscarPorId(id) {
  const r = await db.query(
    `SELECT os.*, oi.descricao as item_descricao, oi.quantidade, oi.cores, oi.impressao,
            oi.acabamentos, oi.tipo_insumo, oi.formato_papel, oi.gramatura,
            o.numero as numero_orcamento, o.cliente_id,
            c.nome as cliente_nome,
            u.name as responsavel_nome
     FROM ordens_servico os
     JOIN orcamento_itens oi ON oi.id = os.orcamento_item_id
     JOIN orcamentos o ON o.id = os.orcamento_id
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     LEFT JOIN users u ON u.id = os.responsavel_id
     WHERE os.id=$1`,
    [id]
  );
  return r.rows[0] || null;
}

async function atualizarStatus(id, novoStatus, responsavel_id) {
  if (!STATUS_VALIDOS.includes(novoStatus))
    return { erro: [`Status inválido. Válidos: ${STATUS_VALIDOS.join(', ')}`] };

  const campos = ['status=$1', 'updated_at=NOW()'];
  const params = [novoStatus];
  if (novoStatus === 'impressao' || novoStatus === 'arte_final') {
    campos.push('data_inicio=COALESCE(data_inicio,NOW())');
  }
  if (novoStatus === 'entregue') campos.push('data_conclusao=NOW()');
  if (responsavel_id) { params.push(responsavel_id); campos.push(`responsavel_id=$${params.length}`); }
  params.push(id);

  const r = await db.query(
    `UPDATE ordens_servico SET ${campos.join(',')} WHERE id=$${params.length} RETURNING *`,
    params
  );
  if (!r.rows[0]) return { erro: ['OS não encontrada'] };
  const os = r.rows[0];

  if (global.io) global.io.emit('os_status_update', { os_id: id, status: novoStatus });

  // Verificar se todas as OSs do orçamento estão entregues
  if (novoStatus === 'entregue') {
    const pendentes = await db.query(
      `SELECT COUNT(*) FROM ordens_servico
       WHERE orcamento_id=$1 AND status != 'entregue' AND status != 'cancelado'`,
      [os.orcamento_id]
    );
    if (parseInt(pendentes.rows[0].count) === 0) {
      if (global.io) global.io.emit('servico_concluido', { orcamento_id: os.orcamento_id });
    }
  }

  // FCM ao vendedor do orçamento
  const orc = await db.query(
    'SELECT vendedor_id, numero FROM orcamentos WHERE id=$1',
    [os.orcamento_id]
  );
  if (orc.rows[0]?.vendedor_id) {
    const labels = {
      impressao: 'Em impressão 🖨️', acabamento: 'Em acabamento ✂️',
      embalagem: 'Em embalagem 📦', pronto: 'Pronto ✅', entregue: 'Entregue 🎉',
    };
    const label = labels[novoStatus];
    if (label) {
      fcm.sendToUser(orc.rows[0].vendedor_id, {
        title: `ORC #${orc.rows[0].numero} — ${label}`,
        body: `OS #${os.numero_os} atualizada`,
        data: { os_id: id, orcamento_id: os.orcamento_id, status: novoStatus },
      }).catch(() => {});
    }
  }

  return { os };
}

module.exports = { listar, buscarPorId, atualizarStatus };
```

- [ ] **Step 4: Implementar `src/modules/os/router.js`**

```js
const express = require('express');
const router = express.Router();
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const soAdmin = requireRole('admin');

router.get('/', async (req, res) => {
  const result = await service.listar(req.query);
  res.json(result);
});

router.get('/:id', async (req, res) => {
  const os = await service.buscarPorId(req.params.id);
  if (!os) return res.status(404).json({ error: 'OS não encontrada' });
  res.json(os);
});

router.patch('/:id/status', soAdmin, async (req, res) => {
  const result = await service.atualizarStatus(req.params.id, req.body.status, req.user.id);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.json(result);
});

module.exports = router;
```

- [ ] **Step 5: Registrar em `src/modules/index.js`**

```js
router.use('/os', requireAuthApi, require('./os/router'));
```

- [ ] **Step 6: Rodar testes**

```bash
npm test -- --testPathPattern=os.test
```

Saída esperada: PASS — 4 testes

- [ ] **Step 7: Commit**

```bash
git add src/modules/os/ src/modules/index.js tests/modules/os.test.js
git commit -m "feat: API de ordens de serviço — listagem, detalhe e atualização de status"
```

---

## Task 5: PDF do Orçamento no Padrão LKL

**Files:**
- Create: `src/services/pdf.js`
- Modify: `src/modules/orcamentos/router.js` — adicionar rota GET /:id/pdf

O PDF segue o layout do modelo "PROPOSTA / ORÇAMENTO" visto no arquivo LKL:
- Cabeçalho: logo LKL (SVG/PNG) + título + número + data
- Destinatário: empresa, ATT, fone, email
- Texto intro: "Conforme solicitação vimos através desta apresentar nossa proposta orçamentária..."
- Tabela de itens: código | descrição | qtde | valor unitário | valor total
- Rodapé: condição pagamento, validade, prazo entrega, observação
- Assinatura: "DIRETORIA / GRUPODE GRAFICAS LKL LTDA" + linha para cliente

- [ ] **Step 1: Obter o logo LKL**

```bash
# Verificar se já existe algum logo nos assets
ls /Users/klebercamara/LKL/public/icons/ 2>/dev/null || echo "sem pasta icons"
ls /Users/klebercamara/LKL/public/ 2>/dev/null
```

O logo deve ser colocado em `public/assets/logo-lkl.png`.
Se não existir, o PDF usa texto "LKL GRÁFICA E COMUNICAÇÃO VISUAL" em azul no lugar.

- [ ] **Step 2: Implementar `src/services/pdf.js`**

```js
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const LOGO_PATH = path.join(__dirname, '../../public/assets/logo-lkl.png');
const AZUL_LKL = '#1a237e';

function formatBRL(value) {
  if (value == null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('pt-BR');
}

/**
 * Gera PDF do orçamento e retorna um Buffer.
 * @param {object} orc — resultado de orcamentos.buscarPorId()
 * @returns {Promise<Buffer>}
 */
function gerarOrcamentoPDF(orc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── CABEÇALHO ───────────────────────────────────────────────────────────
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, 50, 40, { height: 60 });
    } else {
      doc.fontSize(18).fillColor(AZUL_LKL).font('Helvetica-Bold').text('LKL', 50, 50);
      doc.fontSize(8).fillColor('#555').font('Helvetica').text('GRÁFICA E COMUNICAÇÃO VISUAL', 50, 72);
    }

    // Título à direita
    doc.fontSize(16).fillColor(AZUL_LKL).font('Helvetica-Bold')
       .text(`PROPOSTA / ORÇAMENTO ${orc.numero}`, 200, 45, { align: 'right' });
    doc.fontSize(10).fillColor('#333').font('Helvetica')
       .text(`Data Emissão: ${formatDate(orc.created_at)}`, 200, 68, { align: 'right' });

    doc.moveTo(50, 115).lineTo(545, 115).strokeColor('#ccc').lineWidth(1).stroke();

    // ── DESTINATÁRIO ────────────────────────────────────────────────────────
    doc.moveDown(0.5);
    const y = 125;
    doc.fontSize(10).fillColor('#333').font('Helvetica')
       .text('À', 50, y);
    doc.fontSize(12).fillColor(AZUL_LKL).font('Helvetica-Bold')
       .text((orc.cliente_nome || 'CLIENTE NÃO IDENTIFICADO').toUpperCase(), 50, y + 14);

    if (orc.cliente_celular) {
      doc.fontSize(10).fillColor('#333').font('Helvetica')
         .text(`FONE: ${orc.cliente_celular}`, 50, y + 32);
    }

    doc.fontSize(10).fillColor('#555').font('Helvetica-Oblique')
       .text(
         'Conforme solicitação vimos através desta apresentar nossa proposta orçamentária para confecção do(s) serviço(s) conforme especificações abaixo:',
         50, y + 52, { width: 495 }
       );

    // ── TABELA DE ITENS ─────────────────────────────────────────────────────
    const tableTop = y + 100;

    // Cabeçalho da tabela
    doc.rect(50, tableTop, 495, 20).fill(AZUL_LKL);
    doc.fontSize(9).fillColor('#fff').font('Helvetica-Bold');
    doc.text('CÓD.',     55,  tableTop + 6, { width: 40 });
    doc.text('DADOS DO(S) SERVIÇO(S)', 100, tableTop + 6, { width: 230 });
    doc.text('QTDE',    330,  tableTop + 6, { width: 60, align: 'right' });
    doc.text('VL. UNIT.', 395, tableTop + 6, { width: 70, align: 'right' });
    doc.text('VL. TOTAL', 470, tableTop + 6, { width: 70, align: 'right' });

    let rowY = tableTop + 20;
    let totalGeral = 0;
    const itens = orc.itens || [];

    for (let i = 0; i < itens.length; i++) {
      const item = itens[i];
      const bg = i % 2 === 0 ? '#f5f5f5' : '#ffffff';

      // Calcular altura da linha (descrição pode ser longa)
      const descHeight = doc.heightOfString(item.descricao, { width: 230 }) + 8;
      const rowHeight = Math.max(descHeight, 20);

      doc.rect(50, rowY, 495, rowHeight).fill(bg);
      doc.fontSize(9).fillColor('#222').font('Helvetica-Bold');
      doc.text(String(item.codigo), 55, rowY + 6, { width: 40 });

      doc.font('Helvetica');
      doc.text(item.descricao, 100, rowY + 6, { width: 225 });

      // Especificações adicionais em menor
      if (item.tipo_insumo || item.cores || item.impressao) {
        const specs = [item.tipo_insumo, item.cores, item.impressao].filter(Boolean).join(' | ');
        doc.fontSize(8).fillColor('#666').text(specs, 100, rowY + 6 + descHeight - 2, { width: 225 });
      }

      doc.fontSize(9).fillColor('#222').font('Helvetica');
      doc.text(String(item.quantidade), 330, rowY + 6, { width: 60, align: 'right' });
      doc.text(formatBRL(item.valor_unitario), 395, rowY + 6, { width: 70, align: 'right' });
      doc.text(formatBRL(item.valor_total), 470, rowY + 6, { width: 70, align: 'right' });

      totalGeral += Number(item.valor_total) || 0;
      rowY += rowHeight;
    }

    // Linha total
    doc.rect(50, rowY, 495, 22).fill(AZUL_LKL);
    doc.fontSize(10).fillColor('#fff').font('Helvetica-Bold')
       .text('Total da Proposta', 50, rowY + 6, { width: 460, align: 'right' })
       .text(formatBRL(totalGeral), 470, rowY + 6, { width: 70, align: 'right' });
    rowY += 22;

    // ── RODAPÉ ──────────────────────────────────────────────────────────────
    const footY = rowY + 20;
    doc.fontSize(10).fillColor('#333').font('Helvetica');
    doc.text(`Condição de pagamento : ${orc.condicao_pagamento || '—'}`, 50, footY);
    doc.text(`Validade da proposta : ${orc.validade_dias || 35} dias úteis`, 50, footY + 16);
    doc.text(`Prazo Entrega : ${orc.prazo_entrega || 'A Combinar'}`, 50, footY + 32);
    if (orc.observacao) doc.text(`Observação : ${orc.observacao}`, 50, footY + 48);

    // ── ASSINATURAS ─────────────────────────────────────────────────────────
    const sigY = footY + (orc.observacao ? 90 : 75);
    doc.fontSize(9).fillColor('#555').font('Helvetica-Oblique')
       .text('Atenciosamente', 50, sigY);

    // Linha esquerda — LKL
    doc.moveTo(50, sigY + 40).lineTo(230, sigY + 40).strokeColor('#333').lineWidth(0.5).stroke();
    doc.fontSize(9).fillColor('#333').font('Helvetica-Bold')
       .text('DIRETORIA', 50, sigY + 44);
    doc.font('Helvetica').text('GRUPODE GRAFICAS LKL LTDA', 50, sigY + 56);
    doc.fillColor('#555').text('sisgraf@sisgraf.com.br', 50, sigY + 68);

    // Linha direita — cliente
    doc.moveTo(315, sigY + 40).lineTo(545, sigY + 40).strokeColor('#333').lineWidth(0.5).stroke();
    doc.fontSize(9).fillColor('#555').font('Helvetica-Oblique')
       .text('Autorizo a confecção do(s) item(ns) acima assinalados', 315, sigY + 44, { width: 230 });
    doc.fillColor('#333').font('Helvetica-Bold')
       .text((orc.cliente_nome || '').toUpperCase(), 315, sigY + 68, { width: 230 });

    doc.end();
  });
}

module.exports = { gerarOrcamentoPDF };
```

- [ ] **Step 3: Adicionar rota PDF em `src/modules/orcamentos/router.js`**

Adicionar após as rotas existentes, antes do `module.exports`:

```js
const { gerarOrcamentoPDF } = require('../../services/pdf');

// GET /:id/pdf — download do PDF do orçamento
router.get('/:id/pdf', async (req, res) => {
  const orc = await service.buscarPorId(req.params.id);
  if (!orc) return res.status(404).json({ error: 'Orçamento não encontrado' });
  try {
    const buffer = await gerarOrcamentoPDF(orc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="orcamento-${orc.numero}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error('[PDF]', e.message);
    res.status(500).json({ error: 'Erro ao gerar PDF' });
  }
});
```

- [ ] **Step 4: Testar geração do PDF manualmente**

```bash
# Subir server local e testar com curl (substitua o ID real)
npm run dev &
sleep 3
# Primeiro fazer login para pegar token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@lkl.com","password":"senha"}' | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); console.log(JSON.parse(d).token)")
echo "Token: $TOKEN"
```

- [ ] **Step 5: Commit**

```bash
git add src/services/pdf.js src/modules/orcamentos/router.js
git commit -m "feat: geração de PDF do orçamento no padrão LKL (pdfkit)"
```

---

## Task 6: Notificações WhatsApp

**Files:**
- Modify: `src/modules/orcamentos/router.js` — adicionar notificações nos endpoints enviar e aprovar
- Modify: `src/modules/orcamentos/service.js` — expor número do orçamento nas respostas

- [ ] **Step 1: Adicionar notificações ao router de orçamentos**

No arquivo `src/modules/orcamentos/router.js`, modificar os endpoints `enviar` e `aprovar` para disparar WhatsApp:

```js
const whatsapp = require('../../services/whatsapp');

// No PATCH /:id/enviar — após res.json(result), antes do return:
// Notificar cliente por WhatsApp (se tiver celular)
if (result.orcamento) {
  const orc = await service.buscarPorId(req.params.id);
  if (orc?.cliente_celular) {
    const msg = `Olá! A LKL Gráfica enviou um orçamento para você.\n\n` +
      `*Proposta/Orçamento #${orc.numero}*\n` +
      `Validade: ${orc.validade_dias || 35} dias\n` +
      `Prazo entrega: ${orc.prazo_entrega || 'A combinar'}\n\n` +
      `Para aprovar, responda *SIM* ou entre em contato.`;
    whatsapp.sendMessage(orc.cliente_celular, msg).catch(e =>
      console.warn('[WA] Falha ao notificar cliente:', e.message)
    );
  }
}

// No PATCH /:id/aprovar — após res.json(result):
// Notificar vendedor via WhatsApp
if (result.orcamento && result.ordens_servico) {
  // Buscar celular do vendedor
  const db = require('../../db');
  const vend = await db.query(
    'SELECT u.name, c_user.celular FROM users u LEFT JOIN clientes_lkl c_user ON FALSE WHERE u.id=$1',
    [result.orcamento.vendedor_id]
  ).catch(() => null);
  // Notificação via FCM já acontece no service de OS
  // Aqui só logamos
  console.log(`[ORC] Orçamento #${result.orcamento.numero} aprovado — ${result.ordens_servico.length} OSs geradas`);
}
```

**Nota:** A notificação ao vendedor já é feita via FCM no service de OS. O WhatsApp é usado apenas para o cliente (canal externo).

- [ ] **Step 2: Commit**

```bash
git add src/modules/orcamentos/router.js
git commit -m "feat: notificação WhatsApp ao cliente no envio do orçamento"
```

---

## Task 7: PWA — Tela de Orçamentos (Vendedor)

**Files:**
- Create: `public/pwa/orcamentos.html`
- Modify: `public/pwa/app.js` — nada, reusar api() existente

A tela tem duas abas: **Novo Orçamento** e **Meus Orçamentos**.

- [ ] **Step 1: Criar `public/pwa/orcamentos.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<meta name="theme-color" content="#1a237e">
<title>LKL — Orçamentos</title>
<link rel="manifest" href="/manifest.json">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
body { font-family: -apple-system,'Segoe UI',sans-serif; background:#f5f5f5; min-height:100dvh; }
.topbar { background:#1a237e; color:#fff; padding:16px; display:flex; align-items:center; gap:12px; }
.topbar h1 { font-size:17px; font-weight:600; flex:1; }
.topbar button { background:rgba(255,255,255,.15); border:none; color:#fff; padding:6px 12px; border-radius:8px; font-size:13px; cursor:pointer; }
.tabs { display:flex; background:#fff; border-bottom:2px solid #e0e0e0; }
.tab { flex:1; padding:14px; text-align:center; font-size:14px; font-weight:500; color:#666; border:none; background:none; cursor:pointer; border-bottom:3px solid transparent; margin-bottom:-2px; }
.tab.active { color:#1a237e; border-bottom-color:#1a237e; }
.content { padding:16px; }
.hidden { display:none !important; }

/* Form */
.card { background:#fff; border-radius:12px; padding:16px; margin-bottom:12px; box-shadow:0 1px 3px rgba(0,0,0,.1); }
.card h3 { font-size:14px; color:#1a237e; margin-bottom:12px; font-weight:600; }
label { display:block; font-size:13px; color:#555; margin-bottom:4px; margin-top:10px; }
input,textarea,select { width:100%; padding:10px 12px; border:1.5px solid #ddd; border-radius:8px; font-size:14px; outline:none; transition:border-color .2s; }
input:focus,textarea:focus,select:focus { border-color:#1a237e; }
textarea { resize:vertical; min-height:60px; }

/* Itens */
.item-block { border:1.5px solid #e0e0e0; border-radius:10px; padding:12px; margin-bottom:10px; position:relative; }
.item-block h4 { font-size:13px; color:#1a237e; margin-bottom:8px; }
.remove-item { position:absolute; top:10px; right:10px; background:#ffebee; color:#c62828; border:none; border-radius:6px; padding:4px 8px; font-size:12px; cursor:pointer; }
.add-item-btn { width:100%; padding:10px; background:#e8eaf6; color:#1a237e; border:2px dashed #9fa8da; border-radius:10px; font-size:14px; font-weight:500; cursor:pointer; margin-top:8px; }
.row2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }

/* Botão submit */
.btn-primary { width:100%; padding:14px; background:#1a237e; color:#fff; border:none; border-radius:10px; font-size:16px; font-weight:600; cursor:pointer; margin-top:8px; }
.btn-primary:disabled { opacity:.5; }

/* Lista */
.orc-card { background:#fff; border-radius:12px; padding:14px; margin-bottom:10px; box-shadow:0 1px 3px rgba(0,0,0,.1); }
.orc-header { display:flex; justify-content:space-between; align-items:flex-start; }
.orc-num { font-weight:700; color:#1a237e; font-size:15px; }
.badge { display:inline-block; padding:3px 10px; border-radius:20px; font-size:12px; font-weight:600; }
.badge-rascunho  { background:#fff8e1; color:#f57f17; }
.badge-enviado   { background:#e3f2fd; color:#1565c0; }
.badge-aprovado  { background:#e8f5e9; color:#2e7d32; }
.badge-cancelado { background:#fce4ec; color:#c62828; }
.orc-cliente { color:#555; font-size:13px; margin-top:4px; }
.orc-meta { font-size:12px; color:#888; margin-top:6px; }
.orc-actions { display:flex; gap:8px; margin-top:10px; }
.btn-sm { padding:7px 14px; border:none; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; }
.btn-outline { background:#f5f5f5; color:#333; }
.btn-blue { background:#1a237e; color:#fff; }
.empty { text-align:center; color:#999; padding:40px 20px; font-size:14px; }
.toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:#333; color:#fff; padding:12px 20px; border-radius:10px; font-size:14px; z-index:999; opacity:0; transition:opacity .3s; pointer-events:none; }
.toast.show { opacity:1; }
</style>
</head>
<body>

<div class="topbar">
  <h1>📋 Orçamentos</h1>
  <button onclick="window.location='/pwa/pedidos.html'">OS</button>
  <button onclick="logout()">Sair</button>
</div>

<div class="tabs">
  <button class="tab active" id="tab-novo" onclick="switchTab('novo')">Novo Orçamento</button>
  <button class="tab" id="tab-lista" onclick="switchTab('lista')">Meus Orçamentos</button>
</div>

<!-- TAB NOVO ORÇAMENTO -->
<div id="pane-novo" class="content">
  <form id="form-orc" onsubmit="submeterOrcamento(event)">

    <div class="card">
      <h3>Cliente</h3>
      <label>Buscar cliente</label>
      <input type="text" id="cliente-busca" placeholder="Digite o nome..." autocomplete="off" oninput="buscarCliente(this.value)">
      <div id="cliente-sugestoes"></div>
      <input type="hidden" id="cliente-id">
      <input type="text" id="cliente-nome-display" placeholder="Nenhum selecionado" readonly style="margin-top:8px;background:#f9f9f9;">
    </div>

    <div class="card">
      <h3>Condições Comerciais</h3>
      <label>Condição de Pagamento</label>
      <input type="text" id="cond-pagamento" placeholder="Ex: MEDIANTE APROVAÇÃO">
      <label>Validade (dias úteis)</label>
      <input type="number" id="validade" value="35" min="1" max="90">
      <label>Prazo de Entrega</label>
      <input type="text" id="prazo" placeholder="Ex: 10 dias úteis ou A Combinar">
      <label>Observação</label>
      <textarea id="observacao" placeholder="Observações gerais..."></textarea>
    </div>

    <div class="card">
      <h3>Itens do Orçamento</h3>
      <div id="itens-container"></div>
      <button type="button" class="add-item-btn" onclick="adicionarItem()">+ Adicionar Item</button>
    </div>

    <button type="submit" class="btn-primary" id="btn-submit">Salvar Orçamento</button>
  </form>
</div>

<!-- TAB LISTA -->
<div id="pane-lista" class="content hidden">
  <div id="lista-orcamentos"><div class="empty">Carregando...</div></div>
</div>

<div class="toast" id="toast"></div>

<script src="/pwa/app.js"></script>
<script>
let clienteSelecionado = null;
let itemCount = 0;
let debounceTimer;

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('[id^="pane-"]').forEach(p => p.classList.add('hidden'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('pane-' + tab).classList.remove('hidden');
  if (tab === 'lista') carregarLista();
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Cliente autocomplete ──────────────────────────────────────────────
function buscarCliente(q) {
  clearTimeout(debounceTimer);
  if (q.length < 2) { document.getElementById('cliente-sugestoes').innerHTML = ''; return; }
  debounceTimer = setTimeout(async () => {
    const data = await api(`/api/clientes?q=${encodeURIComponent(q)}&limit=5`);
    const sugs = document.getElementById('cliente-sugestoes');
    if (!data?.data?.length) { sugs.innerHTML = ''; return; }
    sugs.innerHTML = data.data.map(c => `
      <div onclick="selecionarCliente('${c.id}','${c.nome.replace(/'/g,"\\'")}','${c.celular||''}')"
           style="padding:8px 12px;border:1px solid #ddd;cursor:pointer;font-size:14px;background:#fff;margin-top:-1px;">
        ${c.nome} ${c.celular ? `<span style="color:#888;font-size:12px;">${c.celular}</span>` : ''}
      </div>`).join('');
  }, 300);
}

function selecionarCliente(id, nome, celular) {
  clienteSelecionado = { id, nome, celular };
  document.getElementById('cliente-id').value = id;
  document.getElementById('cliente-nome-display').value = nome;
  document.getElementById('cliente-busca').value = '';
  document.getElementById('cliente-sugestoes').innerHTML = '';
}

// ── Itens ─────────────────────────────────────────────────────────────
function adicionarItem() {
  itemCount++;
  const idx = itemCount;
  const container = document.getElementById('itens-container');
  const div = document.createElement('div');
  div.className = 'item-block';
  div.id = `item-${idx}`;
  div.innerHTML = `
    <h4>Item ${idx}</h4>
    <button type="button" class="remove-item" onclick="removerItem(${idx})">✕</button>
    <label>Descrição *</label>
    <textarea name="descricao_${idx}" placeholder="Ex: FOLDER 45x21CM ABERTO 250GRS..." required></textarea>
    <div class="row2">
      <div>
        <label>Tipo de Insumo</label>
        <select name="tipo_insumo_${idx}">
          <option value="">Selecione</option>
          <option>papel</option><option>envelope</option><option>lona</option>
          <option>adesivo</option><option>cartão</option>
        </select>
      </div>
      <div>
        <label>Quantidade *</label>
        <input type="number" name="quantidade_${idx}" min="1" required>
      </div>
    </div>
    <div class="row2">
      <div>
        <label>Formato do Papel</label>
        <input type="text" name="formato_${idx}" placeholder="Ex: 66x96">
      </div>
      <div>
        <label>Cores</label>
        <select name="cores_${idx}">
          <option value="">Selecione</option>
          <option>4/4 (CMYK)</option><option>4/0</option>
          <option>1/0</option><option>1/1</option><option>BRANCO</option>
        </select>
      </div>
    </div>
    <label>Impressão</label>
    <select name="impressao_${idx}">
      <option value="">Selecione</option>
      <option value="frente">Só Frente</option>
      <option value="frente_verso">Frente e Verso</option>
    </select>
    <label>Acabamentos</label>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
      ${['Corte','Vinco','Serrilha','Dobra','Colagem','Grampo','Ilhós',
         'Lamin. Brilho','Lamin. Fosca','Numeração','Refile','Envelope'].map(a =>
        `<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;color:#333;font-weight:normal;">
           <input type="checkbox" name="acab_${idx}" value="${a.toLowerCase().replace(' ','_')}"> ${a}
         </label>`).join('')}
    </div>`;
  container.appendChild(div);
}

function removerItem(idx) {
  document.getElementById(`item-${idx}`)?.remove();
}

// ── Submit ─────────────────────────────────────────────────────────────
async function submeterOrcamento(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-submit');
  btn.disabled = true;

  const itens = [];
  document.querySelectorAll('.item-block').forEach(block => {
    const idx = block.id.split('-')[1];
    const acab = [...block.querySelectorAll(`[name="acab_${idx}"]:checked`)].map(c => c.value);
    itens.push({
      descricao:    block.querySelector(`[name="descricao_${idx}"]`).value,
      tipo_insumo:  block.querySelector(`[name="tipo_insumo_${idx}"]`).value || null,
      quantidade:   parseInt(block.querySelector(`[name="quantidade_${idx}"]`).value),
      formato_papel:block.querySelector(`[name="formato_${idx}"]`).value || null,
      cores:        block.querySelector(`[name="cores_${idx}"]`).value || null,
      impressao:    block.querySelector(`[name="impressao_${idx}"]`).value || null,
      acabamentos:  acab.length ? acab : null,
    });
  });

  if (!itens.length) { showToast('Adicione ao menos 1 item'); btn.disabled = false; return; }

  const payload = {
    cliente_id:         document.getElementById('cliente-id').value || null,
    condicao_pagamento: document.getElementById('cond-pagamento').value || null,
    validade_dias:      parseInt(document.getElementById('validade').value) || 35,
    prazo_entrega:      document.getElementById('prazo').value || null,
    observacao:         document.getElementById('observacao').value || null,
    itens,
  };

  const data = await api('/api/orcamentos', { method: 'POST', body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' } });

  if (!data) { showToast('Erro ao salvar orçamento'); btn.disabled = false; return; }
  if (data.errors) { showToast(data.errors[0]); btn.disabled = false; return; }

  showToast(`✅ Orçamento #${data.orcamento.numero} salvo!`);
  document.getElementById('form-orc').reset();
  document.getElementById('itens-container').innerHTML = '';
  document.getElementById('cliente-nome-display').value = '';
  clienteSelecionado = null;
  itemCount = 0;
  btn.disabled = false;
  setTimeout(() => switchTab('lista'), 1500);
}

// ── Lista ──────────────────────────────────────────────────────────────
async function carregarLista() {
  const data = await api('/api/orcamentos?limit=50');
  const el = document.getElementById('lista-orcamentos');
  if (!data?.data?.length) {
    el.innerHTML = '<div class="empty">Nenhum orçamento encontrado.</div>';
    return;
  }
  el.innerHTML = data.data.map(o => `
    <div class="orc-card">
      <div class="orc-header">
        <span class="orc-num">ORC #${o.numero}</span>
        <span class="badge badge-${o.status}">${o.status.toUpperCase()}</span>
      </div>
      <div class="orc-cliente">${o.cliente_nome || 'Cliente não identificado'}</div>
      <div class="orc-meta">${new Date(o.created_at).toLocaleDateString('pt-BR')}</div>
      <div class="orc-actions">
        <button class="btn-sm btn-outline" onclick="window.location='/api/orcamentos/${o.id}/pdf'" target="_blank">📄 PDF</button>
      </div>
    </div>`).join('');
}

// Init
requireAuth();
adicionarItem();
</script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/pwa/orcamentos.html
git commit -m "feat: PWA orçamentos — formulário de criação e listagem para vendedor"
```

---

## Task 8: PWA — Painel Admin (Precificação + OSs)

**Files:**
- Create: `public/pwa/admin.html`

- [ ] **Step 1: Criar `public/pwa/admin.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<meta name="theme-color" content="#1a237e">
<title>LKL — Admin</title>
<link rel="manifest" href="/manifest.json">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system,'Segoe UI',sans-serif; background:#f5f5f5; min-height:100dvh; }
.topbar { background:#1a237e; color:#fff; padding:16px; display:flex; align-items:center; gap:12px; }
.topbar h1 { font-size:17px; font-weight:600; flex:1; }
.topbar button { background:rgba(255,255,255,.15); border:none; color:#fff; padding:6px 12px; border-radius:8px; font-size:13px; cursor:pointer; }
.tabs { display:flex; background:#fff; border-bottom:2px solid #e0e0e0; overflow-x:auto; }
.tab { flex:none; padding:14px 20px; text-align:center; font-size:14px; font-weight:500; color:#666; border:none; background:none; cursor:pointer; border-bottom:3px solid transparent; margin-bottom:-2px; white-space:nowrap; }
.tab.active { color:#1a237e; border-bottom-color:#1a237e; }
.content { padding:16px; }
.hidden { display:none !important; }
.card { background:#fff; border-radius:12px; padding:14px; margin-bottom:10px; box-shadow:0 1px 3px rgba(0,0,0,.1); }
.badge { display:inline-block; padding:3px 10px; border-radius:20px; font-size:12px; font-weight:600; }
.badge-rascunho  { background:#fff8e1; color:#f57f17; }
.badge-enviado   { background:#e3f2fd; color:#1565c0; }
.badge-aprovado  { background:#e8f5e9; color:#2e7d32; }
.badge-cancelado { background:#fce4ec; color:#c62828; }
.badge-aguardando   { background:#f5f5f5; color:#555; }
.badge-arte_final   { background:#e8eaf6; color:#3949ab; }
.badge-impressao    { background:#e3f2fd; color:#0277bd; }
.badge-acabamento   { background:#fff3e0; color:#e65100; }
.badge-embalagem    { background:#f3e5f5; color:#6a1b9a; }
.badge-pronto       { background:#e8f5e9; color:#2e7d32; }
.badge-entregue     { background:#1a237e; color:#fff; }
.row { display:flex; justify-content:space-between; align-items:flex-start; }
label { font-size:13px; color:#555; display:block; margin-top:8px; margin-bottom:3px; }
input,select { width:100%; padding:9px 12px; border:1.5px solid #ddd; border-radius:8px; font-size:14px; }
.btn-primary { padding:10px 16px; background:#1a237e; color:#fff; border:none; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; }
.btn-green { padding:10px 16px; background:#2e7d32; color:#fff; border:none; border-radius:8px; font-size:14px; font-weight:600; cursor:pointer; }
.btn-outline { padding:8px 14px; background:#f5f5f5; color:#333; border:none; border-radius:8px; font-size:13px; cursor:pointer; }
.btn-sm { padding:6px 12px; border:none; border-radius:7px; font-size:12px; font-weight:600; cursor:pointer; }
.item-row { border:1px solid #e0e0e0; border-radius:8px; padding:10px; margin-bottom:8px; }
.empty { text-align:center; color:#999; padding:40px 20px; font-size:14px; }
.toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); background:#333; color:#fff; padding:12px 20px; border-radius:10px; font-size:14px; z-index:999; opacity:0; transition:opacity .3s; pointer-events:none; }
.toast.show { opacity:1; }
.os-status-select { padding:6px 10px; border:1.5px solid #ddd; border-radius:8px; font-size:13px; }
</style>
</head>
<body>

<div class="topbar">
  <h1>⚙️ Painel Admin</h1>
  <button onclick="window.location='/pwa/pedidos.html'">OS v1</button>
  <button onclick="logout()">Sair</button>
</div>

<div class="tabs">
  <button class="tab active" id="tab-orc" onclick="switchTab('orc')">Orçamentos</button>
  <button class="tab" id="tab-os" onclick="switchTab('os')">Ordens de Serviço</button>
</div>

<!-- ORÇAMENTOS -->
<div id="pane-orc" class="content">
  <div id="lista-adm-orc"><div class="empty">Carregando...</div></div>
</div>

<!-- ORDENS DE SERVIÇO -->
<div id="pane-os" class="content hidden">
  <div id="lista-adm-os"><div class="empty">Carregando...</div></div>
</div>

<!-- MODAL PRECIFICAÇÃO -->
<div id="modal-preco" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;overflow-y:auto;padding:20px;">
  <div style="background:#fff;border-radius:16px;padding:20px;max-width:500px;margin:auto;">
    <h2 style="color:#1a237e;font-size:16px;margin-bottom:16px;">Precificar Orçamento <span id="modal-orc-num"></span></h2>
    <div id="modal-itens"></div>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button class="btn-primary" onclick="salvarPrecos()">Salvar Preços</button>
      <button class="btn-outline" onclick="fecharModal()">Cancelar</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script src="/pwa/app.js"></script>
<script>
let orcamentoAtual = null;

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('[id^="pane-"]').forEach(p => p.classList.add('hidden'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('pane-' + tab).classList.remove('hidden');
  if (tab === 'orc') carregarOrcamentos();
  if (tab === 'os') carregarOS();
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Orçamentos ──────────────────────────────────────────────────────────
async function carregarOrcamentos() {
  const data = await api('/api/orcamentos?limit=100');
  const el = document.getElementById('lista-adm-orc');
  if (!data?.data?.length) { el.innerHTML = '<div class="empty">Nenhum orçamento.</div>'; return; }
  el.innerHTML = data.data.map(o => `
    <div class="card">
      <div class="row">
        <div>
          <strong style="color:#1a237e">ORC #${o.numero}</strong>
          <span class="badge badge-${o.status}" style="margin-left:8px;">${o.status}</span>
        </div>
        <small style="color:#888">${new Date(o.created_at).toLocaleDateString('pt-BR')}</small>
      </div>
      <div style="color:#555;font-size:13px;margin-top:4px;">${o.cliente_nome || '—'}</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        <button class="btn-sm" style="background:#e8eaf6;color:#1a237e" onclick="abrirPrecos('${o.id}')">💰 Precificar</button>
        ${o.status === 'rascunho' ? `<button class="btn-sm" style="background:#e3f2fd;color:#0277bd" onclick="enviarOrc('${o.id}')">📤 Enviar</button>` : ''}
        ${o.status === 'enviado' ? `<button class="btn-sm" style="background:#e8f5e9;color:#2e7d32" onclick="aprovarOrc('${o.id}')">✅ Aprovar</button>` : ''}
        <a href="/api/orcamentos/${o.id}/pdf" target="_blank"><button class="btn-sm" style="background:#f5f5f5;color:#333">📄 PDF</button></a>
      </div>
    </div>`).join('');
}

async function abrirPrecos(id) {
  const orc = await api(`/api/orcamentos/${id}`);
  if (!orc) return;
  orcamentoAtual = orc;
  document.getElementById('modal-orc-num').textContent = `#${orc.numero}`;
  document.getElementById('modal-itens').innerHTML = orc.itens.map((item, i) => `
    <div class="item-row">
      <div style="font-size:13px;font-weight:600;color:#333;margin-bottom:8px;">${item.descricao}</div>
      <div style="font-size:12px;color:#888;margin-bottom:8px;">Qtde: ${item.quantidade}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div>
          <label>Valor Unitário (R$)</label>
          <input type="number" id="vunit_${item.id}" step="0.01" min="0"
                 value="${item.valor_unitario || ''}" placeholder="0,00"
                 oninput="calcTotal(${i})">
        </div>
        <div>
          <label>Valor Total (R$)</label>
          <input type="number" id="vtotal_${item.id}" step="0.01" min="0"
                 value="${item.valor_total || ''}" placeholder="0,00">
        </div>
      </div>
    </div>`).join('');
  document.getElementById('modal-preco').style.display = 'block';
}

function calcTotal(i) {
  const item = orcamentoAtual.itens[i];
  const vunit = parseFloat(document.getElementById(`vunit_${item.id}`).value) || 0;
  document.getElementById(`vtotal_${item.id}`).value = (vunit * item.quantidade).toFixed(2);
}

function fecharModal() {
  document.getElementById('modal-preco').style.display = 'none';
  orcamentoAtual = null;
}

async function salvarPrecos() {
  const itens = orcamentoAtual.itens.map(item => ({
    id: item.id,
    valor_unitario: parseFloat(document.getElementById(`vunit_${item.id}`).value) || 0,
    valor_total:    parseFloat(document.getElementById(`vtotal_${item.id}`).value) || 0,
  }));
  const data = await api(`/api/orcamentos/${orcamentoAtual.id}/precificar`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itens }),
  });
  if (!data) { showToast('Erro ao salvar preços'); return; }
  showToast('✅ Preços salvos!');
  fecharModal();
  carregarOrcamentos();
}

async function enviarOrc(id) {
  if (!confirm('Marcar orçamento como ENVIADO ao cliente?')) return;
  const data = await api(`/api/orcamentos/${id}/enviar`, { method: 'PATCH' });
  if (!data) { showToast('Erro'); return; }
  showToast('📤 Orçamento marcado como enviado');
  carregarOrcamentos();
}

async function aprovarOrc(id) {
  if (!confirm('Registrar APROVAÇÃO do cliente? Isso gerará as OSs automaticamente.')) return;
  const via = prompt('Via qual canal o cliente aprovou?', 'whatsapp') || 'whatsapp';
  const data = await api(`/api/orcamentos/${id}/aprovar`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aprovado_via: via }),
  });
  if (!data) { showToast('Erro'); return; }
  showToast(`✅ Aprovado! ${data.ordens_servico?.length || 0} OS(s) gerada(s)`);
  carregarOrcamentos();
}

// ── Ordens de Serviço ───────────────────────────────────────────────────
const STATUS_OS = ['aguardando','arte_final','impressao','acabamento','embalagem','pronto','entregue','cancelado'];

async function carregarOS() {
  const data = await api('/api/os?limit=100');
  const el = document.getElementById('lista-adm-os');
  if (!data?.data?.length) { el.innerHTML = '<div class="empty">Nenhuma OS gerada ainda.</div>'; return; }
  el.innerHTML = data.data.map(os => `
    <div class="card">
      <div class="row">
        <div>
          <strong style="color:#1a237e">OS #${os.numero_os}</strong>
          <small style="color:#888;margin-left:8px;">ORC #${os.numero_orcamento}</small>
        </div>
        <span class="badge badge-${os.status}">${os.status.replace('_',' ')}</span>
      </div>
      <div style="color:#333;font-size:13px;margin-top:6px;">${os.item_descricao}</div>
      <div style="color:#888;font-size:12px;margin-top:2px;">${os.cliente_nome || '—'} · Qtde: ${os.quantidade}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px;">
        <select class="os-status-select" id="sel-${os.id}">
          ${STATUS_OS.map(s => `<option value="${s}" ${s===os.status?'selected':''}>${s.replace('_',' ')}</option>`).join('')}
        </select>
        <button class="btn-sm" style="background:#1a237e;color:#fff" onclick="atualizarOS('${os.id}')">Atualizar</button>
      </div>
    </div>`).join('');
}

async function atualizarOS(id) {
  const status = document.getElementById(`sel-${id}`).value;
  const data = await api(`/api/os/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!data) { showToast('Erro ao atualizar'); return; }
  showToast(`✅ OS atualizada para: ${status}`);
  carregarOS();
}

// Init
requireAuth();
carregarOrcamentos();
</script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/pwa/admin.html
git commit -m "feat: PWA admin — precificação de orçamentos e gestão de OSs"
```

---

## Task 9: Deploy no VPS

**Files:** nenhum novo — apenas push + restart

- [ ] **Step 1: Push para o repositório**

```bash
git push origin main
```

- [ ] **Step 2: Deploy no VPS**

```bash
ssh root@2.25.147.243 << 'EOF'
cd /var/www/lkl-chatbot
git pull origin main
npm install --omit=dev
sudo -u postgres psql -d lkl_chatbot -f sql/migrations/003_sprint2_orcamentos.sql
pm2 restart lkl-chatbot
pm2 logs lkl-chatbot --lines 20 --nostream
EOF
```

- [ ] **Step 3: Verificar endpoints em produção**

```bash
curl -sk https://app.graficalkl.com.br/pwa/orcamentos.html | grep -c "Novo Orçamento"
curl -sk https://app.graficalkl.com.br/pwa/admin.html | grep -c "Painel Admin"
curl -sk https://app.graficalkl.com.br/api/orcamentos -H "Authorization: Bearer TOKEN" | head -30
```

Saída esperada: `1`, `1`, JSON com `{ data: [], total: 0 }`

- [ ] **Step 4: Commit final**

```bash
git tag sprint2-v1 -m "Sprint 2: Orçamentos + OSs automáticas + PDF LKL + PWA"
```

---

## Resumo do Sprint 2

| Entrega | Status |
|---------|--------|
| Tabelas orcamentos + orcamento_itens + ordens_servico | Task 1 |
| API CRUD orçamentos com precificação separada | Task 3 |
| Aprovação automática → geração de OSs | Task 3 |
| API de OSs com atualização de status | Task 4 |
| PDF orçamento no padrão LKL | Task 5 |
| Notificação WhatsApp ao cliente | Task 6 |
| PWA vendedor — criar e acompanhar orçamentos | Task 7 |
| PWA admin — precificar + gerir OSs | Task 8 |
| Deploy em produção | Task 9 |

**O que fica para depois da definição da tabela de preços:**
- Botão "Calcular automaticamente" no formulário do vendedor
- Motor de cálculo baseado em tipo_insumo + formato + cores + quantidade + acabamentos
