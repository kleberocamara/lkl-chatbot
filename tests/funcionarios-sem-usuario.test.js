const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { listar } = require('../src/modules/funcionarios/service');

describe('listar — filtro semUsuario', () => {
  afterEach(() => jest.clearAllMocks());

  test('semUsuario=true adiciona filtro user_id IS NULL', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await listar({ semUsuario: true });

    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/f\.user_id IS NULL/);
  });

  test('sem semUsuario nao filtra por user_id', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await listar({});

    const sql = db.query.mock.calls[0][0];
    expect(sql).not.toMatch(/user_id IS NULL/);
  });
});
