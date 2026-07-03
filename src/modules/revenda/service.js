const db = require('../../db');
const path = require('path');
const { spawn } = require('child_process');
const pricer = require('./pricer');
const { tokensMaterial } = require('../../constants/produtos');

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
  // Marca como 'erro' qualquer sync 'rodando' há mais de 20 min (processo morto/travado) → destrava.
  await db.query("UPDATE revenda_sync_log SET status='erro', finalizado_em=NOW(), erro='sync travada (>20min) — encerrada automaticamente' WHERE status='rodando' AND iniciado_em < NOW() - INTERVAL '20 minutes'");
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

// Score de aproximação entre o texto do pedido e o nome do SKU: nº de tokens do pedido presentes no SKU.
function pontuarSku(textoPedido, nomeSku) {
  const toks = tokensMaterial(textoPedido);
  if (!toks.length) return 0;
  const setSku = new Set(tokensMaterial(nomeSku));
  return toks.reduce((n, t) => n + (setSku.has(t) ? 1 : 0), 0);
}

// Precificação
async function precificarItemRevenda({ revenda_produto_id, quantidade, prazo_horas, acabamentos, largura_cm, altura_cm }) {
  if (!revenda_produto_id) return null;
  const prod = (await db.query('SELECT estrategia, bobina_grupo, preco_m2, espaco_corte_cm FROM revenda_produtos WHERE id=$1', [revenda_produto_id])).rows[0];
  if (!prod) return null;

  if (prod.estrategia === 'manual') return null;

  if (prod.estrategia === 'interno_m2') {
    if (!prod.bobina_grupo) return null;
    const bobinas = (await db.query('SELECT largura_cm FROM revenda_bobina_grupos WHERE grupo=$1 AND ativo=TRUE ORDER BY largura_cm', [prod.bobina_grupo])).rows;
    const calc = pricer.calcularInternoM2(
      { bobinas, preco_m2: prod.preco_m2, espaco_corte_cm: prod.espaco_corte_cm },
      { largura_cm, altura_cm, quantidade }
    );
    return calc ? { ...calc, estrategia: 'interno_m2' } : null;
  }

  // revenda_matriz (default)
  const cfg = (await db.query('SELECT markup_percent, prazo_padrao_horas FROM revenda_config WHERE id=1')).rows[0] || { markup_percent: 0, prazo_padrao_horas: 24 };
  const prazo = Number(prazo_horas) > 0 ? Number(prazo_horas) : cfg.prazo_padrao_horas;
  const faixas = (await db.query('SELECT quantidade, prazo_horas, preco_total FROM revenda_precos WHERE produto_id=$1', [revenda_produto_id])).rows;
  const acabs = (await db.query('SELECT nome, preco FROM revenda_acabamentos WHERE produto_id=$1', [revenda_produto_id])).rows;
  const calc = pricer.calcularRevenda(
    { faixas, acabamentos: acabs, markup_percent: cfg.markup_percent },
    { quantidade, prazo_horas: prazo, selecionados: Array.isArray(acabamentos) ? acabamentos.map((a) => (typeof a === 'string' ? a : a.nome)) : [] }
  );
  return calc ? { ...calc, prazo_horas: prazo, estrategia: 'revenda_matriz' } : null;
}

module.exports = {
  listarCategorias, criarCategoria, atualizarCategoria,
  listarProdutos, detalheProduto,
  statusSync, dispararSync,
  getConfig, setConfig,
  precificarItemRevenda, pontuarSku,
};
