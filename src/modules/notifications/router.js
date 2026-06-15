const express = require('express');
const router = express.Router();
const db = require('../../db');

router.post('/token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token é obrigatório' });
  try {
    await db.query(
      `INSERT INTO device_tokens (user_id, token)
       VALUES ($1, $2)
       ON CONFLICT (user_id, token) DO UPDATE SET updated_at = NOW()`,
      [req.user.id, token]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[notifications] Erro ao salvar token:', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.delete('/token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token é obrigatório' });
  try {
    await db.query(
      'DELETE FROM device_tokens WHERE user_id = $1 AND token = $2',
      [req.user.id, token]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[notifications] Erro ao remover token:', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
