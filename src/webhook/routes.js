const express = require('express');
const router = express.Router();
const { handleInboundMessage, handleInboundMedia } = require('./handler');
const { markAsRead, sendMessage } = require('../services/whatsapp');
const { handleC6Webhook } = require('./c6bank');
const { handleMercadoPagoWebhook } = require('./mercadopago');
const orcamentoService = require('../modules/orcamentos/service');

// Verificação do webhook (Meta exige isso na configuração)
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado com sucesso pela Meta');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Recebimento de mensagens
router.post('/', async (req, res) => {
  // Responde 200 imediatamente para a Meta não reenviar
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const messages = change.value?.messages || [];
        const contacts = change.value?.contacts || [];

        for (const msg of messages) {
          const phone = msg.from;
          const profileName = contacts.find(c => c.wa_id === phone)?.profile?.name || '';

          await markAsRead(msg.id);

          const MEDIA_TYPES = ['image', 'document', 'video', 'audio', 'sticker'];

          if (MEDIA_TYPES.includes(msg.type)) {
            const mediaObj = msg[msg.type];
            await handleInboundMedia(phone, profileName, msg.type, mediaObj, msg.id);
            continue;
          }

          if (msg.type !== 'text') continue;

          const text = msg.text?.body || '';

          // Intercepta SIM/NÃO para fluxo de aprovação de orçamento
          const respostaOrc = await orcamentoService.processarRespostaWA(phone, text);
          if (respostaOrc) {
            await sendMessage(phone, respostaOrc.mensagem);
            continue;
          }

          await handleInboundMessage(phone, profileName, text, msg.id);
        }
      }
    }
  } catch (err) {
    console.error('Erro no processamento do webhook:', err);
  }
});

// Webhook C6 Bank — confirmação de pagamento (PIX e Boleto)
router.post('/c6bank', express.json(), handleC6Webhook);

// Webhook Mercado Pago — confirmação de pagamento via IPN
router.post('/mercadopago', express.json(), handleMercadoPagoWebhook);

module.exports = router;
