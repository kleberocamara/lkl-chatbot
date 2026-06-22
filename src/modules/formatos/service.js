const db = require('../../db');

// Imposição: quantas imagens (img_alt x img_larg) montam num corte (alt x larg), considerando rotação 90°
function _imagensMontadas(alt, larg, ia, il) {
  if (!alt || !larg || !ia || !il) return 0;
  const normal  = Math.floor(alt / ia) * Math.floor(larg / il);
  const girada  = Math.floor(alt / il) * Math.floor(larg / ia);
  return Math.max(normal, girada);
}

// Lista formatos com imagens montadas calculadas, melhor aproveitamento primeiro
async function melhorCorte({ imagem_alt, imagem_larg, formato } = {}) {
  const ia = parseFloat(imagem_alt), il = parseFloat(imagem_larg);
  if (!(ia > 0) || !(il > 0)) return { erro: ['Informe imagem_alt e imagem_larg maiores que zero'] };

  const params = [];
  let where = 'WHERE ativo = true';
  if (formato != null && formato !== '') { params.push(parseInt(formato)); where += ` AND formato = $${params.length}`; }

  const r = await db.query(
    `SELECT formato, altura_corte, largura_corte FROM formatos_papel ${where} ORDER BY formato, altura_corte`,
    params
  );
  const linhas = r.rows
    .map(f => ({
      formato: f.formato,
      altura_corte: f.altura_corte,
      largura_corte: f.largura_corte,
      imagens_montadas: _imagensMontadas(f.altura_corte, f.largura_corte, ia, il),
    }))
    .filter(x => x.imagens_montadas >= 1)
    .sort((a, b) => b.imagens_montadas - a.imagens_montadas
      || (a.altura_corte * a.largura_corte) - (b.altura_corte * b.largura_corte));
  return { imagem_alt: ia, imagem_larg: il, resultados: linhas };
}

async function listar() {
  const r = await db.query('SELECT id, formato, altura_corte, largura_corte FROM formatos_papel WHERE ativo = true ORDER BY formato, altura_corte');
  return r.rows;
}

module.exports = { melhorCorte, listar, _imagensMontadas };
