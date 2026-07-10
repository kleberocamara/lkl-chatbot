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
  test('lona 2,00m x 1,00m, qtd 1 → não gira, bobina 220 (largura cheia, sem dividir por peças hipotéticas)', () => {
    const r = calcularInternoM2({ bobinas: bobinasLona, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 200, altura_cm: 100, quantidade: 1 });
    // com qtd=1, não faz sentido dividir a bobina por várias peças hipotéticas — usa a bobina inteira.
    // normal (200cm de largura): bobina 220cm, n=1, útil=220cm → área = 2,20m × 1,00m = 2,20m²
    // girada (100cm de largura): bobina 160cm, n=1, útil=160cm → área = 1,60m × 2,00m = 3,20m²
    // 2,20m² é menor → escolhe normal (bobina 220, não gira)
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
  test('banner 1,20m x 0,80m, qtd 1 → bobina 160cm cheia (não divide por peça hipotética), R$38,40', () => {
    const r = calcularInternoM2({ bobinas: bobinasLona, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 120, altura_cm: 80, quantidade: 1 });
    // capacidade física da bobina 160cm comportaria 2 peças de 80cm de largura, mas só 1 foi pedida —
    // não faz sentido dividir o custo da largura com uma peça que não existe.
    // normal (120cm largura): bobina 160, n=1, útil=160cm → área = 1,60m × 0,80m = 1,28m²
    // girada (80cm largura): bobina 160, n=1 (min(2,1)), útil=160cm → área = 1,60m × 1,20m = 1,92m²
    // 1,28m² é menor → escolhe normal.
    expect(r.bobina_cm).toBe(160);
    expect(r.valor_total).toBeCloseTo(38.40, 2);
    expect(r.valor_unitario).toBeCloseTo(38.40, 2);
  });
  test('banner 1,20m x 0,80m, qtd 3 → capacidade (2) é menor que a quantidade (3), continua dividindo normalmente', () => {
    const r = calcularInternoM2({ bobinas: bobinasLona, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 120, altura_cm: 80, quantidade: 3 });
    // aqui a capacidade física (2 peças cabem lado a lado) é MENOR que a quantidade pedida (3),
    // então o min(capacidade, quantidade) = 2 continua valendo — comportamento igual ao de antes do fix.
    expect(r.bobina_cm).toBe(160);
    expect(r.valor_total).toBeCloseTo(86.40, 2);
  });
  test('peça pequena 0,30m x 0,30m, qtd 1 → área real 0,48m², aciona mínimo de 1m²/linha → R$30,00', () => {
    const r = calcularInternoM2({ bobinas: bobinasLona, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 30, altura_cm: 30, quantidade: 1 });
    // peça bem menor que qualquer bobina — com qtd=1, usa a menor bobina disponível (160cm) inteira:
    // 1,60m × 0,30m = 0,48m², abaixo do mínimo de 1m²/linha → cobrado como 1m² = R$30,00.
    expect(r.valor_total).toBeCloseTo(30.00, 2);
    expect(r.valor_unitario).toBeCloseTo(30.00, 2);
  });
  test('peça 1,00m x 1,00m, qtd 1 → bobina 160cm cheia (não faz nesting de 3 peças hipotéticas), área acima de 1m², sem ajuste de mínimo', () => {
    const r = calcularInternoM2({ bobinas: bobinasLona, preco_m2: 30, espaco_corte_cm: 0 },
      { largura_cm: 100, altura_cm: 100, quantidade: 1 });
    // com qtd=1, não faz sentido dividir a bobina entre 3 cópias hipotéticas (nesting) —
    // usa a menor bobina que comporta a peça inteira: bobina 160cm × 1,00m = 1,60m² × R$30 = R$48,00
    expect(r.bobina_cm).toBe(160);
    expect(r.valor_total).toBeCloseTo(48.00, 2);
  });
});
