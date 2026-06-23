// src/services/c6bank.js
// API Bolepix C6 Bank — /v2/bank_slips/
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const BASE_URL = process.env.C6_BASE_URL || 'https://baas-api-sandbox.c6bank.info';
const C6_ENV = process.env.C6_ENV || 'sandbox';
const CLIENT_ID = process.env.C6_CLIENT_ID;
const CLIENT_SECRET = process.env.C6_CLIENT_SECRET;
const PIX_KEY = process.env.C6_PIX_KEY;

// Carteira: 21=sandbox, 15=produção
const BILLING_SCHEME = C6_ENV === 'production' ? '15' : '21';

// mTLS agent
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

// Error wrapper
async function c6Request(fn) {
  try {
    return await fn();
  } catch (err) {
    const body = err.response?.data;
    const msg = body?.mensagem || body?.message || body?.detail
      || (typeof body === 'string' ? body : null)
      || err.message;
    const status = err.response?.status ? ` (HTTP ${err.response.status})` : '';
    throw new Error(`C6 Bank${status}: ${msg}`);
  }
}

// Token cache
let _tokenCache = { token: null, expiresAt: 0 };
let _inflight = null;

async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) return _tokenCache.token;
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
  const res = await c6Request(() => axios.post(`${BASE_URL}/v1/auth/`, params.toString(), {
    httpsAgent: getAgent(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }));
  const { access_token, expires_in } = res.data;
  _tokenCache = { token: access_token, expiresAt: Date.now() + (expires_in - 300) * 1000 };
  return access_token;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'partner-software-name': 'Grafica LKL',
    'partner-software-version': '1.0.0',
  };
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function vencimentoPadrao() {
  const d = new Date();
  d.setDate(d.getDate() + 5);
  return formatDate(d);
}

// external_reference_id: exatamente 26 chars [A-Z0-9]
function gerarExternalId() {
  return crypto.randomBytes(13).toString('hex').toUpperCase(); // 26 hex chars
}

/**
 * Emite boleto bancário C6 Bank — /v1/bank_slips/
 *
 * @param {Object} p
 * @param {string} p.seuNumero        - referência interna (ex: "ORC0000003"), max 10 chars alfanum
 * @param {string} p.nomeSacado       - nome do pagador (max 40 chars)
 * @param {string} p.cpfCnpjSacado    - somente dígitos
 * @param {string} [p.email]          - email do pagador
 * @param {number} p.valor            - em reais
 * @param {string} [p.dataVencimento] - YYYY-MM-DD, padrão 5 dias
 * @param {Object} [p.endereco]       - { logradouro, numero, bairro, cidade, uf, cep }
 * @returns {{ id, externalId, boletoId, linhaDigitavel, barCode, pdfBase64, pdfUrl, dataVencimento }}
 */
async function emitirBolepix({ seuNumero, nomeSacado, cpfCnpjSacado, email, valor, dataVencimento, endereco }) {
  const token = await getAccessToken();
  const vencimento = dataVencimento || vencimentoPadrao();

  // external_reference_id: 1-10 chars [a-zA-Z0-9], único por emissão
  const externalId = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars únicos

  const cep = (endereco?.cep || '25085595').replace(/\D/g, '').slice(0, 8).padStart(8, '0');
  const logradouro = (endereco?.logradouro || 'RUA NAO INFORMADA').slice(0, 33);
  const numero = parseInt(endereco?.numero) || 0;

  const body = {
    external_reference_id: externalId,
    amount: valor,
    due_date: vencimento,
    billing_scheme: BILLING_SCHEME,
    instructions: [
      'Nao receber apos 30 dias do vencimento',
      `Ref.: ${seuNumero}`,
    ],
    fine: { type: 'P', value: 2.0, dead_line: 0 },
    interest: { type: 'P', value: 1.0, dead_line: 0 },
    payer: {
      name: (nomeSacado || 'CLIENTE').slice(0, 40),
      tax_id: cpfCnpjSacado.replace(/\D/g, ''),
      ...(email ? { email } : {}),
      address: {
        street: logradouro,
        number: numero,
        city: (endereco?.cidade || 'Duque de Caxias').slice(0, 40),
        state: (endereco?.uf || 'RJ').slice(0, 2).toUpperCase(),
        zip_code: cep,
      },
    },
  };

  const res = await c6Request(() => axios.post(`${BASE_URL}/v1/bank_slips/`, body, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));

  const d = res.data;
  return {
    id: d.id,
    externalId,
    boletoId: d.id,
    linhaDigitavel: d.digitable_line || null,
    barCode: d.bar_code || null,
    pdfBase64: d.base64_pdf_file || null,
    pdfUrl: `${BASE_URL}/v1/bank_slips/${d.id}/pdf`,
    dataVencimento: vencimento,
  };
}

/**
 * Consulta boleto pelo id C6 Bank
 */
async function consultarBoleto(boletoId) {
  const token = await getAccessToken();
  const res = await c6Request(() => axios.get(`${BASE_URL}/v1/bank_slips/${boletoId}`, {
    httpsAgent: getAgent(),
    headers: { ...authHeaders(token), 'Content-Type': 'application/x-www-form-urlencoded' },
  }));
  return res.data;
}

/**
 * Cancela boleto pelo id C6 Bank
 */
async function cancelarBoleto(boletoId) {
  const token = await getAccessToken();
  // C6 (curl documentado): PUT /{id}/cancel SEM corpo, Content-Type x-www-form-urlencoded
  // (enviar corpo retorna "No request body is expected")
  await c6Request(() => axios.put(`${BASE_URL}/v1/bank_slips/${boletoId}/cancel`, undefined, {
    httpsAgent: getAgent(),
    headers: { ...authHeaders(token), 'Content-Type': 'application/x-www-form-urlencoded' },
  }));
}

/**
 * Altera um boleto emitido (vencimento, valor, multa, juros) — PUT /v1/bank_slips/{id}
 * changes: { due_date, amount, fine, interest, ... } conforme schema C6
 */
async function alterarBoleto(boletoId, changes) {
  const token = await getAccessToken();
  const res = await c6Request(() => axios.put(`${BASE_URL}/v1/bank_slips/${boletoId}`, changes, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
  return res.data;
}

/**
 * Cria cobrança PIX imediata (BACEN) — usado para PIX sem boleto
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
 * Cancela cobrança PIX imediata — PATCH /v2/pix/cob/{txid}
 */
async function cancelarPixCobranca(txid) {
  const token = await getAccessToken();
  await c6Request(() => axios.patch(`${BASE_URL}/v2/pix/cob/${txid}`, {
    status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR',
  }, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
}

async function registrarWebhookPix(webhookUrl) {
  if (!PIX_KEY) throw new Error('C6_PIX_KEY não configurado');
  const token = await getAccessToken();
  await c6Request(() => axios.put(`${BASE_URL}/v2/pix/webhook/${PIX_KEY}`, { webhookUrl }, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
}

// ─── Agendamento de Pagamentos ────────────────────────────────────────────

async function consultarDDA() {
  const token = await getAccessToken();
  const res = await c6Request(() => axios.get(`${BASE_URL}/v1/schedule_payments/query`, {
    httpsAgent: getAgent(),
    headers: { ...authHeaders(token), 'Content-Type': 'application/x-www-form-urlencoded' },
  }));
  return res.data.items || [];
}

async function criarLote(items) {
  const token = await getAccessToken();
  const res = await c6Request(() => axios.post(`${BASE_URL}/v1/schedule_payments/decode`, { items }, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
  return res.data.group_id;
}

async function consultarLote(groupId) {
  const token = await getAccessToken();
  const res = await c6Request(() => axios.get(`${BASE_URL}/v1/schedule_payments/${groupId}/items`, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
  return res.data.items || [];
}

async function removerItemLote(groupId, itemId) {
  const token = await getAccessToken();
  await c6Request(() => axios.delete(`${BASE_URL}/v1/schedule_payments/${groupId}/items/${itemId}`, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
}

async function submeterLote(groupId, uploaderName) {
  const token = await getAccessToken();
  await c6Request(() => axios.post(`${BASE_URL}/v1/schedule_payments/submit`, {
    group_id: groupId,
    uploader_name: uploaderName,
  }, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  }));
}

async function consultarExtrato(startDate, endDate) {
  const token = await getAccessToken();
  const res = await c6Request(() => axios.get(`${BASE_URL}/v1/statement/`, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
    params: { start_date: startDate, end_date: endDate },
  }));
  return res.data.entries || [];
}

module.exports = {
  emitirBolepix, consultarBoleto, cancelarBoleto, alterarBoleto,
  criarPixCobranca, cancelarPixCobranca, registrarWebhookPix,
  consultarDDA, criarLote, consultarLote, removerItemLote, submeterLote, consultarExtrato,
  _getAccessToken: getAccessToken,
  _getAgent: getAgent,
};
