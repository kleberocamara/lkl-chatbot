const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../../src/app');
const db = require('../../src/db');

function token(role = 'vendedor', id = '00000000-0000-0000-0000-000000000001') {
  return 'Bearer ' + jwt.sign({ id, name: 'Test', email: 't@t.com', role }, process.env.JWT_SECRET);
}

const ADMIN_ID = '00000000-0000-0000-0000-000000000002';
const VENDEDOR_ID = '00000000-0000-0000-0000-000000000001';
const adminTok = token('admin', ADMIN_ID);
const vendedorTok = token('vendedor', VENDEDOR_ID);

let clienteId;
let osId;
let orcamentoId;

async function criarOSviaPipeline() {
  const cr = await request(app)
    .post('/api/orcamentos')
    .set('Authorization', adminTok)
    .send({ cliente_id: clienteId, itens: [{ descricao: 'FOLDER OS TEST', quantidade: 100 }] });
  const orcId = cr.body.orcamento.id;
  await request(app).patch(`/api/orcamentos/${orcId}/enviar`).set('Authorization', adminTok);
  const apr = await request(app)
    .patch(`/api/orcamentos/${orcId}/aprovar`)
    .set('Authorization', adminTok)
    .send({ aprovado_via: 'email' });
  orcamentoId = orcId;
  return apr.body.ordens_servico[0];
}

beforeAll(async () => {
  const r = await db.query(
    `INSERT INTO clientes_lkl (tipo_pessoa, nome, canal_origem, status)
     VALUES ('PF', 'Cliente Teste OS', 'balcao', 'ativo')
     RETURNING id`
  );
  clienteId = r.rows[0].id;

  const os = await criarOSviaPipeline();
  osId = os.id;
});

afterAll(async () => {
  await db.query('DELETE FROM ordens_servico WHERE orcamento_id IN (SELECT id FROM orcamentos WHERE cliente_id = $1)', [clienteId]);
  await db.query('DELETE FROM orcamento_itens WHERE orcamento_id IN (SELECT id FROM orcamentos WHERE cliente_id = $1)', [clienteId]);
  await db.query('DELETE FROM orcamentos WHERE cliente_id = $1', [clienteId]);
  await db.query('DELETE FROM clientes_lkl WHERE id = $1', [clienteId]);
  return db.pool.end();
});

describe('GET /api/os', () => {
  it('returns 200 with { data: Array }', async () => {
    const res = await request(app)
      .get('/api/os')
      .set('Authorization', adminTok);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/os/:id', () => {
  it('returns OS detail', async () => {
    const res = await request(app)
      .get(`/api/os/${osId}`)
      .set('Authorization', adminTok);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(osId);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app)
      .get('/api/os/00000000-0000-0000-0000-000000000099')
      .set('Authorization', adminTok);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/os/:id/status', () => {
  it('admin updates status to impressao → 200', async () => {
    const res = await request(app)
      .patch(`/api/os/${osId}/status`)
      .set('Authorization', adminTok)
      .send({ status: 'impressao' });
    expect(res.status).toBe(200);
    expect(res.body.os.status).toBe('impressao');
  });

  it('invalid status → 400', async () => {
    const res = await request(app)
      .patch(`/api/os/${osId}/status`)
      .set('Authorization', adminTok)
      .send({ status: 'invalido' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });

  it('vendedor → 403', async () => {
    const res = await request(app)
      .patch(`/api/os/${osId}/status`)
      .set('Authorization', vendedorTok)
      .send({ status: 'impressao' });
    expect(res.status).toBe(403);
  });
});
