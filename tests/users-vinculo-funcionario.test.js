const express = require('express');
const request = require('supertest');

const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../src/db/index', () => ({
  query: jest.fn(),
  pool: { connect: jest.fn(() => mockClient) },
}));
jest.mock('../src/middleware/auth', () => ({
  requireRole: () => (req, res, next) => next(),
}));

const usersRouter = require('../src/modules/users/router');

const app = express();
app.use(express.json());
app.use('/users', usersRouter);

describe('POST /users — vincula usuario a funcionario existente', () => {
  afterEach(() => jest.clearAllMocks());

  test('sem funcionario_id → 400', async () => {
    const res = await request(app).post('/users').send({ email: 'a@a.com', password: '123456' });
    expect(res.status).toBe(400);
  });

  test('funcionario inexistente → 404 e ROLLBACK', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT funcionario
      .mockResolvedValueOnce({}); // ROLLBACK

    const res = await request(app).post('/users').send({ funcionario_id: 'f-x', email: 'a@a.com', password: '123456' });

    expect(res.status).toBe(404);
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
  });

  test('funcionario ja vinculado a outro usuario → 409', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'f-1', nome: 'Bruna', celular: null, setor: null, user_id: 'u-existente' }] })
      .mockResolvedValueOnce({}); // ROLLBACK

    const res = await request(app).post('/users').send({ funcionario_id: 'f-1', email: 'a@a.com', password: '123456' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/já possui um usuário vinculado/);
  });

  test('funcionario livre → cria usuario reaproveitando nome/celular/setor/matricula e linka de volta', async () => {
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'f-1', nome: 'Bruna Bessa Santos', celular: '21999999999', setor: 'Atendimento', user_id: null } ] })
      .mockResolvedValueOnce({ rows: [{ id: 'u-novo', name: 'Bruna Bessa Santos', email: 'bruna@lkl.com', role: 'atendente', matricula: 'LKL-004', setor: 'Atendimento', celular: '21999999999' }] }) // INSERT users
      .mockResolvedValueOnce({}) // UPDATE funcionarios
      .mockResolvedValueOnce({}); // COMMIT

    const res = await request(app).post('/users').send({ funcionario_id: 'f-1', email: 'bruna@lkl.com', password: '123456', role: 'atendente' });

    expect(res.status).toBe(201);
    expect(res.body.matricula).toBe('LKL-004');
    const insertCall = mockClient.query.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO users/);
    expect(insertCall[1]).toEqual(['Bruna Bessa Santos', 'bruna@lkl.com', expect.any(String), 'atendente', 'Atendimento', '21999999999', 'f-1']);
    const updateCall = mockClient.query.mock.calls[3];
    expect(updateCall[0]).toMatch(/UPDATE funcionarios SET user_id/);
    expect(updateCall[1]).toEqual(['u-novo', 'f-1']);
  });
});
