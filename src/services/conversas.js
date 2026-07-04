const db = require('../db');
const whatsapp = require('./whatsapp');

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

function sanitizarLegenda(txt) {
  return String(txt || 'imagem').replace(/\|/g, '/').replace(/[\[\]]/g, '');
}

async function enviarClienteTexto(celular, texto, opts = {}) {
  await whatsapp.sendMessage(celular, texto);
  return registrarMensagemCliente(celular, texto, opts);
}

// Executa fn; se falhar, espera delayMs e tenta 1x mais. Loga o corpo real do erro. Retorna true/false.
async function _enviarComRetry(fn, delayMs = 2000) {
  try {
    await fn();
    return true;
  } catch (e) {
    console.warn('[ARTE-WA]', e.response && e.response.data ? JSON.stringify(e.response.data) : e.message);
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      await fn();
      return true;
    } catch (e2) {
      console.warn('[ARTE-WA] retry falhou:', e2.response && e2.response.data ? JSON.stringify(e2.response.data) : e2.message);
      return false;
    }
  }
}

// Envia a imagem; se falhar, espera delayMs e tenta 1x mais. Retorna true/false.
async function enviarImagemComRetry(celular, urlEnvio, caption, delayMs = 2000) {
  return _enviarComRetry(() => whatsapp.sendImage(celular, urlEnvio, caption), delayMs);
}

// Envio robusto de imagem ao cliente. Com opts.buttons envia interativo (imagem+botões → texto+botões → texto puro).
// Sem opts.buttons mantém o comportamento anterior (imagem → texto). Registra no histórico em qualquer sucesso.
// opts: { mediaRef, legenda, fallbackTexto, buttons, delayMs, sentBy }
async function enviarClienteImagem(celular, urlEnvio, caption, opts = {}) {
  const temBotoes = Array.isArray(opts.buttons) && opts.buttons.length > 0;
  const ref = opts.mediaRef || urlEnvio;
  const conteudoMidia = `[imagem recebido: ${ref} | ${sanitizarLegenda(opts.legenda)}]`;
  const textoFallback = opts.fallbackTexto || `Segue o arquivo: ${urlEnvio}`;

  if (temBotoes) {
    // 1) imagem + botões
    const okImg = await _enviarComRetry(
      () => whatsapp.sendInteractiveButtons(celular, { headerImage: urlEnvio, bodyText: caption, buttons: opts.buttons }),
      opts.delayMs
    );
    if (okImg) {
      await registrarMensagemCliente(celular, conteudoMidia, opts);
      return { ok: true, via: 'imagem' };
    }
    // 2) texto + botões (link no corpo — mantém os botões)
    const okTxt = await _enviarComRetry(
      () => whatsapp.sendInteractiveButtons(celular, { bodyText: textoFallback, buttons: opts.buttons }),
      opts.delayMs
    );
    if (okTxt) {
      await registrarMensagemCliente(celular, textoFallback, opts);
      return { ok: true, via: 'texto_botoes' };
    }
    // 3) texto puro (sem botões)
    try {
      await whatsapp.sendMessage(celular, textoFallback);
    } catch (e) {
      console.warn('[ARTE-WA] fallback texto falhou:', e.message);
      return { ok: false, via: null };
    }
    await registrarMensagemCliente(celular, textoFallback, opts);
    return { ok: true, via: 'texto' };
  }

  // Sem botões — comportamento anterior
  const ok = await enviarImagemComRetry(celular, urlEnvio, caption, opts.delayMs);
  if (ok) {
    await registrarMensagemCliente(celular, conteudoMidia, opts);
    return { ok: true, via: 'imagem' };
  }
  try {
    await whatsapp.sendMessage(celular, textoFallback);
  } catch (e) {
    console.warn('[ARTE-WA] fallback texto falhou:', e.message);
    return { ok: false, via: null };
  }
  await registrarMensagemCliente(celular, textoFallback, opts);
  return { ok: true, via: 'texto' };
}

module.exports = {
  soDigitos,
  acharContatoPorTelefone,
  registrarMensagemCliente,
  enviarClienteTexto,
  enviarImagemComRetry,
  enviarClienteImagem,
};
