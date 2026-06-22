const db = require('../../db');
const { validarCPF } = require('../../utils/validators');

async function listar({ status, page = 1, limit = 20 } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND f.status = $${params.length}`; }
  const offset = (page - 1) * limit;
  const base = `FROM funcionarios f LEFT JOIN users u ON u.id = f.user_id ${where}`;
  const [rows, count] = await Promise.all([
    db.query(`SELECT f.*, u.name as user_nome, u.role as user_role ${base} ORDER BY f.nome LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]),
    db.query(`SELECT COUNT(*) ${base}`, params),
  ]);
  return { funcionarios: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

async function buscarPorId(id) {
  const r = await db.query(
    `SELECT f.*, u.name as user_nome FROM funcionarios f
     LEFT JOIN users u ON u.id = f.user_id WHERE f.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function criar(dados) {
  const erros = [];
  if (!dados.nome || dados.nome.trim().length < 2) erros.push('Nome é obrigatório');
  if (!dados.cpf) erros.push('CPF é obrigatório');
  else if (!validarCPF(dados.cpf)) erros.push('CPF inválido');
  if (!dados.cargo) erros.push('Cargo é obrigatório');
  if (!dados.data_admissao) erros.push('Data de admissão é obrigatória');
  if (erros.length > 0) return { erro: erros };

  const dup = await db.query('SELECT id FROM funcionarios WHERE cpf = $1', [dados.cpf.replace(/\D/g, '')]);
  if (dup.rows.length > 0) return { erro: ['CPF já cadastrado'] };

  const r = await db.query(
    `INSERT INTO funcionarios (user_id, nome, cpf, rg, data_nascimento, cargo, setor, salario,
     data_admissao, telefone, celular, email, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'ativo') RETURNING *`,
    [dados.user_id || null, dados.nome, dados.cpf.replace(/\D/g, ''), dados.rg || null,
     dados.data_nascimento || null, dados.cargo, dados.setor || null, dados.salario || null,
     dados.data_admissao, dados.telefone || null, dados.celular || null, dados.email || null]
  );
  return { funcionario: r.rows[0] };
}

async function atualizar(id, dados) {
  const existente = await buscarPorId(id);
  if (!existente) return { erro: ['Funcionário não encontrado'] };
  if (dados.cpf && !validarCPF(dados.cpf)) return { erro: ['CPF inválido'] };
  const r = await db.query(
    `UPDATE funcionarios SET nome=COALESCE($1,nome), rg=COALESCE($2,rg),
     data_nascimento=COALESCE($3,data_nascimento), cargo=COALESCE($4,cargo),
     setor=COALESCE($5,setor), salario=COALESCE($6,salario), telefone=COALESCE($7,telefone),
     celular=COALESCE($8,celular), email=COALESCE($9,email), status=COALESCE($10,status),
     user_id=COALESCE($11,user_id), updated_at=NOW() WHERE id=$12 RETURNING *`,
    [dados.nome || null, dados.rg || null, dados.data_nascimento || null, dados.cargo || null,
     dados.setor || null, dados.salario || null, dados.telefone || null, dados.celular || null,
     dados.email || null, dados.status || null, dados.user_id || null, id]
  );
  return { funcionario: r.rows[0] };
}

module.exports = { listar, buscarPorId, criar, atualizar };
