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
    const r = await service.criarParcelado({ descricao: 'Compra tintas', tipo_despesa_id: 2 });
    expect(r.erro).toEqual(expect.arrayContaining([expect.stringContaining('obrigat')]));
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('menos de 2 parcelas → erro', async () => {
    const r = await service.criarParcelado({
      descricao: 'Compra tintas', tipo_despesa_id: 2,
      parcelas: [{ vencimento: '2026-08-10', valor: 900 }],
    });
    expect(r.erro).toBeDefined();
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('parcela sem vencimento ou valor → erro', async () => {
    const r = await service.criarParcelado({
      descricao: 'Compra tintas', tipo_despesa_id: 2,
      parcelas: [{ vencimento: '2026-08-10', valor: 350 }, { valor: 350 }],
    });
    expect(r.erro).toEqual(expect.arrayContaining([expect.stringContaining('parcela 2')]));
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('2 parcelas com prazos irregulares (nota Evolution: 28 e 35 dias) → grava exatamente como veio', async () => {
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

    const r = await service.criarParcelado({
      descricao: 'Pedido 26/0471/05/1', fornecedor: 'Evolution Engeplotter', fornecedor_id: null,
      tipo_despesa_id: 2, competencia: '2026-05-27', tipo: 'boleto',
      parcelas: [
        { vencimento: '2026-06-24', valor: 350, linha_digitavel: '00190000090123456789012345678901234567890123' },
        { vencimento: '2026-07-01', valor: 350, linha_digitavel: '00190000090123456789012345678901234567890124' },
      ],
    });

    expect(r.criadas).toHaveLength(2);
    expect(linhasInseridas).toHaveLength(2);
    // [4]=valor [5]=vencimento [7]=linha_digitavel [8]=competencia [9]=parcela_grupo_id
    expect(linhasInseridas[0][5]).toBe('2026-06-24');
    expect(linhasInseridas[0][4]).toBe(350);
    expect(linhasInseridas[0][7]).toBe('00190000090123456789012345678901234567890123');
    expect(linhasInseridas[1][5]).toBe('2026-07-01');
    expect(linhasInseridas[1][7]).toBe('00190000090123456789012345678901234567890124');
    const grupoIds = linhasInseridas.map(p => p[9]);
    expect(new Set(grupoIds).size).toBe(1);
    const competencias = linhasInseridas.map(p => p[8]);
    expect(competencias.every(c => c === '2026-05-27')).toBe(true);
  });

  test('linha_digitavel ausente em uma parcela → grava null, não é obrigatória', async () => {
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

    const r = await service.criarParcelado({
      descricao: 'Compra X', tipo_despesa_id: 1,
      parcelas: [{ vencimento: '2026-08-01', valor: 50 }, { vencimento: '2026-09-01', valor: 50 }],
    });

    expect(r.criadas).toHaveLength(2);
    expect(linhasInseridas[0][7]).toBeNull();
  });

  test('sem competencia informada → usa CURRENT_DATE (data de hoje) como fallback', async () => {
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

    const { format } = require('date-fns');
    const hoje = format(new Date(), 'yyyy-MM-dd');

    await service.criarParcelado({
      descricao: 'Compra X', tipo_despesa_id: 1,
      parcelas: [{ vencimento: '2026-08-01', valor: 50 }, { vencimento: '2026-09-01', valor: 50 }],
    });

    expect(linhasInseridas[0][8]).toBe(hoje);
  });
});
