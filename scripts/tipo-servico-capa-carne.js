// Preenche tipo_servico='OFFSET' nos produtos da categoria "Capa de Carnê"
// (vieram vazios da sincronização; sem isso o matching automático do chatbot
// os descarta pelo filtro de tipo_servico em resolverProdutoRevenda).
// Rodar uma vez: node -r dotenv/config scripts/tipo-servico-capa-carne.js
const db = require('../src/db');

(async () => {
  const cat = await db.query(`SELECT id FROM revenda_categorias WHERE nome = 'Capa de Carnê'`);
  if (!cat.rows[0]) { console.error('categoria "Capa de Carnê" não encontrada'); process.exit(1); }
  const categoriaId = cat.rows[0].id;

  const r = await db.query(
    `UPDATE revenda_produtos SET tipo_servico='OFFSET'
     WHERE categoria_id=$1 AND (tipo_servico IS NULL OR tipo_servico='')
     RETURNING ref, nome`,
    [categoriaId]
  );
  console.log(`Atualizados: ${r.rows.length}`);
  r.rows.forEach(row => console.log(`  -> ${row.ref} ${row.nome}`));

  const semTipo = await db.query(
    `SELECT COUNT(*) FROM revenda_produtos WHERE categoria_id=$1 AND (tipo_servico IS NULL OR tipo_servico='')`,
    [categoriaId]
  );
  console.log(`Ainda sem tipo_servico: ${semTipo.rows[0].count}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
