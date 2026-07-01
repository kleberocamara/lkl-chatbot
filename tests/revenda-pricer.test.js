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
