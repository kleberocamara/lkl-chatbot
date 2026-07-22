jest.mock('../src/db', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock('../src/modules/contas-pagar/service', () => ({ criarOuReconciliarContaPagar: jest.fn() }));

function mockClient(queryImpl) {
  return { query: jest.fn(queryImpl), release: jest.fn() };
}

const db = require('../src/db');
const contasPagarService = require('../src/modules/contas-pagar/service');
const service = require('../src/modules/entradas/service');

beforeEach(() => jest.clearAllMocks());

describe('confirmar — com fornecedor_submissao_id e múltiplos boletos', () => {
  test('grava fornecedor_submissao_id na entrada, atualiza status da submissão pra aceita, e cria uma conta a pagar por boleto com o mesmo parcela_grupo_id', async () => {
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO entradas_estoque')) return Promise.resolve({ rows: [{ id: 'entrada-1' }] });
      if (sql.startsWith('INSERT INTO entradas_estoque_itens')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);
    db.query
      .mockResolvedValueOnce({ rows: [{ status: 'aguardando_entrega' }] }) // checa idempotência (submissão ainda não aceita)
      .mockResolvedValueOnce({ rows: [{ nome: 'Vinil Line' }] }) // busca nome do fornecedor
      .mockResolvedValueOnce({ rows: [] }) // UPDATE entradas_estoque SET fornecedor_submissao_id
      .mockResolvedValueOnce({ rows: [] }); // UPDATE fornecedor_submissoes SET status='aceita'
    contasPagarService.criarOuReconciliarContaPagar
      .mockResolvedValueOnce({ id: 201 })
      .mockResolvedValueOnce({ id: 202 });

    const r = await service.confirmar({
      fornecedor_id: 'forn-1', nnf: '4521', emitida_em: '2026-07-21', valor_total: 425, itens: [],
      fornecedor_submissao_id: 'sub-1',
      boletos: [
        { linha_digitavel: '341...001', valor: 212.50, vencimento: '2026-08-10' },
        { linha_digitavel: '341...002', valor: 212.50, vencimento: '2026-09-10' },
      ],
    });

    expect(r.entrada.id).toBe('entrada-1');
    expect(contasPagarService.criarOuReconciliarContaPagar).toHaveBeenCalledTimes(2);
    const chamada1 = contasPagarService.criarOuReconciliarContaPagar.mock.calls[0][0];
    const chamada2 = contasPagarService.criarOuReconciliarContaPagar.mock.calls[1][0];
    expect(chamada1.parcelaGrupoId).toBe(chamada2.parcelaGrupoId);
    expect(chamada1.parcelaNumero).toBe(1);
    expect(chamada2.parcelaNumero).toBe(2);
    expect(chamada1.parcelaTotal).toBe(2);
    expect(chamada1.linhaDigitavel).toBe('341...001');

    const updateEntrada = db.query.mock.calls.find(c => c[0].startsWith('UPDATE entradas_estoque SET fornecedor_submissao_id'));
    expect(updateEntrada[1]).toEqual(['sub-1', 'entrada-1']);
    const updateSubmissao = db.query.mock.calls.find(c => c[0].startsWith('UPDATE fornecedor_submissoes'));
    expect(updateSubmissao[0]).toMatch(/status = 'aceita'/);
    expect(updateSubmissao[1]).toEqual(['entrada-1', 'sub-1']);
  });

  test('sem fornecedor_submissao_id → comportamento antigo inalterado (1 conta a pagar, sem parcela)', async () => {
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO entradas_estoque')) return Promise.resolve({ rows: [{ id: 'entrada-2' }] });
      if (sql.startsWith('INSERT INTO entradas_estoque_itens')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);
    db.query
      .mockResolvedValueOnce({ rows: [{ nome: 'Fornecedor X' }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE conta_pagar_id (comportamento já existente)
    contasPagarService.criarOuReconciliarContaPagar.mockResolvedValueOnce({ id: 300 });

    await service.confirmar({ fornecedor_id: 'forn-2', nnf: '999', valor_total: 100, itens: [] });

    expect(contasPagarService.criarOuReconciliarContaPagar).toHaveBeenCalledTimes(1);
    expect(contasPagarService.criarOuReconciliarContaPagar.mock.calls[0][0].parcelaGrupoId).toBeUndefined();
  });

  test('submissão já aceita → recusa e não cria entrada nem conta a pagar (evita duplicidade em retry)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ status: 'aceita', entrada_estoque_id: 'entrada-1' }] });

    const r = await service.confirmar({
      fornecedor_id: 'forn-1', nnf: '4521', valor_total: 425, itens: [],
      fornecedor_submissao_id: 'sub-1',
    });

    expect(r.erro).toBeDefined();
    expect(r.erro[0]).toMatch(/já foi aceita/);
    expect(db.pool.connect).not.toHaveBeenCalled();
    expect(contasPagarService.criarOuReconciliarContaPagar).not.toHaveBeenCalled();
  });

  test('emitida_em em formato ISO com hora (bug real de produção) não quebra a geração da conta a pagar', async () => {
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO entradas_estoque')) return Promise.resolve({ rows: [{ id: 'entrada-3' }] });
      if (sql.startsWith('INSERT INTO entradas_estoque_itens')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);
    db.query
      .mockResolvedValueOnce({ rows: [{ status: 'aguardando_entrega' }] })
      .mockResolvedValueOnce({ rows: [{ nome: 'Fornecedor Y' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    contasPagarService.criarOuReconciliarContaPagar.mockResolvedValueOnce({ id: 400 });

    // formato que o pg devolve pra coluna DATE depois de serializado via res.json() (Date.toISOString())
    const r = await service.confirmar({
      fornecedor_id: 'forn-3', nnf: '111', valor_total: 100, itens: [],
      emitida_em: '2026-05-13T00:00:00.000Z',
      fornecedor_submissao_id: 'sub-2',
    });

    expect(r.erro).toBeUndefined();
    expect(r.entrada.id).toBe('entrada-3');
    expect(contasPagarService.criarOuReconciliarContaPagar).toHaveBeenCalledTimes(1);
    expect(contasPagarService.criarOuReconciliarContaPagar.mock.calls[0][0].vencimento).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
