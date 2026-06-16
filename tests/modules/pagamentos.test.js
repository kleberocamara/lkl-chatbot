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
  pool: {
    connect: jest.fn(),
  },
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

describe('cobrar() happy paths', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emite boleto e atualiza orcamento', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'uuid1', status: 'aprovado', status_pagamento: 'pendente', numero: 5, cliente_nome: 'Maria', cliente_cpf_cnpj: '12345678000195', valor_total_calculado: '150.00' }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE orcamentos
    const res = await service.cobrar('uuid1', 'boleto');
    expect(res.tipo).toBe('boleto');
    expect(res.linhaDigitavel).toBeDefined();
    expect(res.valor).toBe(150);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('emite PIX e atualiza orcamento', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'uuid2', status: 'aprovado', status_pagamento: 'pendente', numero: 6, cliente_nome: 'João', cliente_cpf_cnpj: '12345678000195', valor_total_calculado: '200.00' }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE orcamentos
    const res = await service.cobrar('uuid2', 'pix');
    expect(res.tipo).toBe('pix');
    expect(res.pixCopiaECola).toBeDefined();
    expect(res.valor).toBe(200);
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

describe('confirmarPagamento() happy path', () => {
  beforeEach(() => jest.clearAllMocks());

  it('confirma pagamento PIX e atualiza orcamento e OSs', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    db.pool.connect.mockResolvedValue(mockClient);
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid3' }] }); // find by txid

    const res = await service.confirmarPagamento({ tipo: 'pix', txid: 'TXID001' });
    expect(res.confirmado).toBe(true);
    expect(res.orcamento_id).toBe('uuid3');
  });
});
