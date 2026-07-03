const { normalizarTelefone, normalizarNome, dedupClientes } = require('../src/ai/agent');

describe('normalizarTelefone', () => {
  test('remove 55 e formatação, últimos 9', () => {
    expect(normalizarTelefone('5521988596449')).toBe('988596449');
    expect(normalizarTelefone('21988596449')).toBe('988596449');
    expect(normalizarTelefone('(21) 98859-6449')).toBe('988596449');
  });
  test('vazio/nulo', () => {
    expect(normalizarTelefone('')).toBe('');
    expect(normalizarTelefone(null)).toBe('');
  });
});

describe('normalizarNome', () => {
  test('uppercase, sem acento, espaços', () => {
    expect(normalizarNome('Kleber de Oliveira Câmara')).toBe('KLEBER DE OLIVEIRA CAMARA');
    expect(normalizarNome('  a   nossa  ')).toBe('A NOSSA');
  });
});

describe('dedupClientes', () => {
  const kleber = (id, cel) => ({ id, nome: 'KLEBER DE OLIVEIRA CAMARA', tipo_pessoa: 'PF', celular: cel, telefone: null, email: 'k@x.com', cpf_cnpj: null, updated_at: '2026-01-01' });
  test('junta os 3 Kleber com mesmo telefone', () => {
    const r = dedupClientes([kleber(1,'21988596449'), kleber(2,'21988596449'), kleber(3,'21988596449')]);
    expect(r.length).toBe(1);
  });
  test('NÃO junta Kleber com telefone diferente', () => {
    const r = dedupClientes([kleber(1,'21988596449'), kleber(2,'5521967625358')]);
    expect(r.length).toBe(2);
  });
  test('NÃO junta empresa de email igual e nome diferente', () => {
    const drogaria = { id: 9, nome: 'A NOSSA DROGARIA', tipo_pessoa: 'PJ', celular: '21967625358', telefone: null, email: 'k@x.com', cpf_cnpj: null, updated_at: '2026-01-01' };
    const r = dedupClientes([kleber(1,'21988596449'), drogaria]);
    expect(r.length).toBe(2);
  });
  test('junta por CPF/CNPJ igual mesmo com nome diferente', () => {
    const a = { id: 1, nome: 'EMPRESA X LTDA', tipo_pessoa: 'PJ', celular: '111', telefone: null, email: null, cpf_cnpj: '02629511000100', updated_at: '2026-01-01' };
    const b = { id: 2, nome: 'EMPRESA X', tipo_pessoa: 'PJ', celular: '222', telefone: null, email: null, cpf_cnpj: '02.629.511/0001-00', updated_at: '2026-02-01' };
    const r = dedupClientes([a, b]);
    expect(r.length).toBe(1);
    expect(r[0].id).toBe(2);
  });
});
