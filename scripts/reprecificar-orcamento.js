// Reprecifica os itens de um orçamento pelo matcher + motor de revenda.
//   node -r dotenv/config scripts/reprecificar-orcamento.js <numero_orcamento>
const db = require('../src/db');
const revenda = require('../src/modules/revenda/service');
const { parseDimensoes } = require('../src/constants/produtos');

async function main() {
  const numero = parseInt(process.argv[2], 10);
  if (!numero) { console.error('uso: node scripts/reprecificar-orcamento.js <numero>'); process.exit(1); }
  const orc = (await db.query('SELECT id FROM orcamentos WHERE numero=$1', [numero])).rows[0];
  if (!orc) { console.error('orçamento não encontrado'); process.exit(1); }
  const itens = (await db.query(
    `SELECT id, produto, especificacao, quantidade, largura_cm, altura_cm, tipo_producao FROM orcamento_itens WHERE orcamento_id=$1`, [orc.id])).rows;
  for (const it of itens) {
    const material = it.especificacao || '';
    let larg = it.largura_cm, alt = it.altura_cm;
    if (larg == null && alt == null) {
      const dim = parseDimensoes(it.especificacao);
      if (dim) { larg = dim.largura_cm; alt = dim.altura_cm; }
    }
    const prod = await revenda.resolverProdutoRevenda({ produto: it.produto, material, tipo_producao: it.tipo_producao });
    let vu = 0, vt = 0, origem = 'manual', mem = null, rpid = null;
    if (prod && prod.estrategia !== 'manual') {
      const calc = await revenda.precificarItemRevenda({ revenda_produto_id: prod.id, quantidade: it.quantidade, largura_cm: larg, altura_cm: alt, prazo_horas: null, acabamentos: [] });
      if (calc && Number(calc.valor_total) > 0) { vu = calc.valor_unitario; vt = calc.valor_total; origem = 'auto'; rpid = prod.id; mem = `${calc.estrategia} · ${prod.nome}${calc.memoria ? ` · ${calc.memoria}` : ''}`; }
    }
    await db.query(
      `UPDATE orcamento_itens SET valor_unitario=$2, valor_total=$3, preco_origem=$4, preco_memoria=$5, revenda_produto_id=$6, largura_cm=$7, altura_cm=$8 WHERE id=$1`,
      [it.id, vu, vt, origem, mem, rpid, larg != null ? larg : null, alt != null ? alt : null]);
    console.log(`item ${it.produto}: ${origem} R$ ${vt}`);
  }
  await db.query(`UPDATE orcamentos SET total=(SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`, [orc.id]);
  console.log('total recalculado.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
