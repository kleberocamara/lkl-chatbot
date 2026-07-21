const db = require('../../db');
const { pool } = require('../../db');
const { verificarSubmissao } = require('./bot-verificacao');

function _statusInicial(alertas) {
  if (alertas.includes('dado_bancario_mudou')) return 'alerta_dado_bancario';
  if (alertas.length) return 'pendente';
  return 'aguardando_entrega';
}

async function criarSubmissao(fornecedorId, dados) {
  const { alertas } = await verificarSubmissao(fornecedorId, dados);
  const status = _statusInicial(alertas);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sub = await client.query(
      `INSERT INTO fornecedor_submissoes
         (fornecedor_id, nnf, emitida_em, data_entrega_agendada, valor_total, arquivo_nf_path,
          tipo_pagamento, pix_chave, ted_banco_nome, ted_banco_codigo, ted_tipo_conta, ted_titularidade,
          ted_documento, ted_agencia, ted_conta, link_mp_url, status, bot_verificacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'${status}',$17)
       RETURNING *`,
      [fornecedorId, dados.nnf || null, dados.emitida_em || null, dados.data_entrega_agendada || null,
       dados.valor_total, dados.arquivo_nf_path || null, dados.tipo_pagamento,
       dados.pix_chave || null, dados.ted_banco_nome || null, dados.ted_banco_codigo || null,
       dados.ted_tipo_conta || null, dados.ted_titularidade || null, dados.ted_documento || null,
       dados.ted_agencia || null, dados.ted_conta || null, dados.link_mp_url || null,
       JSON.stringify({ alertas })]
    );
    const submissao = sub.rows[0];

    for (const it of dados.itens || []) {
      await client.query(
        `INSERT INTO fornecedor_submissao_itens (submissao_id, produto, quantidade, valor_unitario, valor_total)
         VALUES ($1,$2,$3,$4,$5)`,
        [submissao.id, it.produto, it.quantidade, it.valor_unitario, it.valor_total]
      );
    }
    for (const b of dados.boletos || []) {
      await client.query(
        `INSERT INTO fornecedor_submissao_boletos (submissao_id, arquivo_path, linha_digitavel, valor, vencimento)
         VALUES ($1,$2,$3,$4,$5)`,
        [submissao.id, b.arquivo_path, b.linha_digitavel || null, b.valor || null, b.vencimento || null]
      );
    }
    await client.query('COMMIT');
    return { submissao, alertas };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listarMinhasSubmissoes(fornecedorId) {
  const r = await db.query(
    `SELECT * FROM fornecedor_submissoes WHERE fornecedor_id = $1 ORDER BY criada_em DESC`,
    [fornecedorId]
  );
  return r.rows;
}

async function listarFila({ status } = {}) {
  const params = [];
  let where = '';
  if (status) { params.push(status); where = 'WHERE s.status = $1'; }
  const r = await db.query(
    `SELECT s.*, f.nome AS fornecedor_nome
     FROM fornecedor_submissoes s
     JOIN fornecedores f ON f.id = s.fornecedor_id
     ${where}
     ORDER BY s.criada_em DESC`,
    params
  );
  return r.rows;
}

async function buscarSubmissaoDetalhe(id) {
  const sub = await db.query(
    `SELECT s.*, f.nome AS fornecedor_nome FROM fornecedor_submissoes s
     JOIN fornecedores f ON f.id = s.fornecedor_id WHERE s.id = $1`,
    [id]
  );
  if (!sub.rows[0]) return null;
  const itens = await db.query('SELECT * FROM fornecedor_submissao_itens WHERE submissao_id = $1', [id]);
  const boletos = await db.query('SELECT * FROM fornecedor_submissao_boletos WHERE submissao_id = $1', [id]);
  return { ...sub.rows[0], itens: itens.rows, boletos: boletos.rows };
}

async function aprovarDadoBancario(submissaoId, userId) {
  const r = await db.query(
    `UPDATE fornecedor_submissoes SET status = 'aguardando_entrega', revisada_por = $2, revisada_em = NOW()
     WHERE id = $1 AND status = 'alerta_dado_bancario' RETURNING id`,
    [submissaoId, userId]
  );
  if (!r.rows.length) return { erro: ['Submissão não encontrada ou não está aguardando aprovação de dado bancário'] };
  return { ok: true };
}

module.exports = { criarSubmissao, listarMinhasSubmissoes, listarFila, buscarSubmissaoDetalhe, aprovarDadoBancario };
