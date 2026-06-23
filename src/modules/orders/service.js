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

// Normaliza os itens recebidos: aceita array `itens` ou cai no produto único (legado/chatbot)
function _normalizarItens(dados) {
  let itens = Array.isArray(dados.itens) ? dados.itens : [];
  itens = itens
    .map(it => ({
      produto: (it.produto || '').trim(),
      tipo_producao: it.tipo_producao || null,
      quantidade: parseInt(it.quantidade) || 1,
      especificacao: (it.especificacao || '').trim() || null,
      tem_arte: !!it.tem_arte,
    }))
    .filter(it => it.produto);
  if (!itens.length && dados.produto) {
    itens = [{
      produto: dados.produto,
      tipo_producao: dados.tipo_producao || null,
      quantidade: parseInt(dados.quantidade) || 1,
      especificacao: null,
      tem_arte: dados.tem_arte || false,
    }];
  }
  return itens;
}

async function criarOrder(dados, userId) {
  const erros = [];
  if (!dados.origin_channel || !CANAIS_VALIDOS.includes(dados.origin_channel))
    erros.push(`origin_channel deve ser: ${CANAIS_VALIDOS.join(', ')}`);

  const itens = _normalizarItens(dados);
  if (!itens.length) erros.push('ao menos um item (produto) é obrigatório');
  if (erros.length > 0) return { erro: erros };

  // O pedido guarda o 1º item como resumo (compatível com a listagem atual)
  const principal = itens[0];

  const r = await db.query(
    `INSERT INTO orders
     (origin_channel, cliente_id, vendedor_id, status, produto, tipo_producao, quantidade, material, acabamento,
      tem_arte, prazo, valor_orcamento, observacoes)
     VALUES ($1,$2,$3,'novo',$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [dados.origin_channel, dados.cliente_id || null, dados.vendedor_id || userId || null,
     principal.produto, principal.tipo_producao, principal.quantidade, dados.material || null, dados.acabamento || null,
     principal.tem_arte || false, _parseDate(dados.prazo), dados.valor_orcamento || null,
     dados.observacoes || null]
  );

  const order = r.rows[0];

  // Persiste todos os itens do pedido
  try {
    for (const it of itens) {
      await db.query(
        `INSERT INTO order_items (order_id, produto, quantidade, acabamento, especificacao, valor_unitario, valor_total)
         VALUES ($1,$2,$3,$4,$5,0,0)`,
        [order.id, it.produto, it.quantidade, dados.acabamento || null, it.especificacao]
      );
    }
  } catch (e) {
    console.warn('[ORDER-ITEMS] Falha ao salvar itens do pedido:', e.message);
  }

  // Atualizar celular/email no cadastro do cliente se informados
  if (order.cliente_id && (dados.celular || dados.email)) {
    const sets = [];
    const vals = [];
    if (dados.celular) { vals.push(dados.celular); sets.push(`celular=$${vals.length}`); }
    if (dados.email)   { vals.push(dados.email);   sets.push(`email=$${vals.length}`);   }
    vals.push(order.cliente_id);
    await db.query(`UPDATE clientes_lkl SET ${sets.join(',')} WHERE id=$${vals.length}`, vals);
  }

  // Auto-cria orçamento 'em_orcamento' linkado ao pedido, com todos os itens pré-carregados
  try {
    const orcR = await db.query(
      `INSERT INTO orcamentos (cliente_id, vendedor_id, pedido_id, status, total)
       VALUES ($1, $2, $3, 'em_orcamento', 0) RETURNING id`,
      [order.cliente_id || null, order.vendedor_id || null, order.id]
    );
    const orcamentoId = orcR.rows[0].id;

    let codigo = 1;
    for (const it of itens) {
      const descricao = it.especificacao ? `${it.produto} — ${it.especificacao}` : it.produto;
      await db.query(
        `INSERT INTO orcamento_itens (orcamento_id, codigo, produto, especificacao, descricao, quantidade, valor_unitario, valor_total, tem_arte, tipo_producao)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7, $8)`,
        [orcamentoId, codigo++, it.produto, it.especificacao || null, descricao, it.quantidade, it.tem_arte || false, it.tipo_producao || null]
      );
    }

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
              c.email  AS cliente_email,
              u.name   AS vendedor_nome,
              orc.numero AS orcamento_numero,
              orc.status AS orcamento_status,
              (SELECT COALESCE(SUM(i.valor_total),0) FROM orcamento_itens i WHERE i.orcamento_id = orc.id) AS orcamento_total,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS itens_count
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
              c.email  AS cliente_email,
              u.name   AS vendedor_nome,
              orc.numero AS orcamento_numero,
              orc.status AS orcamento_status,
              (SELECT COALESCE(SUM(i.valor_total),0) FROM orcamento_itens i WHERE i.orcamento_id = orc.id) AS orcamento_total,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS itens_count
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

// Edição do pedido: campos do próprio pedido (observações/prazo) e contato do cliente vinculado (email/celular)
async function atualizarPedido(id, dados) {
  const sets = [], vals = [];
  if (dados.observacoes !== undefined) { vals.push(dados.observacoes || null); sets.push(`observacoes=$${vals.length}`); }
  if (dados.prazo !== undefined) { vals.push(_parseDate(dados.prazo)); sets.push(`prazo=$${vals.length}`); }

  let order;
  if (sets.length) {
    vals.push(id);
    const r = await db.query(
      `UPDATE orders SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
    if (!r.rows[0]) return { erro: ['Pedido não encontrado'] };
    order = r.rows[0];
  } else {
    const r = await db.query('SELECT * FROM orders WHERE id=$1', [id]);
    if (!r.rows[0]) return { erro: ['Pedido não encontrado'] };
    order = r.rows[0];
  }

  // Atualiza contato do cliente vinculado
  if (order.cliente_id && (dados.email !== undefined || dados.celular !== undefined)) {
    const cs = [], cv = [];
    if (dados.email   !== undefined) { cv.push(dados.email   || null); cs.push(`email=$${cv.length}`); }
    if (dados.celular !== undefined) { cv.push(dados.celular || null); cs.push(`celular=$${cv.length}`); }
    cv.push(order.cliente_id);
    await db.query(`UPDATE clientes_lkl SET ${cs.join(', ')} WHERE id=$${cv.length}`, cv);
  }

  if (global.io) global.io.emit('order_status_update', { orderId: id, status: order.status });
  return { order };
}

module.exports = { criarOrder, buscarPorId, atualizarStatus, atualizarPedido, vincularOrcamento, listar, STATUS_VALIDOS, STATUS_VENDEDOR };
