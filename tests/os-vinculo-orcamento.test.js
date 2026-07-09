const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/fcm', () => ({ sendToUser: jest.fn() }));

const { listar } = require('../src/modules/os/service');

describe('listar — filtro ?orcamento_id= considera vínculo indireto via os_itens', () => {
  afterEach(() => jest.clearAllMocks());

  test('a query filtrada por orcamento_id inclui OS vinculada só via os_itens', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // rows
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // count

    await listar({ orcamento_id: 'orc-1' });

    const listSql = db.query.mock.calls[0][0];
    expect(listSql).toMatch(/os\.orcamento_id = \$1/);
    expect(listSql).toMatch(/os_itens/);
    expect(listSql).toMatch(/orcamento_itens/);
  });
});
