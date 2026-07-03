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
