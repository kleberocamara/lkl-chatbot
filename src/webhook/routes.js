const express = require('express');
const router = express.Router();
const { handleInboundMessage } = require('./handler');
const { markAsRead } = require('../services/whatsapp');

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
          if (msg.type !== 'text') continue; // por enquanto só texto

          const phone = msg.from;
          const profileName = contacts.find(c => c.wa_id === phone)?.profile?.name || '';
          const text = msg.text?.body || '';

          await markAsRead(msg.id);
          await handleInboundMessage(phone, profileName, text, msg.id);
        }
      }
    }
  } catch (err) {
    console.error('Erro no processamento do webhook:', err);
  }
});

module.exports = router;
