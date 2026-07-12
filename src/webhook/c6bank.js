const { confirmarPagamento } = require('../modules/orcamentos/service');
const c6bank = require('../services/c6bank');

/**
 * Handler de webhook de confirmação de pagamento do C6 Bank.
 * PIX (padrão BACEN): body.pix[].txid
 * Boleto: body.boletoId + body.status === 'LIQUIDADO'
 *
 * SEGURANÇA: o body do webhook NUNCA é tratado como fonte de verdade — só usamos dele
 * o identificador (txid/boletoId) para saber O QUE reconsultar. O status real vem sempre
 * de uma chamada de volta à API do C6 (mesmo padrão já usado no webhook do Mercado Pago),
 * então mesmo uma requisição forjada (sem assinatura válida) não consegue marcar um pedido
 * como pago sem que o C6 realmente confirme o pagamento.
 */
async function handleC6Webhook(req, res) {
  // Verificação de assinatura (defesa em profundidade — a reconsulta abaixo é a defesa primária)
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
    console.warn('[C6-WEBHOOK] AVISO: C6_WEBHOOK_SECRET não configurado — seguindo apenas com reconsulta ao C6 como defesa.');
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
        let cobranca;
        try {
          cobranca = await c6bank.consultarPixCobranca(pagamento.txid);
        } catch (e) {
          console.warn('[C6-PIX] Falha ao reconsultar txid no C6:', pagamento.txid, e.message);
          continue;
        }
        if (cobranca?.status !== 'CONCLUIDA') {
          console.warn('[C6-PIX] Reconsulta não confirma pagamento — ignorando. txid:', pagamento.txid, 'status real:', cobranca?.status);
          continue;
        }
        const result = await confirmarPagamento({ tipo: 'pix', txid: pagamento.txid });
        if (result.confirmado) {
          console.log(`[C6-PIX] Pagamento confirmado — ORC ID: ${result.orcamento_id}`);
        } else {
          console.warn('[C6-PIX] Não encontrado para txid:', pagamento.txid);
        }
      }
      return;
    }

    // Formato Boleto C6: { boletoId, status, ... } — status do body é só um sinal pra saber que vale a pena reconsultar
    if (body.boletoId) {
      let boleto;
      try {
        boleto = await c6bank.consultarBoleto(body.boletoId);
      } catch (e) {
        console.warn('[C6-BOLETO] Falha ao reconsultar boletoId no C6:', body.boletoId, e.message);
        return;
      }
      if (boleto?.status !== 'LIQUIDADO') {
        console.warn('[C6-BOLETO] Reconsulta não confirma pagamento — ignorando. boletoId:', body.boletoId, 'status real:', boleto?.status);
        return;
      }
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
