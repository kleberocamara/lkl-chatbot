jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');
const { verificarSubmissao } = require('../src/modules/portal-fornecedor/bot-verificacao');

beforeEach(() => jest.clearAllMocks());

describe('verificarSubmissao', () => {
  test('PIX com chave em formato inválido → alerta pix_formato_invalido', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // duplicidade
      .mockResolvedValueOnce({ rows: [] }); // última aprovada (não existe ainda)

    const r = await verificarSubmissao('forn-1', {
      nnf: '4521', tipo_pagamento: 'pix', pix_chave: 'abc', boletos: [],
    });

    expect(r.alertas).toContain('pix_formato_invalido');
  });

  test('mesma NF já submetida pelo fornecedor → alerta duplicidade_nf', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'sub-antiga' }] }) // duplicidade encontrada
      .mockResolvedValueOnce({ rows: [] });

    const r = await verificarSubmissao('forn-1', {
      nnf: '4521', tipo_pagamento: 'pix', pix_chave: 'contato@vinilline.com.br', boletos: [],
    });

    expect(r.alertas).toContain('duplicidade_nf');
  });

  test('TED com dado bancário diferente da última aprovada → alerta dado_bancario_mudou', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // duplicidade
      .mockResolvedValueOnce({ rows: [{ ted_banco_codigo: '001', ted_agencia: '1234', ted_conta: '55667-8', ted_documento: '12345678000199', pix_chave: null }] });

    const r = await verificarSubmissao('forn-1', {
      nnf: '4522', tipo_pagamento: 'ted', ted_banco_codigo: '341', ted_agencia: '1234', ted_conta: '55667-8', ted_documento: '12345678000199', boletos: [],
    });

    expect(r.alertas).toContain('dado_bancario_mudou');
  });

  test('TED com dado bancário igual à última aprovada → sem alerta de mudança', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ted_banco_codigo: '341', ted_agencia: '1234', ted_conta: '55667-8', ted_documento: '12345678000199', pix_chave: null }] });

    const r = await verificarSubmissao('forn-1', {
      nnf: '4522', tipo_pagamento: 'ted', ted_banco_codigo: '341', ted_agencia: '1234', ted_conta: '55667-8', ted_documento: '12345678000199', boletos: [],
    });

    expect(r.alertas).not.toContain('dado_bancario_mudou');
  });

  test('primeira submissão do fornecedor (sem histórico aprovado) → sem alerta de mudança', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // nenhuma aprovada ainda

    const r = await verificarSubmissao('forn-1', {
      nnf: '4523', tipo_pagamento: 'pix', pix_chave: 'contato@vinilline.com.br', boletos: [],
    });

    expect(r.alertas).not.toContain('dado_bancario_mudou');
  });

  test('boleto com linha digitável em formato inválido → alerta boleto_linha_invalida', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const r = await verificarSubmissao('forn-1', {
      nnf: '4524', tipo_pagamento: 'boleto', boletos: [{ linha_digitavel: '123' }],
    });

    expect(r.alertas).toContain('boleto_linha_invalida');
  });

  test('boleto não precisa consultar dado bancário (só pix/ted checam mudança)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // só a checagem de duplicidade

    await verificarSubmissao('forn-1', {
      nnf: '4525', tipo_pagamento: 'boleto',
      boletos: [{ linha_digitavel: '34191790010104351004791020150008291070026000' }],
    });

    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
