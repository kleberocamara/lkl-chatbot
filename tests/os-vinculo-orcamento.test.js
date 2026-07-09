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
    // Isola a cláusula WHERE do filtro (a query já tem os_itens/orcamento_itens
    // em outras subqueries do SELECT — checar o texto inteiro daria falso positivo
    // mesmo sem a correção). O padrão abaixo só existe depois do fix.
    expect(listSql).toMatch(/AND \(os\.orcamento_id = \$1 OR os\.id IN \(\s*SELECT oit\.os_id FROM os_itens oit JOIN orcamento_itens oi ON oi\.id = oit\.orcamento_item_id WHERE oi\.orcamento_id = \$1/);
  });

  test('sem orcamento_id, o filtro não aparece na query', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await listar({});

    const listSql = db.query.mock.calls[0][0];
    expect(listSql).not.toMatch(/oi\.orcamento_id/);
  });
});
