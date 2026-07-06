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

const _semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

// Casa {produto, material, tipo_producao} ao SKU mais provável do catálogo (ou null).
async function resolverProdutoRevenda({ produto, material, tipo_producao, largura_cm, altura_cm, impressao, especificacao }) {
  // Família folheto/flyer/folder: casa por gramatura+tamanho+impressão.
  if (/FOLDER|FOLHETO|FLYER/.test(_semAcento(produto)) && Number(largura_cm) > 0 && Number(altura_cm) > 0) {
    const f = await resolverFolheto({ material, largura_cm, altura_cm, impressao });
    if (f) return f;
  }
  const texto = `${produto || ''} ${material || ''} ${especificacao || ''}`.trim();
  if (!texto) return null;
  const alvoTipo = _semAcento(tipo_producao); // 'COMUNICACAO VISUAL' | 'OFFSET' | ...
  const filtrarTipo = (alvoTipo === 'COMUNICACAO VISUAL' || alvoTipo === 'OFFSET');
  const { rows } = await db.query(
    `SELECT id, nome, tipo_servico, estrategia, bobina_grupo, preco_m2 FROM revenda_produtos WHERE ativo = TRUE`);
  let best = null, bestScore = 0;
  for (const p of rows) {
    if (filtrarTipo && _semAcento(p.tipo_servico) !== alvoTipo) continue;
    const s = pontuarSku(texto, p.nome);
    if (s > bestScore || (s === bestScore && s > 0 && best && p.estrategia === 'interno_m2' && best.estrategia !== 'interno_m2')) {
      best = p; bestScore = s;
    }
  }
  return bestScore > 0 ? best : null;
}

// Escolha pura: menor tamanho >= pedido (nas 2 orientações), impressão exata, gramatura mais próxima.
function escolherFolheto(skus, { gramatura, largura_cm, altura_cm, impressao }) {
  const imp = (impressao === '4/0' || impressao === '4/4') ? impressao : '4/4';
  const pl = Number(largura_cm), pa = Number(altura_cm);
  const cabe = (s) => (s.larg_cm >= pl && s.alt_cm >= pa) || (s.larg_cm >= pa && s.alt_cm >= pl);
  let cands = skus.filter((s) => s.impressao === imp && cabe(s));
  if (!cands.length) return null;
  if (Number.isFinite(gramatura)) {
    let melhorG = null;
    for (const s of cands) { const d = Math.abs(s.gramatura - gramatura); if (melhorG == null || d < melhorG) melhorG = d; }
    cands = cands.filter((s) => Math.abs(s.gramatura - gramatura) === melhorG);
  }
  cands.sort((a, b) => (a.larg_cm * a.alt_cm) - (b.larg_cm * b.alt_cm));
  return cands[0] || null;
}

// Casa a família folheto/flyer/folder ao SKU certo (gramatura+tamanho+impressão). Retorna a linha ou null.
async function resolverFolheto({ material, largura_cm, altura_cm, impressao }) {
  const { rows } = await db.query(
    `SELECT id, nome FROM revenda_produtos WHERE ativo=TRUE AND estrategia='revenda_matriz' AND nome ILIKE 'Folheto %'`);
  const parsed = [];
  for (const r of rows) {
    const m = r.nome.match(/Folheto\s+(\d+)g\s*\|\s*(\d+)\s*x\s*(\d+)\s*cm\s*\|\s*(4\/0|4\/4)/i);
    if (!m) continue;
    parsed.push({ id: r.id, nome: r.nome, gramatura: Number(m[1]), larg_cm: Number(m[2]), alt_cm: Number(m[3]), impressao: m[4] });
  }
  const g = (String(material || '').match(/(\d+)\s*g/i) || [])[1];
  const escolhido = escolherFolheto(parsed, { gramatura: g ? Number(g) : NaN, largura_cm, altura_cm, impressao });
  if (!escolhido) return null;
  return { id: escolhido.id, nome: escolhido.nome, estrategia: 'revenda_matriz' };
}

// Precificação
async function precificarItemRevenda({ revenda_produto_id, quantidade, prazo_horas, acabamentos, largura_cm, altura_cm, dobras }) {
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
  const _sget = async (k, def) => {
    const r = await db.query('SELECT value FROM settings WHERE key=$1', [k]);
    const v = Number(r.rows[0]?.value);
    return Number.isFinite(v) ? v : def;
  };
  const dobraBase = await _sget('revenda_dobra_base_milheiro', 10);
  const dobraAdic = await _sget('revenda_dobra_adicional_milheiro', 5);
  const calc = pricer.calcularRevenda(
    { faixas, acabamentos: acabs, markup_percent: cfg.markup_percent, dobra_base: dobraBase, dobra_adicional: dobraAdic },
    { quantidade, prazo_horas: prazo, selecionados: Array.isArray(acabamentos) ? acabamentos.map((a) => (typeof a === 'string' ? a : a.nome)) : [], dobras: Number(dobras) || 0 }
  );
  return calc ? { ...calc, prazo_horas: prazo, estrategia: 'revenda_matriz' } : null;
}

module.exports = {
  listarCategorias, criarCategoria, atualizarCategoria,
  listarProdutos, detalheProduto,
  statusSync, dispararSync,
  getConfig, setConfig,
  precificarItemRevenda, pontuarSku, resolverProdutoRevenda, escolherFolheto, resolverFolheto,
};
