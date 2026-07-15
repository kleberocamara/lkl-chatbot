const express = require('express');
const request = require('supertest');

jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  requireAuthApi: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));

const db = require('../src/db');
const apiRouter = require('../src/dashboard/api');

const app = express();
app.use(express.json());
app.use('/api', apiRouter);

describe('GET /api/conversations — busca + paginação', () => {
  afterEach(() => jest.clearAllMocks());

  test('sem filtros: usa page/limit da query, sem WHERE', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/conversations?page=2&limit=20');

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/JOIN contacts ct ON ct\.id = c\.contact_id\s+WHERE/);
    expect(params).toEqual(['20', 20]); // limit=20, offset=(2-1)*20
  });

  test('com busca: filtra por nome/profile_name/telefone via ILIKE', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/conversations?busca=wendell');

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/ct\.name ILIKE/);
    expect(sql).toMatch(/ct\.profile_name ILIKE/);
    expect(sql).toMatch(/ct\.phone ILIKE/);
    expect(params).toContain('%wendell%');
  });

  test('com status e busca combinados: AND entre as duas condições', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get('/api/conversations?status=active&busca=5521');

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/c\.status = \$3 AND \(ct\.name ILIKE \$4/);
    expect(params).toEqual([20, 0, 'active', '%5521%']);
  });
});
