const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuthApi, requireAdmin } = require('../middleware/auth');
const { sendMessage, getMediaUrl } = require('../services/whatsapp');
const { log } = require('../services/logger');

// ── AUTH ──────────────────────────────────────────────────────────────────────

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await db.query('SELECT * FROM users WHERE email = $1 AND active = true', [email]);
  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );

  await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

  res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 43200000 });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────

router.get('/dashboard/stats', requireAuthApi, async (req, res) => {
  const [contacts, conversations, todayMessages, waitingHuman, logs] = await Promise.all([
    db.query('SELECT COUNT(*) FROM contacts'),
    db.query('SELECT COUNT(*) FROM conversations'),
    db.query(`SELECT COUNT(*) FROM messages WHERE created_at >= CURRENT_DATE`),
    db.query(`SELECT COUNT(*) FROM conversations WHERE status = 'aguardando_humano'`),
    db.query(`SELECT event_type, description, created_at, metadata FROM activity_logs ORDER BY created_at DESC LIMIT 50`),
  ]);

  res.json({
    totalContacts: parseInt(contacts.rows[0].count),
    totalConversations: parseInt(conversations.rows[0].count),
    todayMessages: parseInt(todayMessages.rows[0].count),
    waitingHuman: parseInt(waitingHuman.rows[0].count),
    recentLogs: logs.rows,
  });
});

// ── CONVERSAS ─────────────────────────────────────────────────────────────────

router.get('/conversations', requireAuthApi, async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let where = '';
  const params = [limit, offset];
  if (status) {
    where = `WHERE c.status = $3`;
    params.push(status);
  }

  const result = await db.query(`
    SELECT c.*, ct.phone, ct.name, ct.profile_name,
           (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
           (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_at
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    ${where}
    ORDER BY c.updated_at DESC
    LIMIT $1 OFFSET $2
  `, params);

  res.json(result.rows);
});

router.get('/conversations/:id', requireAuthApi, async (req, res) => {
  const [conv, messages] = await Promise.all([
    db.query(`
      SELECT c.*, ct.phone, ct.name, ct.profile_name
      FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
      WHERE c.id = $1
    `, [req.params.id]),
    db.query(
      `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    ),
  ]);

  if (!conv.rows[0]) return res.status(404).json({ error: 'Conversa não encontrada' });
  res.json({ conversation: conv.rows[0], messages: messages.rows });
});

// Analista responde ao cliente
router.post('/conversations/:id/reply', requireAuthApi, async (req, res) => {
  const { message } = req.body;
  const conv = await db.query(
    `SELECT c.*, ct.phone FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
    [req.params.id]
  );
  if (!conv.rows[0]) return res.status(404).json({ error: 'Conversa não encontrada' });

  const { phone, id: convId, contact_id } = conv.rows[0];

  await sendMessage(phone, message);
  await db.query(
    `INSERT INTO messages (conversation_id, contact_id, content, direction, sent_by, sent_by_name) VALUES ($1, $2, $3, 'outbound', 'human', $4)`,
    [convId, contact_id, message, req.user.name]
  );
  await log('human_reply', `${req.user.name} respondeu em ${convId}`, {
    conversationId: convId, userId: req.user.id,
    metadata: { message: message.substring(0, 100) },
  });

  if (global.io) global.io.emit('human_reply', { conversationId: convId, message, sent_by_name: req.user.name });
  res.json({ ok: true });
});

// Marca orçamento como enviado e agenda follow-ups
router.post('/conversations/:id/orcamento-enviado', requireAuthApi, async (req, res) => {
  const { id } = req.params;
  const { scheduleFollowUps } = require('../services/followup');

  const conv = await db.query(
    `SELECT c.*, ct.phone FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
    [id]
  );
  if (!conv.rows[0]) return res.status(404).json({ error: 'Conversa não encontrada' });

  const now = new Date();
  await db.query(
    `UPDATE conversations SET status = 'orcamento_enviado', pedido_status = 'orcamento_enviado',
     orcamento_enviado_at = $1, updated_at = NOW() WHERE id = $2`,
    [now.toISOString(), id]
  );

  await scheduleFollowUps(id, now);

  await log('orcamento_enviado', `Orçamento marcado como enviado para ${conv.rows[0].phone}`, {
    conversationId: id,
    userId: req.user.id,
  });

  if (global.io) global.io.emit('conversation_updated', { id, status: 'orcamento_enviado' });
  res.json({ ok: true });
});

// Marca orçamento como aprovado pelo cliente (via painel)
router.post('/conversations/:id/orcamento-aprovado', requireAuthApi, async (req, res) => {
  const { id } = req.params;
  await db.query(
    `UPDATE conversations SET pedido_status = 'orcamento_aprovado', status = 'aguardando_humano', updated_at = NOW() WHERE id = $1`,
    [id]
  );
  await db.query(
    `UPDATE orcamentos SET status = 'aprovado' WHERE conversation_id = $1`,
    [id]
  );
  await log('orcamento_aprovado_manual', `Orçamento marcado como aprovado pelo analista`, {
    conversationId: id, userId: req.user.id,
  });
  if (global.io) global.io.emit('conversation_updated', { id, pedido_status: 'orcamento_aprovado' });
  res.json({ ok: true });
});

// Resolve conversa
router.post('/conversations/:id/resolve', requireAuthApi, async (req, res) => {
  await db.query(
    `UPDATE conversations SET status = 'resolved', resolved_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [req.params.id]
  );
  await log('conversation_resolved', `Conversa ${req.params.id} resolvida`, {
    conversationId: req.params.id, userId: req.user.id,
  });
  if (global.io) global.io.emit('conversation_updated', { id: req.params.id, status: 'resolved' });
  res.json({ ok: true });
});

// ── PEDIDOS (orders) ──────────────────────────────────────────────────────────

router.get('/orders', requireAuthApi, async (req, res) => {
  const result = await db.query(`
    SELECT
      c.id, c.pedido_numero, c.pedido_status, c.started_at AS data,
      c.needs_details, c.status AS conv_status,
      ct.name, ct.profile_name, ct.phone
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.needs_details IS NOT NULL AND c.needs_details::text != '{}'
    ORDER BY c.started_at DESC
  `);

  const rows = result.rows.map(r => {
    const d = r.needs_details || {};
    return {
      id: r.id,
      pedido_numero: r.pedido_numero,
      pedido_status: r.pedido_status || 'em_orcamento',
      data: r.data,
      nome: r.name || r.profile_name || r.phone,
      telefone: r.phone,
      contato: d.contato || '',
      email: d.email || '',
      servico: d.tipo_servico || '',
      produto: d.produto || '',
      quantidade: d.quantidade || '',
      tamanho: d.dimensoes || '',
      material: d.material || '',
      arte: d.tem_arte != null ? (d.tem_arte ? 'Sim' : 'Não') : '',
      prazo: d.prazo || '',
      entrega: d.entrega || '',
      observacoes: d.observacoes || '',
    };
  });

  res.json(rows);
});

router.post('/orders/:id/status', requireAuthApi, async (req, res) => {
  const { status } = req.body;
  await db.query(
    `UPDATE conversations SET pedido_status = $1, updated_at = NOW() WHERE id = $2`,
    [status, req.params.id]
  );
  await log('order_status_updated', `Pedido ${req.params.id} → ${status}`, {
    conversationId: req.params.id, userId: req.user.id,
  });
  res.json({ ok: true });
});

// ── ORÇAMENTOS ────────────────────────────────────────────────────────────────

// Cria orçamento manual para um pedido
router.post('/orcamentos', requireAuthApi, async (req, res) => {
  const { conversation_id, itens, desconto_pct, observacoes } = req.body;
  if (!conversation_id || !itens?.length) return res.status(400).json({ error: 'conversation_id e itens são obrigatórios' });

  const conv = await db.query('SELECT pedido_numero FROM conversations WHERE id=$1', [conversation_id]);
  if (!conv.rows[0]) return res.status(404).json({ error: 'Conversa não encontrada' });
  const pedido_numero = conv.rows[0].pedido_numero;

  const subtotal = itens.reduce((s, it) => s + (parseFloat(it.quantidade) * parseFloat(it.valor_unitario)), 0);
  const pct = parseFloat(desconto_pct) || 0;
  const total = Math.round((subtotal - subtotal * pct / 100) * 100) / 100;

  const result = await db.query(
    `INSERT INTO orcamentos (conversation_id, pedido_numero, itens, subtotal, total, desconto_pct, observacoes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pendente_aprovacao') RETURNING id`,
    [conversation_id, pedido_numero, JSON.stringify(itens), Math.round(subtotal*100)/100, total, pct, observacoes || null]
  );
  await db.query(`UPDATE conversations SET pedido_status='em_orcamento', updated_at=NOW() WHERE id=$1`, [conversation_id]);
  await log('orcamento_criado', `Orçamento manual criado para pedido #${pedido_numero}`, { userId: req.user.id });
  if (global.io) global.io.emit('new_orcamento', { pedido_numero, total });
  res.json({ ok: true, id: result.rows[0].id });
});

router.get('/orcamentos', requireAuthApi, async (req, res) => {
  const result = await db.query(`
    SELECT o.*,
           c.pedido_numero, c.contact_id,
           ct.phone, ct.name AS client_name, ct.profile_name
    FROM orcamentos o
    LEFT JOIN conversations c ON c.id = o.conversation_id
    LEFT JOIN contacts ct ON ct.id = c.contact_id
    ORDER BY o.created_at DESC
  `);
  res.json(result.rows);
});

// Salva itens editados manualmente + desconto
router.put('/orcamentos/:id/itens', requireAuthApi, async (req, res) => {
  const { itens, desconto_pct, subtotal, total, observacoes } = req.body;
  await db.query(
    `UPDATE orcamentos SET itens = $1, desconto_pct = $2, subtotal = $3, total = $4,
     observacoes = COALESCE($5, observacoes), updated_at = NOW()
     WHERE id = $6`,
    [JSON.stringify(itens), desconto_pct || 0, subtotal, total, observacoes || null, req.params.id]
  );
  await log('orcamento_editado', `Orçamento ${req.params.id} editado manualmente`, {
    userId: req.user.id,
    metadata: { total, desconto_pct },
  });
  res.json({ ok: true });
});

router.post('/orcamentos/:id/cancelar', requireAuthApi, async (req, res) => {
  const orc = await db.query('SELECT conversation_id FROM orcamentos WHERE id=$1', [req.params.id]);
  if (!orc.rows[0]) return res.status(404).json({ error: 'Orçamento não encontrado' });
  await db.query(`UPDATE orcamentos SET status='cancelado', updated_at=NOW() WHERE id=$1`, [req.params.id]);
  if (orc.rows[0].conversation_id) {
    await db.query(`UPDATE conversations SET pedido_status='cancelado', updated_at=NOW() WHERE id=$1`, [orc.rows[0].conversation_id]);
  }
  await log('orcamento_cancelado', `Orçamento ${req.params.id} cancelado`, { userId: req.user.id });
  if (global.io) global.io.emit('conversation_updated', { id: orc.rows[0].conversation_id, pedido_status: 'cancelado' });
  res.json({ ok: true });
});

router.post('/orcamentos/:id/aprovar', requireAuthApi, async (req, res) => {
  const { observacoes } = req.body;
  await db.query(
    `UPDATE orcamentos SET status = 'aprovado_interno', aprovado_por = $1, aprovado_em = NOW(),
     observacoes = COALESCE($2, observacoes) WHERE id = $3`,
    [req.user.id, observacoes || null, req.params.id]
  );
  await log('orcamento_aprovado', `Orçamento ${req.params.id} aprovado internamente`, {
    userId: req.user.id,
  });
  res.json({ ok: true });
});

router.post('/orcamentos/:id/enviado', requireAuthApi, async (req, res) => {
  const { scheduleFollowUps } = require('../services/followup');

  const orc = await db.query(
    `SELECT o.*, c.contact_id FROM orcamentos o LEFT JOIN conversations c ON c.id = o.conversation_id WHERE o.id = $1`,
    [req.params.id]
  );
  if (!orc.rows[0]) return res.status(404).json({ error: 'Orçamento não encontrado' });

  const now = new Date();
  await db.query(
    `UPDATE orcamentos SET status = 'enviado', enviado_em = NOW() WHERE id = $1`,
    [req.params.id]
  );

  if (orc.rows[0].conversation_id) {
    await db.query(
      `UPDATE conversations
       SET status = 'orcamento_enviado',
           pedido_status = 'orcamento_enviado',
           orcamento_enviado_at = $1,
           updated_at = NOW()
       WHERE id = $2 AND status != 'orcamento_enviado'`,
      [now.toISOString(), orc.rows[0].conversation_id]
    );
    await scheduleFollowUps(orc.rows[0].conversation_id, now);
  }

  await log('orcamento_enviado_cliente', `Orçamento ${req.params.id} enviado ao cliente`, {
    userId: req.user.id,
  });
  res.json({ ok: true });
});

// Envio direto de mensagem (usado pelo botão "Enviar orçamento")
router.post('/conversations/send-message', requireAuthApi, async (req, res) => {
  const { phone, message, conversation_id } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone e message são obrigatórios' });

  await sendMessage(phone, message);

  if (conversation_id) {
    const conv = await db.query(`SELECT contact_id FROM conversations WHERE id = $1`, [conversation_id]);
    if (conv.rows[0]) {
      await db.query(
        `INSERT INTO messages (conversation_id, contact_id, content, direction, sent_by)
         VALUES ($1, $2, $3, 'outbound', 'human')`,
        [conversation_id, conv.rows[0].contact_id, message]
      );
    }
  }
  res.json({ ok: true });
});

// ── MEDIA ─────────────────────────────────────────────────────────────────────

// Serve arquivo de mídia salvo localmente — contorna problema de proxy com /uploads/
router.get('/file/:filename', requireAuthApi, (req, res) => {
  const path = require('path');
  const fs = require('fs');
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, ''); // sanitiza
  const filePath = path.join(__dirname, '../../public/uploads', filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
  res.sendFile(filePath);
});

router.get('/media/:mediaId', requireAuthApi, async (req, res) => {
  try {
    const data = await getMediaUrl(req.params.mediaId);
    res.json({ url: data.url, mime_type: data.mime_type });
  } catch (e) {
    console.error('Erro ao buscar media:', e.message);
    res.status(500).json({ error: 'Não foi possível obter o link do arquivo' });
  }
});

// ── CONFIGURAÇÕES ─────────────────────────────────────────────────────────────

router.get('/settings', requireAdmin, async (req, res) => {
  const result = await db.query('SELECT * FROM settings ORDER BY key');
  res.json(result.rows);
});

router.put('/settings/:key', requireAdmin, async (req, res) => {
  const { value } = req.body;
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [req.params.key, value]
  );
  await log('settings_updated', `Configuração "${req.params.key}" atualizada`, { userId: req.user.id });
  res.json({ ok: true });
});

// ── TABELA DE PREÇOS ──────────────────────────────────────────────────────────

router.get('/prices', requireAuthApi, async (req, res) => {
  const result = await db.query('SELECT * FROM price_table ORDER BY servico, qtd_min');
  res.json(result.rows);
});

router.post('/prices/:id', requireAdmin, async (req, res) => {
  const { valor_unitario, prazo_dias, active } = req.body;
  await db.query(
    `UPDATE price_table SET valor_unitario = $1, prazo_dias = $2, active = $3, updated_at = NOW() WHERE id = $4`,
    [valor_unitario, prazo_dias, active, req.params.id]
  );
  await log('price_updated', `Preço ID ${req.params.id} atualizado`, { userId: req.user.id });
  res.json({ ok: true });
});

// ── USUÁRIOS (admin) ──────────────────────────────────────────────────────────

router.get('/users', requireAdmin, async (req, res) => {
  const result = await db.query('SELECT id, name, email, role, active, last_login, created_at FROM users ORDER BY created_at');
  res.json(result.rows);
});

router.post('/users', requireAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const result = await db.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role`,
    [name, email, hash, role || 'analyst']
  );
  res.json(result.rows[0]);
});

router.post('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { name, email, role, password } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Nome e e-mail são obrigatórios' });

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await db.query(
        `UPDATE users SET name=$1, email=$2, role=$3, password_hash=$4 WHERE id=$5`,
        [name, email, role || 'analyst', hash, req.params.id]
      );
    } else {
      await db.query(
        `UPDATE users SET name=$1, email=$2, role=$3 WHERE id=$4`,
        [name, email, role || 'analyst', req.params.id]
      );
    }
    await log('user_updated', `Usuário ${req.params.id} atualizado por ${req.user.name}`, { userId: req.user.id });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro ao editar usuário:', e.message);
    res.status(500).json({ error: 'Erro ao salvar usuário' });
  }
});

router.patch('/users/:id/toggle', requireAdmin, async (req, res) => {
  await db.query('UPDATE users SET active = NOT active WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
