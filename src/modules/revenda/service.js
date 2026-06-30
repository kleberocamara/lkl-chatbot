const db = require('../../db');
const path = require('path');
const { spawn } = require('child_process');

// Categorias
async function listarCategorias() {
  return (await db.query('SELECT * FROM revenda_categorias ORDER BY nome')).rows;
}
async function criarCategoria(d) {
  if (!d.nome || !d.url) return { erro: ['nome e url são obrigatórios'] };
  const r = await db.query('INSERT INTO revenda_categorias (nome, url) VALUES ($1,$2) RETURNING *', [d.nome, d.url]);
  return { item: r.rows[0] };
}
async function atualizarCategoria(id, d) {
  const r = await db.query(
    'UPDATE revenda_categorias SET nome=COALESCE($1,nome), url=COALESCE($2,url), ativo=COALESCE($3,ativo) WHERE id=$4 RETURNING *',
    [d.nome ?? null, d.url ?? null, d.ativo, id]
  );
  if (!r.rows[0]) return { erro: ['Categoria não encontrada'] };
  return { item: r.rows[0] };
}

// Catálogo
async function listarProdutos({ busca } = {}) {
  const params = [];
  let where = 'WHERE ativo=TRUE';
  if (busca) { params.push(`%${busca}%`); where += ' AND (nome ILIKE $1 OR ref ILIKE $1)'; }
  return (await db.query(`SELECT * FROM revenda_produtos ${where} ORDER BY nome LIMIT 500`, params)).rows;
}
async function detalheProduto(id) {
  const prod = (await db.query('SELECT * FROM revenda_produtos WHERE id=$1', [id])).rows[0];
  if (!prod) return null;
  prod.precos = (await db.query('SELECT quantidade, prazo_horas, preco_total FROM revenda_precos WHERE produto_id=$1 ORDER BY quantidade, prazo_horas', [id])).rows;
  prod.acabamentos = (await db.query('SELECT nome, preco, tipo, prazo_extra_dias FROM revenda_acabamentos WHERE produto_id=$1 ORDER BY tipo, nome', [id])).rows;
  return prod;
}

// Sync
async function statusSync() {
  return (await db.query('SELECT * FROM revenda_sync_log ORDER BY iniciado_em DESC LIMIT 1')).rows[0] || null;
}
async function dispararSync() {
  const atual = await statusSync();
  if (atual && atual.status === 'rodando') return { erro: ['Já há uma sincronização em andamento'] };
  const job = path.join(__dirname, '..', '..', 'jobs', 'revenda-sync.js');
  const p = spawn('node', [job], { detached: true, stdio: 'ignore', env: process.env });
  p.unref();
  return { ok: true };
}

// Config
async function getConfig() {
  return (await db.query('SELECT markup_percent, prazo_padrao_horas FROM revenda_config WHERE id=1')).rows[0];
}
async function setConfig(d) {
  const r = await db.query(
    'UPDATE revenda_config SET markup_percent=COALESCE($1,markup_percent), prazo_padrao_horas=COALESCE($2,prazo_padrao_horas), updated_at=NOW() WHERE id=1 RETURNING markup_percent, prazo_padrao_horas',
    [d.markup_percent ?? null, d.prazo_padrao_horas ?? null]
  );
  return { item: r.rows[0] };
}

module.exports = {
  listarCategorias, criarCategoria, atualizarCategoria,
  listarProdutos, detalheProduto,
  statusSync, dispararSync,
  getConfig, setConfig,
};
