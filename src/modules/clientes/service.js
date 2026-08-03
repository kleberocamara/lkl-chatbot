const db = require('../../db');
const { validarCPF, validarCNPJ, validarCelular, calcularScoreCompletude } = require('../../utils/validators');

async function listar({ page = 1, limit = 20, busca, status } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  if (busca) {
    params.push(`%${busca}%`);
    where += ` AND (nome ILIKE $${params.length} OR celular ILIKE $${params.length} OR cpf_cnpj ILIKE $${params.length})`;
  }
  const [rows, count] = await Promise.all([
    db.query(`SELECT * FROM clientes_lkl ${where} ORDER BY nome LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]),
    db.query(`SELECT COUNT(*) FROM clientes_lkl ${where}`, params),
  ]);
  return { clientes: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

async function buscarPorId(id) {
  const r = await db.query('SELECT * FROM clientes_lkl WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function validarDados(dados, idExcluir = null) {
  const erros = [];
  if (!dados.nome || dados.nome.trim().length < 3) erros.push('Nome deve ter pelo menos 3 caracteres');
  if (!dados.tipo_pessoa || !['PF', 'PJ'].includes(dados.tipo_pessoa)) erros.push('tipo_pessoa deve ser PF ou PJ');
  if (dados.cpf_cnpj) {
    if (dados.tipo_pessoa === 'PF' && !validarCPF(dados.cpf_cnpj)) erros.push('CPF inválido');
    if (dados.tipo_pessoa === 'PJ' && !validarCNPJ(dados.cpf_cnpj)) erros.push('CNPJ inválido');
    const q = idExcluir
      ? await db.query('SELECT id FROM clientes_lkl WHERE cpf_cnpj = $1 AND id != $2', [dados.cpf_cnpj, idExcluir])
      : await db.query('SELECT id FROM clientes_lkl WHERE cpf_cnpj = $1', [dados.cpf_cnpj]);
    if (q.rows.length > 0) erros.push('CPF/CNPJ já cadastrado');
  }
  if (dados.celular && !validarCelular(dados.celular)) erros.push('Celular inválido — formato: (XX) 9XXXX-XXXX');
  return erros;
}

async function criar(dados) {
  const erros = await validarDados(dados);
  if (erros.length > 0) return { erro: erros };
  const score = calcularScoreCompletude(dados);
  const r = await db.query(
    `INSERT INTO clientes_lkl
     (tipo_pessoa, cpf_cnpj, nome, fantasia, email, celular, telefone, cep, logradouro, numero,
      bairro, cidade, uf, segmento, canal_origem, condicao_pagamento, limite_credito,
      contribuinte_icms, status, score_completude, codigo_sisgraph, ie)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING *`,
    [dados.tipo_pessoa, dados.cpf_cnpj || null, dados.nome, dados.fantasia || null,
     dados.email || null, dados.celular || null, dados.telefone || null, dados.cep || null,
     dados.logradouro || null, dados.numero || null, dados.bairro || null, dados.cidade || null,
     dados.uf || null, dados.segmento || null, dados.canal_origem || 'balcao',
     dados.condicao_pagamento || null, dados.limite_credito || 0,
     dados.contribuinte_icms || 'nao', 'ativo', score, dados.codigo_sisgraph || null, dados.ie || null]
  );
  return { cliente: r.rows[0] };
}

async function atualizar(id, dados) {
  const existente = await buscarPorId(id);
  if (!existente) return { erro: ['Cliente não encontrado'] };
  const merged = { ...existente, ...dados };
  const erros = await validarDados(merged, id);
  if (erros.length > 0) return { erro: erros };
  const score = calcularScoreCompletude(merged);
  const r = await db.query(
    `UPDATE clientes_lkl SET tipo_pessoa=$1, cpf_cnpj=$2, nome=$3, fantasia=$4, email=$5,
     celular=$6, telefone=$7, cep=$8, logradouro=$9, numero=$10, bairro=$11, cidade=$12, uf=$13,
     segmento=$14, condicao_pagamento=$15, limite_credito=$16, contribuinte_icms=$17,
     status=$18, score_completude=$19, ie=$20, updated_at=NOW() WHERE id=$21 RETURNING *`,
    [merged.tipo_pessoa, merged.cpf_cnpj || null, merged.nome, merged.fantasia || null,
     merged.email || null, merged.celular || null, merged.telefone || null, merged.cep || null,
     merged.logradouro || null, merged.numero || null, merged.bairro || null, merged.cidade || null,
     merged.uf || null, merged.segmento || null, merged.condicao_pagamento || null,
     merged.limite_credito || 0, merged.contribuinte_icms || 'nao', merged.status || 'ativo',
     score, merged.ie || null, id]
  );
  return { cliente: r.rows[0] };
}

module.exports = { listar, buscarPorId, criar, atualizar };
