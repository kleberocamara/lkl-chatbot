const db = require('../../db');

async function listarCatalogo() {
  const r = await db.query(
    `SELECT produto, acabamento, MIN(quantidade_min) as qtd_min, MAX(quantidade_max) as qtd_max,
     MIN(preco_unitario) as preco_min, MAX(preco_unitario) as preco_max
     FROM price_table WHERE ativo = true GROUP BY produto, acabamento ORDER BY produto, acabamento`
  );
  return r.rows;
}

async function listarTodos() {
  const r = await db.query('SELECT * FROM price_table ORDER BY produto, acabamento, quantidade_min');
  return r.rows;
}

async function calcularPreco(produto, acabamento, quantidade) {
  const r = await db.query(
    `SELECT preco_unitario FROM price_table
     WHERE produto = $1 AND (acabamento = $2 OR acabamento IS NULL)
     AND quantidade_min <= $3 AND (quantidade_max >= $3 OR quantidade_max IS NULL)
     AND ativo = true
     ORDER BY quantidade_min DESC LIMIT 1`,
    [produto, acabamento || null, quantidade]
  );
  if (!r.rows[0]) return null;
  const unitario = parseFloat(r.rows[0].preco_unitario);
  return { preco_unitario: unitario, valor_total: parseFloat((unitario * quantidade).toFixed(2)) };
}

async function criar(dados) {
  if (!dados.produto || !dados.quantidade_min || !dados.preco_unitario)
    return { erro: ['produto, quantidade_min e preco_unitario são obrigatórios'] };
  const r = await db.query(
    `INSERT INTO price_table (produto, acabamento, quantidade_min, quantidade_max, preco_unitario, unidade, ativo)
     VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *`,
    [dados.produto, dados.acabamento || null, dados.quantidade_min, dados.quantidade_max || null,
     dados.preco_unitario, dados.unidade || 'un']
  );
  return { item: r.rows[0] };
}

async function atualizar(id, dados) {
  const r = await db.query(
    `UPDATE price_table SET produto=COALESCE($1,produto), acabamento=COALESCE($2,acabamento),
     quantidade_min=COALESCE($3,quantidade_min), quantidade_max=COALESCE($4,quantidade_max),
     preco_unitario=COALESCE($5,preco_unitario), ativo=COALESCE($6,ativo), updated_at=NOW()
     WHERE id=$7 RETURNING *`,
    [dados.produto || null, dados.acabamento || null, dados.quantidade_min || null,
     dados.quantidade_max || null, dados.preco_unitario || null,
     dados.ativo !== undefined ? dados.ativo : null, id]
  );
  if (!r.rows[0]) return { erro: ['Item não encontrado'] };
  return { item: r.rows[0] };
}

module.exports = { listarCatalogo, listarTodos, calcularPreco, criar, atualizar };
