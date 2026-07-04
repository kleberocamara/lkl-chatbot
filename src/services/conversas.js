const db = require('../db');

function soDigitos(cel) {
  return String(cel || '').replace(/\D/g, '');
}

// Acha o contato do WhatsApp pelo telefone (casa por sufixo de 9 dígitos p/ tolerar DDI/formatação).
async function acharContatoPorTelefone(celular) {
  const dig = soDigitos(celular);
  if (!dig) return null;
  const suf = dig.slice(-9);
  const r = await db.query(
    `SELECT * FROM contacts WHERE phone LIKE $1 OR phone = $2
     ORDER BY last_contact DESC NULLS LAST LIMIT 1`,
    [`%${suf}`, dig]
  );
  return r.rows[0] || null;
}

async function getOrCreateContatoPorTelefone(celular, nome) {
  const dig = soDigitos(celular);
  if (!dig) return null;
  const existing = await acharContatoPorTelefone(dig);
  if (existing) {
    await db.query(
      `UPDATE contacts SET name = COALESCE(name, $1), last_contact = NOW() WHERE id = $2`,
      [nome || null, existing.id]
    );
    return existing;
  }
  const ins = await db.query(
    `INSERT INTO contacts (phone, profile_name, name, last_contact)
     VALUES ($1, $2, $2, NOW()) RETURNING *`,
    [dig.slice(-9), nome || null]
  );
  return ins.rows[0];
}

async function getOrCreateConversaAtiva(contactId) {
  const r = await db.query(
    `SELECT * FROM conversations WHERE contact_id = $1
     AND status IN ('active', 'aguardando_humano', 'orcamento_enviado')
     ORDER BY started_at DESC LIMIT 1`,
    [contactId]
  );
  if (r.rows[0]) return r.rows[0];
  const ins = await db.query(
    `INSERT INTO conversations (contact_id, status) VALUES ($1, 'active') RETURNING *`,
    [contactId]
  );
  return ins.rows[0];
}

// Registra uma mensagem enviada AO cliente no histórico da conversa dele.
async function registrarMensagemCliente(celular, conteudo, opts = {}) {
  const dig = soDigitos(celular);
  if (!dig) return null;
  const sentBy = opts.sentBy || 'system';
  const waId = opts.whatsappMessageId || null;

  const contato = await getOrCreateContatoPorTelefone(dig, opts.nome);
  if (!contato) return null;
  const conversa = await getOrCreateConversaAtiva(contato.id);

  await db.query(
    `INSERT INTO messages (conversation_id, contact_id, content, direction, whatsapp_message_id, sent_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [conversa.id, contato.id, conteudo, 'outbound', waId, sentBy]
  );

  if (global.io) {
    global.io.emit('new_message', {
      conversationId: conversa.id,
      contactPhone: dig,
      contactName: contato.name || contato.profile_name || '',
      message: conteudo,
      timestamp: new Date().toISOString(),
      sent_by: sentBy,
    });
  }

  return { conversationId: conversa.id, contactId: contato.id };
}

module.exports = {
  soDigitos,
  acharContatoPorTelefone,
  registrarMensagemCliente,
};
