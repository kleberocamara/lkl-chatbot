// tests/modules/nfe.test.js
jest.mock('../../src/db', () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));

jest.mock('../../src/services/nfe', () => ({
  emitirNfe: jest.fn(),
  gerarDanfe: jest.fn().mockResolvedValue('/uploads/nfe/CHAVE123.pdf'),
}));

const service = require('../../src/modules/nfe/service');
const db = require('../../src/db');
const nfeSvc = require('../../src/services/nfe');

const ORC_BASE = {
  id: 1, numero: 42, status: 'aprovado', status_pagamento: 'pago',
  cliente_nome: 'Empresa Teste LTDA', cpf_cnpj: '12.345.678/0001-90',
  logradouro: 'RUA TESTE', c_numero: '100', complemento: '',
  bairro: 'CENTRO', cep: '25000-000', municipio: 'Duque de Caxias',
  uf: 'RJ', celular: '21999999999', cliente_ie: '', boleto_vencimento: null, pago_em: null,
};

const ITENS = [
  { id: 1, codigo: 1, descricao: 'FOLHAS A4', unidade: 'UN', quantidade: '1000', valor_unitario: '0.21', valor_total: '210.00' },
];

const BODY = {
  cnpj_emitente: '19296723000108',
  cfop: '5101',
  ncm_por_item: { '1': '49111090' },
  frete_por_conta: '9',
  frete_valor: 0,
  transportador: null,
};

describe('nfe.service.emitir()', () => {
  let mockClient;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = { query: jest.fn(), release: jest.fn() };
    db.pool.connect.mockResolvedValue(mockClient);
    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ ultimo_numero: 1 }] }) // UPDATE sequencia
      .mockResolvedValueOnce({}); // COMMIT
  });

  it('retorna erro se orçamento não encontrado', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await service.emitir(999, BODY);
    expect(res.erro[0]).toMatch(/não encontrado/);
  });

  it('retorna erro se orçamento não está aprovado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...ORC_BASE, status: 'rascunho' }] });
    const res = await service.emitir(1, BODY);
    expect(res.erro[0]).toMatch(/aprovado/);
  });

  it('retorna erro se nenhuma OS entregue', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [ORC_BASE] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });
    const res = await service.emitir(1, BODY);
    expect(res.erro[0]).toMatch(/OS entregue/);
  });

  it('retorna erro se NCM faltando para item', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [ORC_BASE] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: ITENS });
    const res = await service.emitir(1, { ...BODY, ncm_por_item: {} });
    expect(res.erro[0]).toMatch(/NCM/);
  });

  it('retorna erro se cnpj_emitente inválido', async () => {
    const res = await service.emitir(1, { ...BODY, cnpj_emitente: '00000000000000' });
    expect(res.erro[0]).toMatch(/inválido/);
  });

  it('emite NF-e com sucesso e salva no banco', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [ORC_BASE] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: ITENS })
      .mockResolvedValueOnce({ rows: [{ id: 10 }] })
      .mockResolvedValueOnce({ rows: [] });

    nfeSvc.emitirNfe.mockResolvedValue({
      status: 'autorizada',
      chave: '3321101929672300010855001000000001',
      protocolo: '333210165743554',
      xml: '<NFe/>',
    });

    const res = await service.emitir(1, BODY);
    expect(res.status).toBe('autorizada');
    expect(res.chave).toBeDefined();
    expect(res.danfe_url).toMatch(/\/uploads\/nfe\//);
  });

  it('salva rejeição SEFAZ e retorna erro', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [ORC_BASE] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({ rows: ITENS })
      .mockResolvedValueOnce({ rows: [{ id: 10 }] })
      .mockResolvedValueOnce({ rows: [] });

    nfeSvc.emitirNfe.mockResolvedValue({
      status: 'rejeitada',
      c_stat: '562',
      x_motivo: 'Valor do Desconto superior ao Valor do Item',
      erro: 'Rejeição 562: Valor do Desconto superior ao Valor do Item',
    });

    const res = await service.emitir(1, BODY);
    expect(res.erro[0]).toMatch(/Rejeição/);
  });
});
