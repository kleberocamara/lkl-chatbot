const crypto = require('crypto');
const { query, pool } = require('../../db');
const c6bank = require('../../services/c6bank');
const { format, subDays } = require('date-fns');
const fornecedorMatcher = require('./fornecedor-matcher');
const classificador = require('./classificador');

// ─── LEITURA ──────────────────────────────────────────────────────────────

async function listar({ status, tipo_despesa_id, vencimento_de, vencimento_ate, dias } = {}) {
  const conds = [];
  const params = [];

  if (status) { params.push(status); conds.push(`cp.status = $${params.length}`); }
  if (tipo_despesa_id) { params.push(tipo_despesa_id); conds.push(`cp.tipo_despesa_id = $${params.length}`); }
  if (vencimento_de) { params.push(vencimento_de); conds.push(`cp.vencimento >= $${params.length}`); }
  if (vencimento_ate) { params.push(vencimento_ate); conds.push(`cp.vencimento <= $${params.length}`); }
  if (dias !== undefined) {
    const hoje = format(new Date(), 'yyyy-MM-dd');
    const ate = format(new Date(Date.now() + dias * 86400000), 'yyyy-MM-dd');
    params.push(hoje); conds.push(`cp.vencimento >= $${params.length}`);
    params.push(ate);  conds.push(`cp.vencimento <= $${params.length}`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await query(
    `SELECT cp.*, td.nome AS tipo_despesa_nome, td.codigo AS tipo_despesa_codigo
     FROM contas_pagar cp
     LEFT JOIN tipos_despesa td ON td.id = cp.tipo_despesa_id
     ${where} ORDER BY cp.vencimento ASC, cp.id ASC`,
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

async function criar({ descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo, linha_digitavel, pix_content, tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao, competencia }) {
  if (!descricao || !tipo_despesa_id || !valor || !vencimento) {
    return { erro: ['descricao, tipo_despesa_id, valor e vencimento são obrigatórios'] };
  }
  const colunas = ['descricao','fornecedor','fornecedor_id','tipo_despesa_id','valor','vencimento','tipo',
                    'linha_digitavel','pix_content','tipo_entrada','recorrente','recorrencia_dia',
                    'recorrencia_valor_fixo','observacao'];
  const valores = [descricao, fornecedor || null, fornecedor_id || null, tipo_despesa_id, valor, vencimento,
                    tipo || 'outro', linha_digitavel || null, pix_content || null,
                    tipo_entrada || 'manual', recorrente || false, recorrencia_dia || null,
                    recorrencia_valor_fixo !== false, observacao || null];
  if (competencia) { colunas.push('competencia'); valores.push(competencia); }

  const placeholders = valores.map((_, i) => `$${i + 1}`).join(',');
  const r = await query(
    `INSERT INTO contas_pagar (${colunas.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    valores
  );
  if (fornecedor_id) await gravarMemoriaFornecedor(fornecedor_id, tipo_despesa_id);
  return r.rows[0];
}

async function editar(id, campos) {
  const conta = await buscarPorId(id);
  if (!conta) return { erro: ['Conta não encontrada'] };
  if (!['pendente', 'pendente_classificacao'].includes(conta.status)) {
    return { erro: ['Só é possível editar contas com status pendente'] };
  }

  const permitidos = ['descricao','fornecedor','fornecedor_id','tipo_despesa_id','valor','vencimento','tipo',
                      'linha_digitavel','pix_content','recorrente','recorrencia_dia',
                      'recorrencia_valor_fixo','observacao','competencia'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(campos)) {
    if (permitidos.includes(k)) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (!sets.length) return { erro: ['Nenhum campo válido para atualizar'] };
  if (campos.tipo_despesa_id && conta.status === 'pendente_classificacao') {
    sets.push(`status = 'pendente'`);
  }
  params.push(id);
  const r = await query(
    `UPDATE contas_pagar SET ${sets.join(', ')}, updated_at=NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  const atualizada = r.rows[0];
  if (atualizada.fornecedor_id && campos.tipo_despesa_id) {
    await gravarMemoriaFornecedor(atualizada.fornecedor_id, campos.tipo_despesa_id);
  }
  return atualizada;
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

async function criarRecorrente({ descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, tipo, linha_digitavel, pix_content, recorrencia_dia, recorrencia_valor_fixo, observacao }) {
  if (!descricao || !tipo_despesa_id || !valor || !recorrencia_dia) {
    return { erro: ['descricao, tipo_despesa_id, valor e recorrencia_dia são obrigatórios'] };
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
           (descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo, linha_digitavel, pix_content,
            tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',true,$10,$11,$12) RETURNING *`,
        [descricao, fornecedor || null, fornecedor_id || null, tipo_despesa_id, valorInst,
         format(data, 'yyyy-MM-dd'), tipo || 'outro',
         linha_digitavel || null, pix_content || null,
         recorrencia_dia, recorrencia_valor_fixo !== false, observacao || null]
      );
      criadas.push(r.rows[0]);
    }
    await client.query('COMMIT');
    if (fornecedor_id) await gravarMemoriaFornecedor(fornecedor_id, tipo_despesa_id);
    return { criadas };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function criarParcelado({ descricao, fornecedor, fornecedor_id, tipo_despesa_id, competencia, tipo, observacao, parcelas }) {
  if (!descricao || !Array.isArray(parcelas) || parcelas.length < 2) {
    return { erro: ['descricao e parcelas (mínimo 2 itens) são obrigatórios'] };
  }
  for (let i = 0; i < parcelas.length; i++) {
    const p = parcelas[i];
    if (!p.vencimento || !p.valor) {
      return { erro: [`parcela ${i + 1}: vencimento e valor são obrigatórios`] };
    }
  }

  const parcelaGrupoId = crypto.randomUUID();
  const competenciaFinal = competencia || format(new Date(), 'yyyy-MM-dd');

  const statusInicial = tipo_despesa_id ? 'pendente' : 'pendente_classificacao';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const criadas = [];
    for (let i = 0; i < parcelas.length; i++) {
      const p = parcelas[i];
      const r = await client.query(
        `INSERT INTO contas_pagar
           (descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo, linha_digitavel,
            competencia, parcela_grupo_id, parcela_numero, parcela_total, tipo_entrada, status, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual',$13,$14)
         RETURNING *`,
        [`${descricao} (${i + 1}/${parcelas.length})`, fornecedor || null, fornecedor_id || null, tipo_despesa_id || null,
         p.valor, p.vencimento, tipo || 'boleto', p.linha_digitavel || null,
         competenciaFinal, parcelaGrupoId, i + 1, parcelas.length, statusInicial, observacao || null]
      );
      criadas.push(r.rows[0]);
    }
    await client.query('COMMIT');
    if (fornecedor_id) await gravarMemoriaFornecedor(fornecedor_id, tipo_despesa_id);
    return { criadas };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function converterEmParcelado(id, { descricao, fornecedor, fornecedor_id, tipo_despesa_id, competencia, tipo, observacao, parcelas }) {
  const conta = await buscarPorId(id);
  if (!conta) return { erro: ['Conta não encontrada'] };
  if (conta.status === 'pago' || conta.c6_group_id) {
    return { erro: ['Conta já paga ou processada em lote C6 — não é possível parcelar'] };
  }
  if (!Array.isArray(parcelas) || parcelas.length < 2) {
    return { erro: ['parcelas (mínimo 2 itens) são obrigatórias'] };
  }
  for (let i = 0; i < parcelas.length; i++) {
    const p = parcelas[i];
    if (!p.vencimento || !p.valor) {
      return { erro: [`parcela ${i + 1}: vencimento e valor são obrigatórios`] };
    }
  }

  const descricaoFinal = descricao || conta.descricao;
  const fornecedorFinal = fornecedor !== undefined ? fornecedor : conta.fornecedor;
  const fornecedorIdFinal = fornecedor_id !== undefined ? fornecedor_id : conta.fornecedor_id;
  const tipoDespesaIdFinal = tipo_despesa_id || conta.tipo_despesa_id;
  const tipoFinal = tipo || conta.tipo;
  const competenciaFinal = competencia || format(new Date(conta.competencia), 'yyyy-MM-dd');
  const observacaoFinal = observacao !== undefined ? observacao : conta.observacao;
  const parcelaGrupoId = crypto.randomUUID();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM contas_pagar WHERE id = $1', [id]);
    const criadas = [];
    for (let i = 0; i < parcelas.length; i++) {
      const p = parcelas[i];
      const r = await client.query(
        `INSERT INTO contas_pagar
           (descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo, linha_digitavel,
            competencia, parcela_grupo_id, parcela_numero, parcela_total, tipo_entrada, status, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual','pendente',$13)
         RETURNING *`,
        [`${descricaoFinal} (${i + 1}/${parcelas.length})`, fornecedorFinal || null, fornecedorIdFinal || null,
         tipoDespesaIdFinal, p.valor, p.vencimento, tipoFinal || 'boleto', p.linha_digitavel || null,
         competenciaFinal, parcelaGrupoId, i + 1, parcelas.length, observacaoFinal || null]
      );
      criadas.push(r.rows[0]);
    }
    await client.query('COMMIT');
    if (fornecedorIdFinal) await gravarMemoriaFornecedor(fornecedorIdFinal, tipoDespesaIdFinal);
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
      const jaImportado = await query(
        `SELECT id FROM contas_pagar WHERE linha_digitavel = $1 AND status != 'cancelado'`,
        [b.content]
      );
      if (jaImportado.rows.length) { ignorados++; continue; }

      const fornecedor = await fornecedorMatcher.encontrarOuCriarFornecedor({ nome: b.beneficiary_name });
      await criarOuReconciliarContaPagar({
        fornecedorId: fornecedor?.id || null,
        fornecedorNome: fornecedor?.nome || b.beneficiary_name || 'Boleto DDA',
        descricao: fornecedor?.nome || b.beneficiary_name || 'Boleto DDA',
        valor: b.amount,
        vencimento: b.due_date,
        linhaDigitavel: b.content,
        tipo: 'boleto',
        tipoEntrada: 'dda',
      });
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

async function listarLotes() {
  const r = await query(
    `SELECT c6_group_id, uploader_name, status, valor_total, quantidade_itens, submetido_em, created_at
     FROM payment_batches ORDER BY created_at DESC LIMIT 50`
  );
  return r.rows;
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
      `INSERT INTO contas_pagar (descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo,
        linha_digitavel, pix_content, tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',true,$10,$11,$12)`,
      [c.descricao, c.fornecedor, c.fornecedor_id, c.tipo_despesa_id,
       c.recorrencia_valor_fixo ? c.valor : 0,
       format(venc, 'yyyy-MM-dd'), c.tipo,
       c.linha_digitavel, c.pix_content, c.recorrencia_dia, c.recorrencia_valor_fixo, c.observacao]
    );
    geradas++;
  }
  return { geradas };
}

// ─── CLASSIFICAÇÃO E RECONCILIAÇÃO ─────────────────────────────────────────

async function listarTiposDespesa() {
  const r = await query('SELECT id, codigo, nome, categoria_dre, natureza FROM tipos_despesa WHERE ativo = true ORDER BY codigo');
  return r.rows;
}

async function sugerirTipoDespesa({ fornecedor_id, fornecedor, descricao }) {
  return classificador.classificarDespesa({ fornecedorId: fornecedor_id || null, nomeFornecedor: fornecedor, descricao });
}

async function gravarMemoriaFornecedor(fornecedorId, tipoDespesaId) {
  if (!fornecedorId || !tipoDespesaId) return;
  await query('UPDATE fornecedores SET tipo_despesa_padrao_id = $1, updated_at = NOW() WHERE id = $2', [tipoDespesaId, fornecedorId]);
}

// Ponto único de entrada para gravar uma nova dívida a partir de DDA, entrada de estoque
// ou WhatsApp. Evita duplicar a mesma dívida (ex: NF lançada na entrada de estoque +
// boleto do mesmo fornecedor/valor chegando depois via DDA): se achar exatamente uma
// conta pendente do mesmo fornecedor com o mesmo valor (sem linha digitável ainda),
// mescla nela em vez de criar uma nova. Zero ou 2+ candidatas → cria nova (mais seguro
// que arriscar mesclar errado).
async function criarOuReconciliarContaPagar({ fornecedorId, fornecedorNome, valor, vencimento, descricao, tipoDespesaId, tipoEntrada, linhaDigitavel, tipo, competencia }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let match = null;
    if (fornecedorId && valor != null) {
      const params = [fornecedorId, valor];
      let cond = `fornecedor_id = $1 AND valor = $2 AND linha_digitavel IS NULL AND status IN ('pendente','pendente_classificacao')`;
      if (vencimento) {
        params.push(vencimento);
        cond += ` AND vencimento BETWEEN $3::date - INTERVAL '10 days' AND $3::date + INTERVAL '10 days'`;
      }
      // FOR UPDATE trava as linhas candidatas até o commit — evita que duas chamadas
      // concorrentes (ex: entrada de estoque + WhatsApp ao mesmo tempo) dupliquem a
      // mesma dívida por não enxergarem uma à outra antes de decidir criar/mesclar.
      const r = await client.query(`SELECT * FROM contas_pagar WHERE ${cond} FOR UPDATE`, params);
      if (r.rows.length === 1) match = r.rows[0];
    }

    let tipoFinal = tipoDespesaId || null;
    if (!tipoFinal) {
      const sugestao = await classificador.classificarDespesa({ fornecedorId, nomeFornecedor: fornecedorNome, descricao });
      tipoFinal = sugestao.tipo_despesa_id;
    }

    let conta;
    if (match) {
      const sets = ['updated_at = NOW()'];
      const params = [];
      if (linhaDigitavel) { params.push(linhaDigitavel); sets.push(`linha_digitavel = $${params.length}`); }
      if (vencimento)     { params.push(vencimento);     sets.push(`vencimento = $${params.length}`); }
      if (tipo)           { params.push(tipo);           sets.push(`tipo = $${params.length}`); }
      if (competencia)    { params.push(competencia);    sets.push(`competencia = $${params.length}`); }
      if (!match.tipo_despesa_id && tipoFinal) {
        params.push(tipoFinal); sets.push(`tipo_despesa_id = $${params.length}`);
        sets.push(`status = 'pendente'`);
      }
      params.push(match.id);
      const r = await client.query(`UPDATE contas_pagar SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
      conta = r.rows[0];
    } else {
      const status = tipoFinal ? 'pendente' : 'pendente_classificacao';
      const colunas = ['descricao','fornecedor','fornecedor_id','tipo_despesa_id','valor','vencimento','tipo','linha_digitavel','tipo_entrada','status'];
      const valores = [descricao, fornecedorNome || null, fornecedorId || null, tipoFinal, valor,
                        vencimento, tipo || 'boleto', linhaDigitavel || null, tipoEntrada, status];
      if (competencia) { colunas.push('competencia'); valores.push(competencia); }
      const placeholders = valores.map((_, i) => `$${i + 1}`).join(',');
      const r = await client.query(
        `INSERT INTO contas_pagar (${colunas.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        valores
      );
      conta = r.rows[0];
    }
    await client.query('COMMIT');
    return conta;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  listar, buscarPorId, kpis,
  criar, editar, cancelar, pagarManual,
  criarRecorrente, criarParcelado, converterEmParcelado,
  sincronizarDDA,
  listarLotes, criarLoteC6, consultarLoteC6, removerItemLoteC6, submeterLoteC6,
  reconciliar,
  marcarVencidas, contasVencendoEm, atualizarStatusLotesSubmetidos, gerarRecorrentesProximoMes,
  listarTiposDespesa, sugerirTipoDespesa, gravarMemoriaFornecedor, criarOuReconciliarContaPagar,
};
