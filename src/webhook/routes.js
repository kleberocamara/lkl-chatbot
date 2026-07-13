const express = require('express');
const router = express.Router();
const { handleInboundMessage, handleInboundMedia } = require('./handler');
const { markAsRead, sendMessage, downloadMedia } = require('../services/whatsapp');
const { handleC6Webhook } = require('./c6bank');
const { handleMercadoPagoWebhook } = require('./mercadopago');
const orcamentoService = require('../modules/orcamentos/service');
const contasPagarWhatsapp = require('../modules/contas-pagar/whatsapp');
const { excedeuLimite } = require('./phoneRateLimit');

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

// Verifica a assinatura HMAC-SHA256 que a Meta envia em X-Hub-Signature-256, calculada com o
// App Secret do app configurado no Meta Developers (Configurações Básicas > Chave Secreta do
// Aplicativo). Sem isso, qualquer POST anônimo com o formato certo é processado como se fosse
// uma mensagem real de cliente — incluindo aprovação de orçamento por "SIM"/"NÃO" e o fluxo de
// comprovantes financeiros do número autorizado.
function _assinaturaValida(req) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // não configurado — sem essa defesa, mas não bloqueia o webhook
  const sig = req.headers['x-hub-signature-256'] || '';
  if (!sig.startsWith('sha256=') || !req.rawBody) return false;
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const received = Buffer.from(sig.slice(7));
  const expectedBuf = Buffer.from(expected);
  return received.length === expectedBuf.length && crypto.timingSafeEqual(received, expectedBuf);
}

// Recebimento de mensagens
router.post('/', async (req, res) => {
  if (!_assinaturaValida(req)) {
    console.warn('[WEBHOOK-WA] Assinatura inválida — rejeitado');
    return res.sendStatus(403);
  }
  if (!process.env.WHATSAPP_APP_SECRET) {
    console.warn('[WEBHOOK-WA] AVISO: WHATSAPP_APP_SECRET não configurado — webhook aceita POSTs sem verificar remetente.');
  }

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

          if (excedeuLimite(phone)) {
            console.warn('[WEBHOOK-WA] Limite de mensagens por telefone excedido, ignorando:', phone);
            continue;
          }

          const profileName = contacts.find(c => c.wa_id === phone)?.profile?.name || '';

          await markAsRead(msg.id);

          const MEDIA_TYPES = ['image', 'document', 'video', 'audio', 'sticker'];

          if (MEDIA_TYPES.includes(msg.type) && contasPagarWhatsapp.isNumeroAutorizado(phone) && ['image', 'document'].includes(msg.type)) {
            const mediaObj = msg[msg.type];
            let localPath = null;
            if (mediaObj?.id) {
              try { localPath = await downloadMedia(mediaObj.id, mediaObj.filename || ''); }
              catch (e) { console.error('[CONTAS-PAGAR-WA] erro ao baixar mídia:', e.message); }
            }
            if (localPath) await contasPagarWhatsapp.handleComprovanteDespesa(phone, msg.type, localPath);
            continue;
          }

          if (MEDIA_TYPES.includes(msg.type)) {
            const mediaObj = msg[msg.type];
            await handleInboundMedia(phone, profileName, msg.type, mediaObj, msg.id);
            continue;
          }

          if (msg.type === 'interactive') {
            const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
            if (reply) {
              await handleInboundMessage(phone, profileName, reply.title || '(resposta)', msg.id, reply.id || null);
            }
            continue;
          }

          if (msg.type !== 'text') continue;

          const text = msg.text?.body || '';

          // Intercepta SIM/NÃO para fluxo de confirmação de despesa (WhatsApp do financeiro)
          if (contasPagarWhatsapp.isNumeroAutorizado(phone)) {
            const respostaDespesa = await contasPagarWhatsapp.processarRespostaDespesaWA(phone, text);
            if (respostaDespesa) {
              await sendMessage(phone, respostaDespesa.mensagem);
              continue;
            }
          }

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
module.exports._assinaturaValida = _assinaturaValida;
