const db = require('../db');
const { processMessage } = require('../ai/agent');
const { sendMessage, markAsRead, downloadMedia } = require('../services/whatsapp');
const { processarRespostaArte } = require('../modules/os/service');
const { notifyAnalyst } = require('../services/email');
const { log } = require('../services/logger');

// Deduplicação de mensagens já processadas
const processedMessages = new Set();

async function getOrCreateContact(phone, profileName) {
  const existing = await db.query('SELECT * FROM contacts WHERE phone = $1', [phone]);
  if (existing.rows.length > 0) {
    await db.query(
      'UPDATE contacts SET profile_name = $1, last_contact = NOW(), updated_at = NOW() WHERE phone = $2',
      [profileName, phone]
    );
    return existing.rows[0];
  }

  const result = await db.query(
    `INSERT INTO contacts (phone, profile_name, name, last_contact)
     VALUES ($1, $2, $2, NOW()) RETURNING *`,
    [phone, profileName]
  );
  await log('new_contact', `Novo contato: ${phone}`, { contactId: result.rows[0].id });
  return result.rows[0];
}

async function getActiveConversation(contactId) {
  const result = await db.query(
    `SELECT * FROM conversations WHERE contact_id = $1
     AND status IN ('active', 'aguardando_humano', 'orcamento_enviado')
     ORDER BY started_at DESC LIMIT 1`,
    [contactId]
  );
  return result.rows[0] || null;
}

async function createConversation(contactId) {
  const result = await db.query(
    `INSERT INTO conversations (contact_id, status) VALUES ($1, 'active') RETURNING *`,
    [contactId]
  );
  return result.rows[0];
}

async function saveMessage(conversationId, contactId, content, direction, waMessageId, sentBy = 'ai') {
  await db.query(
    `INSERT INTO messages (conversation_id, contact_id, content, direction, whatsapp_message_id, sent_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [conversationId, contactId, content, direction, waMessageId, sentBy]
  );
  await db.query(
    'UPDATE contacts SET total_conversations = total_conversations + 1, last_contact = NOW() WHERE id = $1',
    [contactId]
  );
}

async function handleInboundMessage(phone, profileName, messageText, waMessageId) {
  // Deduplicação
  if (processedMessages.has(waMessageId)) return;
  processedMessages.add(waMessageId);
  setTimeout(() => processedMessages.delete(waMessageId), 60000);

  const contact = await getOrCreateContact(phone, profileName);
  let conversation = await getActiveConversation(contact.id);

  if (!conversation) {
    conversation = await createConversation(contact.id);
    await log('conversation_started', `Nova conversa iniciada com ${phone}`, {
      contactId: contact.id,
      conversationId: conversation.id,
    });
  }

  // Salva mensagem do cliente
  await saveMessage(conversation.id, contact.id, messageText, 'inbound', waMessageId, 'ai');

  await log('message_received', `Mensagem recebida de ${phone}`, {
    contactId: contact.id,
    conversationId: conversation.id,
    metadata: { message: messageText.substring(0, 100) },
  });

  // Intercepta resposta de aprovação de arte (antes de qualquer outro fluxo)
  const respostaArte = await processarRespostaArte(phone, messageText);
  if (respostaArte) {
    await sendMessage(phone, respostaArte.resposta);
    await saveMessage(conversation.id, contact.id, respostaArte.resposta, 'outbound', null, 'system');
    if (global.io) global.io.emit('arte_' + (respostaArte.aprovado ? 'aprovada' : 'reprovada'), { os_id: respostaArte.os_id });
    return;
  }

  // Cliente respondeu durante período de follow-up
  if (conversation.status === 'orcamento_enviado') {
    const { cancelPendingFollowUps } = require('../services/followup');
    const cancelled = await cancelPendingFollowUps(conversation.id);

    // Detecta se o cliente está aprovando o orçamento
    const msgLower = messageText.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const aprovouOrcamento = /\b(aprovad[oa]|aprovar|aprovo|confirmo|confirmado|pode fazer|pode executar|pode seguir|pode produzir|pode comecar|fechado|fecha|aceito|aceito|topei|topou|ok|tudo certo|esta otimo|ta bom|ta otimo|pode ir|vamos em frente|de acordo|concordo)\b/.test(msgLower);

    if (aprovouOrcamento) {
      // Atualiza status para aprovado
      await db.query(
        `UPDATE conversations SET status = 'aguardando_humano', pedido_status = 'orcamento_aprovado', updated_at = NOW() WHERE id = $1`,
        [conversation.id]
      );
      await db.query(
        `UPDATE orcamentos SET status = 'aprovado' WHERE conversation_id = $1`,
        [conversation.id]
      );

      // Responde ao cliente confirmando
      const nomeCliente = contact.name || contact.profile_name || '';
      const msgConfirmacao = `Que ótimo${nomeCliente ? ', ' + nomeCliente : ''}! 🎉 Orçamento aprovado — nossa equipe já foi notificada e iniciará a produção. Em breve você receberá mais informações. Obrigado pela confiança na Gráfica LKL! 😊`;
      await sendMessage(phone, msgConfirmacao);
      await db.query(
        `INSERT INTO messages (conversation_id, contact_id, content, direction, sent_by) VALUES ($1, $2, $3, 'outbound', 'system')`,
        [conversation.id, contact.id, msgConfirmacao]
      );

      await log('orcamento_aprovado_cliente', `Cliente aprovou orçamento — pedido ${conversation.pedido_numero}`, {
        contactId: contact.id, conversationId: conversation.id,
      });

      if (global.io) {
        global.io.emit('orcamento_aprovado', { conversationId: conversation.id, phone, nome: nomeCliente });
        global.io.emit('new_message', {
          conversationId: conversation.id, contactPhone: phone,
          contactName: nomeCliente, message: messageText,
          timestamp: new Date().toISOString(), status: 'aguardando_humano',
        });
      }
    } else {
      // Cliente respondeu mas não aprovou — reabre para analista
      await db.query(
        `UPDATE conversations SET status = 'aguardando_humano', updated_at = NOW() WHERE id = $1`,
        [conversation.id]
      );
      await log('follow_up_cancelled', `Cliente respondeu — ${cancelled} follow-up(s) cancelado(s)`, {
        contactId: contact.id, conversationId: conversation.id,
      });
      if (global.io) {
        global.io.emit('new_message', {
          conversationId: conversation.id, contactPhone: phone,
          contactName: contact.name || contact.profile_name,
          message: messageText, timestamp: new Date().toISOString(), status: 'aguardando_humano',
        });
      }
    }
    return;
  }

  // Analista humano está conduzindo — não interferir com mensagem automática
  if (conversation.status === 'aguardando_humano') {
    if (global.io) {
      global.io.emit('new_message', {
        conversationId: conversation.id,
        contactPhone: phone,
        contactName: contact.name || contact.profile_name,
        message: messageText,
        timestamp: new Date().toISOString(),
        status: conversation.status,
      });
    }
    return;
  }

  // Processa com IA
  const { response, isComplete, orderDetails } = await processMessage(conversation.id, messageText);

  // Envia resposta ao cliente
  await sendMessage(phone, response);
  await saveMessage(conversation.id, contact.id, response, 'outbound', null, 'ai');

  if (isComplete) {
    await log('order_complete', `Pedido completo capturado de ${phone}`, {
      contactId: contact.id,
      conversationId: conversation.id,
      metadata: orderDetails,
    });

    // Notifica analista por email
    try {
      await notifyAnalyst({ contact, conversation, orderDetails });
    } catch (err) {
      console.error('Erro ao enviar email de notificação:', err.message);
    }
  }

  // Emite evento para o painel em tempo real (via Socket.IO global)
  if (global.io) {
    global.io.emit('new_message', {
      conversationId: conversation.id,
      contactPhone: phone,
      contactName: contact.name || contact.profile_name,
      message: messageText,
      timestamp: new Date().toISOString(),
      status: conversation.status,
    });
  }
}

async function handleInboundMedia(phone, profileName, mediaType, mediaObj, waMessageId) {
  if (processedMessages.has(waMessageId)) return;
  processedMessages.add(waMessageId);
  setTimeout(() => processedMessages.delete(waMessageId), 60000);

  const contact = await getOrCreateContact(phone, profileName);
  let conversation = await getActiveConversation(contact.id);

  if (!conversation) {
    conversation = await createConversation(contact.id);
  }

  const typeLabel = { image: 'imagem', document: 'documento', video: 'vídeo', audio: 'áudio' }[mediaType] || mediaType;
  const mediaId = mediaObj?.id || '';
  const fileName = mediaObj?.filename || '';

  // Baixa e armazena o arquivo permanentemente no servidor
  let localPath = null;
  if (mediaId) {
    try {
      localPath = await downloadMedia(mediaId, fileName);
    } catch (e) {
      console.error(`[MEDIA] Erro ao baixar ${mediaType}:`, e.message);
    }
  }

  // Formato parseável pelo dashboard: [tipo recebido: /uploads/arquivo.jpg | nome original]
  const fileRef = localPath || mediaId;
  const textRepresentation = `[${typeLabel} recebido: ${fileRef}${fileName ? ' | ' + fileName : ''}]`;

  await saveMessage(conversation.id, contact.id, textRepresentation, 'inbound', waMessageId, 'ai');

  await log('media_received', `Mídia (${mediaType}) recebida de ${phone}`, {
    contactId: contact.id, conversationId: conversation.id,
  });

  // Se conversa está em follow-up ou aguardando humano, notifica o painel sem responder
  if (conversation.status === 'orcamento_enviado' || conversation.status === 'aguardando_humano') {
    if (conversation.status === 'orcamento_enviado') {
      const { cancelPendingFollowUps } = require('../services/followup');
      await cancelPendingFollowUps(conversation.id);
      await db.query(`UPDATE conversations SET status='aguardando_humano', updated_at=NOW() WHERE id=$1`, [conversation.id]);
    }
    if (global.io) {
      global.io.emit('new_message', {
        conversationId: conversation.id, contactPhone: phone,
        contactName: contact.name || contact.profile_name,
        message: textRepresentation, timestamp: new Date().toISOString(),
        status: 'aguardando_humano',
      });
    }
    return;
  }

  // Conversa ativa — informa ao cliente que a IA não processa mídia e encaminha para analista
  const resposta = `Recebi seu ${typeLabel}! 😊 Nossa equipe irá analisá-lo e dará o retorno em breve. Se quiser, pode descrever o que precisa por aqui que eu te ajudo!`;
  await sendMessage(phone, resposta);
  await saveMessage(conversation.id, contact.id, resposta, 'outbound', null, 'ai');

  if (global.io) {
    global.io.emit('new_message', {
      conversationId: conversation.id, contactPhone: phone,
      contactName: contact.name || contact.profile_name,
      message: textRepresentation, timestamp: new Date().toISOString(),
      status: conversation.status,
    });
  }
}

module.exports = { handleInboundMessage, handleInboundMedia };
