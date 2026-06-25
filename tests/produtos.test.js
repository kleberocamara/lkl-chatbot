const { matchProduto, tipoPorProduto, parseDimensoes } = require('../src/constants/produtos');

describe('matchProduto', () => {
  test('exato case-insensitive', () => { expect(matchProduto('cartaz').produto).toBe('CARTAZ'); });
  test('singular -> plural (Banner -> BANNERS)', () => { expect(matchProduto('Banner').produto).toBe('BANNERS'); });
  test('plural -> singular (Adesivo -> ADESIVOS)', () => { expect(matchProduto('adesivo').produto).toBe('ADESIVOS'); });
  test('acentos ignorados (catalogo -> CATÁLOGO)', () => { expect(matchProduto('catalogo').produto).toBe('CATÁLOGO'); });
  test('sem correspondência', () => { expect(matchProduto('xyz')).toBeNull(); });
  test('vazio', () => { expect(matchProduto('')).toBeNull(); });
});

describe('tipoPorProduto', () => {
  test('Banner -> COMUNICAÇÃO VISUAL', () => { expect(tipoPorProduto('Banner')).toBe('COMUNICAÇÃO VISUAL'); });
  test('Cartaz -> OFFSET', () => { expect(tipoPorProduto('Cartaz')).toBe('OFFSET'); });
  test('desconhecido -> null', () => { expect(tipoPorProduto('xyz')).toBeNull(); });
});

describe('parseDimensoes', () => {
  test('metros', () => { expect(parseDimensoes('1,20 x 0,60 m')).toEqual({ largura_cm: 120, altura_cm: 60 }); });
  test('cm', () => { expect(parseDimensoes('200x100 cm')).toEqual({ largura_cm: 200, altura_cm: 100 }); });
  test('sem unidade', () => { expect(parseDimensoes('40X30')).toEqual({ largura_cm: 40, altura_cm: 30 }); });
  test('dentro de texto', () => { expect(parseDimensoes('40x30 cm · Couchê 90g')).toEqual({ largura_cm: 40, altura_cm: 30 }); });
  test('sem medida', () => { expect(parseDimensoes('Couchê 90g')).toBeNull(); });
  test('nulo', () => { expect(parseDimensoes(null)).toBeNull(); });
});
