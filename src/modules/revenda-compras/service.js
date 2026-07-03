const db = require('../../db');

// Itens elegíveis a comprar: revenda_matriz (tipo_producao='REVENDA'), orçamento aprovado,
// arte aprovada, e ainda não vinculados a nenhuma compra.
async function itensACompra() {
  const r = await db.query(
    `SELECT oi.id, oi.descricao, oi.quantidade, oi.arte_arquivo_url, oi.revenda_prazo_horas,
            orc.id AS orcamento_id, orc.numero AS numero_orcamento,
            cl.id AS cliente_id, cl.nome AS cliente_nome,
            rp.ref, rp.nome AS produto_revenda
     FROM orcamento_itens oi
     JOIN orcamentos orc ON orc.id = oi.orcamento_id
     LEFT JOIN clientes_lkl cl ON cl.id = orc.cliente_id
     LEFT JOIN revenda_produtos rp ON rp.id = oi.revenda_produto_id
     WHERE orc.status = 'aprovado'
       AND oi.tipo_producao = 'REVENDA'
       AND oi.arte_status = 'aprovada'
       AND NOT EXISTS (SELECT 1 FROM revenda_compra_itens rci WHERE rci.orcamento_item_id = oi.id)
     ORDER BY cl.nome, orc.numero, oi.codigo`
  );
  return r.rows;
}

// Valida os dados da conta a pagar informados pelo operador (função pura, testável sem banco).
function validarDadosConta({ valor_compra, vencimento }) {
  const erros = [];
  const v = Number(valor_compra);
  if (!Number.isFinite(v) || v <= 0) erros.push('Informe o valor da compra (maior que zero)');
  if (!vencimento) erros.push('Informe o vencimento da conta a pagar');
  return erros;
}

async function criarCompra({ item_ids, pedido_graficonauta, previsao_entrega, observacao }, userId) {
  if (!Array.isArray(item_ids) || !item_ids.length) return { erro: ['Selecione ao menos um item'] };
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const val = await client.query(
      `SELECT oi.id, orc.cliente_id
       FROM orcamento_itens oi JOIN orcamentos orc ON orc.id = oi.orcamento_id
       WHERE oi.id = ANY($1) AND orc.status='aprovado' AND oi.tipo_producao='REVENDA' AND oi.arte_status='aprovada'
         AND NOT EXISTS (SELECT 1 FROM revenda_compra_itens rci WHERE rci.orcamento_item_id = oi.id)`,
      [item_ids]
    );
    if (val.rows.length !== item_ids.length) {
      await client.query('ROLLBACK');
      return { erro: ['Um ou mais itens não são elegíveis (não são revenda aprovada com arte, ou já estão em outra compra)'] };
    }
    const clienteId = val.rows[0].cliente_id || null;
    const compraR = await client.query(
      `INSERT INTO revenda_compras (status, pedido_graficonauta, cliente_id, previsao_entrega, observacao, responsavel_id)
       VALUES ('pedido_feito', $1, $2, $3, $4, $5) RETURNING id, numero`,
      [pedido_graficonauta || null, clienteId, previsao_entrega || null, observacao || null, userId || null]
    );
    const compraId = compraR.rows[0].id;
    for (const it of val.rows) {
      await client.query('INSERT INTO revenda_compra_itens (compra_id, orcamento_item_id) VALUES ($1,$2)', [compraId, it.id]);
    }
    await client.query('COMMIT');
    return { item: { id: compraId, numero: compraR.rows[0].numero } };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Marca recebido e gera a OS de entrega (reusa o board do motorista).
async function receber(compraId, userId) {
  const compra = (await db.query('SELECT id, status, cliente_id FROM revenda_compras WHERE id=$1', [compraId])).rows[0];
  if (!compra) return { erro: ['Compra não encontrada'] };
  if (compra.status === 'recebido') return { erro: ['Compra já recebida'] };

  const itens = (await db.query(
    `SELECT rci.orcamento_item_id, oi.quantidade
     FROM revenda_compra_itens rci JOIN orcamento_itens oi ON oi.id = rci.orcamento_item_id
     WHERE rci.compra_id = $1`, [compraId]
  )).rows;
  const qtdTotal = itens.reduce((s, i) => s + (parseInt(i.quantidade) || 0), 0);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const osR = await client.query(
      `INSERT INTO ordens_servico (status, tipo_servico, cliente_id, quantidade)
       VALUES ('entrega', 'revenda', $1, $2) RETURNING id, numero_os`,
      [compra.cliente_id, qtdTotal]
    );
    const osId = osR.rows[0].id;
    for (const it of itens) {
      await client.query('INSERT INTO os_itens (os_id, orcamento_item_id) VALUES ($1,$2)', [osId, it.orcamento_item_id]);
    }
    await client.query('INSERT INTO os_historico (os_id, de_status, para_status, usuario_id) VALUES ($1,$2,$3,$4)', [osId, null, 'entrega', userId || null]);
    await client.query('UPDATE revenda_compras SET status=$2, recebido_em=NOW(), os_entrega_id=$3 WHERE id=$1', [compraId, 'recebido', osId]);
    await client.query('COMMIT');
    if (global.io) global.io.emit('nova_os', { os_id: osId });
    return { item: { compra_id: compraId, os_id: osId, numero_os: osR.rows[0].numero_os } };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listar({ status } = {}) {
  const params = []; let where = '';
  if (status) { params.push(status); where = 'WHERE c.status = $1'; }
  const compras = (await db.query(
    `SELECT c.*, cl.nome AS cliente_nome,
            (SELECT count(*) FROM revenda_compra_itens rci WHERE rci.compra_id = c.id) AS num_itens
     FROM revenda_compras c LEFT JOIN clientes_lkl cl ON cl.id = c.cliente_id
     ${where} ORDER BY c.created_at DESC`, params
  )).rows;
  return compras;
}

async function detalhe(id) {
  const compra = (await db.query('SELECT * FROM revenda_compras WHERE id=$1', [id])).rows[0];
  if (!compra) return null;
  compra.itens = (await db.query(
    `SELECT oi.id, oi.descricao, oi.quantidade, oi.arte_arquivo_url, rp.ref, rp.nome AS produto_revenda,
            orc.numero AS numero_orcamento
     FROM revenda_compra_itens rci
     JOIN orcamento_itens oi ON oi.id = rci.orcamento_item_id
     JOIN orcamentos orc ON orc.id = oi.orcamento_id
     LEFT JOIN revenda_produtos rp ON rp.id = oi.revenda_produto_id
     WHERE rci.compra_id = $1 ORDER BY oi.codigo`, [id]
  )).rows;
  return compra;
}

module.exports = { itensACompra, criarCompra, receber, listar, detalhe, validarDadosConta };
