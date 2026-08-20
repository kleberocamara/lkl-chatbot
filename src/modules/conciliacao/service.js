// src/modules/conciliacao/service.js
const { query } = require('../../db');
const c6bank = require('../../services/c6bank');
const orcamentosService = require('../orcamentos/service');
const { format, subDays } = require('date-fns');

// Sufixos societários e conectivos que não ajudam a identificar quem pagou.
const RUIDO_NOME = new Set([
  'LTDA', 'ME', 'EPP', 'EIRELI', 'SA', 'S/A', 'MEI', 'CIA', 'COMPANHIA',
  'DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'THE',
]);

// Normaliza para comparação: sem acento, maiúsculas, só letras/números/espaço.
function _normalizarNome(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tokens significativos de um nome (>=4 chars, sem ruído societário).
function _tokensNome(s) {
  return _normalizarNome(s).split(' ').filter((t) => t.length >= 4 && !RUIDO_NOME.has(t));
}

// Extrai o nome do pagador do título do extrato ("Pix recebido de FULANO" → "FULANO").
// Títulos genéricos ("CREDITO DE BOLETO") não têm pagador — retorna string vazia.
function extrairPagador(title) {
  const t = String(title || '');
  const m = t.match(/(?:recebid[oa]|transferencia|transfer[êe]ncia)\s+d[eo]\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// O pagador do extrato é plausivelmente o mesmo que o cliente do orçamento?
// Basta um token significativo em comum — cobre "Contraste Marketing" vs
// "CONTRASTE MARKENTING" (typo no cadastro) e "Andre Luis Alves" vs "André".
function nomesCompativeis(pagador, cliente) {
  const a = _tokensNome(pagador);
  const b = _tokensNome(cliente);
  if (!a.length || !b.length) return false;
  const setB = new Set(b);
  return a.some((t) => setB.has(t));
}

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
  // O boleto precisa ter sido emitido ATÉ a data do crédito: um boleto criado depois
  // não pode ter originado um pagamento anterior a ele (sem essa checagem, valores
  // que se repetem entre pedidos do mesmo cliente casavam com o boleto errado).
  const parcelas = await query(
    `SELECT ob.id, ob.orcamento_id, ob.boleto_id
     FROM orcamento_boletos ob
     WHERE ob.status='aguardando' AND ob.valor=$1
       AND ob.criado_em::date <= $2::date
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

  // 2) fallback: orçamento já pago (auditoria), aguardando pagamento sem parcela
  // cadastrada (ex: PIX/link), ou ainda pendente — o cliente pode pagar por PIX
  // direto antes de qualquer cobrança formal ser emitida.
  const candidatos = await query(
    `SELECT o.id, o.status_pagamento, c.nome AS cliente_nome
     FROM orcamentos o
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE o.status_pagamento IN ('pago','aguardando_pagamento','pendente') AND o.total=$1
       AND (o.pago_em IS NULL OR o.pago_em::date BETWEEN $2::date - INTERVAL '1 day' AND $2::date + INTERVAL '1 day')
       AND o.id::text NOT IN (
         SELECT conciliado_id FROM extrato_lancamentos
         WHERE conciliado_tipo='orcamento' AND conciliado_id IS NOT NULL
       )
       -- Se a cobrança formal foi emitida DEPOIS deste crédito e segue em aberto,
       -- o crédito é de outra coisa: ninguém emite boleto para algo já recebido.
       AND NOT EXISTS (
         SELECT 1 FROM orcamento_boletos ob
         WHERE ob.orcamento_id = o.id AND ob.status='aguardando'
           AND ob.criado_em::date > $2::date
       )`,
    [lanc.amount, lanc.entry_date]
  );
  if (!candidatos.rows.length) return false;

  // Orçamento 'pendente' não tem cobrança emitida ligando o pagamento a ele, então
  // valor igual sozinho não é evidência suficiente (dois clientes podem dever o mesmo
  // valor, ou um terceiro pode ter pago outra coisa). Só concilia automaticamente
  // quando o nome do pagador no extrato também bate com o do cliente; caso contrário
  // o lançamento fica pendente e aparece em sugestoesRevisao() para confirmação manual.
  const pagador = extrairPagador(lanc.title);
  const elegiveis = candidatos.rows.filter((o) =>
    o.status_pagamento !== 'pendente' || nomesCompativeis(pagador, o.cliente_nome));
  if (elegiveis.length !== 1) return false;

  const alvo = elegiveis[0];
  if (alvo.status_pagamento !== 'pago') {
    await query(
      `UPDATE orcamentos SET status_pagamento='pago', pago_em=$1 WHERE id=$2`,
      [lanc.entry_date, alvo.id]
    );
  }
  await marcarConciliado(lanc.id, 'orcamento', alvo.id, false);
  return true;
}

// Lançamentos que batem em valor com algum orçamento em aberto, mas que NÃO foram
// conciliados automaticamente (nome do pagador diverge, ou há mais de um candidato).
// Alimenta a revisão manual: são palpites, nunca conciliações.
async function sugestoesRevisao({ dias = 90 } = {}) {
  const desde = format(subDays(new Date(), dias), 'yyyy-MM-dd');
  const r = await query(
    `SELECT e.id AS lancamento_id, e.entry_date, e.amount, e.title,
            o.id AS orcamento_id, o.numero AS orcamento_numero,
            o.status_pagamento, c.nome AS cliente_nome
     FROM extrato_lancamentos e
     JOIN orcamentos o ON o.total = e.amount
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE e.operation_type='INCOMING' AND e.status='pendente'
       AND e.entry_date >= $1
       AND o.status_pagamento <> 'pago'
       AND o.id::text NOT IN (
         SELECT conciliado_id FROM extrato_lancamentos
         WHERE conciliado_tipo='orcamento' AND conciliado_id IS NOT NULL
       )
     ORDER BY e.entry_date DESC`,
    [desde]
  );
  return r.rows.map((row) => {
    const pagador = extrairPagador(row.title);
    return {
      ...row,
      pagador: pagador || null,
      nome_confere: nomesCompativeis(pagador, row.cliente_nome),
      motivo: pagador
        ? 'Nome do pagador não confere com o cliente — confirme antes de conciliar'
        : 'Lançamento sem nome de pagador (ex: crédito de boleto) — confirme a qual orçamento pertence',
    };
  });
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

  // Vincular manualmente uma entrada do extrato a um orçamento é a confirmação de que
  // aquele pagamento é dele — reflete isso no status, senão o orçamento continuaria
  // aparecendo como não pago mesmo depois de conciliado.
  if (tipo === 'orcamento') {
    const lancData = await query('SELECT entry_date, operation_type FROM extrato_lancamentos WHERE id=$1', [lancamentoId]);
    const l = lancData.rows[0];
    if (l?.operation_type === 'INCOMING') {
      await query(
        `UPDATE orcamentos SET status_pagamento='pago', pago_em=$1
         WHERE id=$2 AND status_pagamento <> 'pago'`,
        [l.entry_date, alvoId]
      );
    }
  }

  await marcarConciliado(lancamentoId, tipo, alvoId, true);
  return { ok: true };
}

// Receita que entrou na conta mas não pertence à operação da LKL (ex: boletos
// emitidos fora do sistema, pelo app do banco). Sai da fila de pendências sem ser
// vinculada a nenhum orçamento — diferente de 'ignorado', que é para ruído/engano.
async function marcarReceitaExterna(lancamentoId) {
  const r = await query(
    `UPDATE extrato_lancamentos SET status='receita_externa', updated_at=NOW()
     WHERE id=$1 AND status='pendente' RETURNING id`,
    [lancamentoId]
  );
  if (!r.rowCount) return { erro: ['Lançamento não encontrado ou já classificado'] };
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
  sugestoesRevisao,
  vincularManual,
  marcarReceitaExterna,
  ignorar,
  extrairPagador,
  nomesCompativeis,
};
