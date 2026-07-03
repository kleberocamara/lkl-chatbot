// Merge conservador de clientes_lkl duplicados. Uso:
//   node scripts/dedup-clientes.js            (dry-run: só relata)
//   node scripts/dedup-clientes.js --apply    (executa o merge)
const db = require('../src/db');
const { agruparClientes, escolherCanonicoCliente } = require('../src/ai/agent');

const REF_TABLES = ['orders', 'orcamentos', 'ordens_servico', 'revenda_compras'];

async function main() {
  const apply = process.argv.includes('--apply');
  const { rows } = await db.query(
    `SELECT id, nome, tipo_pessoa, celular, telefone, email, cpf_cnpj, updated_at, created_at FROM clientes_lkl`);
  const dups = agruparClientes(rows).filter(g => g.length > 1);
  console.log(`Total de clientes: ${rows.length} | Grupos duplicados: ${dups.length}`);

  let removidos = 0;
  const refCount = Object.fromEntries(REF_TABLES.map(t => [t, 0]));

  const client = await db.pool.connect();
  try {
    if (apply) await client.query('BEGIN');
    for (const g of dups) {
      const canon = escolherCanonicoCliente(g);
      const outros = g.filter(r => r.id !== canon.id);
      console.log(`\nGrupo (${g.length}) canônico=${canon.nome} [${canon.id}]`);
      for (const d of outros) {
        for (const t of REF_TABLES) {
          const q = `UPDATE ${t} SET cliente_id = $1 WHERE cliente_id = $2`;
          if (apply) {
            const res = await client.query(q, [canon.id, d.id]);
            refCount[t] += res.rowCount;
          } else {
            const res = await db.query(`SELECT COUNT(*) FROM ${t} WHERE cliente_id = $1`, [d.id]);
            refCount[t] += parseInt(res.rows[0].count);
          }
        }
        if (apply) {
          await client.query(
            `UPDATE clientes_lkl SET
               email = COALESCE(NULLIF(email,''), $2),
               telefone = COALESCE(NULLIF(telefone,''), $3),
               celular = COALESCE(NULLIF(celular,''), $4),
               cpf_cnpj = COALESCE(NULLIF(cpf_cnpj,''), $5)
             WHERE id = $1`,
            [canon.id, d.email, d.telefone, d.celular, d.cpf_cnpj]);
          await client.query(`DELETE FROM clientes_lkl WHERE id = $1`, [d.id]);
        }
        removidos++;
        console.log(`   - remove ${d.nome} [${d.id}]`);
      }
    }
    if (apply) await client.query('COMMIT');
  } catch (e) {
    if (apply) await client.query('ROLLBACK');
    console.error('ERRO — rollback:', e.message);
    throw e;
  } finally {
    client.release();
  }

  console.log(`\n${apply ? 'APLICADO' : 'DRY-RUN'} — duplicados ${apply ? 'removidos' : 'a remover'}: ${removidos}`);
  console.log('Referências repontadas por tabela:', refCount);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
