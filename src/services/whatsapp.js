const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://graph.facebook.com/v19.0';
const UPLOADS_DIR = path.join(__dirname, '../../public/uploads');

async function sendMessage(to, text) {
  const url = `${BASE_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  await axios.post(url, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text },
  }, {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

async function sendTemplate(to, templateName, languageCode = 'pt_BR', components = []) {
  const url = `${BASE_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  await axios.post(url, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: templateName, language: { code: languageCode }, components },
  }, {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

async function markAsRead(messageId) {
  const url = `${BASE_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  await axios.post(url, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  }, {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  }).catch(() => {}); // marca como lido sem travar o fluxo
}

async function getMediaUrl(mediaId) {
  const res = await axios.get(`${BASE_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
  });
  return res.data; // { url, mime_type, sha256, file_size, id }
}

// Extensões por mime_type
const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/3gpp': '.3gp',
  'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/aac': '.aac', 'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
};

// Baixa a mídia do WhatsApp e salva em /public/uploads — retorna o caminho relativo
async function downloadMedia(mediaId, originalFilename) {
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  // 1. Obtém a URL temporária
  const meta = await getMediaUrl(mediaId);
  const ext = MIME_EXT[meta.mime_type] || path.extname(originalFilename || '') || '';
  const filename = `${mediaId}${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);

  // Se já foi baixado antes, não baixa de novo
  if (fs.existsSync(filePath)) return `/uploads/${filename}`;

  // 2. Baixa o arquivo binário
  const fileRes = await axios.get(meta.url, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
  });

  fs.writeFileSync(filePath, fileRes.data);
  return `/api/file/${filename}`;
}

async function sendImage(to, imageUrl, caption) {
  const url = `${BASE_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  await axios.post(url, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'image',
    image: { link: imageUrl, caption: caption || '' },
  }, {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// Envia mensagem interativa com botões de resposta (até 3).
// opts: { headerImage?, headerText?, bodyText, buttons: [{ id, title }] }
async function sendInteractiveButtons(to, { headerImage, headerText, bodyText, buttons }) {
  const url = `${BASE_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const interactive = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: (buttons || []).map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
    },
  };
  if (headerImage) interactive.header = { type: 'image', image: { link: headerImage } };
  else if (headerText) interactive.header = { type: 'text', text: headerText };

  await axios.post(url, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive,
  }, {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

module.exports = { sendMessage, sendImage, sendInteractiveButtons, sendTemplate, markAsRead, getMediaUrl, downloadMedia };
