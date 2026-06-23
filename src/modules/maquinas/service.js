const db = require('../../db');

async function listar({ busca, status, page = 1, limit = 50 } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND m.status = $${params.length}`; }
  if (busca) {
    params.push(`%${busca}%`);
    where += ` AND (m.nome ILIKE $${params.length} OR m.fabricante ILIKE $${params.length} OR m.modelo ILIKE $${params.length})`;
  }
  const offset = (page - 1) * limit;
  const base = `FROM maquinas m LEFT JOIN funcionarios f ON f.id = m.operador_padrao_id ${where}`;
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT m.*, f.nome AS operador_padrao_nome ${base}
       ORDER BY m.nome LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) ${base}`, params),
  ]);
  return { maquinas: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

async function buscarPorId(id) {
  const r = await db.query(
    `SELECT m.*, f.nome AS operador_padrao_nome
     FROM maquinas m LEFT JOIN funcionarios f ON f.id = m.operador_padrao_id
     WHERE m.id = $1`, [id]
  );
  return r.rows[0] || null;
}

function _validar(d) {
  if (!d.nome || !String(d.nome).trim()) return ['Nome é obrigatório'];
  for (const [campo, label] of [['num_cores','Nº de cores'],['velocidade_iph','Velocidade'],['custo_lavagem','Custo de lavagem'],['formato_max_larg','Formato (largura)'],['formato_max_alt','Formato (altura)']]) {
    if (d[campo] !== undefined && d[campo] !== null && d[campo] !== '' && !(parseFloat(d[campo]) >= 0)) {
      return [`${label} deve ser um número ≥ 0`];
    }
  }
  return null;
}

async function _operadorExiste(id) {
  if (!id) return true;
  const r = await db.query('SELECT 1 FROM funcionarios WHERE id = $1', [id]);
  return !!r.rows[0];
}

const _num = v => (v != null && v !== '' ? parseFloat(v) : null);
const _int = v => (v != null && v !== '' ? parseInt(v) : null);

async function criar(dados) {
  const erro = _validar(dados);
  if (erro) return { erro };
  if (!(await _operadorExiste(dados.operador_padrao_id))) return { erro: ['Operador padrão inválido'] };
  const r = await db.query(
    `INSERT INTO maquinas (nome, fabricante, modelo, num_cores, formato_max_larg, formato_max_alt,
       velocidade_iph, operador_padrao_id, custo_lavagem, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [dados.nome.trim(), dados.fabricante || null, dados.modelo || null, _int(dados.num_cores),
     _num(dados.formato_max_larg), _num(dados.formato_max_alt), _int(dados.velocidade_iph),
     dados.operador_padrao_id || null, _num(dados.custo_lavagem),
     dados.status === 'inativa' ? 'inativa' : 'ativa']
  );
  return { maquina: r.rows[0] };
}

async function atualizar(id, dados) {
  const existente = await buscarPorId(id);
  if (!existente) return { erro: ['Máquina não encontrada'] };
  const merged = { ...existente, ...dados };
  const erro = _validar(merged);
  if (erro) return { erro };
  if (!(await _operadorExiste(merged.operador_padrao_id))) return { erro: ['Operador padrão inválido'] };
  const r = await db.query(
    `UPDATE maquinas SET nome=$1, fabricante=$2, modelo=$3, num_cores=$4, formato_max_larg=$5,
       formato_max_alt=$6, velocidade_iph=$7, operador_padrao_id=$8, custo_lavagem=$9, status=$10, updated_at=NOW()
     WHERE id=$11 RETURNING *`,
    [merged.nome.trim(), merged.fabricante || null, merged.modelo || null, _int(merged.num_cores),
     _num(merged.formato_max_larg), _num(merged.formato_max_alt), _int(merged.velocidade_iph),
     merged.operador_padrao_id || null, _num(merged.custo_lavagem),
     merged.status === 'inativa' ? 'inativa' : 'ativa', id]
  );
  return { maquina: r.rows[0] };
}

module.exports = { listar, buscarPorId, criar, atualizar };
