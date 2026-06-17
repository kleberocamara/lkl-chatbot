// src/services/c6bank.js
const axios = require('axios');
const https = require('https');
const fs = require('fs');

const BASE_URL = process.env.C6_BASE_URL || 'https://baas-api-sandbox.c6bank.info';
const CLIENT_ID = process.env.C6_CLIENT_ID;
const CLIENT_SECRET = process.env.C6_CLIENT_SECRET;
const PIX_KEY = process.env.C6_PIX_KEY;

// mTLS agent — lido uma vez no boot
let _agent = null;
function getAgent() {
  if (!_agent) {
    const certPath = process.env.C6_CERT_PATH;
    const keyPath = process.env.C6_KEY_PATH;
    if (!certPath || !keyPath) throw new Error('C6_CERT_PATH e C6_KEY_PATH não configurados');
    _agent = new https.Agent({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      rejectUnauthorized: true,
    });
  }
  return _agent;
}

// Error sanitization wrapper
async function c6Request(fn) {
  try {
    return await fn();
  } catch (err) {
    const msg = err.response?.data?.mensagem || err.response?.data?.message || err.message;
    throw new Error(`C6 Bank: ${msg}`);
  }
}

// Token cache — válido 55 minutos (C6 expira em 60)
let _tokenCache = { token: null, expiresAt: 0 };
let _inflight = null;

async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.token;
  }
  if (_inflight) return _inflight;
  _inflight = _fetchToken().finally(() => { _inflight = null; });
  return _inflight;
}

async function _fetchToken() {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await c6Request(() => axios.post(`${BASE_URL}/v1/token`, params.toString(), {
    httpsAgent: getAgent(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }));
  const { access_token, expires_in } = res.data;
  _tokenCache = {
    token: access_token,
    expiresAt: Date.now() + (expires_in - 300) * 1000, // 5min de margem
  };
  return access_token;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function vencimentoPadrao() {
  const d = new Date();
  d.setDate(d.getDate() + 5);
  return formatDate(d);
}

/**
 * Emite boleto de cobrança
 * @param {Object} params
 * @param {string} params.seuNumero - referência interna (ex: "ORC-1")
 * @param {string} params.nomeSacado
 * @param {string} params.cpfCnpjSacado - somente dígitos
 * @param {number} params.valor - em reais (ex: 150.00)
 * @param {string} [params.dataVencimento] - YYYY-MM-DD, padrão 5 dias
 * @returns {Object} { boletoId, linhaDigitavel, pdfUrl, dataVencimento }
 */
async function emitirBoleto({ seuNumero, nomeSacado, cpfCnpjSacado, valor, dataVencimento }) {
  const token = await getAccessToken();
  const vencimento = dataVencimento || vencimentoPadrao();
  const res = await c6Request(() => axios.post(`${BASE_URL}/v1/boleto`, {
    seuNumero,
    nomeSacado,
    cpfCnpjSacado: cpfCnpjSacado.replace(/\D/g, ''),
    valor,
    dataVencimento: vencimento,
    jurosDiarios: 0.033,
    multa: 2.0,
  }, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
  const d = res.data;
  return {
    boletoId: d.boletoId || d.id,
    linhaDigitavel: d.linhaDigitavel || d.codigoDeBarras,
    pdfUrl: d.urlBoleto || d.pdfUrl || null,
    dataVencimento: vencimento,
  };
}

/**
 * Cria cobrança PIX imediata (padrão BACEN / DICT)
 * @param {Object} params
 * @param {string} params.txid - identificador único (32 chars alphanum)
 * @param {number} params.valor - em reais
 * @param {string} params.nomeDevedor
 * @param {string} params.cpfCnpjDevedor - somente dígitos
 * @param {string} params.solicitacao - descrição (ex: "ORC #1 - LKL Gráfica")
 * @returns {Object} { txid, pixCopiaECola, qrCodeBase64 }
 */
async function criarPixCobranca({ txid, valor, nomeDevedor, cpfCnpjDevedor, solicitacao }) {
  if (!PIX_KEY) throw new Error('C6_PIX_KEY não configurado');
  const token = await getAccessToken();
  const cpfCnpj = cpfCnpjDevedor.replace(/\D/g, '');
  const devedor = cpfCnpj.length === 11
    ? { cpf: cpfCnpj, nome: nomeDevedor }
    : { cnpj: cpfCnpj, nome: nomeDevedor };

  const res = await c6Request(() => axios.put(`${BASE_URL}/v2/pix/cob/${txid}`, {
    calendario: { expiracao: 86400 },
    devedor,
    valor: { original: valor.toFixed(2) },
    chave: PIX_KEY,
    solicitacaoPagador: solicitacao,
  }, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
  const d = res.data;
  return {
    txid: d.txid,
    pixCopiaECola: d.pixCopiaECola || d.pix_copia_cola,
    qrCodeBase64: d.imagemQrcode || null,
  };
}

/**
 * Registra webhook para notificações PIX
 * @param {string} webhookUrl - URL pública do endpoint
 */
async function registrarWebhookPix(webhookUrl) {
  if (!PIX_KEY) throw new Error('C6_PIX_KEY não configurado');
  const token = await getAccessToken();
  await c6Request(() => axios.put(`${BASE_URL}/v2/pix/webhook/${PIX_KEY}`, { webhookUrl }, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
}

module.exports = { emitirBoleto, criarPixCobranca, registrarWebhookPix };
