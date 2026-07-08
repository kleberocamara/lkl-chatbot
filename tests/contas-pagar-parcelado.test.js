const db = require('../src/db');
jest.mock('../src/db', () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));

const service = require('../src/modules/contas-pagar/service');

function mockClient(queryImpl) {
  return { query: jest.fn(queryImpl), release: jest.fn() };
}

describe('criarParcelado', () => {
  afterEach(() => jest.clearAllMocks());

  test('campos obrigatórios faltando → erro, sem abrir transação', async () => {
    const r = await service.criarParcelado({ descricao: 'Compra tintas', tipo_despesa_id: 2, valor_total: 900 });
    expect(r.erro).toEqual(expect.arrayContaining([expect.stringContaining('obrigat')]));
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('parcelas < 2 → erro', async () => {
    const r = await service.criarParcelado({
      descricao: 'Compra tintas', tipo_despesa_id: 2, valor_total: 900, parcelas: 1, primeiro_vencimento: '2026-08-10',
    });
    expect(r.erro).toBeDefined();
  });

  test('3 parcelas de R$300 → 3 linhas, mesma competência e parcela_grupo_id, vencimentos mensais', async () => {
    const linhasInseridas = [];
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        linhasInseridas.push(params);
        return Promise.resolve({ rows: [{ id: linhasInseridas.length, valor: params[4], vencimento: params[5] }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarParcelado({
      descricao: 'Compra de tintas e solventes', fornecedor: 'Evolution', fornecedor_id: null,
      tipo_despesa_id: 2, valor_total: 900, parcelas: 3, primeiro_vencimento: '2026-08-10', tipo: 'boleto',
    });

    expect(r.criadas).toHaveLength(3);
    expect(linhasInseridas).toHaveLength(3);
    const somaParcelas = linhasInseridas.reduce((s, p) => s + p[4], 0);
    expect(somaParcelas).toBeCloseTo(900, 2);
    const grupoIds = linhasInseridas.map(p => p[8]);
    expect(new Set(grupoIds).size).toBe(1); // mesmo parcela_grupo_id
    const competencias = linhasInseridas.map(p => p[7]);
    expect(new Set(competencias).size).toBe(1); // mesma competência
    expect(linhasInseridas[0][5]).toBe('2026-08-10');
    expect(linhasInseridas[1][5]).toBe('2026-09-10');
    expect(linhasInseridas[2][5]).toBe('2026-10-10');
  });

  test('valor não divisível igualmente → ajuste de centavos fica na última parcela, soma bate exato', async () => {
    const linhasInseridas = [];
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        linhasInseridas.push(params);
        return Promise.resolve({ rows: [{ id: linhasInseridas.length }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await service.criarParcelado({
      descricao: 'Compra X', tipo_despesa_id: 1, valor_total: 100, parcelas: 3, primeiro_vencimento: '2026-08-01',
    });

    const soma = linhasInseridas.reduce((s, p) => s + p[4], 0);
    expect(Math.round(soma * 100) / 100).toBe(100);
  });
});
