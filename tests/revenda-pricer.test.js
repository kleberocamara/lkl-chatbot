const { calcularRevenda } = require('../src/modules/revenda/pricer');

const faixas = [
  { quantidade: 2500, prazo_horas: 12, preco_total: 76.29 },
  { quantidade: 2500, prazo_horas: 24, preco_total: 74.00 },
  { quantidade: 2500, prazo_horas: 48, preco_total: 71.78 },
  { quantidade: 5000, prazo_horas: 24, preco_total: 110.00 },
  { quantidade: 10000, prazo_horas: 24, preco_total: 195.00 },
];
const acabamentos = [
  { nome: '1 Corte Extra', preco: 3.00 },
  { nome: 'Checagem das Galáxias', preco: 9.00 },
];

describe('calcularRevenda', () => {
  test('faixa exata, prazo 24h, markup 40%, sem acabamento', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 40 }, { quantidade: 2500, prazo_horas: 24, selecionados: [] });
    expect(r.faixa_usada).toBe(2500);
    expect(r.valor_total).toBeCloseTo(103.60, 2);
    expect(r.valor_unitario).toBeCloseTo(0.0414, 3);
  });
  test('quantidade abaixo da mínima usa a menor faixa (1000 -> 2500)', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 0 }, { quantidade: 1000, prazo_horas: 24, selecionados: [] });
    expect(r.faixa_usada).toBe(2500);
    expect(r.valor_total).toBeCloseTo(74.00, 2);
  });
  test('proxima faixa acima (3000 -> 5000)', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 0 }, { quantidade: 3000, prazo_horas: 24, selecionados: [] });
    expect(r.faixa_usada).toBe(5000);
    expect(r.valor_total).toBeCloseTo(110.00, 2);
  });
  test('acima da maxima usa a maior (99999 -> 10000)', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 0 }, { quantidade: 99999, prazo_horas: 24, selecionados: [] });
    expect(r.faixa_usada).toBe(10000);
    expect(r.valor_total).toBeCloseTo(195.00, 2);
  });
  test('acabamentos somam antes da margem', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 40 }, { quantidade: 2500, prazo_horas: 24, selecionados: ['1 Corte Extra'] });
    expect(r.valor_total).toBeCloseTo(107.80, 2);
  });
  test('prazo diferente (12h)', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 0 }, { quantidade: 2500, prazo_horas: 12, selecionados: [] });
    expect(r.valor_total).toBeCloseTo(76.29, 2);
  });
  test('prazo sem faixas -> null', () => {
    const r2 = calcularRevenda({ faixas: [{ quantidade: 2500, prazo_horas: 24, preco_total: 74 }], acabamentos, markup_percent: 0 }, { quantidade: 2500, prazo_horas: 12, selecionados: [] });
    expect(r2).toBeNull();
  });
  test('quantidade ausente vira 1 (usa menor faixa)', () => {
    const r = calcularRevenda({ faixas, acabamentos, markup_percent: 0 }, { prazo_horas: 24, selecionados: [] });
    expect(r.faixa_usada).toBe(2500);
  });
});

const { calcularInternoM2 } = require('../src/modules/revenda/pricer');

const bobinasAdesivo = [{ largura_cm: 106 }, { largura_cm: 127 }, { largura_cm: 150 }];
const bobinasLona = [{ largura_cm: 160 }, { largura_cm: 220 }, { largura_cm: 320 }];

describe('calcularInternoM2', () => {
  test('adesivo 1,00m x 2,00m → melhor bobina 106 → 1,06×2,00 × R$30 = 63,60', () => {
    const r = calcularInternoM2({ bobinas: bobinasAdesivo, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 100, altura_cm: 200, quantidade: 1 });
    expect(r.bobina_cm).toBe(106);
    expect(r.valor_total).toBeCloseTo(63.60, 2);
  });
  test('lona 2,00m x 1,00m → bobina 220 → 2,20×1,00 × 30 = 66,00', () => {
    const r = calcularInternoM2({ bobinas: bobinasLona, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 200, altura_cm: 100, quantidade: 1 });
    expect(r.bobina_cm).toBe(220);
    expect(r.valor_total).toBeCloseTo(66.00, 2);
  });
  test('arte 0,50m cabe 3× na bobina 150 (util 0,50m) × qtd 3 = 45,00', () => {
    const r = calcularInternoM2({ bobinas: bobinasAdesivo, preco_m2: 30 },
      { largura_cm: 50, altura_cm: 100, quantidade: 3 });
    expect(r.bobina_cm).toBe(150);
    expect(r.valor_total).toBeCloseTo(45.00, 2);
  });
  test('dimensão ausente → null', () => {
    expect(calcularInternoM2({ bobinas: bobinasAdesivo, preco_m2: 30 }, { quantidade: 1 })).toBeNull();
  });
  test('arte mais larga que todas as bobinas → null', () => {
    expect(calcularInternoM2({ bobinas: bobinasAdesivo, preco_m2: 30 },
      { largura_cm: 200, altura_cm: 100, quantidade: 1 })).toBeNull();
  });
});
