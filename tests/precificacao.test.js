const { calcularItem, escolherBobina } = require('../src/modules/precificacao/engine');

describe('calcularItem — fixo', () => {
  test('preço fixo × quantidade', () => {
    const r = calcularItem({ metodo_calculo: 'fixo', preco_base: 2.5 }, { quantidade: 4 }, {});
    expect(r.valor_unitario).toBe(2.5);
    expect(r.valor_total).toBe(10);
  });
  test('quantidade ausente vira 1', () => {
    const r = calcularItem({ metodo_calculo: 'fixo', preco_base: 7 }, {}, {});
    expect(r.valor_total).toBe(7);
  });
});

describe('calcularItem — m2', () => {
  test('área simples', () => {
    const r = calcularItem({ metodo_calculo: 'm2', preco_base: 50 },
      { quantidade: 2, largura_cm: 100, altura_cm: 50 }, {});
    expect(r.valor_unitario).toBe(25);
    expect(r.valor_total).toBe(50);
  });
  test('aplica m2_minimo', () => {
    const r = calcularItem({ metodo_calculo: 'm2', preco_base: 50, m2_minimo: 1 },
      { quantidade: 1, largura_cm: 50, altura_cm: 50 }, {});
    expect(r.valor_unitario).toBe(50);
  });
  test('dimensão ausente → null', () => {
    expect(calcularItem({ metodo_calculo: 'm2', preco_base: 50 }, { quantidade: 1 }, {})).toBeNull();
  });
});

describe('escolherBobina', () => {
  test('sem folga: arte 0,50m, bobinas 1,52 e 1,10 → menor largura imputada', () => {
    const b = escolherBobina(50, 0, [{ largura_cm: 152 }, { largura_cm: 110 }]);
    expect(b.largura_cm).toBe(152);
    expect(b.n).toBe(3);
    expect(b.largura_util_cm).toBeCloseTo(50.6667, 3);
  });
  test('descarta bobina que não comporta a arte', () => {
    const b = escolherBobina(120, 0, [{ largura_cm: 110 }, { largura_cm: 152 }]);
    expect(b.largura_cm).toBe(152);
    expect(b.n).toBe(1);
  });
  test('folga reduz n por largura', () => {
    const b = escolherBobina(50, 2, [{ largura_cm: 152 }]);
    expect(b.n).toBe(2);
    expect(b.largura_util_cm).toBe(76);
  });
  test('nenhuma bobina comporta → null', () => {
    expect(escolherBobina(200, 0, [{ largura_cm: 152 }])).toBeNull();
  });
});

describe('calcularItem — m2_bobina', () => {
  test('cobra largura imputada × altura', () => {
    const r = calcularItem({ metodo_calculo: 'm2_bobina', preco_base: 25, espaco_corte_cm: 0 },
      { quantidade: 1, largura_cm: 50, altura_cm: 100 }, { bobinas: [{ largura_cm: 152 }] });
    expect(r.valor_unitario).toBeCloseTo(12.67, 2);
  });
  test('sem bobina que comporte → null', () => {
    const r = calcularItem({ metodo_calculo: 'm2_bobina', preco_base: 25 },
      { quantidade: 1, largura_cm: 200, altura_cm: 100 }, { bobinas: [{ largura_cm: 152 }] });
    expect(r).toBeNull();
  });
  test('dimensão ausente → null', () => {
    const r = calcularItem({ metodo_calculo: 'm2_bobina', preco_base: 25 },
      { quantidade: 1 }, { bobinas: [{ largura_cm: 152 }] });
    expect(r).toBeNull();
  });
});

describe('calcularItem — faixa', () => {
  const faixas = [
    { qtd_min: 1, qtd_max: 99, preco_unitario: 3 },
    { qtd_min: 100, qtd_max: null, preco_unitario: 2 },
  ];
  test('seleciona faixa pela quantidade', () => {
    const r = calcularItem({ metodo_calculo: 'faixa' }, { quantidade: 150 }, { faixas });
    expect(r.valor_unitario).toBe(2);
    expect(r.valor_total).toBe(300);
  });
  test('faixa com teto', () => {
    const r = calcularItem({ metodo_calculo: 'faixa' }, { quantidade: 10 }, { faixas });
    expect(r.valor_unitario).toBe(3);
  });
  test('fora de qualquer faixa → null', () => {
    const r = calcularItem({ metodo_calculo: 'faixa' }, { quantidade: 0 },
      { faixas: [{ qtd_min: 5, qtd_max: 10, preco_unitario: 3 }] });
    expect(r).toBeNull();
  });
});

describe('calcularItem — revenda', () => {
  test('usa preço espelho', () => {
    const r = calcularItem({ metodo_calculo: 'revenda' }, { quantidade: 3 },
      { precoRevenda: { preco_unitario: 9.9, sincronizado_em: '2026-06-30' } });
    expect(r.valor_unitario).toBe(9.9);
    expect(r.valor_total).toBe(29.7);
  });
  test('sem preço sincronizado → null', () => {
    expect(calcularItem({ metodo_calculo: 'revenda' }, { quantidade: 3 }, { precoRevenda: null })).toBeNull();
  });
});

describe('calcularItem — manual', () => {
  test('sempre null', () => {
    expect(calcularItem({ metodo_calculo: 'manual' }, { quantidade: 5 }, {})).toBeNull();
  });
});
