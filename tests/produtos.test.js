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
  test('milímetros', () => { expect(parseDimensoes('300x200mm')).toEqual({ largura_cm: 30, altura_cm: 20 }); });
  test('metros com unidade nos dois números (formato do chatbot)', () => { expect(parseDimensoes('1,20m x 1,10m · lona 440g brilho')).toEqual({ largura_cm: 120, altura_cm: 110 }); });
  test('cm nos dois números', () => { expect(parseDimensoes('30cm x 45cm')).toEqual({ largura_cm: 30, altura_cm: 45 }); });
  test('sem medida', () => { expect(parseDimensoes('Couchê 90g')).toBeNull(); });
  test('nulo', () => { expect(parseDimensoes(null)).toBeNull(); });
});

const { tokensMaterial, selecionarMaterialId } = require('../src/constants/produtos');

describe('tokensMaterial', () => {
  test('separa número da unidade de gramatura', () => {
    expect(tokensMaterial('couchê 90g')).toEqual(['COUCHE', '90']);
  });
  test('descarta unidades e mantém palavras', () => {
    expect(tokensMaterial('vinil fosco')).toEqual(['VINIL', 'FOSCO']);
  });
  test('vazio', () => { expect(tokensMaterial('')).toEqual([]); });
});

describe('selecionarMaterialId', () => {
  const fix = [
    { id: 'a', nome: 'COUCHE LISO 90 GR 96X66' },
    { id: 'b', nome: 'COUCHE LISO 150 GR 96X66' },
    { id: 'c', nome: 'LONA 440 BRILHO' },
    { id: 'd', nome: 'VINIL FOSCO 1,50X50' },
  ];
  test('couchê 90g -> COUCHE 90', () => { expect(selecionarMaterialId(fix, 'couchê 90g')).toBe('a'); });
  test('lona -> LONA 440', () => { expect(selecionarMaterialId(fix, 'lona')).toBe('c'); });
  test('vinil fosco -> VINIL FOSCO', () => { expect(selecionarMaterialId(fix, 'vinil fosco')).toBe('d'); });
  test('sem correspondência -> null', () => { expect(selecionarMaterialId(fix, 'xyz')).toBeNull(); });
  test('termo vazio -> null', () => { expect(selecionarMaterialId(fix, '')).toBeNull(); });
  test('prefere o nome mais curto', () => {
    const f2 = [{ id: 'x', nome: 'COUCHE 90' }, { id: 'y', nome: 'COUCHE LISO 90 GR 96X66' }];
    expect(selecionarMaterialId(f2, 'couchê 90g')).toBe('x');
  });
});

const { tipoProducaoDoItemRevenda } = require('../src/constants/produtos');

describe('tipoProducaoDoItemRevenda', () => {
  test('interno_m2 é sempre COMUNICAÇÃO VISUAL', () => {
    expect(tipoProducaoDoItemRevenda('interno_m2', 'COMUNICAÇÃO VISUAL')).toBe('COMUNICAÇÃO VISUAL');
    expect(tipoProducaoDoItemRevenda('interno_m2', 'OFFSET')).toBe('COMUNICAÇÃO VISUAL');
  });
  test('manual OFFSET → OFFSET', () => {
    expect(tipoProducaoDoItemRevenda('manual', 'OFFSET')).toBe('OFFSET');
  });
  test('manual CV → COMUNICAÇÃO VISUAL', () => {
    expect(tipoProducaoDoItemRevenda('manual', 'COMUNICAÇÃO VISUAL')).toBe('COMUNICAÇÃO VISUAL');
  });
  test('manual IMP. DIGITAL → REVENDA', () => {
    expect(tipoProducaoDoItemRevenda('manual', 'IMP. DIGITAL')).toBe('REVENDA');
  });
  test('revenda_matriz → REVENDA', () => {
    expect(tipoProducaoDoItemRevenda('revenda_matriz', 'OFFSET')).toBe('REVENDA');
    expect(tipoProducaoDoItemRevenda('revenda_matriz', 'COMUNICAÇÃO VISUAL')).toBe('REVENDA');
  });
  test('estrategia/tipo ausentes → REVENDA', () => {
    expect(tipoProducaoDoItemRevenda(null, null)).toBe('REVENDA');
    expect(tipoProducaoDoItemRevenda(undefined, undefined)).toBe('REVENDA');
  });
});
