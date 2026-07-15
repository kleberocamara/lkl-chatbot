const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));

const { reabrir } = require('../src/modules/orcamentos/service');

describe('reabrir — reabre orçamento reprovado para correção/reenvio', () => {
  afterEach(() => jest.clearAllMocks());

  test('orçamento reprovado → volta para em_orcamento', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'orc-1', status: 'reprovado' }] }) // buscarPorId: SELECT o.*
      .mockResolvedValueOnce({ rows: [] }) // itens
      .mockResolvedValueOnce({ rows: [] }) // ordens_servico
      .mockResolvedValueOnce({ rows: [] }) // boletos
      .mockResolvedValueOnce({ rows: [{ id: 'orc-1', status: 'em_orcamento' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // _syncPedidoStatus UPDATE orders

    const result = await reabrir('orc-1');

    expect(result.erro).toBeUndefined();
    expect(result.orcamento.status).toBe('em_orcamento');
    const updateSql = db.query.mock.calls[4][0];
    expect(updateSql).toMatch(/SET status='em_orcamento'/);
    expect(updateSql).toMatch(/AND status='reprovado'/);
  });

  test('orçamento não encontrado → erro', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // buscarPorId: sem linha

    const result = await reabrir('orc-x');

    expect(result.erro).toEqual(['Orçamento não encontrado']);
  });

  test('orçamento não está reprovado → erro', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'orc-1', status: 'enviado' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await reabrir('orc-1');

    expect(result.erro).toEqual(['Só é possível reabrir um orçamento com status "reprovado"']);
  });

  test('corrida: status já mudou entre o SELECT e o UPDATE → erro', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'orc-1', status: 'reprovado' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE não afeta nenhuma linha

    const result = await reabrir('orc-1');

    expect(result.erro).toEqual(['Este orçamento já foi processado por outra ação simultânea.']);
  });
});
