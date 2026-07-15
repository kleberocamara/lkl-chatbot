const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../db/index');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();
const requireGestorPlus = requireRole('admin', 'gestor');

router.get('/', requireGestorPlus, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, email, role, active, matricula, setor, celular, last_login, created_at
       FROM users ORDER BY created_at ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireGestorPlus, async (req, res) => {
  const { funcionario_id, email, password, role } = req.body;
  if (!funcionario_id || !email || !password) return res.status(400).json({ error: 'funcionario_id, email e senha são obrigatórios' });

  const client = await pool.pool.connect();
  try {
    await client.query('BEGIN');

    const funcR = await client.query(
      `SELECT id, nome, celular, setor, user_id FROM funcionarios WHERE id = $1 FOR UPDATE`,
      [funcionario_id]
    );
    if (!funcR.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Funcionário não encontrado' }); }
    const func = funcR.rows[0];
    if (func.user_id) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Este funcionário já possui um usuário vinculado' }); }

    const hash = await bcrypt.hash(password, 10);
    const userR = await client.query(
      `INSERT INTO users (name, email, password_hash, role, setor, celular, matricula)
       VALUES ($1, $2, $3, $4, $5, $6, (SELECT matricula FROM funcionarios WHERE id = $7))
       RETURNING id, name, email, role, matricula, setor, celular`,
      [func.nome, email, hash, role || 'atendente', func.setor, func.celular, funcionario_id]
    );
    const user = userR.rows[0];

    await client.query(`UPDATE funcionarios SET user_id = $1, updated_at = NOW() WHERE id = $2`, [user.id, funcionario_id]);

    await client.query('COMMIT');
    res.status(201).json(user);
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'E-mail já cadastrado' });
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

router.patch('/:id', requireGestorPlus, async (req, res) => {
  try {
    const { active, role, setor, name, observacao, celular } = req.body;
    const sets = [];
    const vals = [];
    let i = 1;
    if (active !== undefined) { sets.push(`active=$${i++}`); vals.push(active); }
    if (role     !== undefined) { sets.push(`role=$${i++}`);   vals.push(role); }
    if (setor    !== undefined) { sets.push(`setor=$${i++}`);  vals.push(setor); }
    if (name     !== undefined) { sets.push(`name=$${i++}`);   vals.push(name); }
    if (celular  !== undefined) { sets.push(`celular=$${i++}`); vals.push(celular); }
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
