const db = require('../../db');
const { pool } = require('../../db');

const STATUS_VALIDOS = ['rascunho', 'enviado', 'aprovado', 'cancelado'];

async function buscarPorId(id) {
  const r = await db.query(
    `SELECT o.*,
            c.nome AS cliente_nome,
            u.name AS vendedor_nome
     FROM orcamentos o
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     LEFT JOIN users u ON u.id = o.vendedor_id
     WHERE o.id = $1`,
    [id]
  );
  if (!r.rows[0]) return null;
  const orcamento = r.rows[0];

  const itensR = await db.query(
    'SELECT * FROM orcamento_itens WHERE orcamento_id = $1 ORDER BY codigo',
    [id]
  );
  const osR = await db.query(
    'SELECT * FROM ordens_servico WHERE orcamento_id = $1 ORDER BY numero_os',
    [id]
  );

  return { ...orcamento, itens: itensR.rows, ordens_servico: osR.rows };
}

async function criar({ cliente_id, vendedor_id, condicao_pagamento, validade_dias, prazo_entrega, observacao, itens }) {
  if (!itens || !Array.isArray(itens) || itens.length === 0) {
    return { erro: ['itens deve ser um array não vazio'] };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const oR = await client.query(
      `INSERT INTO orcamentos (cliente_id, vendedor_id, condicao_pagamento, validade_dias, prazo_entrega, observacao, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'rascunho')
       RETURNING *`,
      [cliente_id, vendedor_id, condicao_pagamento || null, validade_dias || null, prazo_entrega || null, observacao || null]
    );
    const orcamento = oR.rows[0];

    const insertedItens = [];
    for (let i = 0; i < itens.length; i++) {
      const item = itens[i];
      const iR = await client.query(
        `INSERT INTO orcamento_itens
           (orcamento_id, codigo, descricao, tipo_insumo, formato_papel, gramatura, cores, impressao, acabamentos, quantidade, valor_unitario, valor_total, tem_arte)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          orcamento.id,
          i + 1,
          item.descricao,
          item.tipo_insumo || null,
          item.formato_papel || null,
          item.gramatura || null,
          item.cores || null,
          item.impressao || null,
          item.acabamentos || null,
          item.quantidade,
          item.valor_unitario || null,
          item.valor_total || null,
          !!item.tem_arte,
        ]
      );
      insertedItens.push(iR.rows[0]);
    }

    await client.query('COMMIT');
    return { orcamento, itens: insertedItens };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function precificar(id, itensPrecos) {
  const existing = await buscarPorId(id);
  if (!existing) return { erro: ['Orçamento não encontrado'] };
  if (existing.status === 'aprovado' || existing.status === 'cancelado') {
    return { erro: ['Não é possível alterar preços de um orçamento aprovado ou cancelado'] };
  }

  for (const ip of itensPrecos) {
    await db.query(
      `UPDATE orcamento_itens SET valor_unitario = $1, valor_total = $2 WHERE id = $3 AND orcamento_id = $4`,
      [ip.valor_unitario, ip.valor_total, ip.id, id]
    );
  }
  return buscarPorId(id);
}

async function mudarStatus(id, novoStatus, extra = {}) {
  if (!STATUS_VALIDOS.includes(novoStatus)) {
    return { erro: [`Status inválido: ${novoStatus}`] };
  }

  const current = await db.query('SELECT status FROM orcamentos WHERE id=$1', [id]);
  if (!current.rows[0]) return { erro: ['Orçamento não encontrado'] };
  const currentStatus = current.rows[0].status;

  const validTransitions = {
    enviado: ['rascunho'],
    cancelado: ['rascunho', 'enviado'],
  };
  if (validTransitions[novoStatus] && !validTransitions[novoStatus].includes(currentStatus)) {
    return { erro: [`Transição inválida: orçamento está '${currentStatus}', não pode ir para '${novoStatus}'`] };
  }

  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [novoStatus];

  if (novoStatus === 'aprovado') {
    updates.push(`aprovado_em = NOW()`);
    if (extra.aprovado_via) {
      params.push(extra.aprovado_via);
      updates.push(`aprovado_via = $${params.length}`);
    }
  }

  params.push(id);
  const r = await db.query(
    `UPDATE orcamentos SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!r.rows[0]) return { erro: ['Orçamento não encontrado'] };
  return { orcamento: r.rows[0] };
}

async function aprovar(id, aprovado_via) {
  const existing = await buscarPorId(id);
  if (!existing) return { erro: ['Orçamento não encontrado'] };
  if (existing.status !== 'enviado') return { erro: ['Orçamento precisa estar com status "enviado" para ser aprovado'] };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updates = ['status = $1', 'updated_at = NOW()', 'aprovado_em = NOW()'];
    const params = ['aprovado'];
    if (aprovado_via) {
      params.push(aprovado_via);
      updates.push(`aprovado_via = $${params.length}`);
    }
    params.push(id);
    const uR = await client.query(
      `UPDATE orcamentos SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    const orcamento = uR.rows[0];

    const ordens = [];
    for (const item of existing.itens) {
      const statusInicial = item.tem_arte ? 'impressao' : 'aguardando';
      const osR = await client.query(
        `INSERT INTO ordens_servico (orcamento_id, orcamento_item_id, status)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [id, item.id, statusInicial]
      );
      ordens.push(osR.rows[0]);
    }

    await client.query('COMMIT');

    if (global.io) {
      global.io.emit('orcamento_aprovado', { orcamento_id: id });
    }

    return { orcamento, ordens_servico: ordens };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listar({ page = 1, limit = 20, status, vendedor_id, cliente_id } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';

  if (status) { params.push(status); where += ` AND o.status = $${params.length}`; }
  if (vendedor_id) { params.push(vendedor_id); where += ` AND o.vendedor_id = $${params.length}`; }
  if (cliente_id) { params.push(cliente_id); where += ` AND o.cliente_id = $${params.length}`; }

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT o.*, c.nome AS cliente_nome, u.name AS vendedor_nome
       FROM orcamentos o
       LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
       LEFT JOIN users u ON u.id = o.vendedor_id
       ${where} ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) FROM orcamentos o ${where}`, params),
  ]);

  return { data: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

module.exports = { criar, precificar, mudarStatus, aprovar, buscarPorId, listar };
