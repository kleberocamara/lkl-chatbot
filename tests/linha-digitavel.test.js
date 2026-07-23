const { normalizarLinhaDigitavel } = require('../src/modules/contas-pagar/linha-digitavel');

describe('normalizarLinhaDigitavel', () => {
  test('linha digitável de 47 dígitos (OCR) vira código de barras de 44 dígitos, igual ao do DDA', () => {
    const ocr = '34191570070020107030735564680003515370000076350';
    const dda = '34195153700000763501570000201070303556468000';
    expect(normalizarLinhaDigitavel(ocr)).toBe(dda);
  });

  test('código de barras de 44 dígitos já normalizado retorna igual', () => {
    const dda = '34195153700000763501570000201070303556468000';
    expect(normalizarLinhaDigitavel(dda)).toBe(dda);
  });

  test('remove pontos e espaços da linha digitável formatada', () => {
    const formatada = '34191.57007 00201.070307 35564.680003 5 15370000076350';
    const semFormatacao = '34195153700000763501570000201070303556468000';
    expect(normalizarLinhaDigitavel(formatada)).toBe(semFormatacao);
  });

  test('valor nulo ou vazio retorna como veio', () => {
    expect(normalizarLinhaDigitavel(null)).toBeNull();
    expect(normalizarLinhaDigitavel(undefined)).toBeUndefined();
    expect(normalizarLinhaDigitavel('')).toBe('');
  });

  test('tamanho desconhecido (nem 44 nem 47) mantém como veio (só remove não-dígitos)', () => {
    expect(normalizarLinhaDigitavel('123-abc-456')).toBe('123456');
  });
});
