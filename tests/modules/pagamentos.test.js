// tests/modules/pagamentos.test.js
const service = require('../../src/modules/orcamentos/service');

jest.mock('../../src/services/c6bank', () => ({
  emitirBoleto: jest.fn().mockResolvedValue({
    boletoId: 'BOLETO-001',
    linhaDigitavel: '12345.67890 12345.678901 12345.678901 1 12340000010000',
    pdfUrl: 'https://example.com/boleto.pdf',
    dataVencimento: '2026-07-01',
  }),
  criarPixCobranca: jest.fn().mockResolvedValue({
    txid: 'TXID001',
    pixCopiaECola: '00020126330014br.gov.bcb.pix01110b3a4612',
    qrCodeBase64: null,
  }),
}));

jest.mock('../../src/db', () => ({
  query: jest.fn(),
}));

const db = require('../../src/db');

describe('cobrar()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('retorna erro se orçamento não encontrado', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await service.cobrar('uuid-inexistente', 'boleto');
    expect(res.erro).toBeDefined();
    expect(res.erro[0]).toMatch(/não encontrado/);
  });

  it('retorna erro se orçamento não está aprovado', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'uuid', status: 'rascunho', status_pagamento: 'pendente' }] });
    const res = await service.cobrar('uuid', 'boleto');
    expect(res.erro[0]).toMatch(/aprovado/);
  });

  it('retorna erro se tipo inválido', async () => {
    const res = await service.cobrar('uuid', 'cartao');
    expect(res.erro[0]).toMatch(/boleto.*pix/i);
  });
});

describe('confirmarPagamento()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
  });

  it('retorna erro se orçamento não encontrado por txid', async () => {
    const res = await service.confirmarPagamento({ tipo: 'pix', txid: 'NAO_EXISTE' });
    expect(res.erro).toBeDefined();
  });
});
