const db = require('../../db');

function normalizarNome(nome) {
  return String(nome || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, '')
    .trim();
}

function soDigitos(s) {
  return String(s || '').replace(/\D/g, '');
}

function ehCnpjProprio(cnpj) {
  const digitos = soDigitos(cnpj);
  if (!digitos) return false;
  const proprios = String(process.env.EMPRESA_CNPJS || '').split(',').map(soDigitos).filter(Boolean);
  return proprios.includes(digitos);
}

async function buscarPorCnpj(cnpj) {
  const digitos = soDigitos(cnpj);
  if (!digitos) return null;
  const r = await db.query(
    `SELECT * FROM fornecedores WHERE regexp_replace(COALESCE(cnpj,''), '\\D', '', 'g') = $1 LIMIT 1`,
    [digitos]
  );
  return r.rows[0] || null;
}

async function buscarPorNome(nome) {
  const norm = normalizarNome(nome);
  if (!norm) return null;
  const r = await db.query(
    `SELECT * FROM fornecedores WHERE regexp_replace(UPPER(nome), '[^A-Z0-9 ]', '', 'g') = $1 LIMIT 1`,
    [norm]
  );
  return r.rows[0] || null;
}

async function criarFornecedor({ nome, cnpj }) {
  if (cnpj) {
    const digitos = soDigitos(cnpj);
    const r = await db.query(
      `INSERT INTO fornecedores (nome, cnpj, status) VALUES ($1,$2,'ativo')
       ON CONFLICT (cnpj) WHERE cnpj IS NOT NULL DO NOTHING RETURNING *`,
      [nome, cnpj]
    );
    if (r.rows[0]) return r.rows[0];
    // Conflito: outra chamada concorrente já criou um fornecedor com esse CNPJ — busca e retorna.
    const existente = await buscarPorCnpj(digitos);
    if (existente) return existente;
    // Não deveria chegar aqui (conflito sem achar por busca), mas evita retornar undefined.
    throw new Error(`Falha ao criar ou localizar fornecedor com CNPJ ${digitos} após conflito de índice único`);
  }
  const r = await db.query(
    `INSERT INTO fornecedores (nome, cnpj, status) VALUES ($1,$2,'ativo') RETURNING *`,
    [nome, cnpj || null]
  );
  return r.rows[0];
}

// Casa por CNPJ (se informado), depois por nome; sem match nenhum, cadastra um fornecedor mínimo.
async function encontrarOuCriarFornecedor({ nome, cnpj }) {
  if (!nome && !cnpj) return null;
  if (cnpj) {
    const porCnpj = await buscarPorCnpj(cnpj);
    if (porCnpj) return porCnpj;
  }
  if (nome) {
    const porNome = await buscarPorNome(nome);
    if (porNome) return porNome;
  }
  return criarFornecedor({ nome: nome || 'Fornecedor não identificado', cnpj });
}

module.exports = {
  normalizarNome,
  soDigitos,
  ehCnpjProprio,
  buscarPorCnpj,
  buscarPorNome,
  criarFornecedor,
  encontrarOuCriarFornecedor,
};
