const db = require('../db');

async function log(eventType, description, { contactId, conversationId, userId, metadata } = {}) {
  try {
    await db.query(
      `INSERT INTO activity_logs (event_type, description, contact_id, conversation_id, user_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [eventType, description, contactId || null, conversationId || null, userId || null, JSON.stringify(metadata || {})]
    );
  } catch (err) {
    console.error('Erro ao registrar log:', err.message);
  }
}

module.exports = { log };
