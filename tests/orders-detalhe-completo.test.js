jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/modules/orcamentos/service', () => ({ buscarPorId: jest.fn() }));
jest.mock('../src/modules/os/service', () => ({ historico: jest.fn() }));

const db = require('../src/db');
const orcamentosService = require('../src/modules/orcamentos/service');
const osService = require('../src/modules/os/service');
const { detalheCompleto } = require('../src/modules/orders/service');

describe('detalheCompleto', () => {
  afterEach(() => jest.clearAllMocks());

  test('pedido sem orcamento_id → retorna pedido sem orcamento/ordens_servico, sem chamar os outros services', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'ord-1', orcamento_id: null, numero_os: 5 }] }) // order
      .mockResolvedValueOnce({ rows: [] }); // order_items

    const r = await detalheCompleto('ord-1');

    expect(r.orcamento).toBeNull();
    expect(r.ordens_servico).toEqual([]);
    expect(orcamentosService.buscarPorId).not.toHaveBeenCalled();
    expect(osService.historico).not.toHaveBeenCalled();
  });

  test('pedido inexistente → null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await detalheCompleto('ord-x');
    expect(r).toBeNull();
  });

  test('OS offset em "impressao" → corte concluído, impressao é a fase atual, acabamento/entrega futuras', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'ord-1', orcamento_id: 'orc-1', numero_os: 5 }] })
      .mockResolvedValueOnce({ rows: [] });
    orcamentosService.buscarPorId.mockResolvedValueOnce({
      id: 'orc-1', itens: [{ id: 'item-1', produto: 'FLYER', valor_total: 100 }],
      ordens_servico: [{ id: 'os-1', tipo_servico: 'offset', status: 'impressao' }],
    });
    osService.historico.mockResolvedValueOnce([
      { de_status: null, para_status: 'corte', em: '2026-07-01T10:00:00Z' },
      { de_status: 'corte', para_status: 'impressao', em: '2026-07-02T10:00:00Z' },
    ]);

    const r = await detalheCompleto('ord-1');

    expect(r.orcamento.itens).toHaveLength(1);
    expect(r.ordens_servico).toHaveLength(1);
    const os = r.ordens_servico[0];
    expect(os.fase_atual).toBe('impressao');
    expect(os.fases_concluidas).toEqual(['corte']);
    expect(os.fases_futuras).toEqual(['acabamento', 'entrega']);
    expect(os.historico).toHaveLength(2);
  });

  test('OS comunicação visual "entregue" → todas as fases concluídas, sem fase atual nem futuras', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'ord-1', orcamento_id: 'orc-1', numero_os: 5 }] })
      .mockResolvedValueOnce({ rows: [] });
    orcamentosService.buscarPorId.mockResolvedValueOnce({
      id: 'orc-1', itens: [],
      ordens_servico: [{ id: 'os-2', tipo_servico: 'comunicacao_visual', status: 'entregue' }],
    });
    osService.historico.mockResolvedValueOnce([]);

    const r = await detalheCompleto('ord-1');

    const os = r.ordens_servico[0];
    expect(os.fases_concluidas).toEqual(['impressao', 'acabamento', 'entrega']);
    expect(os.fase_atual).toBeNull();
    expect(os.fases_futuras).toEqual([]);
  });

  test('pedido com 2 OS vinculadas (offset + comunicacao_visual) → as duas aparecem em ordens_servico', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'ord-1', orcamento_id: 'orc-1', numero_os: 5 }] })
      .mockResolvedValueOnce({ rows: [] });
    orcamentosService.buscarPorId.mockResolvedValueOnce({
      id: 'orc-1', itens: [],
      ordens_servico: [
        { id: 'os-1', tipo_servico: 'offset', status: 'corte' },
        { id: 'os-2', tipo_servico: 'comunicacao_visual', status: 'acabamento' },
      ],
    });
    osService.historico.mockResolvedValue([]);

    const r = await detalheCompleto('ord-1');

    expect(r.ordens_servico).toHaveLength(2);
    expect(r.ordens_servico.map(o => o.id)).toEqual(['os-1', 'os-2']);
    expect(osService.historico).toHaveBeenCalledTimes(2);
  });
});
