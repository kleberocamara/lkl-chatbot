jest.mock('../src/modules/portal-fornecedor/submissao-service', () => ({
  listarFila: jest.fn(), buscarSubmissaoDetalhe: jest.fn(), aprovarDadoBancario: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const submissaoService = require('../src/modules/portal-fornecedor/submissao-service');
const fornecedorSubmissoesRouter = require('../src/modules/fornecedor-submissoes/router');

// requireRole (usado no POST de aprovação) re-verifica o JWT por conta própria,
// então o "usuário" do teste precisa ser um token real, não só req.user injetado.
function tokenPara(role) {
  return jwt.sign({ id: 'user-1', role }, process.env.JWT_SECRET);
}

function appComRole(role) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'user-1', role }; next(); });
  app.use('/fornecedor-submissoes', fornecedorSubmissoesRouter);
  return app;
}

function postComRole(app, role, path) {
  return request(app).post(path).set('Authorization', `Bearer ${tokenPara(role)}`);
}

describe('GET /fornecedor-submissoes', () => {
  afterEach(() => jest.clearAllMocks());

  test('lista a fila', async () => {
    submissaoService.listarFila.mockResolvedValueOnce([{ id: 'sub-1' }]);
    const res = await request(appComRole('atendente')).get('/fornecedor-submissoes');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('filtra por status via query param', async () => {
    submissaoService.listarFila.mockResolvedValueOnce([]);
    await request(appComRole('atendente')).get('/fornecedor-submissoes?status=alerta_dado_bancario');
    expect(submissaoService.listarFila).toHaveBeenCalledWith({ status: 'alerta_dado_bancario' });
  });
});

describe('POST /fornecedor-submissoes/:id/aprovar-dado-bancario', () => {
  afterEach(() => jest.clearAllMocks());

  test('admin consegue aprovar', async () => {
    submissaoService.aprovarDadoBancario.mockResolvedValueOnce({ ok: true });
    const res = await postComRole(appComRole('admin'), 'admin', '/fornecedor-submissoes/sub-1/aprovar-dado-bancario');
    expect(res.status).toBe(200);
  });

  test('atendente NÃO consegue aprovar (403)', async () => {
    const res = await postComRole(appComRole('atendente'), 'atendente', '/fornecedor-submissoes/sub-1/aprovar-dado-bancario');
    expect(res.status).toBe(403);
    expect(submissaoService.aprovarDadoBancario).not.toHaveBeenCalled();
  });
});
