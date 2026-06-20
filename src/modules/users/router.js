const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../db/index');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();
const requireGestorPlus = requireRole('admin', 'gestor');

router.get('/', requireGestorPlus, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, active, matricula, setor, last_login, created_at
       FROM users ORDER BY created_at ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireGestorPlus, async (req, res) => {
  try {
    const { name, email, password, role, setor } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'nome, email e senha são obrigatórios' });
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, setor)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role, matricula, setor`,
      [name, email, hash, role || 'atendente', setor || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'E-mail já cadastrado' });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', requireGestorPlus, async (req, res) => {
  try {
    const { active, role, setor, name, observacao } = req.body;
    const sets = [];
    const vals = [];
    let i = 1;
    if (active !== undefined) { sets.push(`active=$${i++}`); vals.push(active); }
    if (role     !== undefined) { sets.push(`role=$${i++}`);   vals.push(role); }
    if (setor    !== undefined) { sets.push(`setor=$${i++}`);  vals.push(setor); }
    if (name     !== undefined) { sets.push(`name=$${i++}`);   vals.push(name); }
    if (observacao !== undefined) { sets.push(`observacao=$${i++}`); vals.push(observacao); }
    if (!sets.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    vals.push(req.params.id);
    await pool.query(`UPDATE users SET ${sets.join(',')} WHERE id=$${i}`, vals);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
