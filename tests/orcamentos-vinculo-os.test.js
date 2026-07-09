const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { buscarPorId, listar } = require('../src/modules/orcamentos/service');

describe('buscarPorId — OS vinculada via os_itens (offset/revenda)', () => {
  afterEach(() => jest.clearAllMocks());

  test('a query de OS considera vínculo indireto via os_itens/orcamento_itens', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'orc-1' }] }) // SELECT o.*, ...
      .mockResolvedValueOnce({ rows: [] }) // itens
      .mockResolvedValueOnce({ rows: [] }) // ordens_servico
      .mockResolvedValueOnce({ rows: [] }); // boletos

    await buscarPorId('orc-1');

    const osSql = db.query.mock.calls[2][0];
    expect(osSql).toMatch(/os_itens/);
    expect(osSql).toMatch(/orcamento_itens/);
  });
});

describe('listar — tem_os_entregue considera vínculo indireto via os_itens/orcamento_itens', () => {
  afterEach(() => jest.clearAllMocks());

  test('a subquery tem_os_entregue considera vínculo indireto', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // rows
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // count

    await listar({});

    const listSql = db.query.mock.calls[0][0];
    expect(listSql).toMatch(/tem_os_entregue/);
    expect(listSql).toMatch(/os_itens/);
    expect(listSql).toMatch(/orcamento_itens/);
  });
});
