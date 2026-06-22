const db = require('../../db');

async function listar({ page = 1, limit = 20, busca, status } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  if (busca) {
    params.push(`%${busca}%`);
    where += ` AND (nome ILIKE $${params.length} OR cnpj ILIKE $${params.length})`;
  }
  const [rows, count] = await Promise.all([
    db.query(`SELECT * FROM fornecedores ${where} ORDER BY nome LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]),
    db.query(`SELECT COUNT(*) FROM fornecedores ${where}`, params),
  ]);
  return { fornecedores: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

async function buscarPorId(id) {
  const r = await db.query('SELECT * FROM fornecedores WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function criar(dados) {
  if (!dados.nome || dados.nome.trim().length < 2) return { erro: ['Nome é obrigatório'] };
  const r = await db.query(
    `INSERT INTO fornecedores (codigo_sisgraph, nome, cnpj, contato, ddd, telefone, celular, email, logradouro, cidade, uf, categoria, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ativo') RETURNING *`,
    [dados.codigo_sisgraph || null, dados.nome, dados.cnpj || null, dados.contato || null,
     dados.ddd || null, dados.telefone || null, dados.celular || null, dados.email || null,
     dados.logradouro || null, dados.cidade || null, dados.uf || null, dados.categoria || null]
  );
  return { fornecedor: r.rows[0] };
}

async function atualizar(id, dados) {
  const r = await db.query(
    `UPDATE fornecedores SET nome=COALESCE($1,nome), cnpj=COALESCE($2,cnpj), contato=COALESCE($3,contato),
     ddd=COALESCE($4,ddd), telefone=COALESCE($5,telefone), celular=COALESCE($6,celular),
     email=COALESCE($7,email), logradouro=COALESCE($8,logradouro), cidade=COALESCE($9,cidade),
     uf=COALESCE($10,uf), categoria=COALESCE($11,categoria), status=COALESCE($12,status),
     updated_at=NOW() WHERE id=$13 RETURNING *`,
    [dados.nome || null, dados.cnpj || null, dados.contato || null,
     dados.ddd || null, dados.telefone || null, dados.celular || null,
     dados.email || null, dados.logradouro || null, dados.cidade || null,
     dados.uf || null, dados.categoria || null, dados.status || null, id]
  );
  if (!r.rows[0]) return { erro: ['Fornecedor não encontrado'] };
  return { fornecedor: r.rows[0] };
}

module.exports = { listar, buscarPorId, criar, atualizar };
