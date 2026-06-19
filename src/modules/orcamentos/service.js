const db = require('../../db');
const { pool } = require('../../db');
const c6bank = require('../../services/c6bank');
const mercadopago = require('../../services/mercadopago');

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
  const boletosR = await db.query(
    'SELECT * FROM orcamento_boletos WHERE orcamento_id = $1 ORDER BY parcela',
    [id]
  );

  return { ...orcamento, itens: itensR.rows, ordens_servico: osR.rows, boletos_parcelas: boletosR.rows };
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
              (SELECT n.status FROM nfe n WHERE n.orcamento_id = o.id AND n.status = 'autorizada' LIMIT 1) AS nfe_status,
              (SELECT n.id FROM nfe n WHERE n.orcamento_id = o.id AND n.status = 'autorizada' LIMIT 1) AS nfe_id
       FROM orcamentos o
       LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
       LEFT JOIN users u ON u.id = o.vendedor_id
       ${where} ORDER BY o.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) FROM orcamentos o ${where}`, params),
  ]);

  // Inclui parcelas de boleto para cada orçamento
  const ids = rows.rows.map(r => r.id);
  let parcelasMap = {};
  if (ids.length) {
    const bp = await db.query(
      `SELECT * FROM orcamento_boletos WHERE orcamento_id = ANY($1) ORDER BY orcamento_id, parcela`,
      [ids]
    );
    for (const p of bp.rows) {
      if (!parcelasMap[p.orcamento_id]) parcelasMap[p.orcamento_id] = [];
      parcelasMap[p.orcamento_id].push(p);
    }
  }
  const data = rows.rows.map(r => ({ ...r, boletos_parcelas: parcelasMap[r.id] || [] }));

  return { data, total: parseInt(count.rows[0].count), page, limit };
}

async function cobrar(id, tipo, dataVencimento, parcelas = 1, intervaloDias = 30) {
  const crypto = require('crypto');
  if (!['boleto', 'pix', 'link_mp'].includes(tipo)) {
    return { erro: ['tipo deve ser boleto, pix ou link_mp'] };
  }
  parcelas = parseInt(parcelas) || 1;
  intervaloDias = parseInt(intervaloDias) || 30;
  if (parcelas < 1 || parcelas > 24) return { erro: ['Número de parcelas deve ser entre 1 e 24'] };

  const r = await db.query(
    `SELECT o.id, o.numero, o.status, o.status_pagamento, o.tipo_cobranca,
            COALESCE((SELECT SUM(valor_total) FROM orcamento_itens WHERE orcamento_id = o.id), 0) AS valor_total_calculado,
            c.nome AS cliente_nome, c.cpf_cnpj AS cliente_cpf_cnpj, c.celular AS cliente_celular,
            c.email AS cliente_email,
            c.logradouro AS end_logradouro, c.bairro AS end_bairro,
            c.cidade AS end_cidade, c.uf AS end_uf, c.cep AS end_cep
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

  const seuNumero = `ORC${String(orc.numero).padStart(7, '0')}`;
  const nomeSacado = orc.cliente_nome || 'Cliente';
  const cpfCnpj = (orc.cliente_cpf_cnpj || '').replace(/\D/g, '');
  if (!cpfCnpj) return { erro: ['Cliente sem CPF/CNPJ cadastrado — necessário para emitir cobrança'] };

  const endereco = {
    logradouro: orc.end_logradouro,
    bairro: orc.end_bairro,
    cidade: orc.end_cidade,
    uf: orc.end_uf,
    cep: orc.end_cep,
  };

  try {
    if (tipo === 'boleto') {
      // Deletar parcelas anteriores (reemissão)
      await db.query('DELETE FROM orcamento_boletos WHERE orcamento_id = $1', [id]);

      const valorParcela = Math.round((valor / parcelas) * 100) / 100;
      const boletosGerados = [];

      for (let i = 0; i < parcelas; i++) {
        const venc = new Date(dataVencimento + 'T12:00:00');
        venc.setDate(venc.getDate() + i * intervaloDias);
        const vencStr = venc.toISOString().split('T')[0];

        // Última parcela absorve centavos de arredondamento
        const valorEsta = i === parcelas - 1
          ? Math.round((valor - valorParcela * (parcelas - 1)) * 100) / 100
          : valorParcela;

        const numParcela = `${seuNumero}P${i + 1}`;
        const bolepix = await c6bank.emitirBolepix({
          seuNumero: numParcela,
          nomeSacado,
          cpfCnpjSacado: cpfCnpj,
          email: orc.cliente_email || undefined,
          valor: valorEsta,
          dataVencimento: vencStr,
          endereco,
        });

        await db.query(
          `INSERT INTO orcamento_boletos (orcamento_id, parcela, total_parcelas, boleto_id, linha_digitavel, pdf_url, vencimento, valor)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, i + 1, parcelas, bolepix.boletoId, bolepix.linhaDigitavel, bolepix.pdfUrl, vencStr, valorEsta]
        );
        boletosGerados.push({
          parcela: i + 1,
          valor: valorEsta,
          vencimento: vencStr,
          linhaDigitavel: bolepix.linhaDigitavel,
          pdfUrl: bolepix.pdfUrl,
          boletoId: bolepix.boletoId,
        });
      }

      // Atualiza orcamento com dados da 1ª parcela (retrocompatibilidade)
      const p1 = boletosGerados[0];
      await db.query(
        `UPDATE orcamentos SET tipo_cobranca='boleto', status_pagamento='aguardando_pagamento',
         boleto_id=$1, boleto_linha_digitavel=$2, boleto_pdf_url=$3, boleto_vencimento=$4, updated_at=NOW() WHERE id=$5`,
        [p1.boletoId, p1.linhaDigitavel, p1.pdfUrl, p1.vencimento, id]
      );

      return { tipo: 'boleto', parcelas, intervaloDias, boletos: boletosGerados, valor };
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
    } else {
      // link_mp — Mercado Pago checkout
      const pref = await mercadopago.criarPreference({
        titulo: `Orçamento #${orc.numero} — LKL Gráfica`,
        valor,
        orcamentoNumero: orc.numero,
        clienteNome: nomeSacado,
        clienteEmail: orc.cliente_email,
      });
      await db.query(
        `UPDATE orcamentos SET tipo_cobranca='link_mp', status_pagamento='aguardando_pagamento',
         mp_preference_id=$1, mp_checkout_url=$2, updated_at=NOW() WHERE id=$3`,
        [pref.preferenceId, pref.checkoutUrl, id]
      );
      return { tipo: 'link_mp', preferenceId: pref.preferenceId, checkoutUrl: pref.checkoutUrl, valor };
    }
  } catch (e) {
    console.error('[C6-COBRAR]', e.message);
    return { erro: [`Erro na API C6 Bank: ${e.message}`] };
  }
}

async function confirmarPagamento({ tipo, txid, boletoId }) {
  let orcId;

  if (tipo === 'pix' && txid) {
    const r = await db.query('SELECT id FROM orcamentos WHERE pix_txid = $1', [txid]);
    if (!r.rows[0]) return { erro: ['Orçamento não encontrado para este pagamento'] };
    orcId = r.rows[0].id;
  } else if (tipo === 'boleto' && boletoId) {
    // Busca pelo boleto_id na parcela específica ou no campo legado do orçamento
    const rParcela = await db.query(
      `SELECT orcamento_id FROM orcamento_boletos WHERE boleto_id = $1`, [boletoId]
    );
    if (rParcela.rows[0]) {
      orcId = rParcela.rows[0].orcamento_id;
    } else {
      const rOrc = await db.query('SELECT id FROM orcamentos WHERE boleto_id = $1', [boletoId]);
      if (!rOrc.rows[0]) return { erro: ['Orçamento não encontrado para este pagamento'] };
      orcId = rOrc.rows[0].id;
    }
  } else {
    return { erro: ['txid ou boletoId obrigatório'] };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Marca a parcela específica como paga (se existir em orcamento_boletos)
    if (tipo === 'boleto' && boletoId) {
      await client.query(
        `UPDATE orcamento_boletos SET status='pago' WHERE boleto_id=$1 AND status='aguardando'`,
        [boletoId]
      );
    }

    // Para boletos parcelados: só marca orçamento como pago quando todas as parcelas estiverem pagas ou canceladas
    const pendentes = await client.query(
      `SELECT COUNT(*) FROM orcamento_boletos WHERE orcamento_id=$1 AND status='aguardando'`,
      [orcId]
    );
    const totalParcelas = await client.query(
      `SELECT COUNT(*) FROM orcamento_boletos WHERE orcamento_id=$1`,
      [orcId]
    );
    // Se não há parcelas no sistema (legado) ou todas foram resolvidas, marca pago
    if (parseInt(totalParcelas.rows[0].count) === 0 || parseInt(pendentes.rows[0].count) === 0) {
      await client.query(
        `UPDATE orcamentos SET status_pagamento='pago', pago_em=COALESCE(pago_em, NOW()), updated_at=NOW()
         WHERE id=$1 AND status_pagamento != 'pago'`,
        [orcId]
      );
      await client.query(
        `UPDATE ordens_servico SET pago=true, updated_at=NOW() WHERE orcamento_id=$1`,
        [orcId]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return { confirmado: true, orcamento_id: orcId };
}

async function cancelarLinkMp(orcamentoId) {
  const r = await db.query(
    `SELECT id, mp_preference_id, status_pagamento FROM orcamentos WHERE id=$1`, [orcamentoId]
  );
  const orc = r.rows[0];
  if (!orc) return { erro: ['Orçamento não encontrado'] };
  if (!orc.mp_preference_id) return { erro: ['Nenhum link MP registrado neste orçamento'] };
  if (orc.status_pagamento === 'pago') return { erro: ['Pagamento já confirmado, não é possível cancelar'] };
  if (orc.status_pagamento === 'cancelado') return { erro: ['Link MP já foi cancelado'] };

  // Preferências MP expiram automaticamente — apenas limpar localmente
  await db.query(
    `UPDATE orcamentos SET status_pagamento='cancelado',
     mp_preference_id=NULL, mp_checkout_url=NULL, updated_at=NOW() WHERE id=$1`,
    [orcamentoId]
  );
  return { cancelado: true };
}

async function cancelarBoleto(orcamentoId, boletoRowId) {
  const r = await db.query(
    `SELECT * FROM orcamento_boletos WHERE id=$1 AND orcamento_id=$2`,
    [boletoRowId, orcamentoId]
  );
  const boleto = r.rows[0];
  if (!boleto) return { erro: ['Boleto não encontrado'] };
  if (boleto.status === 'cancelado') return { erro: ['Boleto já está cancelado'] };
  if (boleto.status === 'pago') return { erro: ['Boleto já foi pago e não pode ser cancelado'] };

  await c6bank.cancelarBoleto(boleto.boleto_id);
  await db.query(`UPDATE orcamento_boletos SET status='cancelado' WHERE id=$1`, [boletoRowId]);

  const restantes = await db.query(
    `SELECT COUNT(*) FROM orcamento_boletos WHERE orcamento_id=$1 AND status != 'cancelado'`,
    [orcamentoId]
  );
  if (parseInt(restantes.rows[0].count) === 0) {
    await db.query(
      `UPDATE orcamentos SET status_pagamento='cancelado', updated_at=NOW() WHERE id=$1`,
      [orcamentoId]
    );
  }
  return { cancelado: true, boleto_id: boleto.boleto_id };
}

async function cancelarPix(orcamentoId) {
  const r = await db.query(
    `SELECT id, pix_txid, status_pagamento FROM orcamentos WHERE id=$1`, [orcamentoId]
  );
  const orc = r.rows[0];
  if (!orc) return { erro: ['Orçamento não encontrado'] };
  if (!orc.pix_txid) return { erro: ['Nenhuma cobrança PIX registrada neste orçamento'] };
  if (orc.status_pagamento === 'pago') return { erro: ['Pagamento já confirmado, não é possível cancelar'] };
  if (orc.status_pagamento === 'cancelado') return { erro: ['Cobrança PIX já foi cancelada'] };

  await c6bank.cancelarPixCobranca(orc.pix_txid);
  await db.query(
    `UPDATE orcamentos SET status_pagamento='cancelado', pix_txid=NULL, pix_copia_cola=NULL, updated_at=NOW() WHERE id=$1`,
    [orcamentoId]
  );
  return { cancelado: true, txid: orc.pix_txid };
}

// Cancela boleto usando o boleto_id armazenado diretamente no orçamento (fluxo legado ou parcela único)
async function cancelarBoletoDireto(orcamentoId) {
  const r = await db.query(
    `SELECT id, boleto_id, status_pagamento FROM orcamentos WHERE id=$1`,
    [orcamentoId]
  );
  const orc = r.rows[0];
  if (!orc) return { erro: ['Orçamento não encontrado'] };
  if (!orc.boleto_id) return { erro: ['Nenhum boleto registrado neste orçamento'] };
  if (orc.status_pagamento === 'pago') return { erro: ['Pagamento já confirmado, não é possível cancelar'] };
  if (orc.status_pagamento === 'cancelado') return { erro: ['Cobrança já foi cancelada'] };

  try {
    await c6bank.cancelarBoleto(orc.boleto_id);
  } catch (e) {
    // C6 retorna 400 se o boleto já foi cancelado lá — trata como idempotente
    if (!e.message.includes('CANCELLED') && !e.message.includes('400')) throw e;
  }

  await db.query(
    `UPDATE orcamento_boletos SET status='cancelado' WHERE orcamento_id=$1 AND status='aguardando'`,
    [orcamentoId]
  );
  await db.query(
    `UPDATE orcamentos SET status_pagamento='cancelado', updated_at=NOW() WHERE id=$1`,
    [orcamentoId]
  );

  return { cancelado: true, boleto_id: orc.boleto_id };
}

module.exports = { listar, buscarPorId, criar, precificar, mudarStatus, aprovar, cobrar, confirmarPagamento, cancelarBoleto, cancelarBoletoDireto, cancelarPix, cancelarLinkMp };
