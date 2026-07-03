const { validarDadosConta } = require('../src/modules/revenda-compras/service');

describe('validarDadosConta', () => {
  test('aceita valor positivo e vencimento presente', () => {
    expect(validarDadosConta({ valor_compra: 150.5, vencimento: '2026-07-10' })).toEqual([]);
  });
  test('rejeita valor ausente', () => {
    expect(validarDadosConta({ vencimento: '2026-07-10' })).toContain('Informe o valor da compra (maior que zero)');
  });
  test('rejeita valor zero ou negativo', () => {
    expect(validarDadosConta({ valor_compra: 0, vencimento: '2026-07-10' })).toContain('Informe o valor da compra (maior que zero)');
    expect(validarDadosConta({ valor_compra: -5, vencimento: '2026-07-10' })).toContain('Informe o valor da compra (maior que zero)');
  });
  test('rejeita valor não numérico', () => {
    expect(validarDadosConta({ valor_compra: 'abc', vencimento: '2026-07-10' })).toContain('Informe o valor da compra (maior que zero)');
  });
  test('rejeita vencimento ausente', () => {
    expect(validarDadosConta({ valor_compra: 10 })).toContain('Informe o vencimento da conta a pagar');
  });
});
