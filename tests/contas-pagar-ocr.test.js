const fs = require('fs');
const os = require('os');
const path = require('path');

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockCreate } },
})));

const { extrairDadosComprovante } = require('../src/modules/contas-pagar/ocr');

describe('extrairDadosComprovante', () => {
  let tmpFile;
  beforeAll(() => {
    tmpFile = path.join(os.tmpdir(), 'comprovante-teste.jpg');
    fs.writeFileSync(tmpFile, Buffer.from([0xff, 0xd8, 0xff])); // bytes mínimos, conteúdo não importa (mock)
  });
  afterAll(() => { fs.unlinkSync(tmpFile); });
  afterEach(() => jest.clearAllMocks());

  test('resposta válida do modelo → retorna objeto normalizado', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","cnpj":"12345678000199","valor":150.5,"vencimento":"2026-08-10","descricao":"Compra de papel"}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toEqual({
      fornecedor: 'Papelaria X', cnpj: '12345678000199', valor: 150.5,
      vencimento: '2026-08-10', descricao: 'Compra de papel',
    });
  });

  test('resposta sem campos obrigatórios (valor ausente) → null', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","vencimento":"2026-08-10"}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toBeNull();
  });

  test('resposta sem JSON válido → null', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'não consegui ler' } }] });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toBeNull();
  });
});
