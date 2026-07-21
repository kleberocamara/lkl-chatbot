jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/modules/portal-fornecedor/auth-service', () => ({ criarConvite: jest.fn() }));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';

const db = require('../src/db');
const authService = require('../src/modules/portal-fornecedor/auth-service');
const fornecedoresRouter = require('../src/modules/fornecedores/router');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 'user-1', role: 'admin' }; next(); });
app.use('/fornecedores', fornecedoresRouter);

describe('POST /fornecedores/:id/portal/liberar', () => {
  afterEach(() => jest.clearAllMocks());

  test('libera o portal e retorna o link de convite', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'forn-1', nome: 'Vinil Line' }] }); // busca fornecedor
    authService.criarConvite.mockResolvedValueOnce({ conviteToken: 'abc123' });

    const res = await request(app)
      .post('/fornecedores/forn-1/portal/liberar')
      .send({ email: 'contato@vinilline.com.br' });

    expect(res.status).toBe(200);
    expect(res.body.conviteUrl).toMatch(/\/portal-fornecedor\/definir-senha\.html\?token=abc123$/);
    expect(authService.criarConvite).toHaveBeenCalledWith('forn-1', 'contato@vinilline.com.br');
  });

  test('sem e-mail informado → erro 400', async () => {
    const res = await request(app).post('/fornecedores/forn-1/portal/liberar').send({});
    expect(res.status).toBe(400);
  });
});
