const fs = require('fs');
const os = require('os');
const path = require('path');

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockCreate } },
})));

const { extrairDadosComprovante, _validarDadosExtraidos } = require('../src/modules/contas-pagar/ocr');

describe('extrairDadosComprovante', () => {
  let tmpFile;
  beforeAll(() => {
    tmpFile = path.join(os.tmpdir(), 'comprovante-teste.jpg');
    fs.writeFileSync(tmpFile, Buffer.from([0xff, 0xd8, 0xff])); // bytes mínimos, conteúdo não importa (mock)
  });
  afterAll(() => { fs.unlinkSync(tmpFile); });
  afterEach(() => jest.clearAllMocks());

  test('resposta válida com 1 parcela → retorna objeto normalizado', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","cnpj":"12345678000199","data_entrega":"2026-08-01","descricao":"Compra de papel","parcelas":[{"valor":150.5,"vencimento":"2026-08-10"}]}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toEqual({
      fornecedor: 'Papelaria X', cnpj: '12345678000199', data_entrega: '2026-08-01',
      descricao: 'Compra de papel', parcelas: [{ valor: 150.5, vencimento: '2026-08-10' }],
    });
  });

  test('resposta válida com 2 parcelas → array com as 2', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Konita Brasil","cnpj":"05624693000107","data_entrega":"2026-05-15","descricao":null,"parcelas":[{"valor":817.85,"vencimento":"2026-06-15"},{"valor":817.84,"vencimento":"2026-06-29"}]}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r.parcelas).toEqual([
      { valor: 817.85, vencimento: '2026-06-15' },
      { valor: 817.84, vencimento: '2026-06-29' },
    ]);
  });

  test('sem fornecedor → null', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"parcelas":[{"valor":100,"vencimento":"2026-08-10"}]}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toBeNull();
  });

  test('sem parcelas (array vazio ou ausente) → null', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","parcelas":[]}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toBeNull();
  });

  test('parcela sem valor ou vencimento → null (toda a extração é descartada)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","parcelas":[{"valor":100,"vencimento":"2026-08-10"},{"valor":null,"vencimento":"2026-09-10"}]}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toBeNull();
  });

  test('sem data_entrega → usa a data de hoje como fallback', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","parcelas":[{"valor":100,"vencimento":"2026-08-10"}]}' } }],
    });
    const { format } = require('date-fns');
    const hoje = format(new Date(), 'yyyy-MM-dd');
    const r = await extrairDadosComprovante(tmpFile);
    expect(r.data_entrega).toBe(hoje);
  });

  test('resposta sem JSON válido → null', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'não consegui ler' } }] });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toBeNull();
  });

  test('o prompt enviado ao modelo menciona emitente/destinatário e os CNPJs próprios', async () => {
    process.env.EMPRESA_CNPJS = '19.296.723/0001-08,44.448.899/0001-85';
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"X","parcelas":[{"valor":1,"vencimento":"2026-08-10"}]}' } }],
    });
    await extrairDadosComprovante(tmpFile);
    const promptEnviado = mockCreate.mock.calls[0][0].messages[0].content;
    expect(promptEnviado).toMatch(/EMITENTE/);
    expect(promptEnviado).toMatch(/DESTINATÁRIO/);
    expect(promptEnviado).toMatch(/19\.296\.723\/0001-08/);
    expect(promptEnviado).toMatch(/44\.448\.899\/0001-85/);
  });
});

describe('_validarDadosExtraidos', () => {
  test('normaliza valores numéricos das parcelas (strings viram number)', () => {
    const r = _validarDadosExtraidos({ fornecedor: 'X', parcelas: [{ valor: '150.50', vencimento: '2026-08-10' }] });
    expect(r.parcelas[0].valor).toBe(150.5);
  });

  test('valor não numérico na parcela → null', () => {
    const r = _validarDadosExtraidos({ fornecedor: 'X', parcelas: [{ valor: 'R$ 150,50', vencimento: '2026-08-10' }] });
    expect(r).toBeNull();
  });
});
