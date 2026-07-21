jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('bcryptjs', () => ({ hash: jest.fn(), compare: jest.fn() }));
jest.mock('jsonwebtoken', () => ({ sign: jest.fn() }));
jest.mock('crypto', () => ({ randomBytes: jest.fn(() => ({ toString: () => 'token-gerado-64chars' })) }));

const db = require('../src/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authService = require('../src/modules/portal-fornecedor/auth-service');

beforeEach(() => jest.clearAllMocks());

describe('criarConvite', () => {
  test('gera token, grava e-mail + expira em 7 dias, marca portal_liberado', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // upsert fornecedor_logins
      .mockResolvedValueOnce({ rows: [] }); // update fornecedores.portal_liberado

    const r = await authService.criarConvite('forn-1', 'contato@vinilline.com.br');

    expect(r.conviteToken).toBe('token-gerado-64chars');
    const insert = db.query.mock.calls[0];
    expect(insert[0]).toMatch(/INSERT INTO fornecedor_logins/);
    expect(insert[1]).toEqual(['forn-1', 'contato@vinilline.com.br', 'token-gerado-64chars']);
  });
});

describe('definirSenha', () => {
  test('token válido e não expirado → grava hash e limpa o convite', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'login-1', convite_expira: new Date(Date.now() + 3600_000).toISOString() }],
    });
    bcrypt.hash.mockResolvedValueOnce('hash-da-senha');

    const r = await authService.definirSenha('token-valido', 'MinhaSenh@123');

    expect(r.ok).toBe(true);
    const update = db.query.mock.calls[1];
    expect(update[0]).toMatch(/UPDATE fornecedor_logins SET senha_hash/);
    expect(update[1]).toEqual(['hash-da-senha', 'login-1']);
  });

  test('token expirado → erro', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'login-1', convite_expira: new Date(Date.now() - 3600_000).toISOString() }],
    });
    const r = await authService.definirSenha('token-expirado', 'MinhaSenh@123');
    expect(r.erro).toEqual(['Convite expirado — peça um novo à Gráfica LKL']);
  });

  test('token inexistente → erro', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await authService.definirSenha('token-invalido', 'MinhaSenh@123');
    expect(r.erro).toEqual(['Convite inválido']);
  });
});

describe('login', () => {
  test('credenciais corretas → retorna token JWT com tipo=fornecedor', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'login-1', fornecedor_id: 'forn-1', senha_hash: 'hash', ativo: true }],
    });
    bcrypt.compare.mockResolvedValueOnce(true);
    jwt.sign.mockReturnValueOnce('jwt-assinado');

    const r = await authService.login('contato@vinilline.com.br', 'MinhaSenh@123');

    expect(r.token).toBe('jwt-assinado');
    expect(jwt.sign.mock.calls[0][0]).toEqual(expect.objectContaining({ tipo: 'fornecedor', fornecedorId: 'forn-1' }));
  });

  test('senha errada → erro', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'login-1', senha_hash: 'hash', ativo: true }] });
    bcrypt.compare.mockResolvedValueOnce(false);
    const r = await authService.login('contato@vinilline.com.br', 'errada');
    expect(r.erro).toEqual(['Credenciais inválidas']);
  });

  test('login sem senha definida ainda (convite pendente) → erro', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'login-1', senha_hash: null, ativo: true }] });
    const r = await authService.login('contato@vinilline.com.br', 'qualquer');
    expect(r.erro).toEqual(['Credenciais inválidas']);
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });
});
