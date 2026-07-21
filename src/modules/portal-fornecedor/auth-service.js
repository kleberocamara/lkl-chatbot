// src/modules/portal-fornecedor/auth-service.js
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../db');

async function criarConvite(fornecedorId, email) {
  const conviteToken = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO fornecedor_logins (fornecedor_id, email, convite_token, convite_expira)
     VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')
     ON CONFLICT (fornecedor_id) DO UPDATE SET
       email = $2, convite_token = $3, convite_expira = NOW() + INTERVAL '7 days', updated_at = NOW()`,
    [fornecedorId, email, conviteToken]
  );
  await db.query('UPDATE fornecedores SET portal_liberado = true WHERE id = $1', [fornecedorId]);
  return { conviteToken };
}

async function definirSenha(conviteToken, novaSenha) {
  const r = await db.query(
    `SELECT id, convite_expira FROM fornecedor_logins WHERE convite_token = $1`,
    [conviteToken]
  );
  if (!r.rows[0]) return { erro: ['Convite inválido'] };
  if (new Date(r.rows[0].convite_expira) < new Date()) {
    return { erro: ['Convite expirado — peça um novo à Gráfica LKL'] };
  }
  const hash = await bcrypt.hash(novaSenha, 10);
  await db.query(
    `UPDATE fornecedor_logins SET senha_hash = $1, senha_definida_em = NOW(), convite_token = NULL, convite_expira = NULL, updated_at = NOW() WHERE id = $2`,
    [hash, r.rows[0].id]
  );
  return { ok: true };
}

async function login(email, senha) {
  const r = await db.query(
    `SELECT id, fornecedor_id, senha_hash, ativo FROM fornecedor_logins WHERE email = $1`,
    [email]
  );
  const login = r.rows[0];
  if (!login || !login.senha_hash || !login.ativo) return { erro: ['Credenciais inválidas'] };
  const ok = await bcrypt.compare(senha, login.senha_hash);
  if (!ok) return { erro: ['Credenciais inválidas'] };
  const token = jwt.sign(
    { tipo: 'fornecedor', fornecedorId: login.fornecedor_id, loginId: login.id },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
  return { token, fornecedorId: login.fornecedor_id };
}

module.exports = { criarConvite, definirSenha, login };
