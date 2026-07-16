const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/middleware/auth', () => ({
  requireAuthApi: (req, res, next) => { req.user = { id: 'u-1' }; next(); },
  requireAdmin: (req, res, next) => next(),
}));

const db = require('../src/db');
const apiRouter = require('../src/dashboard/api');

const app = express();
app.use(express.json());
app.use('/api', apiRouter);

describe('POST /api/auth/login — inclui mustChangePassword', () => {
  afterEach(() => jest.clearAllMocks());

  test('login bem sucedido repassa mustChangePassword no body e no JWT', async () => {
    const hash = await bcrypt.hash('senha123', 10);
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'u-1', name: 'Fulano', email: 'f@lkl.com', role: 'atendente', password_hash: hash, must_change_password: true }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE last_login

    const res = await request(app).post('/api/auth/login').send({ email: 'f@lkl.com', password: 'senha123' });

    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(true);
  });
});

describe('POST /api/auth/change-password', () => {
  afterEach(() => jest.clearAllMocks());

  test('senha atual incorreta → 401', async () => {
    const hash = await bcrypt.hash('senhaCerta', 10);
    db.query.mockResolvedValueOnce({ rows: [{ id: 'u-1', password_hash: hash }] });

    const res = await request(app).post('/api/auth/change-password').send({ currentPassword: 'errada', newPassword: 'novaSenha123' });

    expect(res.status).toBe(401);
  });

  test('nova senha curta → 400', async () => {
    const res = await request(app).post('/api/auth/change-password').send({ currentPassword: 'x', newPassword: '123' });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('senha atual correta → atualiza hash e zera must_change_password', async () => {
    const hash = await bcrypt.hash('senhaAtual', 10);
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'u-1', name: 'Fulano', email: 'f@lkl.com', role: 'atendente', password_hash: hash }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    const res = await request(app).post('/api/auth/change-password').send({ currentPassword: 'senhaAtual', newPassword: 'senhaNova123' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toMatch(/must_change_password = false/);
    expect(updateCall[1][1]).toBe('u-1');
  });
});
