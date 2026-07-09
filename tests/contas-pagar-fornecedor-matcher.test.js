const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { normalizarNome, soDigitos, encontrarOuCriarFornecedor, ehCnpjProprio } = require('../src/modules/contas-pagar/fornecedor-matcher');

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

  test('colisão de CNPJ único (chamada concorrente já criou) → busca e retorna o existente', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // busca por CNPJ inicial
      .mockResolvedValueOnce({ rows: [] }) // busca por nome
      .mockResolvedValueOnce({ rows: [] }) // INSERT ... ON CONFLICT DO NOTHING → sem linha (colidiu)
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-concorrente', nome: 'Fornecedor Concorrente' }] }); // busca de novo por CNPJ, acha o que a outra chamada criou
    const f = await encontrarOuCriarFornecedor({ nome: 'Fornecedor Concorrente', cnpj: '99.888.777/0001-66' });
    expect(f.id).toBe('uuid-concorrente');
  });

  test('sem nome e sem cnpj → null', async () => {
    const f = await encontrarOuCriarFornecedor({});
    expect(f).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('ehCnpjProprio', () => {
  const ORIGINAL_ENV = process.env.EMPRESA_CNPJS;
  afterEach(() => { process.env.EMPRESA_CNPJS = ORIGINAL_ENV; });

  test('CNPJ com máscara bate um dos CNPJs próprios (com máscara na env)', () => {
    process.env.EMPRESA_CNPJS = '19.296.723/0001-08,44.448.899/0001-85';
    expect(ehCnpjProprio('19296723000108')).toBe(true);
    expect(ehCnpjProprio('19.296.723/0001-08')).toBe(true);
  });

  test('CNPJ com máscara bate um dos CNPJs próprios (sem máscara na env)', () => {
    process.env.EMPRESA_CNPJS = '19296723000108,44448899000185';
    expect(ehCnpjProprio('19.296.723/0001-08')).toBe(true);
  });

  test('CNPJ de terceiro não bate', () => {
    process.env.EMPRESA_CNPJS = '19.296.723/0001-08,44.448.899/0001-85';
    expect(ehCnpjProprio('05.624.693/0001-07')).toBe(false);
  });

  test('EMPRESA_CNPJS vazio/ausente não quebra, retorna false', () => {
    delete process.env.EMPRESA_CNPJS;
    expect(ehCnpjProprio('19.296.723/0001-08')).toBe(false);
  });

  test('cnpj nulo/vazio → false', () => {
    process.env.EMPRESA_CNPJS = '19.296.723/0001-08';
    expect(ehCnpjProprio(null)).toBe(false);
    expect(ehCnpjProprio('')).toBe(false);
  });
});
