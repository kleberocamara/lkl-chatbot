jest.mock('../src/db', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock('../src/modules/portal-fornecedor/bot-verificacao', () => ({ verificarSubmissao: jest.fn() }));

function mockClient(queryImpl) {
  return { query: jest.fn(queryImpl), release: jest.fn() };
}

const db = require('../src/db');
const botVerificacao = require('../src/modules/portal-fornecedor/bot-verificacao');
const submissaoService = require('../src/modules/portal-fornecedor/submissao-service');

beforeEach(() => jest.clearAllMocks());

describe('criarSubmissao', () => {
  test('sem alertas → status aguardando_entrega', async () => {
    botVerificacao.verificarSubmissao.mockResolvedValueOnce({ alertas: [] });
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO fornecedor_submissoes')) return Promise.resolve({ rows: [{ id: 'sub-1' }] });
      if (sql.startsWith('INSERT INTO fornecedor_submissao_itens')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await submissaoService.criarSubmissao('forn-1', {
      nnf: '4521', valor_total: 425, tipo_pagamento: 'pix', pix_chave: 'contato@vinilline.com.br',
      itens: [{ produto: 'Vinil', quantidade: 50, valor_unitario: 8.5, valor_total: 425 }], boletos: [],
    });

    expect(r.submissao.id).toBe('sub-1');
    const insertSubmissao = client.query.mock.calls.find(c => c[0].startsWith('INSERT INTO fornecedor_submissoes'));
    expect(insertSubmissao[0]).toContain("'aguardando_entrega'");
  });

  test('com alerta dado_bancario_mudou → status alerta_dado_bancario', async () => {
    botVerificacao.verificarSubmissao.mockResolvedValueOnce({ alertas: ['dado_bancario_mudou'] });
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO fornecedor_submissoes')) return Promise.resolve({ rows: [{ id: 'sub-2' }] });
      if (sql.startsWith('INSERT INTO fornecedor_submissao_itens')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await submissaoService.criarSubmissao('forn-1', {
      nnf: '4522', valor_total: 100, tipo_pagamento: 'ted', ted_banco_codigo: '341',
      itens: [], boletos: [],
    });

    const insertSubmissao = client.query.mock.calls.find(c => c[0].startsWith('INSERT INTO fornecedor_submissoes'));
    expect(insertSubmissao[0]).toContain("'alerta_dado_bancario'");
  });

  test('com alerta de formato/duplicidade (não bancário) → status pendente', async () => {
    botVerificacao.verificarSubmissao.mockResolvedValueOnce({ alertas: ['duplicidade_nf'] });
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO fornecedor_submissoes')) return Promise.resolve({ rows: [{ id: 'sub-3' }] });
      if (sql.startsWith('INSERT INTO fornecedor_submissao_itens')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await submissaoService.criarSubmissao('forn-1', {
      nnf: '4521', valor_total: 425, tipo_pagamento: 'pix', pix_chave: 'x', itens: [], boletos: [],
    });

    const insertSubmissao = client.query.mock.calls.find(c => c[0].startsWith('INSERT INTO fornecedor_submissoes'));
    expect(insertSubmissao[0]).toContain("'pendente'");
  });
});

describe('listarFila', () => {
  test('sem filtro → lista todas ordenadas por criada_em desc', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'sub-1' }, { id: 'sub-2' }] });
    const r = await submissaoService.listarFila({});
    expect(r).toHaveLength(2);
    expect(db.query.mock.calls[0][0]).toMatch(/ORDER BY s.criada_em DESC/);
  });

  test('com filtro de status → adiciona WHERE', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await submissaoService.listarFila({ status: 'alerta_dado_bancario' });
    expect(db.query.mock.calls[0][0]).toMatch(/WHERE s.status = \$1/);
    expect(db.query.mock.calls[0][1]).toEqual(['alerta_dado_bancario']);
  });
});

describe('aprovarDadoBancario', () => {
  test('muda status de alerta_dado_bancario para aguardando_entrega', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'sub-1' }] });
    const r = await submissaoService.aprovarDadoBancario('sub-1', 'user-1');
    expect(r.ok).toBe(true);
    expect(db.query.mock.calls[0][0]).toMatch(/UPDATE fornecedor_submissoes SET status = 'aguardando_entrega'/);
  });

  test('submissão não encontrada ou não está em alerta → erro', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await submissaoService.aprovarDadoBancario('sub-999', 'user-1');
    expect(r.erro).toEqual(['Submissão não encontrada ou não está aguardando aprovação de dado bancário']);
  });
});
