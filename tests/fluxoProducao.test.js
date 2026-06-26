const { FLUXO, FASE_LABEL, proximaFase } = require('../src/constants/fluxoProducao');

describe('FLUXO', () => {
  test('offset tem 4 fases', () => {
    expect(FLUXO.offset).toEqual(['corte','impressao','acabamento','entrega']);
  });
  test('comunicacao_visual tem 3 fases', () => {
    expect(FLUXO.comunicacao_visual).toEqual(['impressao','acabamento','entrega']);
  });
});

describe('FASE_LABEL', () => {
  test('corte label', () => { expect(FASE_LABEL.corte).toBe('Corte'); });
  test('entregue label', () => { expect(FASE_LABEL.entregue).toBe('Entregue'); });
});

describe('proximaFase', () => {
  test('offset: corte → impressao', () => {
    expect(proximaFase('offset','corte')).toBe('impressao');
  });
  test('offset: impressao → acabamento', () => {
    expect(proximaFase('offset','impressao')).toBe('acabamento');
  });
  test('offset: acabamento → entrega', () => {
    expect(proximaFase('offset','acabamento')).toBe('entrega');
  });
  test('offset: entrega → entregue (terminal gate)', () => {
    expect(proximaFase('offset','entrega')).toBe('entregue');
  });
  test('cv: impressao → acabamento', () => {
    expect(proximaFase('comunicacao_visual','impressao')).toBe('acabamento');
  });
  test('cv: acabamento → entrega', () => {
    expect(proximaFase('comunicacao_visual','acabamento')).toBe('entrega');
  });
  test('cv: entrega → entregue', () => {
    expect(proximaFase('comunicacao_visual','entrega')).toBe('entregue');
  });
  test('entregue → null', () => {
    expect(proximaFase('offset','entregue')).toBeNull();
  });
  test('cancelado → null', () => {
    expect(proximaFase('offset','cancelado')).toBeNull();
  });
  test('status desconhecido → null', () => {
    expect(proximaFase('offset','aguardando')).toBeNull();
  });
  test('tipo desconhecido → null', () => {
    expect(proximaFase('desconhecido','corte')).toBeNull();
  });
});
