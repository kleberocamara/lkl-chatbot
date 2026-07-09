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

  test('sem tipo_despesa_id (classificador não identificou) → cria mesmo assim com status pendente_classificacao', async () => {
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
      descricao: 'Nota NF-e via WhatsApp', fornecedor: 'Fornecedor X', fornecedor_id: null,
      tipo_despesa_id: null,
      parcelas: [
        { vencimento: '2026-08-10', valor: 500 },
        { vencimento: '2026-09-10', valor: 500 },
      ],
    });

    expect(r.erro).toBeUndefined();
    expect(r.criadas).toHaveLength(2);
    expect(linhasInseridas).toHaveLength(2);
    // params: [1]descricao [2]fornecedor [3]fornecedor_id [4]tipo_despesa_id ... status deve ser 'pendente_classificacao'
    linhasInseridas.forEach(params => {
      expect(params).toContain('pendente_classificacao');
    });
  });
});

describe('converterEmParcelado', () => {
  afterEach(() => jest.clearAllMocks());

  test('conta não encontrada → erro', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await service.converterEmParcelado(999, { parcelas: [{ vencimento: '2026-08-01', valor: 50 }, { vencimento: '2026-09-01', valor: 50 }] });
    expect(r.erro).toEqual(expect.arrayContaining([expect.stringContaining('não encontrada')]));
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('conta já paga → erro, sem apagar nada', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 5, status: 'pago', c6_group_id: null }] });
    const r = await service.converterEmParcelado(5, { parcelas: [{ vencimento: '2026-08-01', valor: 50 }, { vencimento: '2026-09-01', valor: 50 }] });
    expect(r.erro).toEqual(expect.arrayContaining([expect.stringContaining('não é possível parcelar')]));
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('conta em lote C6 (c6_group_id preenchido) → erro, sem apagar nada', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 6, status: 'agendado', c6_group_id: 'grupo-123' }] });
    const r = await service.converterEmParcelado(6, { parcelas: [{ vencimento: '2026-08-01', valor: 50 }, { vencimento: '2026-09-01', valor: 50 }] });
    expect(r.erro).toEqual(expect.arrayContaining([expect.stringContaining('não é possível parcelar')]));
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('menos de 2 parcelas → erro, sem apagar nada', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 7, status: 'pendente', c6_group_id: null }] });
    const r = await service.converterEmParcelado(7, { parcelas: [{ vencimento: '2026-08-01', valor: 50 }] });
    expect(r.erro).toBeDefined();
    expect(db.pool.connect).not.toHaveBeenCalled();
  });

  test('conta elegível → apaga a original e cria N novas na mesma transação', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 8, status: 'pendente', c6_group_id: null, descricao: 'Nota Evolution',
        fornecedor: 'Evolution', fornecedor_id: null, tipo_despesa_id: 2, tipo: 'boleto',
        competencia: '2026-05-27', observacao: null,
      }],
    });
    const queries = [];
    const client = mockClient((sql, params) => {
      queries.push(sql.split('\n')[0].trim());
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('DELETE FROM contas_pagar')) return Promise.resolve({ rowCount: 1 });
      if (sql.startsWith('INSERT INTO contas_pagar')) return Promise.resolve({ rows: [{ id: queries.length }] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.converterEmParcelado(8, {
      parcelas: [
        { vencimento: '2026-06-24', valor: 350 },
        { vencimento: '2026-07-01', valor: 350 },
      ],
    });

    expect(r.criadas).toHaveLength(2);
    const deleteIndex = queries.findIndex(q => q.startsWith('DELETE'));
    const insertIndexes = queries.map((q, i) => q.startsWith('INSERT') ? i : -1).filter(i => i !== -1);
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndexes.every(i => i > deleteIndex)).toBe(true);
  });

  test('falha na criação das novas parcelas → rollback (DELETE não é commitado)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 9, status: 'pendente', c6_group_id: null, descricao: 'Nota X',
        fornecedor: null, fornecedor_id: null, tipo_despesa_id: 2, tipo: 'boleto',
        competencia: '2026-05-27', observacao: null,
      }],
    });
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('DELETE FROM contas_pagar')) return Promise.resolve({ rowCount: 1 });
      if (sql.startsWith('INSERT INTO contas_pagar')) return Promise.reject(new Error('falha simulada de insercao'));
      if (sql.startsWith('ROLLBACK')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await expect(service.converterEmParcelado(9, {
      parcelas: [{ vencimento: '2026-06-24', valor: 175 }, { vencimento: '2026-07-01', valor: 175 }],
    })).rejects.toThrow('falha simulada de insercao');

    expect(client.query.mock.calls.some(c => c[0].startsWith('ROLLBACK'))).toBe(true);
    expect(client.query.mock.calls.some(c => c[0].startsWith('COMMIT'))).toBe(false);
  });
});
