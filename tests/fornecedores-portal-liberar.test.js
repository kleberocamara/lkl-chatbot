jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/modules/portal-fornecedor/auth-service', () => ({ criarConvite: jest.fn() }));
jest.mock('../src/services/email', () => ({ enviarConvitePortalFornecedor: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn() }));

const request = require('supertest');
const express = require('express');

process.env.JWT_SECRET = 'test-secret';
process.env.BASE_URL = 'https://app.graficalkl.com.br';

const db = require('../src/db');
const authService = require('../src/modules/portal-fornecedor/auth-service');
const email = require('../src/services/email');
const whatsapp = require('../src/services/whatsapp');
const fornecedoresRouter = require('../src/modules/fornecedores/router');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 'user-1', role: 'admin' }; next(); });
app.use('/fornecedores', fornecedoresRouter);

describe('POST /fornecedores/:id/portal/liberar', () => {
  afterEach(() => jest.clearAllMocks());

  test('com email e celular cadastrados → libera e envia pelos dois canais', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'forn-1', nome: 'Vinil Line', email: 'contato@vinilline.com.br', celular: '21986449859' }] });
    authService.criarConvite.mockResolvedValueOnce({ conviteToken: 'abc123' });
    email.enviarConvitePortalFornecedor.mockResolvedValueOnce();
    whatsapp.sendMessage.mockResolvedValueOnce();

    const res = await request(app).post('/fornecedores/forn-1/portal/liberar').send({});

    expect(res.status).toBe(200);
    expect(res.body.conviteUrl).toMatch(/\/portal-fornecedor\/definir-senha\.html\?token=abc123$/);
    expect(res.body.enviadoEmail).toBe(true);
    expect(res.body.enviadoWhatsapp).toBe(true);
    expect(res.body.avisos).toEqual([]);
    expect(authService.criarConvite).toHaveBeenCalledWith('forn-1', 'contato@vinilline.com.br');
    expect(email.enviarConvitePortalFornecedor).toHaveBeenCalledWith(expect.objectContaining({
      email: 'contato@vinilline.com.br', nome: 'Vinil Line',
    }));
    expect(whatsapp.sendMessage).toHaveBeenCalledWith('5521986449859', expect.stringContaining('token=abc123'));
  });

  test('sem celular cadastrado → libera, envia só email, avisa da ausência de WhatsApp', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'forn-2', nome: 'Fornecedor Y', email: 'y@x.com', celular: null }] });
    authService.criarConvite.mockResolvedValueOnce({ conviteToken: 'xyz789' });
    email.enviarConvitePortalFornecedor.mockResolvedValueOnce();

    const res = await request(app).post('/fornecedores/forn-2/portal/liberar').send({});

    expect(res.status).toBe(200);
    expect(res.body.enviadoEmail).toBe(true);
    expect(res.body.enviadoWhatsapp).toBe(false);
    expect(res.body.avisos.some(a => /celular/i.test(a))).toBe(true);
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('sem email cadastrado → 400, não cria convite nem envia nada', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'forn-3', nome: 'Fornecedor Z', email: null, celular: '21999998888' }] });

    const res = await request(app).post('/fornecedores/forn-3/portal/liberar').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/e-mail/i);
    expect(authService.criarConvite).not.toHaveBeenCalled();
    expect(email.enviarConvitePortalFornecedor).not.toHaveBeenCalled();
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('falha no envio de email não derruba a rota — convite continua disponível', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'forn-4', nome: 'Fornecedor W', email: 'w@x.com', celular: null } ]});
    authService.criarConvite.mockResolvedValueOnce({ conviteToken: 'fail-email' });
    email.enviarConvitePortalFornecedor.mockRejectedValueOnce(new Error('SMTP indisponível'));

    const res = await request(app).post('/fornecedores/forn-4/portal/liberar').send({});

    expect(res.status).toBe(200);
    expect(res.body.conviteUrl).toMatch(/token=fail-email$/);
    expect(res.body.enviadoEmail).toBe(false);
    expect(res.body.avisos.some(a => /e-mail/i.test(a))).toBe(true);
  });

  test('fornecedor não encontrado → 404', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/fornecedores/inexistente/portal/liberar').send({});
    expect(res.status).toBe(404);
  });
});
