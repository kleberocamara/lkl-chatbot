const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function _dataUri(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  const b64 = fs.readFileSync(absPath).toString('base64');
  return `data:${mime};base64,${b64}`;
}

const PROMPT = `Você recebe a foto ou PDF de um boleto ou nota fiscal de compra de uma gráfica.
Extraia os dados e responda SOMENTE com um JSON no formato:
{"fornecedor": string ou null, "cnpj": string (somente dígitos) ou null, "valor": number ou null, "vencimento": "YYYY-MM-DD" ou null, "descricao": string ou null}
Se não conseguir identificar um campo com confiança, use null nele. Não escreva nada fora do JSON.`;

async function extrairDadosComprovante(absPath) {
  const dataUri = _dataUri(absPath);
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] },
    ],
    temperature: 0,
    max_tokens: 300,
  });
  const texto = response.choices[0]?.message?.content || '';
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let dados;
  try {
    dados = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!dados.fornecedor || !dados.valor || !dados.vencimento) return null;
  return {
    fornecedor: dados.fornecedor,
    cnpj: dados.cnpj || null,
    valor: Number(dados.valor),
    vencimento: dados.vencimento,
    descricao: dados.descricao || dados.fornecedor,
  };
}

module.exports = { extrairDadosComprovante };
