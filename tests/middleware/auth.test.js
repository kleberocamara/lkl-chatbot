const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret-lkl-2026';
const { requireRole, requireAuthApi } = require('../../src/middleware/auth');

function makeReq(role) {
  const token = jwt.sign({ id: '1', role }, process.env.JWT_SECRET);
  return { cookies: { token }, headers: {} };
}

function makeReqComTroca(mustChangePassword, path) {
  const token = jwt.sign({ id: '1', role: 'atendente', mustChangePassword }, process.env.JWT_SECRET);
  return { cookies: { token }, headers: {}, path };
}

function makeRes() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return res;
}

test('requireRole permite role correto', () => {
  const req = makeReq('admin');
  const res = makeRes();
  const next = jest.fn();
  requireRole('admin', 'gestor')(req, res, next);
  expect(next).toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
});

test('requireRole bloqueia role incorreto', () => {
  const req = makeReq('operador');
  const res = makeRes();
  const next = jest.fn();
  requireRole('admin', 'gestor')(req, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});

test('requireRole retorna 401 sem token', () => {
  const req = { cookies: {}, headers: {} };
  const res = makeRes();
  const next = jest.fn();
  requireRole('admin')(req, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
});

describe('requireAuthApi — bloqueio por troca de senha pendente', () => {
  test('mustChangePassword=true bloqueia rota qualquer com 403 MUST_CHANGE_PASSWORD', () => {
    const req = makeReqComTroca(true, '/dashboard/stats');
    const res = makeRes();
    const next = jest.fn();
    requireAuthApi(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'MUST_CHANGE_PASSWORD' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('mustChangePassword=true permite /auth/change-password', () => {
    const req = makeReqComTroca(true, '/auth/change-password');
    const res = makeRes();
    const next = jest.fn();
    requireAuthApi(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('mustChangePassword=true permite /auth/logout', () => {
    const req = makeReqComTroca(true, '/auth/logout');
    const res = makeRes();
    const next = jest.fn();
    requireAuthApi(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('mustChangePassword=false permite qualquer rota', () => {
    const req = makeReqComTroca(false, '/dashboard/stats');
    const res = makeRes();
    const next = jest.fn();
    requireAuthApi(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
