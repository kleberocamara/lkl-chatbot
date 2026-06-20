const { query, pool } = require('../../db');
const c6bank = require('../../services/c6bank');
const { format, subDays } = require('date-fns');

// ─── LEITURA ──────────────────────────────────────────────────────────────

async function listar({ status, tipo_despesa, vencimento_de, vencimento_ate, dias } = {}) {
  const conds = [];
  const params = [];

  if (status) { params.push(status); conds.push(`status = $${params.length}`); }
  if (tipo_despesa) { params.push(tipo_despesa); conds.push(`tipo_despesa = $${params.length}`); }
  if (vencimento_de) { params.push(vencimento_de); conds.push(`vencimento >= $${params.length}`); }
  if (vencimento_ate) { params.push(vencimento_ate); conds.push(`vencimento <= $${params.length}`); }
  if (dias !== undefined) {
    const hoje = format(new Date(), 'yyyy-MM-dd');
    const ate = format(new Date(Date.now() + dias * 86400000), 'yyyy-MM-dd');
    params.push(hoje); conds.push(`vencimento >= $${params.length}`);
    params.push(ate);  conds.push(`vencimento <= $${params.length}`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await query(
    `SELECT * FROM contas_pagar ${where} ORDER BY vencimento ASC, id ASC`,
    params
  );
  return r.rows;
}

async function buscarPorId(id) {
  const r = await query('SELECT * FROM contas_pagar WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// ─── KPIs ─────────────────────────────────────────────────────────────────

async function kpis() {
  const hoje = format(new Date(), 'yyyy-MM-dd');
  const em30  = format(new Date(Date.now() + 30 * 86400000), 'yyyy-MM-dd');
  const inicioMes = format(new Date(new Date().getFullYear(), new Date().getMonth(), 1), 'yyyy-MM-dd');

  const [a30, hoje_, vencidos, pagoMes] = await Promise.all([
    query(`SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar WHERE status IN ('pendente','agendado') AND vencimento BETWEEN $1 AND $2`, [hoje, em30]),
    query(`SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar WHERE status IN ('pendente','agendado','vencido') AND vencimento = $1`, [hoje]),
    query(`SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar WHERE status = 'vencido'`),
    query(`SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar WHERE status = 'pago' AND pago_em >= $1`, [inicioMes]),
  ]);

  return {
    total_30d:    parseFloat(a30.rows[0].total),
    vencendo_hoje: parseFloat(hoje_.rows[0].total),
    vencidos:     parseFloat(vencidos.rows[0].total),
    pago_mes:     parseFloat(pagoMes.rows[0].total),
  };
}

// ─── ESCRITA ──────────────────────────────────────────────────────────────

async function criar({ descricao, fornecedor, tipo_despesa, valor, vencimento, tipo, linha_digitavel, pix_content, tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao }) {
  if (!descricao || !tipo_despesa || !valor || !vencimento) {
    return { erro: ['descricao, tipo_despesa, valor e vencimento são obrigatórios'] };
  }
  const r = await query(
    `INSERT INTO contas_pagar
       (descricao, fornecedor, tipo_despesa, valor, vencimento, tipo, linha_digitavel, pix_content,
        tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [descricao, fornecedor || null, tipo_despesa, valor, vencimento,
     tipo || 'outro', linha_digitavel || null, pix_content || null,
     tipo_entrada || 'manual', recorrente || false, recorrencia_dia || null,
     recorrencia_valor_fixo !== false, observacao || null]
  );
  return r.rows[0];
}

async function editar(id, campos) {
  const conta = await buscarPorId(id);
  if (!conta) return { erro: ['Conta não encontrada'] };
  if (conta.status !== 'pendente') return { erro: ['Só é possível editar contas com status pendente'] };

  const permitidos = ['descricao','fornecedor','tipo_despesa','valor','vencimento','tipo',
                      'linha_digitavel','pix_content','recorrente','recorrencia_dia',
                      'recorrencia_valor_fixo','observacao'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(campos)) {
    if (permitidos.includes(k)) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (!sets.length) return { erro: ['Nenhum campo válido para atualizar'] };
  params.push(id);
  const r = await query(
    `UPDATE contas_pagar SET ${sets.join(', ')}, updated_at=NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  return r.rows[0];
}

async function cancelar(id) {
  const conta = await buscarPorId(id);
  if (!conta) return { erro: ['Conta não encontrada'] };
  if (!['pendente','vencido'].includes(conta.status)) return { erro: ['Só é possível cancelar contas pendentes ou vencidas'] };
  const r = await query(
    `UPDATE contas_pagar SET status='cancelado', updated_at=NOW() WHERE id = $1 RETURNING *`, [id]
  );
  return r.rows[0];
}

async function pagarManual(id) {
  const conta = await buscarPorId(id);
  if (!conta) return { erro: ['Conta não encontrada'] };
  if (conta.status === 'pago') return { erro: ['Conta já está paga'] };
  if (conta.status === 'cancelado') return { erro: ['Conta cancelada não pode ser paga'] };
  const r = await query(
    `UPDATE contas_pagar SET status='pago', pago_em=NOW(), updated_at=NOW() WHERE id = $1 RETURNING *`, [id]
  );
  return r.rows[0];
}

// ─── RECORRENTES ──────────────────────────────────────────────────────────

async function criarRecorrente({ descricao, fornecedor, tipo_despesa, valor, tipo, linha_digitavel, pix_content, recorrencia_dia, recorrencia_valor_fixo, observacao }) {
  if (!descricao || !tipo_despesa || !valor || !recorrencia_dia) {
    return { erro: ['descricao, tipo_despesa, valor e recorrencia_dia são obrigatórios'] };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const criadas = [];
    const hoje = new Date();
    for (let m = 0; m < 12; m++) {
      const data = new Date(hoje.getFullYear(), hoje.getMonth() + m, recorrencia_dia);
      const valorInst = recorrencia_valor_fixo !== false ? valor : 0;
      const r = await client.query(
        `INSERT INTO contas_pagar
           (descricao, fornecedor, tipo_despesa, valor, vencimento, tipo, linha_digitavel, pix_content,
            tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',true,$9,$10,$11) RETURNING *`,
        [descricao, fornecedor || null, tipo_despesa, valorInst,
         format(data, 'yyyy-MM-dd'), tipo || 'outro',
         linha_digitavel || null, pix_content || null,
         recorrencia_dia, recorrencia_valor_fixo !== false, observacao || null]
      );
      criadas.push(r.rows[0]);
    }
    await client.query('COMMIT');
    return { criadas };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── DDA ──────────────────────────────────────────────────────────────────

async function sincronizarDDA() {
  const boletos = await c6bank.consultarDDA();
  let importados = 0;
  let ignorados = 0;
  for (const b of boletos) {
    if (!b.content) { ignorados++; continue; }
    try {
      await query(
        `INSERT INTO contas_pagar
           (descricao, fornecedor, tipo_despesa, valor, vencimento, tipo, linha_digitavel, tipo_entrada, status)
         VALUES ($1,$2,'FORNECEDOR',$3,$4,'boleto',$5,'dda','pendente')
         ON CONFLICT (linha_digitavel) WHERE linha_digitavel IS NOT NULL AND status != 'cancelado'
         DO NOTHING`,
        [
          b.beneficiary_name || 'Boleto DDA',
          b.beneficiary_name || null,
          b.amount,
          b.due_date,
          b.content,
        ]
      );
      importados++;
    } catch (err) { console.error('[CONTAS-PAGAR] sincronizarDDA erro ao inserir boleto:', err.message); ignorados++; }
  }
  return { total: boletos.length, importados, ignorados };
}

// ─── LOTES C6 ─────────────────────────────────────────────────────────────

async function criarLoteC6(ids, uploaderName) {
  if (!ids || !ids.length) return { erro: ['Informe ao menos um ID de conta'] };
  if (!uploaderName) return { erro: ['uploaderName é obrigatório'] };

  const r = await query(
    `SELECT * FROM contas_pagar WHERE id = ANY($1) AND status IN ('pendente','vencido')`,
    [ids]
  );
  const contas = r.rows;
  if (!contas.length) return { erro: ['Nenhuma conta válida encontrada'] };

  const items = contas.map(c => ({
    content: c.linha_digitavel || c.pix_content,
    amount: parseFloat(c.valor),
    description: `CP-${c.id} ${c.descricao}`.substring(0, 100),
  }));

  const groupId = await c6bank.criarLote(items);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO payment_batches (c6_group_id, uploader_name, valor_total, quantidade_itens)
       VALUES ($1,$2,$3,$4)`,
      [groupId, uploaderName, contas.reduce((s, c) => s + parseFloat(c.valor), 0), contas.length]
    );
    // C6 pode demorar alguns segundos para processar os itens após criar o lote
    let loteItems = [];
    for (let tentativa = 1; tentativa <= 5; tentativa++) {
      try {
        loteItems = await c6bank.consultarLote(groupId);
        break;
      } catch (e) {
        if (tentativa === 5 || !e.message.includes('422')) throw e;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    for (const item of loteItems) {
      const conta = contas.find(c => `CP-${c.id}` === (item.description || '').split(' ')[0]);
      if (conta) {
        await client.query(
          `UPDATE contas_pagar SET c6_group_id=$1, c6_item_id=$2, c6_status=$3, status='agendado', updated_at=NOW() WHERE id=$4`,
          [groupId, item.id, item.status, conta.id]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[CONTAS-PAGAR] ATENÇÃO: lote C6 ${groupId} criado no banco mas registro local falhou. Grupo precisa ser cancelado manualmente.`, err.message);
    throw err;
  } finally {
    client.release();
  }

  return { groupId, quantidade: contas.length };
}

async function consultarLoteC6(groupId) {
  const [batch, items] = await Promise.all([
    query('SELECT * FROM payment_batches WHERE c6_group_id = $1', [groupId]),
    c6bank.consultarLote(groupId),
  ]);
  return { batch: batch.rows[0] || null, items };
}

async function removerItemLoteC6(groupId, itemId) {
  await c6bank.removerItemLote(groupId, itemId);
  await query(
    `UPDATE contas_pagar SET c6_group_id=NULL, c6_item_id=NULL, c6_status=NULL, status='pendente', updated_at=NOW()
     WHERE c6_group_id=$1 AND c6_item_id=$2`,
    [groupId, itemId]
  );
  return { removido: true };
}

async function submeterLoteC6(groupId, uploaderName) {
  const existing = await query('SELECT status FROM payment_batches WHERE c6_group_id=$1', [groupId]);
  if (existing.rows[0]?.status === 'submetido') return { submetido: true };
  await c6bank.submeterLote(groupId, uploaderName || 'Admin LKL');
  await query(
    `UPDATE payment_batches SET status='submetido', submetido_em=NOW(), updated_at=NOW() WHERE c6_group_id=$1`,
    [groupId]
  );
  return { submetido: true };
}

// ─── RECONCILIAÇÃO ────────────────────────────────────────────────────────

async function reconciliar() {
  const hoje = format(new Date(), 'yyyy-MM-dd');
  const ha30 = format(subDays(new Date(), 30), 'yyyy-MM-dd');
  const entradas = await c6bank.consultarExtrato(ha30, hoje);

  const saidas = entradas.filter(e =>
    e.operation_type === 'OUTGOING' && e.transaction_type === 'PAYMENT'
  );

  let atualizadas = 0;
  for (const e of saidas) {
    const match = (e.description || e.title || '').match(/CP-(\d+)/);
    if (!match) continue;
    const contaId = parseInt(match[1]);
    const pagoEm = e.entry_date || e.transaction_date || e.date || null;
    const r = await query(
      `UPDATE contas_pagar SET status='pago', pago_em=COALESCE($2::timestamp, NOW()), c6_status='PROCESSED', updated_at=NOW()
       WHERE id=$1 AND status NOT IN ('pago','cancelado') RETURNING id`,
      [contaId, pagoEm]
    );
    if (r.rowCount) atualizadas++;
  }
  return { verificadas: saidas.length, atualizadas };
}

// ─── JOBS (exportados para uso nos cron jobs) ─────────────────────────────

async function marcarVencidas() {
  const r = await query(
    `UPDATE contas_pagar SET status='vencido', updated_at=NOW()
     WHERE status='pendente' AND vencimento < CURRENT_DATE RETURNING id`
  );
  return { atualizadas: r.rowCount };
}

async function contasVencendoEm(dias) {
  const data = format(new Date(Date.now() + dias * 86400000), 'yyyy-MM-dd');
  const r = await query(
    `SELECT * FROM contas_pagar WHERE status IN ('pendente','agendado') AND vencimento = $1`,
    [data]
  );
  return r.rows;
}

async function atualizarStatusLotesSubmetidos() {
  const r = await query(`SELECT c6_group_id FROM payment_batches WHERE status='submetido'`);
  let aprovados = 0;
  for (const batch of r.rows) {
    try {
      const items = await c6bank.consultarLote(batch.c6_group_id);
      const todos = items.length;
      const processados = items.filter(i => i.status === 'PROCESSED').length;
      const erros = items.filter(i => i.status === 'ERROR' || i.status === 'DECODE_ERROR').length;

      let novoStatus = 'submetido';
      if (processados === todos) novoStatus = 'aprovado';
      else if (processados > 0) novoStatus = 'parcial';
      else if (erros === todos) novoStatus = 'erro';

      const extraCol = novoStatus === 'aprovado' ? ', aprovado_em=NOW()' : '';
      await query(
        `UPDATE payment_batches SET status=$1${extraCol}, updated_at=NOW() WHERE c6_group_id=$2`,
        [novoStatus, batch.c6_group_id]
      );

      for (const item of items) {
        if (item.status === 'PROCESSED') {
          await query(
            `UPDATE contas_pagar SET status='pago', c6_status='PROCESSED', pago_em=NOW(), updated_at=NOW()
             WHERE c6_group_id=$1 AND c6_item_id=$2 AND status != 'pago'`,
            [batch.c6_group_id, item.id]
          );
          aprovados++;
        }
      }
    } catch (err) { console.error(`[CONTAS-PAGAR] check_batch_status erro no lote ${batch.c6_group_id}:`, err.message); }
  }
  return { aprovados };
}

async function gerarRecorrentesProximoMes() {
  const r = await query(
    `SELECT DISTINCT ON (descricao, recorrencia_dia) * FROM contas_pagar
     WHERE recorrente=true AND status != 'cancelado'
     ORDER BY descricao, recorrencia_dia, created_at DESC`
  );
  const proximo = new Date();
  proximo.setMonth(proximo.getMonth() + 1);
  let geradas = 0;
  for (const c of r.rows) {
    const venc = new Date(proximo.getFullYear(), proximo.getMonth(), c.recorrencia_dia);
    const existe = await query(
      `SELECT 1 FROM contas_pagar WHERE descricao=$1 AND vencimento=$2 AND recorrente=true`,
      [c.descricao, format(venc, 'yyyy-MM-dd')]
    );
    if (existe.rowCount) continue;
    await query(
      `INSERT INTO contas_pagar (descricao, fornecedor, tipo_despesa, valor, vencimento, tipo,
        linha_digitavel, pix_content, tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',true,$9,$10,$11)`,
      [c.descricao, c.fornecedor, c.tipo_despesa,
       c.recorrencia_valor_fixo ? c.valor : 0,
       format(venc, 'yyyy-MM-dd'), c.tipo,
       c.linha_digitavel, c.pix_content, c.recorrencia_dia, c.recorrencia_valor_fixo, c.observacao]
    );
    geradas++;
  }
  return { geradas };
}

module.exports = {
  listar, buscarPorId, kpis,
  criar, editar, cancelar, pagarManual,
  criarRecorrente,
  sincronizarDDA,
  criarLoteC6, consultarLoteC6, removerItemLoteC6, submeterLoteC6,
  reconciliar,
  marcarVencidas, contasVencendoEm, atualizarStatusLotesSubmetidos, gerarRecorrentesProximoMes,
};
