const db = require('../../db');

async function listar({ busca, status, categoria, page = 1, limit = 20 } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND m.status = $${params.length}`; }
  if (categoria) { params.push(categoria); where += ` AND m.categoria = $${params.length}`; }
  if (busca) { params.push(`%${busca}%`); where += ` AND (m.nome ILIKE $${params.length} OR m.codigo ILIKE $${params.length})`; }
  const offset = (page - 1) * limit;
  const base = `FROM materiais m LEFT JOIN fornecedores f ON f.id = m.fornecedor_id ${where}`;
  const [rows, count] = await Promise.all([
    db.query(`SELECT m.*, f.nome as fornecedor_nome ${base} ORDER BY m.codigo::int NULLS LAST, m.nome LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]),
    db.query(`SELECT COUNT(*) ${base}`, params),
  ]);
  return { materiais: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

async function buscarPorId(id) {
  const r = await db.query('SELECT * FROM materiais WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function criar(dados) {
  if (!dados.nome) return { erro: ['Nome é obrigatório'] };
  if (!dados.unidade) return { erro: ['Unidade é obrigatória'] };
  const r = await db.query(
    `INSERT INTO materiais (codigo, nome, categoria, unidade, qt_embalagem, estoque_atual, estoque_minimo, estoque_maximo, custo_medio, fornecedor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [dados.codigo || null, dados.nome, dados.categoria || null, dados.unidade,
     dados.qt_embalagem || 0, dados.estoque_atual || 0, dados.estoque_minimo || 0,
     dados.estoque_maximo || 0, dados.custo_medio || 0, dados.fornecedor_id || null]
  );
  return { material: r.rows[0] };
}

async function atualizar(id, dados) {
  const existente = await buscarPorId(id);
  if (!existente) return { erro: ['Material não encontrado'] };
  const merged = { ...existente, ...dados };
  if (!merged.nome) return { erro: ['Nome é obrigatório'] };
  if (!merged.unidade) return { erro: ['Unidade é obrigatória'] };
  const r = await db.query(
    `UPDATE materiais SET codigo=$1, nome=$2, categoria=$3, unidade=$4, qt_embalagem=$5,
     estoque_atual=$6, estoque_minimo=$7, estoque_maximo=$8, custo_medio=$9, fornecedor_id=$10, updated_at=NOW()
     WHERE id=$11 RETURNING *`,
    [merged.codigo || null, merged.nome, merged.categoria || null, merged.unidade,
     merged.qt_embalagem || 0, merged.estoque_atual || 0, merged.estoque_minimo || 0,
     merged.estoque_maximo || 0, merged.custo_medio || 0, merged.fornecedor_id || null, id]
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

module.exports = { listar, buscarPorId, criar, atualizar, atualizarEstoque };
