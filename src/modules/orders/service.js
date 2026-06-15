const db = require('../../db');
const priceService = require('../price-table/service');

const CANAIS_VALIDOS = ['whatsapp', 'balcao', 'telefone', 'site', 'vendedor'];
const STATUS_VALIDOS = [
  'criada', 'gerando_arquivo_impressao', 'arte_enviada_cliente',
  'arte_aprovada_cliente', 'arte_reprovada_cliente',
  'em_producao', 'concluido', 'entregue', 'cancelado',
];

async function criarOrder(dados, userId) {
  const erros = [];
  if (!dados.origin_channel || !CANAIS_VALIDOS.includes(dados.origin_channel))
    erros.push(`origin_channel deve ser: ${CANAIS_VALIDOS.join(', ')}`);
  if (!dados.produto) erros.push('produto é obrigatório');
  if (!dados.quantidade || dados.quantidade < 1) erros.push('quantidade deve ser maior que zero');
  if (!dados.cliente_id) erros.push('cliente_id é obrigatório');
  if (erros.length > 0) return { erro: erros };

  let valor_orcamento = dados.valor_orcamento || null;
  if (!valor_orcamento && dados.produto && dados.quantidade) {
    const preco = await priceService.calcularPreco(dados.produto, dados.acabamento, dados.quantidade);
    if (preco) valor_orcamento = preco.valor_total;
  }

  const r = await db.query(
    `INSERT INTO orders
     (origin_channel, cliente_id, vendedor_id, status, produto, quantidade, material, acabamento,
      tem_arte, prazo, valor_orcamento, observacoes)
     VALUES ($1,$2,$3,'criada',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [dados.origin_channel, dados.cliente_id, dados.vendedor_id || userId || null,
     dados.produto, dados.quantidade, dados.material || null, dados.acabamento || null,
     dados.tem_arte || false, dados.prazo || null, valor_orcamento,
     dados.observacoes || null]
  );

  if (dados.itens && dados.itens.length > 0) {
    for (const item of dados.itens) {
      await db.query(
        `INSERT INTO order_items (order_id, produto, quantidade, acabamento, valor_unitario, valor_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [r.rows[0].id, item.produto, item.quantidade, item.acabamento || null,
         item.valor_unitario, item.valor_total]
      );
    }
  }

  if (global.io) global.io.emit('new_order', { orderId: r.rows[0].id, numeroOs: r.rows[0].numero_os });
  return { order: r.rows[0] };
}

async function buscarPorId(id) {
  const [order, items] = await Promise.all([
    db.query(
      `SELECT o.*, c.nome as cliente_nome, c.celular as cliente_celular, u.name as vendedor_nome
       FROM orders o
       LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
       LEFT JOIN users u ON u.id = o.vendedor_id
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
    'UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
    [novoStatus, id]
  );
  if (!r.rows[0]) return { erro: ['OS não encontrada'] };
  if (global.io) global.io.emit('order_status_update', { orderId: id, status: novoStatus });
  return { order: r.rows[0] };
}

async function listar({ page = 1, limit = 20, status, cliente_id, origin_channel } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND o.status = $${params.length}`; }
  if (cliente_id) { params.push(cliente_id); where += ` AND o.cliente_id = $${params.length}`; }
  if (origin_channel) { params.push(origin_channel); where += ` AND o.origin_channel = $${params.length}`; }
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT o.*, c.nome as cliente_nome FROM orders o
       LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
       ${where} ORDER BY o.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) FROM orders o ${where}`, params),
  ]);
  return { orders: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

module.exports = { criarOrder, buscarPorId, atualizarStatus, listar };
