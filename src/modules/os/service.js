const db = require('../../db');
const fcm = require('../../services/fcm');

const STATUS_VALIDOS = ['aguardando', 'arte_final', 'impressao', 'acabamento', 'embalagem', 'pronto', 'entregue', 'cancelado'];

async function listar({ page = 1, limit = 20, status, orcamento_id } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';

  if (status) { params.push(status); where += ` AND os.status = $${params.length}`; }
  if (orcamento_id) { params.push(orcamento_id); where += ` AND os.orcamento_id = $${params.length}`; }

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT os.id, os.numero_os, os.status, os.data_inicio, os.data_conclusao, os.created_at, os.updated_at,
              oi.descricao AS item_descricao, oi.quantidade,
              o.numero AS numero_orcamento,
              c.nome AS cliente_nome,
              u.name AS responsavel_nome
       FROM ordens_servico os
       LEFT JOIN orcamento_itens oi ON oi.id = os.orcamento_item_id
       LEFT JOIN orcamentos o ON o.id = os.orcamento_id
       LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
       LEFT JOIN users u ON u.id = os.responsavel_id
       ${where} ORDER BY os.numero_os DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) FROM ordens_servico os ${where}`, params),
  ]);

  return { data: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

async function buscarPorId(id) {
  const r = await db.query(
    `SELECT os.*,
            oi.descricao, oi.quantidade, oi.cores, oi.impressao,
            oi.acabamentos, oi.tipo_insumo, oi.formato_papel, oi.gramatura,
            o.numero AS numero_orcamento,
            c.nome AS cliente_nome,
            u.name AS responsavel_nome
     FROM ordens_servico os
     LEFT JOIN orcamento_itens oi ON oi.id = os.orcamento_item_id
     LEFT JOIN orcamentos o ON o.id = os.orcamento_id
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     LEFT JOIN users u ON u.id = os.responsavel_id
     WHERE os.id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

async function atualizarStatus(id, novoStatus, responsavel_id) {
  if (!STATUS_VALIDOS.includes(novoStatus)) {
    return { erro: [`Status inválido: ${novoStatus}. Valores válidos: ${STATUS_VALIDOS.join(', ')}`] };
  }

  const existing = await db.query('SELECT * FROM ordens_servico WHERE id=$1', [id]);
  if (!existing.rows[0]) return { erro: ['OS não encontrada'] };
  const os = existing.rows[0];

  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [novoStatus];

  if (novoStatus === 'arte_final' || novoStatus === 'impressao') {
    updates.push('data_inicio = COALESCE(data_inicio, NOW())');
  }
  if (novoStatus === 'entregue') {
    updates.push('data_conclusao = NOW()');
  }
  if (responsavel_id) {
    params.push(responsavel_id);
    updates.push(`responsavel_id = $${params.length}`);
  }

  params.push(id);
  const r = await db.query(
    `UPDATE ordens_servico SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  const updatedOs = r.rows[0];

  // If entregue, check if all OSs for this orcamento are done
  if (novoStatus === 'entregue') {
    const pendingR = await db.query(
      `SELECT COUNT(*) FROM ordens_servico WHERE orcamento_id=$1 AND status NOT IN ('entregue','cancelado')`,
      [os.orcamento_id]
    );
    if (parseInt(pendingR.rows[0].count) === 0 && global.io) {
      global.io.emit('servico_concluido', { orcamento_id: os.orcamento_id });
    }
  }

  // Send FCM push to vendedor
  const labels = {
    impressao: 'Em impressão 🖨️',
    acabamento: 'Em acabamento ✂️',
    embalagem: 'Em embalagem 📦',
    pronto: 'Pronto ✅',
    entregue: 'Entregue 🎉',
  };
  const label = labels[novoStatus];
  if (label) {
    const orcR = await db.query('SELECT vendedor_id, numero FROM orcamentos WHERE id=$1', [os.orcamento_id]);
    if (orcR.rows[0]) {
      const { vendedor_id, numero } = orcR.rows[0];
      fcm.sendToUser(vendedor_id, {
        title: `ORC #${numero} — ${label}`,
        body: `OS #${updatedOs.numero_os} atualizada`,
        data: { os_id: id, orcamento_id: os.orcamento_id, status: novoStatus },
      }).catch(() => {});
    }
  }

  return { os: updatedOs };
}

module.exports = { listar, buscarPorId, atualizarStatus };
