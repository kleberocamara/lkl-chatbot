// src/modules/conciliacao/service.js
const { query } = require('../../db');
const c6bank = require('../../services/c6bank');
const orcamentosService = require('../orcamentos/service');
const { format, subDays } = require('date-fns');

// Puxa o extrato C6, grava os lançamentos novos (idempotente por external_id)
// e tenta conciliar automaticamente contra contas_pagar / orcamentos.
async function sincronizar({ startDate, endDate } = {}) {
  const hoje = format(new Date(), 'yyyy-MM-dd');
  const inicio = startDate || format(subDays(new Date(), 30), 'yyyy-MM-dd');
  const fim = endDate || hoje;

  const entradas = await c6bank.consultarExtrato(inicio, fim);

  let novos = 0;
  for (const e of entradas) {
    const r = await query(
      `INSERT INTO extrato_lancamentos
        (external_id, entry_date, amount, operation_type, transaction_type, title, description, reference, end_to_end_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (external_id) DO NOTHING RETURNING id`,
      [
        e.external_id, e.entry_date, parseFloat(e.amount), e.operation_type, e.transaction_type || null,
        e.title || null, e.description || null, e.reference || null, e.end_to_end_id || null,
      ]
    );
    if (r.rowCount) novos++;
  }

  const resultado = await conciliarPendentes();
  return { total: entradas.length, novos, ...resultado };
}

// Percorre os lançamentos ainda não conciliados e tenta bater automaticamente
// (mesmo valor + direção certa + data em até 1 dia de diferença). Quando há
// mais de um candidato com o mesmo valor/data, fica pendente para revisão manual.
async function conciliarPendentes() {
  const pendentes = await query(`SELECT * FROM extrato_lancamentos WHERE status='pendente'`);
  let saidasConciliadas = 0, entradasConciliadas = 0;

  for (const lanc of pendentes.rows) {
    if (lanc.operation_type === 'OUTGOING') {
      if (await tentarConciliarSaida(lanc)) saidasConciliadas++;
    } else if (lanc.operation_type === 'INCOMING') {
      if (await tentarConciliarEntrada(lanc)) entradasConciliadas++;
    }
  }
  return { saidasConciliadas, entradasConciliadas };
}

async function tentarConciliarSaida(lanc) {
  const candidatos = await query(
    `SELECT id FROM contas_pagar
     WHERE status='pago' AND valor=$1
       AND pago_em::date BETWEEN $2::date - INTERVAL '1 day' AND $2::date + INTERVAL '1 day'
       AND id::text NOT IN (
         SELECT conciliado_id FROM extrato_lancamentos
         WHERE conciliado_tipo='conta_pagar' AND conciliado_id IS NOT NULL
       )`,
    [lanc.amount, lanc.entry_date]
  );
  if (candidatos.rows.length !== 1) return false;
  await marcarConciliado(lanc.id, 'conta_pagar', candidatos.rows[0].id, false);
  return true;
}

// Tenta bater a entrada do extrato contra um pagamento já conhecido como pago, OU
// contra uma cobrança ainda em aberto (parcela de boleto ou orçamento aguardando
// pagamento) — nesse segundo caso, o lançamento do extrato é quem CONFIRMA o
// pagamento no sistema (o webhook do C6 deveria fazer isso em tempo real, mas
// se ele falhar/atrasar, a conciliação funciona como rede de segurança).
async function tentarConciliarEntrada(lanc) {
  // 1) bate contra uma parcela de boleto aguardando pagamento — a mais comum e mais
  // precisa, já que casa pelo valor exato da parcela (não do orçamento inteiro).
  const parcelas = await query(
    `SELECT ob.id, ob.orcamento_id, ob.boleto_id
     FROM orcamento_boletos ob
     WHERE ob.status='aguardando' AND ob.valor=$1
       AND ob.vencimento BETWEEN $2::date - INTERVAL '10 days' AND $2::date + INTERVAL '60 days'`,
    [lanc.amount, lanc.entry_date]
  );
  if (parcelas.rows.length === 1 && parcelas.rows[0].boleto_id) {
    const r = await orcamentosService.confirmarPagamento({ tipo: 'boleto', boletoId: parcelas.rows[0].boleto_id });
    if (!r.erro) {
      await marcarConciliado(lanc.id, 'orcamento', parcelas.rows[0].orcamento_id, false);
      return true;
    }
  }

  // 2) fallback: orçamento já pago (auditoria) ou aguardando pagamento sem parcela
  // cadastrada (ex: PIX/link de pagamento) — bate pelo valor total do orçamento.
  const candidatos = await query(
    `SELECT id, status_pagamento FROM orcamentos
     WHERE status_pagamento IN ('pago','aguardando_pagamento') AND total=$1
       AND (pago_em IS NULL OR pago_em::date BETWEEN $2::date - INTERVAL '1 day' AND $2::date + INTERVAL '1 day')
       AND id::text NOT IN (
         SELECT conciliado_id FROM extrato_lancamentos
         WHERE conciliado_tipo='orcamento' AND conciliado_id IS NOT NULL
       )`,
    [lanc.amount, lanc.entry_date]
  );
  if (candidatos.rows.length !== 1) return false;
  const alvo = candidatos.rows[0];
  if (alvo.status_pagamento !== 'pago') {
    await query(
      `UPDATE orcamentos SET status_pagamento='pago', pago_em=$1 WHERE id=$2`,
      [lanc.entry_date, alvo.id]
    );
  }
  await marcarConciliado(lanc.id, 'orcamento', alvo.id, false);
  return true;
}

async function marcarConciliado(lancamentoId, tipo, alvoId, manual) {
  await query(
    `UPDATE extrato_lancamentos
     SET status='conciliado', conciliado_tipo=$1, conciliado_id=$2, conciliado_em=NOW(), conciliado_manual=$3
     WHERE id=$4`,
    [tipo, String(alvoId), manual, lancamentoId]
  );
}

async function listarLancamentos({ status, startDate, endDate } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND status=$${params.length}`; }
  if (startDate) { params.push(startDate); where += ` AND entry_date >= $${params.length}`; }
  if (endDate) { params.push(endDate); where += ` AND entry_date <= $${params.length}`; }
  const r = await query(
    `SELECT * FROM extrato_lancamentos ${where} ORDER BY entry_date DESC, id DESC LIMIT 500`,
    params
  );
  return r.rows;
}

// Contas pagas/orçamentos pagos que ainda não têm um lançamento do extrato batido.
async function semCorrespondenciaNoBanco({ dias = 30 } = {}) {
  const desde = format(subDays(new Date(), dias), 'yyyy-MM-dd');
  const [contasPagar, orcamentos] = await Promise.all([
    query(
      `SELECT id, descricao, valor, pago_em FROM contas_pagar
       WHERE status='pago' AND pago_em >= $1
         AND id::text NOT IN (
           SELECT conciliado_id FROM extrato_lancamentos
           WHERE conciliado_tipo='conta_pagar' AND conciliado_id IS NOT NULL
         )
       ORDER BY pago_em DESC`,
      [desde]
    ),
    query(
      `SELECT id, numero, cliente_id, total, pago_em FROM orcamentos
       WHERE status_pagamento='pago' AND pago_em >= $1
         AND id::text NOT IN (
           SELECT conciliado_id FROM extrato_lancamentos
           WHERE conciliado_tipo='orcamento' AND conciliado_id IS NOT NULL
         )
       ORDER BY pago_em DESC`,
      [desde]
    ),
  ]);
  return { contasPagar: contasPagar.rows, orcamentos: orcamentos.rows };
}

async function vincularManual(lancamentoId, tipo, alvoId) {
  if (!['conta_pagar', 'orcamento'].includes(tipo)) return { erro: ['Tipo inválido'] };
  const lanc = await query('SELECT id FROM extrato_lancamentos WHERE id=$1', [lancamentoId]);
  if (!lanc.rows[0]) return { erro: ['Lançamento não encontrado'] };

  const tabela = tipo === 'conta_pagar' ? 'contas_pagar' : 'orcamentos';
  const alvo = await query(`SELECT id FROM ${tabela} WHERE id=$1`, [alvoId]);
  if (!alvo.rows[0]) return { erro: ['Registro alvo não encontrado'] };

  await marcarConciliado(lancamentoId, tipo, alvoId, true);
  return { ok: true };
}

async function ignorar(lancamentoId) {
  const r = await query(
    `UPDATE extrato_lancamentos SET status='ignorado', updated_at=NOW() WHERE id=$1 AND status='pendente' RETURNING id`,
    [lancamentoId]
  );
  if (!r.rowCount) return { erro: ['Lançamento não encontrado ou já conciliado'] };
  return { ok: true };
}

module.exports = {
  sincronizar,
  conciliarPendentes,
  listarLancamentos,
  semCorrespondenciaNoBanco,
  vincularManual,
  ignorar,
};
