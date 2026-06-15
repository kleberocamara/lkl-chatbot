const { validarCPF, validarCNPJ, validarCelular, calcularScoreCompletude } = require('../../src/utils/validators');

describe('validarCPF', () => {
  test('CPF válido', () => expect(validarCPF('529.982.247-25')).toBe(true));
  test('CPF inválido — dígito errado', () => expect(validarCPF('529.982.247-26')).toBe(false));
  test('CPF com todos dígitos iguais', () => expect(validarCPF('111.111.111-11')).toBe(false));
});

describe('validarCNPJ', () => {
  test('CNPJ válido', () => expect(validarCNPJ('11.222.333/0001-81')).toBe(true));
  test('CNPJ inválido', () => expect(validarCNPJ('11.222.333/0001-82')).toBe(false));
  test('CNPJ com todos dígitos iguais', () => expect(validarCNPJ('00.000.000/0000-00')).toBe(false));
});

describe('validarCelular', () => {
  test('celular válido SP', () => expect(validarCelular('(11) 99999-9999')).toBe(true));
  test('celular válido RJ', () => expect(validarCelular('21987654321')).toBe(true));
  test('celular sem 9 no início', () => expect(validarCelular('2187654321')).toBe(false));
  test('celular curto demais', () => expect(validarCelular('2199999')).toBe(false));
});

describe('calcularScoreCompletude', () => {
  test('cliente completo = 100', () => {
    const c = { nome: 'X', cpf_cnpj: '1', celular: '1', email: 'x@y', cep: '1', logradouro: '1', bairro: '1' };
    expect(calcularScoreCompletude(c)).toBe(100);
  });
  test('cliente só com nome = 20', () => {
    expect(calcularScoreCompletude({ nome: 'X' })).toBe(20);
  });
});
