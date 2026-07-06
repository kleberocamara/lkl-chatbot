// Padroniza o catálogo do grupo de bobina 'lona' para todo nome conter "Banner",
// garantindo que itens de pedido chamados "Banner" casem com qualquer SKU de lona.
// Rodar uma vez: node -r dotenv/config scripts/padronizar-nome-lona.js
const db = require('../src/db');

(async () => {
  const before = await db.query(
    `SELECT id, nome FROM revenda_produtos WHERE bobina_grupo='lona' ORDER BY nome`
  );
  console.log(`Total no grupo 'lona': ${before.rows.length}`);

  const r = await db.query(
    `UPDATE revenda_produtos
     SET nome = 'Banner | ' || nome
     WHERE bobina_grupo = 'lona' AND nome NOT ILIKE 'Banner |%'
     RETURNING id, nome`
  );
  console.log(`Renomeados: ${r.rows.length}`);
  r.rows.forEach(row => console.log(`  -> ${row.nome}`));

  const semBanner = await db.query(
    `SELECT COUNT(*) FROM revenda_produtos WHERE bobina_grupo='lona' AND nome NOT ILIKE '%Banner%'`
  );
  console.log(`Itens do grupo lona ainda sem "Banner" no nome: ${semBanner.rows[0].count}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
