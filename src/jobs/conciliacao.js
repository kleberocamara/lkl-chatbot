const cron = require('node-cron');
const service = require('../modules/conciliacao/service');

function log(msg) { console.log(`[CRON-CONCILIACAO] ${new Date().toISOString()} ${msg}`); }

// 07h15 — Puxa o extrato C6 e concilia automaticamente contra contas_pagar/orcamentos
cron.schedule('15 7 * * *', async () => {
  try {
    const r = await service.sincronizar();
    log(`sincronizar: ${r.novos} lançamentos novos, ${r.saidasConciliadas} saídas + ${r.entradasConciliadas} entradas conciliadas`);
  } catch (err) { log(`ERRO sincronizar: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });
