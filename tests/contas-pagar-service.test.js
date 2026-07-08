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
});
