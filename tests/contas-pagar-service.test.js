const db = require('../src/db');
jest.mock('../src/db', () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));
jest.mock('../src/services/c6bank', () => ({ consultarDDA: jest.fn() }));
jest.mock('../src/modules/contas-pagar/fornecedor-matcher', () => ({ encontrarOuCriarFornecedor: jest.fn() }));

const c6bank = require('../src/services/c6bank');
const fornecedorMatcher = require('../src/modules/contas-pagar/fornecedor-matcher');
const service = require('../src/modules/contas-pagar/service');

function mockClient(queryImpl) {
  return { query: jest.fn(queryImpl), release: jest.fn() };
}

describe('criarOuReconciliarContaPagar', () => {
  afterEach(() => jest.clearAllMocks());

  test('acha 1 correspondência (entrada de estoque pendente) → mescla, não duplica', async () => {
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) {
        return Promise.resolve({ rows: [{ id: 10, tipo_despesa_id: 5 }] });
      }
      if (sql.startsWith('UPDATE contas_pagar')) {
        return Promise.resolve({ rows: [{ id: 10, linha_digitavel: '123', status: 'pendente' }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-1', fornecedorNome: 'Papelaria X', descricao: 'NF 123',
      valor: 500, vencimento: '2026-08-10', tipoDespesaId: 5, tipoEntrada: 'dda', linhaDigitavel: '123',
    });

    expect(r.id).toBe(10);
    expect(client.query.mock.calls.some(c => c[0].startsWith('INSERT INTO contas_pagar'))).toBe(false);
  });

  test('zero correspondências → insere nova', async () => {
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('INSERT INTO contas_pagar')) return Promise.resolve({ rows: [{ id: 20 }] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-2', fornecedorNome: 'Fornecedor Novo', descricao: 'Boleto DDA',
      valor: 300, vencimento: '2026-08-15', tipoDespesaId: 3, tipoEntrada: 'dda', linhaDigitavel: '456',
    });

    expect(r.id).toBe(20);
  });

  test('duas ou mais correspondências → insere nova (evita mesclar errado)', async () => {
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) {
        return Promise.resolve({ rows: [{ id: 30 }, { id: 31 }] });
      }
      if (sql.startsWith('INSERT INTO contas_pagar')) return Promise.resolve({ rows: [{ id: 40 }] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-3', fornecedorNome: 'Ambíguo', descricao: 'x',
      valor: 100, vencimento: '2026-08-01', tipoDespesaId: 3, tipoEntrada: 'manual',
    });

    expect(r.id).toBe(40);
  });

  test('com competencia e zero correspondências → INSERT inclui a coluna competencia', async () => {
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        expect(sql).toContain('competencia');
        expect(params).toContain('2026-05-27');
        return Promise.resolve({ rows: [{ id: 50 }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-5', fornecedorNome: 'Konita', descricao: 'NF Konita',
      valor: 817.84, vencimento: '2026-06-29', tipoDespesaId: 2, tipoEntrada: 'whatsapp_ocr',
      competencia: '2026-05-27',
    });

    expect(r.id).toBe(50);
  });

  test('com competencia e 1 correspondência (match) → UPDATE inclui a coluna competencia', async () => {
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) {
        return Promise.resolve({ rows: [{ id: 60, tipo_despesa_id: 2 }] });
      }
      if (sql.startsWith('UPDATE contas_pagar')) {
        expect(sql).toContain('competencia');
        expect(params).toContain('2026-05-27');
        return Promise.resolve({ rows: [{ id: 60 }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-6', valor: 817.84, vencimento: '2026-06-29',
      tipoDespesaId: 2, tipoEntrada: 'whatsapp_ocr', competencia: '2026-05-27',
    });

    expect(r.id).toBe(60);
  });

  test('sem competencia → INSERT não inclui a coluna (banco usa DEFAULT)', async () => {
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        expect(sql).not.toContain('competencia');
        return Promise.resolve({ rows: [{ id: 70 }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-7', valor: 100, vencimento: '2026-08-01',
      tipoDespesaId: 1, tipoEntrada: 'manual',
    });
  });
});

describe('sincronizarDDA', () => {
  afterEach(() => jest.clearAllMocks());

  test('boleto com linha_digitavel já importada → ignora, não reprocessa', async () => {
    c6bank.consultarDDA.mockResolvedValueOnce([{ content: 'LD-1', beneficiary_name: 'X', amount: 10, due_date: '2026-08-01' }]);
    db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // já existe conta com essa linha_digitavel

    const r = await service.sincronizarDDA();
    expect(r).toEqual({ total: 1, importados: 0, ignorados: 1 });
  });

  test('boleto sem content → ignora', async () => {
    c6bank.consultarDDA.mockResolvedValueOnce([{ beneficiary_name: 'Y', amount: 10, due_date: '2026-08-01' }]);
    const r = await service.sincronizarDDA();
    expect(r).toEqual({ total: 1, importados: 0, ignorados: 1 });
  });

  test('fornecedor bloqueado (fraude) → ignora e não cria conta a pagar', async () => {
    c6bank.consultarDDA.mockResolvedValueOnce([
      { content: 'LD-FRAUDE', beneficiary_name: 'Itev - Informacoes Tributarias Para Empr', amount: 719.80, due_date: '2026-08-01' },
    ]);
    db.query.mockResolvedValueOnce({ rows: [] }); // linha_digitavel ainda não importada
    fornecedorMatcher.encontrarOuCriarFornecedor.mockResolvedValueOnce({ id: 'uuid-fraude', nome: 'Itev', status: 'bloqueado' });

    const r = await service.sincronizarDDA();

    expect(r).toEqual({ total: 1, importados: 0, ignorados: 1 });
    expect(db.pool.connect).not.toHaveBeenCalled();
  });
});

describe('editar', () => {
  afterEach(() => jest.clearAllMocks());

  test('conta vencida → permite editar (ex: classificar/corrigir uma conta atrasada)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 38, status: 'vencido', fornecedor_id: null }] }) // buscarPorId
      .mockResolvedValueOnce({ rows: [{ id: 38, status: 'vencido', tipo_despesa_id: 5 }] });  // UPDATE

    const r = await service.editar(38, { tipo_despesa_id: 5 });

    expect(r.erro).toBeUndefined();
    expect(db.query.mock.calls[1][0]).toMatch(/UPDATE contas_pagar/);
  });

  test('conta paga → não permite editar', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 1, status: 'pago' }] }); // buscarPorId

    const r = await service.editar(1, { valor: 100 });

    expect(r.erro).toEqual(['Só é possível editar contas com status pendente ou vencido']);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('conta cancelada → não permite editar', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 1, status: 'cancelado' }] });

    const r = await service.editar(1, { valor: 100 });

    expect(r.erro).toEqual(['Só é possível editar contas com status pendente ou vencido']);
  });
});

describe('criarRecorrente', () => {
  afterEach(() => jest.clearAllMocks());

  // Regressão: cada parcela recorrente (ex: 12 meses de aluguel) tinha a coluna
  // competencia deixada de fora do INSERT, então o banco usava o DEFAULT (data de
  // criação) para as 12 — inflando a DRE do mês em que a recorrência foi cadastrada
  // com um ano inteiro de despesa de uma vez. Cada parcela deve reconhecer a
  // despesa no próprio mês de vencimento, não no dia em que foi cadastrada.
  test('cada parcela grava competencia igual ao próprio mês de vencimento, não a data de criação', async () => {
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        expect(sql).toContain('competencia');
        const vencimento = params[5];
        const competencia = params[12];
        expect(competencia).toBe(vencimento);
        return Promise.resolve({ rows: [{ id: 1 }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarRecorrente({
      descricao: 'ALUGUEL GALPAO', fornecedor_id: 'uuid-1', tipo_despesa_id: 15,
      valor: 12699.84, recorrencia_dia: 15,
    });

    expect(r.criadas).toHaveLength(12);
    // as 12 parcelas não podem ter todas a mesma competencia (meses diferentes)
    const competencias = client.query.mock.calls
      .filter(c => c[0].startsWith('INSERT INTO contas_pagar'))
      .map(c => c[1][12]);
    expect(new Set(competencias).size).toBe(12);
  });
});

describe('gerarRecorrentesProximoMes', () => {
  afterEach(() => jest.clearAllMocks());

  test('parcela gerada pro próximo mês grava competencia igual ao vencimento (mesmo mês)', async () => {
    db.query.mockImplementation((sql, params) => {
      if (sql.startsWith('SELECT DISTINCT ON')) {
        return Promise.resolve({ rows: [{
          descricao: 'ALUGUEL GALPAO', fornecedor: null, fornecedor_id: 'uuid-1', tipo_despesa_id: 15,
          valor: 12699.84, tipo: 'outro', linha_digitavel: null, pix_content: null,
          recorrencia_dia: 15, recorrencia_valor_fixo: true, observacao: null,
        }] });
      }
      if (sql.startsWith('SELECT 1 FROM contas_pagar')) return Promise.resolve({ rowCount: 0 });
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        expect(sql).toContain('competencia');
        const vencimento = params[5];
        const competencia = params[12];
        expect(competencia).toBe(vencimento);
        return Promise.resolve({ rows: [] });
      }
      throw new Error('query inesperada: ' + sql);
    });

    const r = await service.gerarRecorrentesProximoMes();
    expect(r.geradas).toBe(1);
  });
});

describe('criar', () => {
  afterEach(() => jest.clearAllMocks());

  test('sem competencia informada → INSERT não inclui a coluna competencia', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });

    await service.criar({
      descricao: 'Conta Light', tipo_despesa_id: 3, valor: 200, vencimento: '2026-08-10',
    });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toContain('competencia');
    expect(params).toHaveLength(14);
  });

  test('com competencia informada → INSERT inclui a coluna e o valor', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 2 }] });

    await service.criar({
      descricao: 'Conta Evolution', tipo_despesa_id: 2, valor: 350, vencimento: '2026-06-24',
      competencia: '2026-05-27',
    });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('competencia');
    expect(params).toContain('2026-05-27');
    expect(params).toHaveLength(15);
  });
});
