const { confirmarPagamento } = require('../modules/orcamentos/service');

/**
 * Handler de webhook de confirmação de pagamento do C6 Bank.
 * PIX (padrão BACEN): body.pix[].txid
 * Boleto: body.boletoId + body.status === 'LIQUIDADO'
 */
async function handleC6Webhook(req, res) {
  // Signature verification (if C6_WEBHOOK_SECRET is configured)
  const secret = process.env.C6_WEBHOOK_SECRET;
  if (secret) {
    const crypto = require('crypto');
    const sig = req.headers['x-webhook-signature'] || req.headers['x-c6-signature'] || '';
    if (!sig) {
      console.warn('[C6-WEBHOOK] Assinatura ausente no header — rejeitado');
      return res.sendStatus(401);
    }
    const payload = JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const sigBuf = Buffer.from(sig.replace(/^sha256=/, ''));
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.warn('[C6-WEBHOOK] Assinatura inválida — rejeitado');
      return res.sendStatus(403);
    }
  } else {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[C6-WEBHOOK] AVISO: C6_WEBHOOK_SECRET não configurado em produção!');
    }
  }

  // Responde imediatamente — C6 pode retentar se demorar
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log('[C6-WEBHOOK]', JSON.stringify(body).slice(0, 300));

    // Formato PIX (padrão BACEN): { pix: [{ txid, valor, horario, ... }] }
    if (body.pix && Array.isArray(body.pix)) {
      for (const pagamento of body.pix) {
        if (!pagamento.txid) continue;
        const result = await confirmarPagamento({ tipo: 'pix', txid: pagamento.txid });
        if (result.confirmado) {
          console.log(`[C6-PIX] Pagamento confirmado — ORC ID: ${result.orcamento_id}`);
        } else {
          console.warn('[C6-PIX] Não encontrado para txid:', pagamento.txid);
        }
      }
      return;
    }

    // Formato Boleto C6: { boletoId, status, ... }
    if (body.boletoId && body.status === 'LIQUIDADO') {
      const result = await confirmarPagamento({ tipo: 'boleto', boletoId: body.boletoId });
      if (result.confirmado) {
        console.log(`[C6-BOLETO] Pagamento confirmado — ORC ID: ${result.orcamento_id}`);
      } else {
        console.warn('[C6-BOLETO] Não encontrado para boletoId:', body.boletoId);
      }
      return;
    }

    console.warn('[C6-WEBHOOK] Payload não reconhecido:', JSON.stringify(body).slice(0, 200));
  } catch (err) {
    console.error('[C6-WEBHOOK] Erro ao processar:', err.message);
  }
}

module.exports = { handleC6Webhook };
