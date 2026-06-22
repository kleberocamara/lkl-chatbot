const db = require('../../db');
const fcm = require('../../services/fcm');

// Aceita data ISO ou texto livre — retorna null se não for data válida
function _parseDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const CANAIS_VALIDOS = ['whatsapp', 'balcao', 'telefone', 'site', 'vendedor', 'chatbot'];

const STATUS_VALIDOS = [
  'novo', 'em_orcamento', 'aguardando_aprovacao', 'aprovado',
  'em_producao', 'concluido', 'entregue',
  'aguardando_pagamento', 'pago',
  'reprovado', 'cancelado',
];

// Status que vendedor pode ver na PWA
const STATUS_VENDEDOR = ['novo', 'em_producao', 'entregue'];

const FCM_LABELS = {
  em_producao:      'Em produção 🖨️',
  concluido:        'Concluído ✅',
  entregue:         'Entregue 🎉',
  cancelado:        'Cancelado ❌',
  aprovado:         'Orçamento aprovado 👍',
  reprovado:        'Orçamento reprovado ⚠️',
  aguardando_pagamento: 'Aguardando pagamento 💰',
  pago:             'Pagamento confirmado ✅',
};

async function criarOrder(dados, userId) {
  const erros = [];
  if (!dados.origin_channel || !CANAIS_VALIDOS.includes(dados.origin_channel))
    erros.push(`origin_channel deve ser: ${CANAIS_VALIDOS.join(', ')}`);
  if (!dados.produto) erros.push('produto é obrigatório');
  if (erros.length > 0) return { erro: erros };

  const r = await db.query(
    `INSERT INTO orders
     (origin_channel, cliente_id, vendedor_id, status, produto, tipo_producao, quantidade, material, acabamento,
      tem_arte, prazo, valor_orcamento, observacoes)
     VALUES ($1,$2,$3,'novo',$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [dados.origin_channel, dados.cliente_id || null, dados.vendedor_id || userId || null,
     dados.produto, dados.tipo_producao || null, dados.quantidade || null, dados.material || null, dados.acabamento || null,
     dados.tem_arte || false, _parseDate(dados.prazo), dados.valor_orcamento || null,
     dados.observacoes || null]
  );

  const order = r.rows[0];

  // Atualizar celular/email no cadastro do cliente se informados
  if (order.cliente_id && (dados.celular || dados.email)) {
    const sets = [];
    const vals = [];
    if (dados.celular) { vals.push(dados.celular); sets.push(`celular=$${vals.length}`); }
    if (dados.email)   { vals.push(dados.email);   sets.push(`email=$${vals.length}`);   }
    vals.push(order.cliente_id);
    await db.query(`UPDATE clientes_lkl SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
  }

  // Auto-cria orçamento 'em_orcamento' linkado ao pedido, com o produto pré-carregado
  try {
    const orcR = await db.query(
      `INSERT INTO orcamentos (cliente_id, vendedor_id, pedido_id, status, total)
       VALUES ($1, $2, $3, 'em_orcamento', 0) RETURNING id`,
      [order.cliente_id || null, order.vendedor_id || null, order.id]
    );
    const orcamentoId = orcR.rows[0].id;

    await db.query(
      `INSERT INTO orcamento_itens (orcamento_id, codigo, descricao, quantidade, valor_unitario, valor_total, tem_arte)
       VALUES ($1, 1, $2, $3, 0, 0, $4)`,
      [orcamentoId, order.produto, order.quantidade || 1, order.tem_arte || false]
    );

    await db.query(
      `UPDATE orders SET orcamento_id=$1, status='em_orcamento', updated_at=NOW() WHERE id=$2`,
      [orcamentoId, order.id]
    );
    order.orcamento_id = orcamentoId;
    order.status = 'em_orcamento';
  } catch (e) {
    console.warn('[ORDER->ORC] Falha ao auto-criar orçamento:', e.message);
  }

  if (global.io) global.io.emit('new_order', { orderId: order.id });
  return { order };
}

async function buscarPorId(id) {
  const [order, items] = await Promise.all([
    db.query(
      `SELECT o.*,
              c.nome   AS cliente_nome,
              c.celular AS cliente_celular,
              u.name   AS vendedor_nome,
              orc.numero AS orcamento_numero,
              orc.status AS orcamento_status,
              (SELECT COALESCE(SUM(i.valor_total),0) FROM orcamento_itens i WHERE i.orcamento_id = orc.id) AS orcamento_total
       FROM orders o
       LEFT JOIN clientes_lkl c  ON c.id  = o.cliente_id
       LEFT JOIN users u          ON u.id  = o.vendedor_id
       LEFT JOIN orcamentos orc   ON orc.id = o.orcamento_id
       WHERE o.id = $1`,
      [id]
    ),
    db.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at', [id]),
  ]);
  if (!order.rows[0]) return null;
  return { ...order.rows[0], itens: items.rows };
}

async function atualizarStatus(id, novoStatus) {
  if (!STATUS_VALIDOS.includes(novoStatus))
    return { erro: [`Status inválido. Válidos: ${STATUS_VALIDOS.join(', ')}`] };

  const r = await db.query(
    `UPDATE orders SET status=$1, updated_at=NOW()
     WHERE id=$2 RETURNING id, numero_os, status, vendedor_id, produto`,
    [novoStatus, id]
  );
  if (!r.rows[0]) return { erro: ['Pedido não encontrado'] };
  const updated = r.rows[0];

  if (global.io) global.io.emit('order_status_update', { orderId: id, status: novoStatus });

  const label = FCM_LABELS[novoStatus];
  if (label && updated.vendedor_id) {
    fcm.sendToUser(updated.vendedor_id, {
      title: `Pedido #${updated.numero_os} — ${label}`,
      body: updated.produto ? `Produto: ${updated.produto}` : 'Pedido atualizado',
      data: { order_id: updated.id, status: novoStatus },
    }).catch(() => {});
  }

  return { order: updated };
}

// Vincula orçamento ao pedido e atualiza status
async function vincularOrcamento(pedidoId, orcamentoId) {
  const r = await db.query(
    `UPDATE orders SET orcamento_id=$1, status='em_orcamento', updated_at=NOW()
     WHERE id=$2 AND orcamento_id IS NULL RETURNING id`,
    [orcamentoId, pedidoId]
  );
  return r.rowCount > 0;
}

async function listar({ page = 1, limit = 50, status, cliente_id, origin_channel, vendedorId, busca } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';

  if (status) {
    const statusList = status.split(',').map(s => s.trim()).filter(s => STATUS_VALIDOS.includes(s));
    if (statusList.length === 1) { params.push(statusList[0]); where += ` AND o.status = $${params.length}`; }
    else if (statusList.length > 1) { params.push(statusList); where += ` AND o.status = ANY($${params.length})`; }
  }
  if (cliente_id) { params.push(cliente_id); where += ` AND o.cliente_id = $${params.length}`; }
  if (origin_channel) { params.push(origin_channel); where += ` AND o.origin_channel = $${params.length}`; }
  if (vendedorId) { params.push(vendedorId); where += ` AND o.vendedor_id = $${params.length}`; }
  if (busca) {
    params.push(`%${busca}%`);
    where += ` AND (c.nome ILIKE $${params.length} OR o.produto ILIKE $${params.length} OR CAST(o.numero_os AS TEXT) ILIKE $${params.length})`;
  }

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT o.*,
              c.nome   AS cliente_nome,
              c.celular AS cliente_celular,
              u.name   AS vendedor_nome,
              orc.numero AS orcamento_numero,
              orc.status AS orcamento_status,
              (SELECT COALESCE(SUM(i.valor_total),0) FROM orcamento_itens i WHERE i.orcamento_id = orc.id) AS orcamento_total
       FROM orders o
       LEFT JOIN clientes_lkl c  ON c.id  = o.cliente_id
       LEFT JOIN users u          ON u.id  = o.vendedor_id
       LEFT JOIN orcamentos orc   ON orc.id = o.orcamento_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    ),
    db.query(
      `SELECT COUNT(*) FROM orders o
       LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
       ${where}`,
      params
    ),
  ]);

  return { orders: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

module.exports = { criarOrder, buscarPorId, atualizarStatus, vincularOrcamento, listar, STATUS_VALIDOS, STATUS_VENDEDOR };
