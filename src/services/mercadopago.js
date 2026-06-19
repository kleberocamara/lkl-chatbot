// src/services/mercadopago.js
const axios = require('axios');

const MP_BASE = 'https://api.mercadopago.com';

function mpHeaders() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) throw new Error('MP_ACCESS_TOKEN não configurado');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Idempotency-Key': `${Date.now()}-${Math.random()}`,
  };
}

/**
 * Cria uma Preference (link de checkout) no Mercado Pago.
 * @param {Object} p
 * @param {string} p.titulo
 * @param {number} p.valor
 * @param {string|number} p.orcamentoNumero  — external_reference para rastrear no webhook
 * @param {string} p.clienteNome
 * @param {string} [p.clienteEmail]
 * @returns {{ preferenceId: string, checkoutUrl: string }}
 */
async function criarPreference({ titulo, valor, orcamentoNumero, clienteNome, clienteEmail, maxParcelas }) {
  const appUrl = process.env.APP_URL || 'https://chatbot.klebercamaraconsultoria.cloud';
  const body = {
    items: [{
      title: titulo,
      quantity: 1,
      unit_price: parseFloat(valor.toFixed(2)),
      currency_id: 'BRL',
    }],
    payer: {
      name: (clienteNome || 'Cliente').slice(0, 256),
      email: clienteEmail || 'cliente@lklgrafica.com.br',
    },
    payment_methods: {
      installments: parseInt(maxParcelas) || 12,
    },
    external_reference: String(orcamentoNumero),
    notification_url: `${appUrl}/webhook/mercadopago`,
    statement_descriptor: 'FACTOR GRAFICA',
  };

  try {
    const res = await axios.post(`${MP_BASE}/checkout/preferences`, body, {
      headers: mpHeaders(),
      timeout: 15000,
    });
    const d = res.data;
    // init_point = produção, sandbox_init_point = teste
    const checkoutUrl = d.sandbox_init_point || d.init_point;
    return { preferenceId: d.id, checkoutUrl };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`Mercado Pago: ${msg}`);
  }
}

/**
 * Consulta um pagamento pelo ID.
 * @returns {{ status: string, externalReference: string, valor: number }}
 */
async function consultarPagamento(paymentId) {
  try {
    const res = await axios.get(`${MP_BASE}/v1/payments/${paymentId}`, {
      headers: mpHeaders(),
      timeout: 10000,
    });
    const d = res.data;
    return {
      status: d.status,
      externalReference: d.external_reference,
      valor: d.transaction_amount,
    };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`Mercado Pago: ${msg}`);
  }
}

module.exports = { criarPreference, consultarPagamento };
