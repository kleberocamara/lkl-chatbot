jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/modules/revenda/service', () => ({
  resolverProdutoRevenda: jest.fn(),
  precificarItemRevenda: jest.fn(),
}));

const db = require('../src/db');
const revendaService = require('../src/modules/revenda/service');
const { criarOrder } = require('../src/modules/orders/service');

describe('criarOrder — revenda_produto_id explícito', () => {
  afterEach(() => jest.clearAllMocks());

  test('item com revenda_produto_id → não chama resolverProdutoRevenda, precifica direto por esse id', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'order-1', cliente_id: 'cli-1', vendedor_id: 'vend-1' }] }) // INSERT orders
      .mockResolvedValueOnce({ rows: [] }) // INSERT order_items
      .mockResolvedValueOnce({ rows: [{ id: 'orc-1' }] }) // INSERT orcamentos
      .mockResolvedValueOnce({ rows: [{ id: 'sku-banner-240', nome: 'Banner | Lona Fosca 240g', estrategia: 'interno_m2' }] }) // SELECT revenda_produtos WHERE id=$1
      .mockResolvedValueOnce({ rows: [] }); // INSERT orcamento_itens

    revendaService.precificarItemRevenda.mockResolvedValueOnce({
      valor_unitario: 28.8, valor_total: 28.8, memoria: 'Bobina 1.6m...', estrategia: 'interno_m2',
    });

    await criarOrder({
      origin_channel: 'balcao',
      cliente_id: 'cli-1',
      itens: [{ produto: 'Banner | Lona Fosca 240g', revenda_produto_id: 'sku-banner-240', quantidade: 1, especificacao: '1,20 X 0,80' }],
    }, 'user-1');

    expect(revendaService.resolverProdutoRevenda).not.toHaveBeenCalled();
    expect(revendaService.precificarItemRevenda).toHaveBeenCalledWith(expect.objectContaining({ revenda_produto_id: 'sku-banner-240' }));
    const insertItem = db.query.mock.calls[4];
    expect(insertItem[0]).toMatch(/INSERT INTO orcamento_itens/);
    expect(insertItem[1]).toEqual(expect.arrayContaining([28.8, 28.8, 'auto']));
  });

  test('item sem revenda_produto_id → continua chamando resolverProdutoRevenda (comportamento inalterado)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'order-2', cliente_id: 'cli-1', vendedor_id: 'vend-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'orc-2' }] })
      .mockResolvedValueOnce({ rows: [] }); // INSERT orcamento_itens (sem match, valor 0)

    revendaService.resolverProdutoRevenda.mockResolvedValueOnce(null);

    await criarOrder({
      origin_channel: 'balcao',
      cliente_id: 'cli-1',
      itens: [{ produto: 'BANNERS', quantidade: 1, especificacao: '1,20 X 0,80' }],
    }, 'user-1');

    expect(revendaService.resolverProdutoRevenda).toHaveBeenCalledTimes(1);
    expect(revendaService.precificarItemRevenda).not.toHaveBeenCalled();
  });
});
