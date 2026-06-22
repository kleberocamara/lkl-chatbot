const express = require('express');
const db = require('../../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const r = await db.query('SELECT id, nome FROM especificacoes WHERE ativo = true ORDER BY nome');
    res.json(r.rows);
  } catch (e) { console.error('[ESPEC]', e); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
