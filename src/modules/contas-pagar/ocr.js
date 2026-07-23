const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
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
  const listaCnpjs = cnpjs.length ? cnpjs.join(', ') : '(não configurado)';
  return `Você recebe a foto ou PDF de um boleto ou nota fiscal de compra de uma gráfica (DANFE/NF-e).

IMPORTANTE — identificação do fornecedor:
- O FORNECEDOR é sempre o EMITENTE/REMETENTE da nota (quem vendeu/prestou o serviço) — geralmente no topo do documento, perto do CNPJ do emitente.
- O DESTINATÁRIO (para quem a nota foi emitida) NUNCA é o fornecedor — é o cliente que recebeu a mercadoria.
- Os CNPJs ${listaCnpjs} são da nossa própria empresa (destinatária). Se o CNPJ que você está prestes a extrair como "fornecedor" for um desses, você pegou o bloco errado — procure o CNPJ do emitente, não o do destinatário.

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
    const valorNum = Number(p.valor);
    if (!Number.isFinite(valorNum)) return null;
    parcelas.push({ valor: valorNum, vencimento: p.vencimento });
  }
  return {
    fornecedor: dados.fornecedor,
    cnpj: dados.cnpj || null,
    data_entrega: dados.data_entrega || format(new Date(), 'yyyy-MM-dd'),
    descricao: dados.descricao || dados.fornecedor,
    parcelas,
  };
}

// GPT-4o Vision rejeita PDF via image_url (só aceita png/jpeg/gif/webp) —
// por isso convertemos a 1ª página do PDF pra JPEG antes de mandar pro OCR,
// pra o fornecedor não precisar converter nada na mão.
function _isPdf(absPath) {
  return path.extname(absPath).toLowerCase() === '.pdf';
}

function _pdfParaImagem(absPath) {
  return new Promise((resolve) => {
    const outBase = path.join(os.tmpdir(), `ocr-pdf-${crypto.randomBytes(8).toString('hex')}`);
    execFile('pdftoppm', ['-jpeg', '-r', '150', '-singlefile', '-f', '1', '-l', '1', absPath, outBase], (err) => {
      if (err) { console.error('[OCR] falha ao converter PDF em imagem:', err.message); resolve(null); return; }
      const outPath = `${outBase}.jpg`;
      resolve(fs.existsSync(outPath) ? outPath : null);
    });
  });
}

// Resolve o caminho de imagem a usar no OCR: converte PDF pra JPEG temporário
// (removido logo em seguida) ou retorna o próprio caminho se já for imagem.
async function _resolverImagem(absPath) {
  if (!_isPdf(absPath)) return { imgPath: absPath, temporario: false };
  const imgPath = await _pdfParaImagem(absPath);
  if (!imgPath) return { imgPath: null, temporario: false };
  return { imgPath, temporario: true };
}

async function extrairDadosComprovante(absPath) {
  const { imgPath, temporario } = await _resolverImagem(absPath);
  if (!imgPath) { console.warn('[OCR] não foi possível ler o arquivo:', absPath); return null; }
  const dataUri = _dataUri(imgPath);
  if (temporario) fs.unlink(imgPath, () => {});
  let response;
  try {
    response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: [
        { role: 'system', content: _prompt() },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] },
      ],
      temperature: 0,
      max_tokens: 500,
    });
  } catch (err) {
    console.error('[OCR] erro ao extrair dados do comprovante:', err.message);
    return null;
  }
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

function _promptNFCompra() {
  return `Você recebe a imagem/PDF de uma Nota Fiscal de compra de mercadoria. Extraia em JSON:
{
  "nnf": "número da NF (string)",
  "emitida_em": "data de emissão no formato YYYY-MM-DD",
  "valor_total": número (valor total da nota),
  "itens": [{ "produto": "descrição do produto", "quantidade": número, "valor_unitario": número, "valor_total": número }]
}
Responda APENAS o JSON, sem texto adicional. Se não conseguir identificar um campo, use null.`;
}

async function extrairDadosNFCompra(absPath) {
  const { imgPath, temporario } = await _resolverImagem(absPath);
  if (!imgPath) { console.warn('[OCR] não foi possível ler o arquivo:', absPath); return null; }
  const dataUri = _dataUri(imgPath);
  if (temporario) fs.unlink(imgPath, () => {});
  let response;
  try {
    response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: [
        { role: 'system', content: _promptNFCompra() },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] },
      ],
      temperature: 0,
      max_tokens: 800,
    });
  } catch (err) {
    console.error('[OCR] erro ao extrair dados da NF:', err.message);
    return null;
  }
  const texto = response.choices[0]?.message?.content || '';
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function _promptLinhaDigitavel() {
  return `Você recebe a imagem de um boleto bancário. Extraia em JSON:
{ "linha_digitavel": "os dígitos da linha digitável, sem espaços", "valor": número, "vencimento": "YYYY-MM-DD" }
Responda APENAS o JSON. Se não conseguir ler algum campo, use null.`;
}

async function extrairLinhaDigitavel(absPath) {
  const { imgPath, temporario } = await _resolverImagem(absPath);
  if (!imgPath) { console.warn('[OCR] não foi possível ler o arquivo:', absPath); return null; }
  const dataUri = _dataUri(imgPath);
  if (temporario) fs.unlink(imgPath, () => {});
  let response;
  try {
    response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: [
        { role: 'system', content: _promptLinhaDigitavel() },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] },
      ],
      temperature: 0,
      max_tokens: 300,
    });
  } catch (err) {
    console.error('[OCR] erro ao extrair linha digitável:', err.message);
    return null;
  }
  const texto = response.choices[0]?.message?.content || '';
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

module.exports = { extrairDadosComprovante, _validarDadosExtraidos, _cnpjsProprios, extrairDadosNFCompra, extrairLinhaDigitavel };
