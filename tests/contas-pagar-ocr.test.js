const fs = require('fs');
const os = require('os');
const path = require('path');

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockCreate } },
})));

const { extrairDadosComprovante, _validarDadosExtraidos } = require('../src/modules/contas-pagar/ocr');

// PDF de 1 página válido (mínimo) — usado nos testes que exercitam a conversão
// real via pdftoppm antes do OCR.
const PDF_MINIMO = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n'
);

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

  test('PDF é convertido em imagem antes de chamar a API — GPT-4o Vision não aceita PDF via image_url', async () => {
    const tmpPdfFile = path.join(os.tmpdir(), 'comprovante-teste.pdf');
    fs.writeFileSync(tmpPdfFile, PDF_MINIMO);
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","parcelas":[{"valor":100,"vencimento":"2026-08-10"}]}' } }],
    });
    try {
      const r = await extrairDadosComprovante(tmpPdfFile);
      expect(r.fornecedor).toBe('Papelaria X');
      expect(mockCreate).toHaveBeenCalledTimes(1);
      const dataUri = mockCreate.mock.calls[0][0].messages[1].content[0].image_url.url;
      expect(dataUri).toMatch(/^data:image\/jpeg;base64,/);
    } finally {
      fs.unlinkSync(tmpPdfFile);
    }
  });

  test('PDF inválido (não renderizável) → null sem chamar a API', async () => {
    const tmpPdfFile = path.join(os.tmpdir(), 'comprovante-invalido.pdf');
    fs.writeFileSync(tmpPdfFile, Buffer.from('isso não é um PDF de verdade'));
    try {
      const r = await extrairDadosComprovante(tmpPdfFile);
      expect(r).toBeNull();
      expect(mockCreate).not.toHaveBeenCalled();
    } finally {
      fs.unlinkSync(tmpPdfFile);
    }
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

describe('extrairDadosNFCompra', () => {
  let tmpNfFile;
  let tmpNfPdfFile;
  beforeAll(() => {
    tmpNfFile = path.join(os.tmpdir(), 'nf-teste.jpg');
    fs.writeFileSync(tmpNfFile, Buffer.from([0xff, 0xd8, 0xff]));
    tmpNfPdfFile = path.join(os.tmpdir(), 'nf-teste.pdf');
    fs.writeFileSync(tmpNfPdfFile, PDF_MINIMO);
  });
  afterAll(() => { fs.unlinkSync(tmpNfFile); fs.unlinkSync(tmpNfPdfFile); });
  afterEach(() => jest.clearAllMocks());

  test('PDF é convertido em imagem antes de chamar a API — GPT-4o Vision não aceita PDF via image_url', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ nnf: '1', emitida_em: '2026-01-01', valor_total: 1, itens: [] }) } }],
    });
    const { extrairDadosNFCompra } = require('../src/modules/contas-pagar/ocr');
    const r = await extrairDadosNFCompra(tmpNfPdfFile);
    expect(r.nnf).toBe('1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('extrai número, emissão e itens da NF a partir da imagem', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        nnf: '4521', emitida_em: '2026-07-21', valor_total: 425.00,
        itens: [{ produto: 'Vinil Fosco 1,20m', quantidade: 50, valor_unitario: 8.50, valor_total: 425.00 }],
      }) } }],
    });

    const { extrairDadosNFCompra } = require('../src/modules/contas-pagar/ocr');
    const r = await extrairDadosNFCompra(tmpNfFile);

    expect(r.nnf).toBe('4521');
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0].produto).toBe('Vinil Fosco 1,20m');
  });

  test('resposta sem JSON válido → retorna null', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'não consegui ler' } }] });

    const { extrairDadosNFCompra } = require('../src/modules/contas-pagar/ocr');
    const r = await extrairDadosNFCompra(tmpNfFile);
    expect(r).toBeNull();
  });
});

describe('extrairLinhaDigitavel', () => {
  let tmpBoletoFile;
  let tmpBoletoPdfFile;
  beforeAll(() => {
    tmpBoletoFile = path.join(os.tmpdir(), 'boleto-teste.jpg');
    fs.writeFileSync(tmpBoletoFile, Buffer.from([0xff, 0xd8, 0xff]));
    tmpBoletoPdfFile = path.join(os.tmpdir(), 'boleto-teste.pdf');
    fs.writeFileSync(tmpBoletoPdfFile, PDF_MINIMO);
  });
  afterAll(() => { fs.unlinkSync(tmpBoletoFile); fs.unlinkSync(tmpBoletoPdfFile); });
  afterEach(() => jest.clearAllMocks());

  test('extrai a linha digitável de uma imagem de boleto', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        linha_digitavel: '34191790010104351004791020150008291070026000', valor: 425.00, vencimento: '2026-08-10',
      }) } }],
    });

    const { extrairLinhaDigitavel } = require('../src/modules/contas-pagar/ocr');
    const r = await extrairLinhaDigitavel(tmpBoletoFile);

    expect(r.linha_digitavel).toBe('34191790010104351004791020150008291070026000');
    expect(r.valor).toBe(425.00);
  });

  test('PDF é convertido em imagem antes de chamar a API — GPT-4o Vision não aceita PDF via image_url', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ linha_digitavel: '123', valor: 1, vencimento: '2026-01-01' }) } }],
    });
    const { extrairLinhaDigitavel } = require('../src/modules/contas-pagar/ocr');
    const r = await extrairLinhaDigitavel(tmpBoletoPdfFile);
    expect(r.linha_digitavel).toBe('123');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
