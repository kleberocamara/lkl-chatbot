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
      `SELECT o.*, c.nome AS cliente_nome, u.name AS vendedor_nome,
              EXISTS(SELECT 1 FROM ordens_servico os WHERE os.orcamento_id = o.id AND os.status = 'entregue') AS tem_os_entregue,
              (SELECT n.status FROM nfe n WHERE n.orcamento_id = o.id AND n.status = 'autorizada' LIMIT 1) AS nfe_status
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

async function cobrar(id, tipo) {
  const c6bank = require('../../services/c6bank');
  const crypto = require('crypto');
  if (!['boleto', 'pix'].includes(tipo)) {
    return { erro: ['tipo deve ser boleto ou pix'] };
  }

  const r = await db.query(
    `SELECT o.id, o.numero, o.status, o.status_pagamento, o.tipo_cobranca,
            COALESCE((SELECT SUM(valor_total) FROM orcamento_itens WHERE orcamento_id = o.id), 0) AS valor_total_calculado,
            c.nome AS cliente_nome, c.cpf_cnpj AS cliente_cpf_cnpj, c.celular AS cliente_celular
     FROM orcamentos o
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE o.id = $1`,
    [id]
  );
  if (!r.rows[0]) return { erro: ['Orçamento não encontrado'] };
  const orc = r.rows[0];

  if (orc.status !== 'aprovado') return { erro: ['Orçamento precisa estar aprovado para gerar cobrança'] };
  if (orc.status_pagamento === 'pago') return { erro: ['Orçamento já está pago'] };
  if (orc.status_pagamento === 'aguardando_pagamento' && orc.tipo_cobranca && orc.tipo_cobranca !== tipo) {
    return { erro: [`Já existe uma cobrança de ${orc.tipo_cobranca} aguardando pagamento. Cancele-a antes de emitir um novo tipo.`] };
  }

  let valor = parseFloat(orc.valor_total_calculado) || 0;
  if (!valor) {
    const itensR = await db.query(
      'SELECT COALESCE(SUM(valor_total), 0) AS total FROM orcamento_itens WHERE orcamento_id = $1',
      [id]
    );
    valor = parseFloat(itensR.rows[0].total) || 0;
  }
  if (!valor || valor <= 0) return { erro: ['Orçamento sem valor definido — precifique antes de cobrar'] };

  const seuNumero = `ORC-${orc.numero}`;
  const nomeSacado = orc.cliente_nome || 'Cliente';
  const cpfCnpj = (orc.cliente_cpf_cnpj || '').replace(/\D/g, '');
  if (!cpfCnpj) return { erro: ['Cliente sem CPF/CNPJ cadastrado — necessário para emitir cobrança'] };

  try {
    if (tipo === 'boleto') {
      const boleto = await c6bank.emitirBoleto({ seuNumero, nomeSacado, cpfCnpjSacado: cpfCnpj, valor });
      await db.query(
        `UPDATE orcamentos SET tipo_cobranca='boleto', status_pagamento='aguardando_pagamento',
         boleto_id=$1, boleto_linha_digitavel=$2, boleto_pdf_url=$3, boleto_vencimento=$4,
         updated_at=NOW() WHERE id=$5`,
        [boleto.boletoId, boleto.linhaDigitavel, boleto.pdfUrl, boleto.dataVencimento, id]
      );
      return { tipo: 'boleto', linhaDigitavel: boleto.linhaDigitavel, pdfUrl: boleto.pdfUrl, dataVencimento: boleto.dataVencimento, valor };
    } else {
      const txid = crypto.randomBytes(16).toString('hex').slice(0, 32);
      const pix = await c6bank.criarPixCobranca({
        txid,
        valor,
        nomeDevedor: nomeSacado,
        cpfCnpjDevedor: cpfCnpj,
        solicitacao: `${seuNumero} - LKL Gráfica`,
      });
      await db.query(
        `UPDATE orcamentos SET tipo_cobranca='pix', status_pagamento='aguardando_pagamento',
         pix_txid=$1, pix_copia_cola=$2, updated_at=NOW() WHERE id=$3`,
        [pix.txid, pix.pixCopiaECola, id]
      );
      return { tipo: 'pix', txid: pix.txid, pixCopiaECola: pix.pixCopiaECola, valor };
    }
  } catch (e) {
    console.error('[C6-COBRAR]', e.message);
    return { erro: [`Erro na API C6 Bank: ${e.message}`] };
  }
}

async function confirmarPagamento({ tipo, txid, boletoId }) {
  let findResult;
  if (tipo === 'pix' && txid) {
    findResult = await db.query('SELECT id FROM orcamentos WHERE pix_txid = $1', [txid]);
  } else if (tipo === 'boleto' && boletoId) {
    findResult = await db.query('SELECT id FROM orcamentos WHERE boleto_id = $1', [boletoId]);
  } else {
    return { erro: ['txid ou boletoId obrigatório'] };
  }

  if (!findResult.rows[0]) return { erro: ['Orçamento não encontrado para este pagamento'] };
  const orcId = findResult.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE orcamentos SET status_pagamento='pago', pago_em=COALESCE(pago_em, NOW()), updated_at=NOW()
       WHERE id=$1 AND status_pagamento != 'pago'`,
      [orcId]
    );
    await client.query(
      `UPDATE ordens_servico SET pago=true, updated_at=NOW() WHERE orcamento_id=$1`,
      [orcId]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return { confirmado: true, orcamento_id: orcId };
}

module.exports = { listar, buscarPorId, criar, precificar, mudarStatus, aprovar, cobrar, confirmarPagamento };
