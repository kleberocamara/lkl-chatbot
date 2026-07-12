jest.mock('../src/services/c6bank', () => ({
  consultarPixCobranca: jest.fn(),
  consultarBoleto: jest.fn(),
}));
jest.mock('../src/modules/orcamentos/service', () => ({
  confirmarPagamento: jest.fn(),
}));

const c6bank = require('../src/services/c6bank');
const { confirmarPagamento } = require('../src/modules/orcamentos/service');
const { handleC6Webhook } = require('../src/webhook/c6bank');

function mockRes() {
  return { sendStatus: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.C6_WEBHOOK_SECRET;
});

describe('handleC6Webhook — PIX', () => {
  test('body diz txid pago, mas reconsulta ao C6 mostra status diferente de CONCLUIDA → NÃO confirma pagamento', async () => {
    c6bank.consultarPixCobranca.mockResolvedValueOnce({ status: 'ATIVA' });
    const req = { headers: {}, body: { pix: [{ txid: 'txid-forjado' }] } };
    const res = mockRes();

    await handleC6Webhook(req, res);

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(c6bank.consultarPixCobranca).toHaveBeenCalledWith('txid-forjado');
    expect(confirmarPagamento).not.toHaveBeenCalled();
  });

  test('reconsulta ao C6 confirma status CONCLUIDA → confirma pagamento', async () => {
    c6bank.consultarPixCobranca.mockResolvedValueOnce({ status: 'CONCLUIDA' });
    confirmarPagamento.mockResolvedValueOnce({ confirmado: true, orcamento_id: 'orc-1' });
    const req = { headers: {}, body: { pix: [{ txid: 'txid-real' }] } };
    const res = mockRes();

    await handleC6Webhook(req, res);

    expect(confirmarPagamento).toHaveBeenCalledWith({ tipo: 'pix', txid: 'txid-real' });
  });

  test('falha ao reconsultar C6 → não confirma pagamento (fail-safe)', async () => {
    c6bank.consultarPixCobranca.mockRejectedValueOnce(new Error('timeout'));
    const req = { headers: {}, body: { pix: [{ txid: 'txid-x' }] } };
    const res = mockRes();

    await handleC6Webhook(req, res);

    expect(confirmarPagamento).not.toHaveBeenCalled();
  });
});

describe('handleC6Webhook — Boleto', () => {
  test('body diz LIQUIDADO, mas reconsulta ao C6 mostra outro status → NÃO confirma pagamento (bloqueia forjamento)', async () => {
    c6bank.consultarBoleto.mockResolvedValueOnce({ status: 'REGISTERED' });
    const req = { headers: {}, body: { boletoId: 'boleto-forjado', status: 'LIQUIDADO' } };
    const res = mockRes();

    await handleC6Webhook(req, res);

    expect(c6bank.consultarBoleto).toHaveBeenCalledWith('boleto-forjado');
    expect(confirmarPagamento).not.toHaveBeenCalled();
  });

  test('reconsulta ao C6 confirma LIQUIDADO → confirma pagamento', async () => {
    c6bank.consultarBoleto.mockResolvedValueOnce({ status: 'LIQUIDADO' });
    confirmarPagamento.mockResolvedValueOnce({ confirmado: true, orcamento_id: 'orc-2' });
    const req = { headers: {}, body: { boletoId: 'boleto-real', status: 'LIQUIDADO' } };
    const res = mockRes();

    await handleC6Webhook(req, res);

    expect(confirmarPagamento).toHaveBeenCalledWith({ tipo: 'boleto', boletoId: 'boleto-real' });
  });

  test('body sem status LIQUIDADO mas reconsulta confirma pago → confirma mesmo assim (body é só sinal, não fonte de verdade)', async () => {
    c6bank.consultarBoleto.mockResolvedValueOnce({ status: 'LIQUIDADO' });
    confirmarPagamento.mockResolvedValueOnce({ confirmado: true, orcamento_id: 'orc-3' });
    const req = { headers: {}, body: { boletoId: 'boleto-y', status: 'REGISTERED' } };
    const res = mockRes();

    await handleC6Webhook(req, res);

    expect(confirmarPagamento).toHaveBeenCalledWith({ tipo: 'boleto', boletoId: 'boleto-y' });
  });
});

describe('handleC6Webhook — assinatura (quando C6_WEBHOOK_SECRET configurado)', () => {
  test('assinatura ausente → 401, não processa', async () => {
    process.env.C6_WEBHOOK_SECRET = 'segredo';
    const req = { headers: {}, body: { boletoId: 'x', status: 'LIQUIDADO' } };
    const res = mockRes();

    await handleC6Webhook(req, res);

    expect(res.sendStatus).toHaveBeenCalledWith(401);
    expect(c6bank.consultarBoleto).not.toHaveBeenCalled();
  });

  test('assinatura inválida → 403, não processa', async () => {
    process.env.C6_WEBHOOK_SECRET = 'segredo';
    const req = { headers: { 'x-webhook-signature': 'sha256=invalida' }, body: { boletoId: 'x', status: 'LIQUIDADO' } };
    const res = mockRes();

    await handleC6Webhook(req, res);

    expect(res.sendStatus).toHaveBeenCalledWith(403);
    expect(c6bank.consultarBoleto).not.toHaveBeenCalled();
  });

  test('assinatura válida → processa normalmente', async () => {
    const crypto = require('crypto');
    process.env.C6_WEBHOOK_SECRET = 'segredo';
    const body = { boletoId: 'x', status: 'LIQUIDADO' };
    const sig = crypto.createHmac('sha256', 'segredo').update(JSON.stringify(body)).digest('hex');
    c6bank.consultarBoleto.mockResolvedValueOnce({ status: 'LIQUIDADO' });
    confirmarPagamento.mockResolvedValueOnce({ confirmado: true, orcamento_id: 'orc-4' });
    const req = { headers: { 'x-webhook-signature': `sha256=${sig}` }, body };
    const res = mockRes();

    await handleC6Webhook(req, res);

    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(confirmarPagamento).toHaveBeenCalledWith({ tipo: 'boleto', boletoId: 'x' });
  });
});
