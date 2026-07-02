const PRODUTOS = [
  { produto: 'ACRILICO',           tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'ADESIVOS',           tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'BANNERS',            tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'BLOCK LETTER',       tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'CARTAZ',             tipo: 'OFFSET' },
  { produto: 'CARTOES DE VISITA',  tipo: 'OFFSET' },
  { produto: 'CATÁLOGO',           tipo: 'OFFSET' },
  { produto: 'ENVELOPAMENTO',      tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'ENVELOPES',          tipo: 'OFFSET' },
  { produto: 'ETIQUETA ADESIVA',   tipo: 'OFFSET' },
  { produto: 'FOLDER',             tipo: 'OFFSET' },
  { produto: 'ILUMINAÇÃO',         tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'JORNAL',             tipo: 'OFFSET' },
  { produto: 'LÂMINAS',            tipo: 'OFFSET' },
  { produto: 'LETREIRO',           tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'LIVROS',             tipo: 'OFFSET' },
  { produto: 'NOTAS',              tipo: 'OFFSET' },
  { produto: 'PAINEL',             tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'PAINEL ACM',         tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'PEDIDOS',            tipo: 'OFFSET' },
  { produto: 'RECEITUÁRIOS',       tipo: 'OFFSET' },
  { produto: 'RECORTE ELETRÔNICO', tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'REVISTA',            tipo: 'OFFSET' },
  { produto: 'ROUTER',             tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'SINALIZAÇÃO',        tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'TAG',                tipo: 'OFFSET' },
  { produto: 'TIMBRADOS',          tipo: 'OFFSET' },
  { produto: 'WIND BANNER',        tipo: 'COMUNICAÇÃO VISUAL' },
  { produto: 'OUTROS/OFFSET',      tipo: 'OFFSET' },
];

function _norm(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 /]/g, '').trim();
}
function _singular(s) { return _norm(s).replace(/S$/, ''); }

function matchProduto(nome) {
  const n = _norm(nome);
  if (!n) return null;
  let hit = PRODUTOS.find(p => _norm(p.produto) === n);
  if (hit) return hit;
  const sg = _singular(nome);
  hit = PRODUTOS.find(p => _singular(p.produto) === sg);
  return hit || null;
}
function tipoPorProduto(nome) { const h = matchProduto(nome); return h ? h.tipo : null; }

function parseDimensoes(texto) {
  if (!texto) return null;
  const m = String(texto).match(/(\d+(?:[.,]\d+)?)\s*[x×X]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?/i);
  if (!m) return null;
  const num = (s) => parseFloat(String(s).replace(',', '.'));
  let l = num(m[1]), a = num(m[2]);
  const unidade = (m[3] || '').toLowerCase();
  if (unidade === 'm') { l *= 100; a *= 100; }
  else if (unidade === 'mm') { l /= 10; a /= 10; }
  if (!(l > 0) || !(a > 0)) return null;
  return { largura_cm: Math.round(l * 100) / 100, altura_cm: Math.round(a * 100) / 100 };
}

function _normTexto(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
const _STOP_MAT = new Set(['GR', 'G', 'GRS', 'KG', 'CM', 'MM', 'M', 'UN', 'UND', 'UNID', 'DE', 'DA', 'DO', 'COM', 'SEM']);
function tokensMaterial(termo) {
  const raw = _normTexto(termo).match(/[A-Z]+|[0-9]+/g) || [];
  return raw.filter(t => /[0-9]/.test(t) ? true : (t.length >= 2 && !_STOP_MAT.has(t)));
}
function selecionarMaterialId(materiais, termo) {
  const toks = tokensMaterial(termo);
  if (!toks.length) return null;
  const cand = (materiais || []).filter(m => {
    const n = _normTexto(m.nome);
    return toks.every(t => n.includes(t));
  });
  if (!cand.length) return null;
  cand.sort((a, b) => String(a.nome || '').length - String(b.nome || '').length);
  return cand[0].id;
}

// AO-4a: tipo_producao do item de revenda conforme a estratégia do produto do catálogo.
function tipoProducaoDoItemRevenda(estrategia, tipo_servico) {
  if (estrategia === 'interno_m2') return 'COMUNICAÇÃO VISUAL';
  if (estrategia === 'manual') {
    if (tipo_servico === 'OFFSET') return 'OFFSET';
    if (tipo_servico === 'COMUNICAÇÃO VISUAL') return 'COMUNICAÇÃO VISUAL';
    return 'REVENDA';
  }
  return 'REVENDA';
}

module.exports = { PRODUTOS, matchProduto, tipoPorProduto, parseDimensoes, tokensMaterial, selecionarMaterialId, tipoProducaoDoItemRevenda };
