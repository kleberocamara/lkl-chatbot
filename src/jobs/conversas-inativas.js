const cron = require('node-cron');
const db = require('../db');

function log(msg) { console.log(`[CRON-CONVERSAS] ${new Date().toISOString()} ${msg}`); }

// 03h00 — Fecha conversas sem nenhuma mensagem há 3+ dias
cron.schedule('0 3 * * *', async () => {
  try {
    const r = await db.query(`
      UPDATE conversations SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
      WHERE status IN ('active', 'aguardando_humano', 'orcamento_enviado')
        AND id NOT IN (
          SELECT DISTINCT conversation_id FROM messages
          WHERE created_at > NOW() - INTERVAL '3 days'
        )
        AND updated_at < NOW() - INTERVAL '3 days'
      RETURNING id`);
    log(`${r.rowCount} conversa(s) fechada(s) por inatividade`);
  } catch (err) {
    log(`ERRO: ${err.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });
