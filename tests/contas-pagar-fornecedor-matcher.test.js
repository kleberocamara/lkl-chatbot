const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { normalizarNome, soDigitos, encontrarOuCriarFornecedor } = require('../src/modules/contas-pagar/fornecedor-matcher');

describe('normalizarNome', () => {
  test('maiusculas, sem acento, sem pontuação', () => {
    expect(normalizarNome('Gráfica São João Ltda.')).toBe('GRAFICA SAO JOAO LTDA');
  });
  test('vazio', () => { expect(normalizarNome('')).toBe(''); });
  test('nulo', () => { expect(normalizarNome(null)).toBe(''); });
});

describe('soDigitos', () => {
  test('remove tudo que não é dígito', () => { expect(soDigitos('12.345.678/0001-99')).toBe('12345678000199'); });
  test('vazio/nulo', () => { expect(soDigitos('')).toBe(''); expect(soDigitos(null)).toBe(''); });
});

describe('encontrarOuCriarFornecedor', () => {
  afterEach(() => jest.clearAllMocks());

  test('acha por CNPJ', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-1', nome: 'Fornecedor X' }] }); // busca por CNPJ
    const f = await encontrarOuCriarFornecedor({ nome: 'Fornecedor X Ltda', cnpj: '12.345.678/0001-99' });
    expect(f.id).toBe('uuid-1');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('sem CNPJ, acha por nome normalizado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-2', nome: 'Papelaria Central' }] }); // busca por nome
    const f = await encontrarOuCriarFornecedor({ nome: 'Papelaria Central' });
    expect(f.id).toBe('uuid-2');
  });

  test('sem match nenhum, cria fornecedor novo', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // busca por CNPJ
      .mockResolvedValueOnce({ rows: [] }) // busca por nome
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-3', nome: 'Novo Fornecedor', cnpj: '11222333000144' }] }); // insert
    const f = await encontrarOuCriarFornecedor({ nome: 'Novo Fornecedor', cnpj: '11.222.333/0001-44' });
    expect(f.id).toBe('uuid-3');
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  test('sem nome e sem cnpj → null', async () => {
    const f = await encontrarOuCriarFornecedor({});
    expect(f).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});
