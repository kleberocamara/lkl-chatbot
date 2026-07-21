jest.mock('jsonwebtoken');
const jwt = require('jsonwebtoken');
const { requireAuthFornecedor, requireAuthApi, requireRole } = require('../src/middleware/auth');

function mockReqRes(token) {
  const req = { cookies: {}, headers: { authorization: `Bearer ${token}` }, path: '/x' };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), redirect: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
}

describe('requireAuthFornecedor', () => {
  afterEach(() => jest.clearAllMocks());

  test('token com tipo=fornecedor → passa', () => {
    jwt.verify.mockReturnValueOnce({ tipo: 'fornecedor', fornecedorId: 'uuid-1' });
    const { req, res, next } = mockReqRes('tok');
    requireAuthFornecedor(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('token de funcionário (sem tipo=fornecedor) → rejeitado', () => {
    jwt.verify.mockReturnValueOnce({ id: 'user-1', role: 'admin' });
    const { req, res, next } = mockReqRes('tok');
    requireAuthFornecedor(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('requireAuthApi — rejeita token de fornecedor', () => {
  afterEach(() => jest.clearAllMocks());

  test('token com tipo=fornecedor → rejeitado mesmo com JWT válido', () => {
    jwt.verify.mockReturnValueOnce({ tipo: 'fornecedor', fornecedorId: 'uuid-1' });
    const { req, res, next } = mockReqRes('tok');
    requireAuthApi(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('requireRole — rejeita token de fornecedor', () => {
  afterEach(() => jest.clearAllMocks());

  test('token com tipo=fornecedor → rejeitado mesmo se role bater por acaso', () => {
    jwt.verify.mockReturnValueOnce({ tipo: 'fornecedor', fornecedorId: 'uuid-1', role: 'admin' });
    const { req, res, next } = mockReqRes('tok');
    requireRole('admin')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
