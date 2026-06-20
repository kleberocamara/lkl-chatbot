const cron = require('node-cron');
const service = require('../modules/contas-pagar/service');
const whatsapp = require('../services/whatsapp');

function log(msg) { console.log(`[CRON-CONTAS-PAGAR] ${new Date().toISOString()} ${msg}`); }

// 07h00 — Importar boletos DDA
cron.schedule('0 7 * * *', async () => {
  try {
    const r = await service.sincronizarDDA();
    log(`DDA sync: ${r.importados} importados, ${r.ignorados} ignorados`);
  } catch (err) { log(`ERRO sync_dda: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });

// 07h30 — Reconciliar extrato C6
cron.schedule('30 7 * * *', async () => {
  try {
    const r = await service.reconciliar();
    log(`Reconciliação: ${r.atualizadas} contas marcadas como pagas`);
  } catch (err) { log(`ERRO reconciliar_extrato: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });

// 08h00 — Marcar vencidas
cron.schedule('0 8 * * *', async () => {
  try {
    const r = await service.marcarVencidas();
    log(`check_overdue: ${r.atualizadas} contas marcadas como vencidas`);
  } catch (err) { log(`ERRO check_overdue: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });

// 09h00 — Alertar vencimentos em 2 dias
cron.schedule('0 9 * * *', async () => {
  const ownerWpp = process.env.OWNER_WHATSAPP;
  if (!ownerWpp) { log('OWNER_WHATSAPP não configurado — alerta pulado'); return; }
  try {
    const contas = await service.contasVencendoEm(2);
    if (!contas.length) return;
    const total = contas.reduce((s, c) => s + parseFloat(c.valor), 0);
    const lista = contas.map(c => `• ${c.descricao} — R$${parseFloat(c.valor).toFixed(2)}`).join('\n');
    const msg = `⚠️ *Contas a Pagar — Vencimento em 2 dias*\n\n${lista}\n\n*Total: R$${total.toFixed(2)}*\n\nAcesse o painel para agendar o pagamento.`;
    await whatsapp.sendMessage(ownerWpp, msg);
    log(`alert_vencendo: ${contas.length} contas notificadas`);
  } catch (err) { log(`ERRO alert_vencendo: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });

// A cada 2h (07h–21h, seg–sex) — Verificar status dos lotes submetidos
cron.schedule('0 7,9,11,13,15,17,19,21 * * 1-5', async () => {
  try {
    const r = await service.atualizarStatusLotesSubmetidos();
    if (r.aprovados) log(`check_batch_status: ${r.aprovados} itens aprovados`);
  } catch (err) { log(`ERRO check_batch_status: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });

// Dia 25 às 09h — Gerar contas recorrentes do próximo mês
cron.schedule('0 9 25 * *', async () => {
  try {
    const r = await service.gerarRecorrentesProximoMes();
    log(`generate_recurrent: ${r.geradas} contas geradas para o próximo mês`);
  } catch (err) { log(`ERRO generate_recurrent: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });

log('Cron jobs de contas a pagar inicializados');
