const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { classificarPorPalavraChave, classificarDespesa } = require('../src/modules/contas-pagar/classificador');

describe('classificarPorPalavraChave', () => {
  test('papel/substrato → 01', () => { expect(classificarPorPalavraChave('Compra de Papel Couché 90g')).toBe('01'); });
  test('posto de combustível → 31', () => { expect(classificarPorPalavraChave('Posto Ipiranga - combustível')).toBe('31'); });
  test('Enel → 19 (luz)', () => { expect(classificarPorPalavraChave('ENEL DISTRIBUICAO')).toBe('19'); });
  test('sem termo conhecido → null', () => { expect(classificarPorPalavraChave('xyz aleatorio')).toBeNull(); });
});

describe('classificarDespesa', () => {
  afterEach(() => jest.clearAllMocks());

  test('fornecedor já tem tipo_despesa_padrao_id → usa a memória', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ tipo_despesa_padrao_id: 7 }] });
    const r = await classificarDespesa({ fornecedorId: 'uuid-1', nomeFornecedor: 'Qualquer', descricao: null });
    expect(r).toEqual({ tipo_despesa_id: 7, origem: 'fornecedor' });
  });

  test('sem memória, mas bate por palavra-chave → busca o id do código', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ tipo_despesa_padrao_id: null }] }) // fornecedor sem memória
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });                       // SELECT id FROM tipos_despesa WHERE codigo='01'
    const r = await classificarDespesa({ fornecedorId: 'uuid-2', nomeFornecedor: 'Distribuidora de Papel', descricao: null });
    expect(r).toEqual({ tipo_despesa_id: 1, origem: 'keyword' });
  });

  test('sem fornecedorId, sem keyword → nenhum', async () => {
    const r = await classificarDespesa({ fornecedorId: null, nomeFornecedor: 'xyz', descricao: null });
    expect(r).toEqual({ tipo_despesa_id: null, origem: 'nenhum' });
    expect(db.query).not.toHaveBeenCalled();
  });
});
