const fs = require('fs');
const path = require('path');
const { format } = require('date-fns');
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

function _cnpjsProprios() {
  return String(process.env.EMPRESA_CNPJS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function _prompt() {
  const cnpjs = _cnpjsProprios();
  const cnpj1 = cnpjs[0] || '(não configurado)';
  const cnpj2 = cnpjs[1] || '(não configurado)';
  return `Você recebe a foto ou PDF de um boleto ou nota fiscal de compra de uma gráfica (DANFE/NF-e).

IMPORTANTE — identificação do fornecedor:
- O FORNECEDOR é sempre o EMITENTE/REMETENTE da nota (quem vendeu/prestou o serviço) — geralmente no topo do documento, perto do CNPJ do emitente.
- O DESTINATÁRIO (para quem a nota foi emitida) NUNCA é o fornecedor — é o cliente que recebeu a mercadoria.
- Os CNPJs ${cnpj1} e ${cnpj2} são da nossa própria empresa (destinatária). Se o CNPJ que você está prestes a extrair como "fornecedor" for um desses, você pegou o bloco errado — procure o CNPJ do emitente, não o do destinatário.

IMPORTANTE — parcelas:
- Se a nota mostrar mais de um vencimento/boleto (ex: "PARCELADO", "BOL=001", "BOL=002", duplicatas), extraia CADA parcela separadamente no array "parcelas" — nunca escolha só uma.
- Se só houver 1 vencimento, "parcelas" ainda é um array, só que com 1 item.
- A soma dos valores das parcelas deve bater com o valor total da nota, se ele aparecer.

Extraia os dados e responda SOMENTE com um JSON no formato:
{"fornecedor": string ou null, "cnpj": string (somente dígitos) ou null, "data_entrega": "YYYY-MM-DD" ou null, "descricao": string ou null, "parcelas": [{"valor": number, "vencimento": "YYYY-MM-DD"}, ...] ou null}

"data_entrega" é a data de emissão ou de entrada/saída da nota (não confundir com vencimento de boleto).
Se não conseguir identificar um campo com confiança, use null nele. Não escreva nada fora do JSON.`;
}

function _validarDadosExtraidos(dados) {
  if (!dados || !dados.fornecedor) return null;
  if (!Array.isArray(dados.parcelas) || dados.parcelas.length === 0) return null;
  const parcelas = [];
  for (const p of dados.parcelas) {
    if (!p || p.valor == null || !p.vencimento) return null;
    parcelas.push({ valor: Number(p.valor), vencimento: p.vencimento });
  }
  return {
    fornecedor: dados.fornecedor,
    cnpj: dados.cnpj || null,
    data_entrega: dados.data_entrega || format(new Date(), 'yyyy-MM-dd'),
    descricao: dados.descricao || dados.fornecedor,
    parcelas,
  };
}

async function extrairDadosComprovante(absPath) {
  const dataUri = _dataUri(absPath);
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [
      { role: 'system', content: _prompt() },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] },
    ],
    temperature: 0,
    max_tokens: 500,
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
  return _validarDadosExtraidos(dados);
}

module.exports = { extrairDadosComprovante, _validarDadosExtraidos, _cnpjsProprios };
