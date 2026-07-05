// Recalcula orders.status a partir do estado atual das OS (dois caminhos de vínculo).
// Rodar uma vez: node -r dotenv/config scripts/backfill-status-pedido.js
const db = require('../src/db');
const { pedidoStatusDaOS } = require('../src/constants/fluxoProducao');

async function statusOSsDoOrcamento(orcamentoId) {
  const r = await db.query(
    `SELECT DISTINCT os.id, os.status FROM ordens_servico os
     WHERE os.status != 'cancelado' AND (
       os.orcamento_id = $1
       OR os.id IN (SELECT oit.os_id FROM os_itens oit
                    JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
                    WHERE oi.orcamento_id = $1)
     )`,
    [orcamentoId]
  );
  return r.rows.map(x => x.status);
}

(async () => {
  const orders = await db.query(
    `SELECT id, status, orcamento_id FROM orders WHERE orcamento_id IS NOT NULL`
  );
  let changed = 0;
  for (const o of orders.rows) {
    const statuses = await statusOSsDoOrcamento(o.orcamento_id);
    let alvo = pedidoStatusDaOS(statuses);
    if (!alvo) {
      // Sem OS: se pagamento vazou pro campo, normaliza para aprovado.
      if (o.status === 'pago' || o.status === 'aguardando_pagamento') alvo = 'aprovado';
      else continue;
    }
    if (alvo !== o.status) {
      await db.query('UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2', [alvo, o.id]);
      changed++;
      console.log(`Pedido ${String(o.id).slice(0, 8)}  ${o.status} -> ${alvo}`);
    }
  }
  console.log(`\nBackfill concluído: ${changed} pedido(s) atualizado(s).`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
