const service = require('../src/modules/orcamentos/service');
const db = require('../src/db');

jest.mock('../src/db', () => ({ query: jest.fn() }));

describe('buscarResumoPorToken', () => {
  afterEach(() => jest.clearAllMocks());

  test('token inexistente → null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // SELECT id por token
    const r = await service.buscarResumoPorToken('tok-x');
    expect(r).toBeNull();
  });

  test('token válido → retorna orçamento com itens', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'orc-1' }] })         // SELECT id por token
      .mockResolvedValueOnce({ rows: [{ id: 'orc-1', numero: 5, status: 'enviado' }] }) // buscarPorId: orcamento
      .mockResolvedValueOnce({ rows: [{ descricao: 'BANNER', quantidade: 2, valor_total: 120 }] }) // itens
      .mockResolvedValueOnce({ rows: [] })                        // ordens_servico
      .mockResolvedValueOnce({ rows: [] });                       // boletos_parcelas
    const r = await service.buscarResumoPorToken('tok-1');
    expect(r).not.toBeNull();
    expect(r.numero).toBe(5);
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0].descricao).toBe('BANNER');
  });
});
