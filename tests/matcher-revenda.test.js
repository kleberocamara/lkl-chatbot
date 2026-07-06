const { pontuarSku } = require('../src/modules/revenda/service');

describe('pontuarSku', () => {
  test('banner/lona casa melhor com SKU de lona que com adesivo', () => {
    const alvo = 'BANNERS lona 440g brilho';
    const scoreLona = pontuarSku(alvo, 'Banner | Lona Brilho 300g | 1000x1000');
    const scoreAdesivo = pontuarSku(alvo, 'Adesivo Vinil Fosco');
    expect(scoreLona).toBeGreaterThan(scoreAdesivo);
  });
  test('sem sobreposição → 0', () => {
    expect(pontuarSku('CARTOES couché 300g', 'Lona Fosca 440g')).toBe(0);
  });
  test('texto vazio → 0', () => {
    expect(pontuarSku('', 'Banner Lona')).toBe(0);
  });
});

const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { resolverProdutoRevenda } = require('../src/modules/revenda/service');

describe('resolverProdutoRevenda com especificacao', () => {
  afterEach(() => jest.clearAllMocks());

  test('produto="BANNERS" sem material, com especificacao "lona 440g" → casa com SKU de lona', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'sku-lona-440', nome: 'Banner | Lona Fosca 440g', tipo_servico: 'COMUNICAÇÃO VISUAL', estrategia: 'interno_m2', bobina_grupo: 'lona', preco_m2: 30 },
        { id: 'sku-adesivo', nome: 'Adesivo Vinil Fosco', tipo_servico: 'COMUNICAÇÃO VISUAL', estrategia: 'interno_m2', bobina_grupo: 'adesivo', preco_m2: 30 },
      ],
    });
    const prod = await resolverProdutoRevenda({
      produto: 'BANNERS',
      material: null,
      tipo_producao: 'COMUNICAÇÃO VISUAL',
      largura_cm: 678, altura_cm: 230,
      especificacao: '6,78m x 2,30m · lona 440g',
    });
    expect(prod).not.toBeNull();
    expect(prod.id).toBe('sku-lona-440');
  });

  test('sem especificacao, produto isolado sem overlap → null (comportamento anterior preservado)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'sku-lona', nome: 'Banner | Lona Fosca 440g', tipo_servico: 'COMUNICAÇÃO VISUAL', estrategia: 'interno_m2', bobina_grupo: 'lona', preco_m2: 30 },
      ],
    });
    const prod = await resolverProdutoRevenda({
      produto: 'BANNERS',
      material: null,
      tipo_producao: 'COMUNICAÇÃO VISUAL',
      largura_cm: 678, altura_cm: 230,
    });
    expect(prod).toBeNull();
  });
});
