const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret-lkl-2026';
const { requireRole } = require('../../src/middleware/auth');

function makeReq(role) {
  const token = jwt.sign({ id: '1', role }, process.env.JWT_SECRET);
  return { cookies: { token }, headers: {} };
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
