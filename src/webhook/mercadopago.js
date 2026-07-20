// src/webhook/mercadopago.js
const crypto = require('crypto');
const { consultarPagamento } = require('../services/mercadopago');
const db = require('../db');
const { pool } = require('../db');

/**
 * MP envia duas formas de notificação (ambas tratadas aqui):
 * 1. Query params: GET/POST ?type=payment&data.id=<id>
 * 2. Body JSON: { action: "payment.updated", data: { id: "<id>" } }
 */
async function handleMercadoPagoWebhook(req, res) {
  // Responde 200 imediatamente para o MP não fazer retry
  res.sendStatus(200);

  try {
    // Validação de assinatura (opcional — só se MP_WEBHOOK_SECRET estiver configurado)
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (secret) {
      const xSignature = req.headers['x-signature'] || '';
      const xRequestId = req.headers['x-request-id'] || '';
      const dataId = req.query['data.id'] || req.body?.data?.id || '';
      const signedTemplate = `id:${dataId};request-id:${xRequestId};ts:${_extractTs(xSignature)};`;
      const expected = crypto.createHmac('sha256', secret).update(signedTemplate).digest('hex');
      const received = _extractV1(xSignature);
      if (received && received !== expected) {
        console.warn('[MP-WEBHOOK] Assinatura inválida — ignorando', {
          xSignature, xRequestId, dataId, query: req.query, template: signedTemplate, expected, received,
        });
        return;
      }
    }

    // Extrai o payment ID (query param ou body)
    const paymentId = req.query['data.id'] || req.body?.data?.id;
    const type = req.query['type'] || req.body?.action?.split('.')?.[0];

    if (!paymentId || type !== 'payment') return;

    const pagamento = await consultarPagamento(paymentId);
    if (pagamento.status !== 'approved') return;

    // external_reference = número do orçamento
    const numeroOrc = pagamento.externalReference;
    if (!numeroOrc) return;

    const r = await db.query(
      `SELECT id FROM orcamentos WHERE numero = $1 AND tipo_cobranca = 'link_mp'
       AND status_pagamento = 'aguardando_pagamento'`,
      [parseInt(numeroOrc)]
    );
    if (!r.rows[0]) return;

    const orcId = r.rows[0].id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE orcamentos SET status_pagamento='pago', pago_em=COALESCE(pago_em, NOW()),
         updated_at=NOW() WHERE id=$1 AND status_pagamento != 'pago'`,
        [orcId]
      );
      await client.query(
        `UPDATE ordens_servico SET pago=true, updated_at=NOW() WHERE orcamento_id=$1`,
        [orcId]
      );
      await client.query('COMMIT');
      console.log(`[MP-WEBHOOK] Orçamento ${numeroOrc} marcado como pago (payment ${paymentId})`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[MP-WEBHOOK] Erro:', err.message);
  }
}

function _extractTs(xSignature) {
  const m = xSignature.match(/ts=([^,]+)/);
  return m ? m[1] : '';
}

function _extractV1(xSignature) {
  const m = xSignature.match(/v1=([^,]+)/);
  return m ? m[1] : '';
}

module.exports = { handleMercadoPagoWebhook };
