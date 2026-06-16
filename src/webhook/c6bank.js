const { confirmarPagamento } = require('../modules/orcamentos/service');

/**
 * Handler de webhook de confirmação de pagamento do C6 Bank.
 * PIX (padrão BACEN): body.pix[].txid
 * Boleto: body.boletoId + body.status === 'LIQUIDADO'
 */
async function handleC6Webhook(req, res) {
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
