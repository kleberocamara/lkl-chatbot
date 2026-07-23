// Um boleto bancário tem duas representações numéricas equivalentes do mesmo
// documento: a linha digitável impressa (47 dígitos, com dígito verificador
// por campo) e o código de barras (44 dígitos, sem os DVs de campo). Fontes
// diferentes entregam formatos diferentes — o OCR lê a linha digitável
// impressa no boleto, mas o DDA do C6 retorna o código de barras. Sem
// normalizar pra uma forma canônica antes de comparar/gravar, a mesma dívida
// nunca bate como duplicada entre as duas fontes.
//
// Normaliza sempre para o código de barras (44 dígitos), removendo os DVs de
// campo da linha digitável.
function normalizarLinhaDigitavel(valor) {
  if (!valor) return valor;
  const digitos = String(valor).replace(/\D/g, '');
  if (digitos.length === 44) return digitos;
  if (digitos.length !== 47) return digitos; // formato desconhecido — mantém como veio

  const campo1 = digitos.slice(0, 10);
  const campo2 = digitos.slice(10, 21);
  const campo3 = digitos.slice(21, 32);
  const dvGeral = digitos.slice(32, 33);
  const fatorValor = digitos.slice(33, 47);

  return campo1.slice(0, 4) + dvGeral + fatorValor + campo1.slice(4, 9) + campo2.slice(0, 10) + campo3.slice(0, 10);
}

module.exports = { normalizarLinhaDigitavel };
