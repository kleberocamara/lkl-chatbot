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
  test('lona 2,00m x 1,00m → gira e casa 3× na bobina 320 (menor desperdício que 220 direto)', () => {
    const r = calcularInternoM2({ bobinas: bobinasLona, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 200, altura_cm: 100, quantidade: 1 });
    expect(r.bobina_cm).toBe(320);
    expect(r.valor_total).toBeCloseTo(64.00, 2);
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
  test('arte mais larga que todas as bobinas em qualquer orientação → null', () => {
    expect(calcularInternoM2({ bobinas: bobinasAdesivo, preco_m2: 30 },
      { largura_cm: 200, altura_cm: 180, quantidade: 1 })).toBeNull();
  });
  test('só cabe girada (200x100 vira 100x200) → mesmo resultado do 100x200 direto', () => {
    const r = calcularInternoM2({ bobinas: bobinasAdesivo, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 200, altura_cm: 100, quantidade: 1 });
    expect(r.bobina_cm).toBe(106);
    expect(r.valor_total).toBeCloseTo(63.60, 2);
  });
  test('pedido 33: banner 6,78m x 2,30m → gira, bobina 3,20m, R$650,88', () => {
    const r = calcularInternoM2({ bobinas: bobinasLona, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 678, altura_cm: 230, quantidade: 1 });
    expect(r.bobina_cm).toBe(320);
    expect(r.valor_total).toBeCloseTo(650.88, 2);
  });
  test('área total abaixo de 1m² → aplica mínimo de 1m²/linha (banner 1,20m x 0,80m, qtd 1)', () => {
    const r = calcularInternoM2({ bobinas: bobinasLona, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 120, altura_cm: 80, quantidade: 1 });
    // área bruta real: bobina 160cm, gira, 2 por largura → útil 0,80m × comprimento 1,20m = 0,96m²
    // com mínimo de 1m²/linha: 1m² × R$30 = R$30,00 (em vez de R$28,80)
    expect(r.valor_total).toBeCloseTo(30.00, 2);
    expect(r.valor_unitario).toBeCloseTo(30.00, 2);
  });
  test('quantidade multiplica a área bruta antes de checar o mínimo (3 peças de área bruta pequena somam >1m² → sem ajuste)', () => {
    const r = calcularInternoM2({ bobinas: bobinasLona, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 120, altura_cm: 80, quantidade: 3 });
    // área bruta por peça 0,96m² × 3 = 2,88m² (já acima de 1m², não aciona o mínimo)
    expect(r.valor_total).toBeCloseTo(86.40, 2);
  });
  test('área bruta já acima de 1m² (peça 1,00m x 1,00m nesting na bobina 320 dá 1,0667m²) → não aciona o mínimo, resultado igual ao cálculo normal', () => {
    const r = calcularInternoM2({ bobinas: bobinasLona, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 100, altura_cm: 100, quantidade: 1 });
    // área real por nesting: bobina 320cm ÷ 3 = 106,67cm útil × 100cm = 1,0667m² × R$30 = R$32,00
    expect(r.valor_total).toBeCloseTo(32.00, 2);
  });
});
