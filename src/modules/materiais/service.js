const db = require('../../db');

async function listar({ busca, status } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND m.status = $${params.length}`; }
  if (busca) { params.push(`%${busca}%`); where += ` AND m.nome ILIKE $${params.length}`; }
  const r = await db.query(
    `SELECT m.*, f.nome as fornecedor_nome FROM materiais m
     LEFT JOIN fornecedores f ON f.id = m.fornecedor_id ${where} ORDER BY m.nome`,
    params
  );
  return r.rows;
}

async function buscarPorId(id) {
  const r = await db.query('SELECT * FROM materiais WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function criar(dados) {
  if (!dados.nome) return { erro: ['Nome é obrigatório'] };
  if (!dados.unidade) return { erro: ['Unidade é obrigatória'] };
  const r = await db.query(
    `INSERT INTO materiais (codigo, nome, unidade, estoque_atual, estoque_minimo, custo_medio, fornecedor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [dados.codigo || null, dados.nome, dados.unidade, dados.estoque_atual || 0,
     dados.estoque_minimo || 0, dados.custo_medio || 0, dados.fornecedor_id || null]
  );
  return { material: r.rows[0] };
}

async function atualizarEstoque(id, quantidade, tipo) {
  const op = tipo === 'entrada' ? '+' : '-';
  const r = await db.query(
    `UPDATE materiais SET estoque_atual = estoque_atual ${op} $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [Math.abs(quantidade), id]
  );
  if (!r.rows[0]) return { erro: ['Material não encontrado'] };
  return { material: r.rows[0] };
}

module.exports = { listar, buscarPorId, criar, atualizarEstoque };
