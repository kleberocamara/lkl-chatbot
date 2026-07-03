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

const { escolherFolheto } = require('../src/modules/revenda/service');

describe('escolherFolheto', () => {
  const skus = [
    { id: 'a', gramatura: 115, larg_cm: 10, alt_cm: 14, impressao: '4/4' },
    { id: 'b', gramatura: 115, larg_cm: 10, alt_cm: 21, impressao: '4/4' },
    { id: 'c', gramatura: 115, larg_cm: 10, alt_cm: 28, impressao: '4/4' },
    { id: 'd', gramatura: 150, larg_cm: 10, alt_cm: 21, impressao: '4/4' },
    { id: 'e', gramatura: 115, larg_cm: 10, alt_cm: 21, impressao: '4/0' },
  ];
  test('menor tamanho >= pedido, impressão e gramatura corretas', () => {
    const r = escolherFolheto(skus, { gramatura: 115, largura_cm: 10, altura_cm: 20, impressao: '4/4' });
    expect(r.id).toBe('b');
  });
  test('respeita a impressão', () => {
    const r = escolherFolheto(skus, { gramatura: 115, largura_cm: 10, altura_cm: 21, impressao: '4/0' });
    expect(r.id).toBe('e');
  });
  test('gramatura mais próxima', () => {
    const r = escolherFolheto(skus, { gramatura: 140, largura_cm: 10, altura_cm: 21, impressao: '4/4' });
    expect(r.id).toBe('d');
  });
  test('nada serve → null', () => {
    expect(escolherFolheto(skus, { gramatura: 115, largura_cm: 50, altura_cm: 50, impressao: '4/4' })).toBeNull();
  });
});
