require('dotenv').config();
const fs = require('fs');
const db = require('../src/db');

function estrategiaDe(cond) {
  const c = String(cond || '').toLowerCase();
  if (c.includes('interna')) return 'interno_m2';
  if (c.includes('manual')) return 'manual';
  return 'revenda_matriz';
}
function grupoDe(nome) {
  const n = String(nome || '').toLowerCase();
  if (n.includes('lona')) return 'lona';
  if (/(adesivo|vinil|kraft|blackout|casca de ovo|retrover)/.test(n)) return 'adesivo';
  return 'adesivo';
}
function parseCSV(txt) {
  const linhas = txt.split(/\r?\n/).filter(Boolean);
  const head = linhas.shift().split(',').map(s => s.trim());
  return linhas.map(l => {
    const cols = l.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0).map(s => s.replace(/^"|"$/g, '').replace(/""/g, '"'));
    const o = {}; head.forEach((h, i) => o[h] = (cols[i] || '').trim()); return o;
  });
}

async function main() {
  const path = process.argv[2];
  if (!path) { console.error('uso: node scripts/revenda-importar-revisao.js <csv>'); process.exit(1); }
  const rows = parseCSV(fs.readFileSync(path, 'utf8'));

  let cat = (await db.query("SELECT id FROM revenda_categorias WHERE nome='LKL — Interno'")).rows[0];
  if (!cat) cat = (await db.query("INSERT INTO revenda_categorias (nome, url, sincronizavel) VALUES ('LKL — Interno','interno',FALSE) RETURNING id")).rows[0];

  let up = 0, novos = 0, internoM2 = 0;
  for (const r of rows) {
    const ref = (r.ref || '').toLowerCase();
    if (!ref) continue;
    const est = estrategiaDe(r.condicao);
    const tipo = r.tipo_servico || null;
    const existe = (await db.query('SELECT id FROM revenda_produtos WHERE ref=$1', [ref])).rows[0];
    if (existe) {
      if (est === 'interno_m2') {
        await db.query('UPDATE revenda_produtos SET tipo_servico=$2, estrategia=$3, bobina_grupo=$4, preco_m2=30 WHERE id=$1', [existe.id, tipo, est, grupoDe(r.nome)]);
        internoM2++;
      } else {
        await db.query('UPDATE revenda_produtos SET tipo_servico=$2, estrategia=$3 WHERE id=$1', [existe.id, tipo, est]);
      }
      up++;
    } else {
      await db.query(
        `INSERT INTO revenda_produtos (ref, nome, categoria_id, estrategia, tipo_servico, ativo)
         VALUES ($1,$2,$3,$4,$5,TRUE) ON CONFLICT (ref) DO NOTHING`,
        [ref, r.nome || ref, cat.id, est, tipo]
      );
      novos++;
    }
  }
  console.log(`import OK: atualizados=${up}, novos=${novos}, interno_m2=${internoM2}`);
  const rep = (await db.query("SELECT bobina_grupo, count(*) FROM revenda_produtos WHERE estrategia='interno_m2' GROUP BY bobina_grupo")).rows;
  console.log('bobina_grupo:', JSON.stringify(rep));
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
