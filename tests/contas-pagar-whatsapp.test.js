const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn() }));
jest.mock('../src/modules/contas-pagar/ocr', () => ({ extrairDadosComprovante: jest.fn() }));
jest.mock('../src/modules/contas-pagar/fornecedor-matcher', () => ({ encontrarOuCriarFornecedor: jest.fn() }));
jest.mock('../src/modules/contas-pagar/classificador', () => ({ classificarDespesa: jest.fn() }));
jest.mock('../src/modules/contas-pagar/service', () => ({ criarOuReconciliarContaPagar: jest.fn() }));

const { sendMessage } = require('../src/services/whatsapp');
const ocr = require('../src/modules/contas-pagar/ocr');
const fornecedorMatcher = require('../src/modules/contas-pagar/fornecedor-matcher');
const classificador = require('../src/modules/contas-pagar/classificador');
const service = require('../src/modules/contas-pagar/service');

const wa = require('../src/modules/contas-pagar/whatsapp');

describe('isNumeroAutorizado', () => {
  const OLD = process.env.CONTAS_PAGAR_WHATSAPP_NUMEROS;
  afterEach(() => { process.env.CONTAS_PAGAR_WHATSAPP_NUMEROS = OLD; });

  test('número na lista → true', () => {
    process.env.CONTAS_PAGAR_WHATSAPP_NUMEROS = '5521984023229,5521999999999';
    expect(wa.isNumeroAutorizado('5521984023229')).toBe(true);
  });
  test('número fora da lista → false', () => {
    process.env.CONTAS_PAGAR_WHATSAPP_NUMEROS = '5521984023229';
    expect(wa.isNumeroAutorizado('5511900000000')).toBe(false);
  });
  test('variável vazia → false', () => {
    process.env.CONTAS_PAGAR_WHATSAPP_NUMEROS = '';
    expect(wa.isNumeroAutorizado('5521984023229')).toBe(false);
  });
});

describe('handleComprovanteDespesa', () => {
  afterEach(() => jest.clearAllMocks());

  test('OCR não retorna dados → avisa e não grava nada', async () => {
    ocr.extrairDadosComprovante.mockResolvedValueOnce(null);
    await wa.handleComprovanteDespesa('5521984023229', 'image', '/api/file/abc.jpg');
    expect(sendMessage).toHaveBeenCalledWith('5521984023229', expect.stringMatching(/Não consegui ler/));
    expect(db.query).not.toHaveBeenCalled();
  });

  test('OCR retorna dados → grava pendente e manda resumo pra confirmar', async () => {
    ocr.extrairDadosComprovante.mockResolvedValueOnce({
      fornecedor: 'Papelaria X', cnpj: '12345678000199', valor: 200, vencimento: '2026-08-20', descricao: 'Compra papel',
    });
    fornecedorMatcher.encontrarOuCriarFornecedor.mockResolvedValueOnce({ id: 'uuid-1', nome: 'Papelaria X' });
    classificador.classificarDespesa.mockResolvedValueOnce({ tipo_despesa_id: 1, origem: 'keyword' });
    db.query
      .mockResolvedValueOnce({ rowCount: 0 }) // DELETE pendente antigo
      .mockResolvedValueOnce({ rows: [] })    // INSERT pendente
      .mockResolvedValueOnce({ rows: [{ nome: 'PAPEL E SUBSTRATOS' }] }); // nome do tipo pra mensagem

    await wa.handleComprovanteDespesa('5521984023229', 'image', '/api/file/abc.jpg');

    expect(sendMessage).toHaveBeenCalledWith('5521984023229', expect.stringMatching(/Papelaria X/));
    expect(sendMessage).toHaveBeenCalledWith('5521984023229', expect.stringMatching(/confirma/i));
  });
});

describe('processarRespostaDespesaWA', () => {
  afterEach(() => jest.clearAllMocks());

  test('texto não é sim/não → retorna null (não intercepta)', async () => {
    const r = await wa.processarRespostaDespesaWA('5521984023229', 'oi, tudo bem?');
    expect(r).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('sim/não sem pendente → retorna null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await wa.processarRespostaDespesaWA('5521984023229', 'sim');
    expect(r).toBeNull();
  });

  test('responde não → descarta o pendente', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 5, fornecedor_id: null, valor: 100, vencimento: '2026-08-01', descricao: 'x', tipo_despesa_id: null }] })
      .mockResolvedValueOnce({ rowCount: 1 }); // DELETE
    const r = await wa.processarRespostaDespesaWA('5521984023229', 'não');
    expect(r.mensagem).toMatch(/não lancei/i);
    expect(service.criarOuReconciliarContaPagar).not.toHaveBeenCalled();
  });

  test('responde sim → grava a conta e confirma', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 5, fornecedor_id: 'uuid-1', valor: 100, vencimento: '2026-08-01', descricao: 'x', tipo_despesa_id: 3 }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // DELETE
      .mockResolvedValueOnce({ rows: [{ nome: 'Fornecedor X' }] }); // nome do fornecedor
    service.criarOuReconciliarContaPagar.mockResolvedValueOnce({ id: 99 });

    const r = await wa.processarRespostaDespesaWA('5521984023229', 'SIM');
    expect(r.mensagem).toMatch(/Lançado/);
    expect(service.criarOuReconciliarContaPagar).toHaveBeenCalledWith(expect.objectContaining({
      fornecedorId: 'uuid-1', valor: 100, tipoDespesaId: 3, tipoEntrada: 'whatsapp_ocr',
    }));
  });
});
