const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { listarArtesPendentes } = require('../src/modules/orcamentos/service');

describe('listarArtesPendentes — exclui itens de servico (nao geram arte)', () => {
  afterEach(() => jest.clearAllMocks());

  test('SQL exclui tipo_producao = SERVICO', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await listarArtesPendentes();

    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/tipo_producao IS DISTINCT FROM 'SERVICO'/);
  });
});
