const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../../src/app');
const db = require('../../src/db');
const orcamentosService = require('../../src/modules/orcamentos/service');

function token(role = 'vendedor', id = '00000000-0000-0000-0000-000000000001') {
  return 'Bearer ' + jwt.sign({ id, name: 'Test', email: 't@t.com', role }, process.env.JWT_SECRET);
}

const ADMIN_ID = '00000000-0000-0000-0000-000000000002';
const VENDEDOR_ID = '00000000-0000-0000-0000-000000000001';

let clienteId;
let orcamentoId;

beforeAll(async () => {
  // Create a test client
  const r = await db.query(
    `INSERT INTO clientes_lkl (tipo_pessoa, nome, canal_origem, status)
     VALUES ('PF', 'Cliente Teste Orcamento', 'balcao', 'ativo')
     RETURNING id`
  );
  clienteId = r.rows[0].id;
});

afterAll(async () => {
  await db.query('DELETE FROM ordens_servico WHERE orcamento_id IN (SELECT id FROM orcamentos WHERE cliente_id = $1)', [clienteId]);
  await db.query('DELETE FROM orcamento_itens WHERE orcamento_id IN (SELECT id FROM orcamentos WHERE cliente_id = $1)', [clienteId]);
  await db.query('DELETE FROM orcamentos WHERE cliente_id = $1', [clienteId]);
  await db.query('DELETE FROM clientes_lkl WHERE id = $1', [clienteId]);
  return db.pool.end();
});

describe('POST /api/orcamentos', () => {
  it('creates orçamento rascunho with items → 201', async () => {
    const res = await request(app)
      .post('/api/orcamentos')
      .set('Authorization', token('vendedor', VENDEDOR_ID))
      .send({
        cliente_id: clienteId,
        condicao_pagamento: '30/60',
        validade_dias: 15,
        itens: [
          { descricao: 'Cartão de Visita', quantidade: 1000, tipo_insumo: 'papel' },
          { descricao: 'Folder A4', quantidade: 500, tipo_insumo: 'papel' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.orcamento.status).toBe('rascunho');
    expect(res.body.itens.length).toBe(2);
    orcamentoId = res.body.orcamento.id;
  });

  it('returns 400 when itens is empty', async () => {
    const res = await request(app)
      .post('/api/orcamentos')
      .set('Authorization', token('vendedor', VENDEDOR_ID))
      .send({
        cliente_id: clienteId,
        itens: [],
      });
    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });
});

describe('PATCH /api/orcamentos/:id/precificar', () => {
  it('allows admin to precificar → 200', async () => {
    const detail = await request(app)
      .get(`/api/orcamentos/${orcamentoId}`)
      .set('Authorization', token('admin', ADMIN_ID));
    const itens = detail.body.itens;

    const res = await request(app)
      .patch(`/api/orcamentos/${orcamentoId}/precificar`)
      .set('Authorization', token('admin', ADMIN_ID))
      .send({
        itens: itens.map(i => ({ id: i.id, valor_unitario: '0.50', valor_total: String(i.quantidade * 0.5) })),
      });
    expect(res.status).toBe(200);
    expect(res.body.itens[0].valor_unitario).toBeDefined();
  });

  it('returns 403 for vendedor on precificar', async () => {
    const res = await request(app)
      .patch(`/api/orcamentos/${orcamentoId}/precificar`)
      .set('Authorization', token('vendedor', VENDEDOR_ID))
      .send({ itens: [] });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/orcamentos/:id/enviar', () => {
  it('admin enviar → 200, status=enviado', async () => {
    const res = await request(app)
      .patch(`/api/orcamentos/${orcamentoId}/enviar`)
      .set('Authorization', token('admin', ADMIN_ID));
    expect(res.status).toBe(200);
    expect(res.body.orcamento.status).toBe('enviado');
  });
});

describe('PATCH /api/orcamentos/:id/aprovar', () => {
  it('approves and auto-generates OSs → 200, ordens_servico.length === item count', async () => {
    const res = await request(app)
      .patch(`/api/orcamentos/${orcamentoId}/aprovar`)
      .set('Authorization', token('admin', ADMIN_ID))
      .send({ aprovado_via: 'whatsapp' });
    expect(res.status).toBe(200);
    expect(res.body.ordens_servico.length).toBe(2);
    expect(res.body.ordens_servico[0].status).toBe('aguardando');
  });
});

describe('buscarEnviadoPorTelefone', () => {
  const CELULAR = '11987654321';
  let clienteTelId;
  let orcamentoEnviadoId;

  beforeAll(async () => {
    const cli = await db.query(
      `INSERT INTO clientes_lkl (tipo_pessoa, nome, canal_origem, status, celular)
       VALUES ('PF', 'Cliente Teste Telefone', 'balcao', 'ativo', $1)
       RETURNING id`,
      [CELULAR]
    );
    clienteTelId = cli.rows[0].id;

    const orc = await db.query(
      `INSERT INTO orcamentos (cliente_id, status, enviado_em)
       VALUES ($1, 'enviado', NOW())
       RETURNING id`,
      [clienteTelId]
    );
    orcamentoEnviadoId = orc.rows[0].id;
  });

  afterAll(async () => {
    await db.query('DELETE FROM orcamentos WHERE cliente_id = $1', [clienteTelId]);
    await db.query('DELETE FROM clientes_lkl WHERE id = $1', [clienteTelId]);
  });

  it('finds the most recent orçamento "enviado" by exact phone', async () => {
    const r = await orcamentosService.buscarEnviadoPorTelefone(CELULAR);
    expect(r).toBeTruthy();
    expect(r.id).toBe(orcamentoEnviadoId);
  });

  it('finds the orçamento by phone with DDI/mask (matches by 9-digit suffix)', async () => {
    const r = await orcamentosService.buscarEnviadoPorTelefone(`+55${CELULAR}`);
    expect(r).toBeTruthy();
    expect(r.id).toBe(orcamentoEnviadoId);
  });

  it('returns null when phone has no orçamento "enviado"', async () => {
    const r = await orcamentosService.buscarEnviadoPorTelefone('11900000000');
    expect(r).toBeNull();
  });
});
