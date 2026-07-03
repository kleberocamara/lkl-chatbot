const { custoDobraMilheiro, calcularRevenda } = require('../src/modules/revenda/pricer');

describe('custoDobraMilheiro', () => {
  test('1 dobra / 1000un = R$10', () => {
    expect(custoDobraMilheiro({ dobras: 1, quantidade: 1000, base: 10, adicional: 5 })).toBe(10);
  });
  test('2 dobras / 1000un = R$15', () => {
    expect(custoDobraMilheiro({ dobras: 2, quantidade: 1000, base: 10, adicional: 5 })).toBe(15);
  });
  test('3 dobras / 2000un = R$40', () => {
    expect(custoDobraMilheiro({ dobras: 3, quantidade: 2000, base: 10, adicional: 5 })).toBe(40);
  });
  test('0 dobras = 0', () => {
    expect(custoDobraMilheiro({ dobras: 0, quantidade: 1000, base: 10, adicional: 5 })).toBe(0);
  });
});

describe('calcularRevenda com dobra', () => {
  const ctx = {
    faixas: [{ quantidade: 1000, prazo_horas: 24, preco_total: 120 }],
    acabamentos: [], markup_percent: 0, dobra_base: 10, dobra_adicional: 5,
  };
  test('inclui a dobra na conta (sem markup)', () => {
    const r = calcularRevenda(ctx, { quantidade: 1000, prazo_horas: 24, selecionados: [], dobras: 1 });
    expect(r.valor_total).toBe(130); // 120 + 10
  });
  test('sem dobra não altera', () => {
    const r = calcularRevenda(ctx, { quantidade: 1000, prazo_horas: 24, selecionados: [], dobras: 0 });
    expect(r.valor_total).toBe(120);
  });
});
