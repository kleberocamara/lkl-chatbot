const db = require('../../db');
const { pool } = require('../../db');
const c6bank = require('../../services/c6bank');
const mercadopago = require('../../services/mercadopago');
const { enviarOrcamentoCliente } = require('../../services/email');
const whatsapp = require('../../services/whatsapp');
const conversas = require('../../services/conversas');
const fcm = require('../../services/fcm');
const { gerarOrcamentoPDF } = require('../../services/pdf');
const osService = require('../os/service');

// Sync de status do pedido vinculado — fire-and-forget
async function _syncPedidoStatus(orcamentoId, novoStatus) {
  try {
    const MAP = {
      enviado:   'aguardando_aprovacao',
      aprovado:  'aprovado',
      reprovado: 'reprovado',
      cancelado: 'cancelado',
    };
    const pedidoStatus = MAP[novoStatus];
    if (!pedidoStatus) return;
    await db.query(
      `UPDATE orders SET status=$1, updated_at=NOW()
       WHERE orcamento_id=(SELECT id FROM orcamentos WHERE id=$2)
         AND status NOT IN ('pago','entregue','cancelado')`,
      [pedidoStatus, orcamentoId]
    );
  } catch (e) {
    console.warn('[ORC-SYNC]', e.message);
  }
}

// Notifica o vendedor responsável quando o cliente responde ao orçamento — PWA (FCM) + WhatsApp
async function _notifyVendedorResposta(orcamentoId, novoStatus) {
  if (novoStatus !== 'aprovado' && novoStatus !== 'reprovado') return;
  try {
    const r = await db.query(
      `SELECT o.numero, o.vendedor_id, c.nome AS cliente_nome, u.celular AS vendedor_celular
       FROM orcamentos o
       LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
       LEFT JOIN users u ON u.id = o.vendedor_id
       WHERE o.id = $1`,
      [orcamentoId]
    );
    const orc = r.rows[0];
    if (!orc || !orc.vendedor_id) return;
    const aprovado = novoStatus === 'aprovado';
    const titulo = aprovado
      ? `Orçamento #${orc.numero} aprovado 👍`
      : `Orçamento #${orc.numero} reprovado 👎`;
    const corpo = `${orc.cliente_nome || 'Cliente'} ${aprovado ? 'aprovou' : 'reprovou'} o orçamento.`;

    // PWA (push)
    fcm.sendToUser(orc.vendedor_id, {
      title: titulo,
      body: corpo,
      data: { orcamento_id: String(orcamentoId), status: novoStatus },
    }).catch(e => console.warn('[ORC-VENDEDOR-FCM]', e.message));

    // WhatsApp
    if (orc.vendedor_celular) {
      const emoji = aprovado ? '✅' : '❌';
      whatsapp.sendMessage(orc.vendedor_celular, `${emoji} *${titulo}*\n${corpo}`)
        .catch(e => console.warn('[ORC-VENDEDOR-WA]', e.message));
    }
  } catch (e) {
    console.warn('[ORC-VENDEDOR-NOTIFY]', e.message);
  }
}

// Status do fluxo novo
const STATUS_VALIDOS = [
  'rascunho', 'aprovado_interno',          // legado congelado
  'em_orcamento', 'em_revisao', 'concluido',
  'enviado', 'aprovado', 'reprovado', 'cancelado',
];

const TRANSICOES_VALIDAS = {
  em_revisao:  ['em_orcamento'],
  concluido:   ['em_orcamento', 'em_revisao'],
  enviado:     ['concluido'],
  aprovado:    ['enviado'],
  reprovado:   ['enviado'],
  cancelado:   ['em_orcamento', 'em_revisao', 'concluido', 'enviado'],
};

async function buscarPorId(id) {
  const r = await db.query(
    `SELECT o.*,
            c.nome    AS cliente_nome,
            c.celular AS cliente_celular,
            c.email   AS cliente_email,
            c.cpf_cnpj AS cpf_cnpj,
            u.name    AS vendedor_nome,
            (SELECT numero_os FROM orders WHERE orcamento_id = o.id ORDER BY created_at LIMIT 1) AS pedido_numero
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

async function criar({ cliente_id, vendedor_id, pedido_id, condicao_pagamento, validade_dias, prazo_entrega, observacao, itens }) {
  if (!itens || !Array.isArray(itens) || itens.length === 0) {
    return { erro: ['itens deve ser um array não vazio'] };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const oR = await client.query(
      `INSERT INTO orcamentos (cliente_id, vendedor_id, pedido_id, condicao_pagamento, validade_dias, prazo_entrega, observacao, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'em_orcamento')
       RETURNING *`,
      [cliente_id, vendedor_id, pedido_id || null, condicao_pagamento || null, validade_dias || null, prazo_entrega || null, observacao || null]
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

    // Vincula o pedido ao orçamento recém-criado
    if (pedido_id) {
      await client.query(
        `UPDATE orders SET orcamento_id=$1, status='em_orcamento', updated_at=NOW()
         WHERE id=$2 AND orcamento_id IS NULL`,
        [orcamento.id, pedido_id]
      );
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

  const permitidos = TRANSICOES_VALIDAS[novoStatus];
  if (permitidos && !permitidos.includes(currentStatus)) {
    return { erro: [`Transição inválida: orçamento está '${currentStatus}', não pode ir para '${novoStatus}'`] };
  }

  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [novoStatus];

  if (novoStatus === 'aprovado') {
    updates.push('aprovado_em = NOW()');
    if (extra.aprovado_via) { params.push(extra.aprovado_via); updates.push(`aprovado_via = $${params.length}`); }
  }
  if (novoStatus === 'reprovado') {
    updates.push('reprovado_em = NOW()');
    if (extra.reprovado_via) { params.push(extra.reprovado_via); updates.push(`reprovado_via = $${params.length}`); }
  }
  if (novoStatus === 'enviado') {
    updates.push('enviado_em = NOW()');
  }

  params.push(id);
  const r = await db.query(
    `UPDATE orcamentos SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!r.rows[0]) return { erro: ['Orçamento não encontrado'] };

  _syncPedidoStatus(id, novoStatus);
  _notifyVendedorResposta(id, novoStatus);

  return { orcamento: r.rows[0] };
}

// Marca como concluído e dispara envio imediato ao cliente (WA + e-mail)
async function concluir(id, userId) {
  const orc = await buscarPorId(id);
  if (!orc) return { erro: ['Orçamento não encontrado'] };

  const permitidos = TRANSICOES_VALIDAS['concluido'];
  if (!permitidos.includes(orc.status)) {
    return { erro: [`Orçamento está '${orc.status}', não pode ser concluído agora`] };
  }

  // Marca concluido e já atualiza para enviado em uma transação
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Recalcula o total a partir dos itens antes de enviar
    await client.query(
      `UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`,
      [id]
    );
    await client.query(
      `UPDATE orcamentos SET status='concluido', concluido_em=NOW(), concluido_por=$1, updated_at=NOW() WHERE id=$2`,
      [userId, id]
    );
    await client.query(
      `UPDATE orcamentos SET status='enviado', enviado_em=NOW(), updated_at=NOW() WHERE id=$1`,
      [id]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    client.release();
    return { erro: [e.message] };
  }
  client.release();

  const atualizado = await buscarPorId(id);

  // Disparo fire-and-forget: WA + e-mail
  _dispararNotificacoesEnvio(atualizado).catch(e =>
    console.warn('[ORC] Falha ao notificar cliente:', e.message)
  );

  return { orcamento: atualizado };
}

// Reenvia as notificações (e-mail/WhatsApp) de um orçamento já enviado,
// reaproveitando o mesmo token de aprovação. Útil quando o link anterior falhou.
async function reenviar(id) {
  const orc = await buscarPorId(id);
  if (!orc) return { erro: ['Orçamento não encontrado'] };
  if (!['enviado', 'concluido'].includes(orc.status)) {
    return { erro: [`Só é possível reenviar orçamento enviado (status atual: ${orc.status})`] };
  }
  if (!orc.cliente_email && !orc.cliente_celular) {
    return { erro: ['Cliente sem e-mail nem celular cadastrado'] };
  }
  await _dispararNotificacoesEnvio(orc);
  return { ok: true, email: orc.cliente_email || null, celular: orc.cliente_celular || null };
}

async function _dispararNotificacoesEnvio(orc) {
  const baseUrl = process.env.BASE_URL || 'https://app.graficalkl.com.br';
  const urlAprovar  = `${baseUrl}/api/v2/orcamentos/resposta?token=${orc.token_aprovacao}&r=aprovado`;
  const urlReprovar = `${baseUrl}/api/v2/orcamentos/resposta?token=${orc.token_aprovacao}&r=reprovado`;

  const totalFmt = `R$ ${parseFloat(orc.total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`;

  // Gera o PDF (com links de aprovação) uma única vez para reutilizar
  let pdfBuffer = null;
  try {
    pdfBuffer = await gerarOrcamentoPDF(orc);
  } catch (e) {
    console.warn('[ORC] Falha ao gerar PDF para envio:', e.message);
  }

  // WhatsApp
  if (orc.cliente_celular) {
    const msg =
      `Olá, ${orc.cliente_nome || 'cliente'}! 🖨\n\n` +
      `A Gráfica LKL preparou seu *Pedido #${orc.pedido_numero || orc.numero}* no valor de *${totalFmt}*.\n\n` +
      `Prazo de entrega: ${orc.prazo_entrega || 'a combinar'}\n` +
      `Validade: ${orc.validade_dias || 30} dias\n\n` +
      `Para aprovar, responda *SIM*.\n` +
      `Para reprovar, responda *NÃO*.\n\n` +
      `Ou clique para aprovar: ${urlAprovar}`;
    await whatsapp.sendMessage(orc.cliente_celular, msg);

    // Registra pendência de confirmação WA
    await db.query(
      `INSERT INTO orcamento_confirmacao_wa (phone, orcamento_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour')
       ON CONFLICT (phone) DO UPDATE SET orcamento_id=$2, expires_at=NOW() + INTERVAL '1 hour'`,
      [orc.cliente_celular, orc.id]
    );
  }

  // E-mail
  if (orc.cliente_email) {
    await enviarOrcamentoCliente({
      clienteNome:   orc.cliente_nome,
      clienteEmail:  orc.cliente_email,
      numero:        orc.numero,
      numeroPedido:  orc.pedido_numero,
      total:         orc.total,
      validade_dias: orc.validade_dias,
      prazo_entrega: orc.prazo_entrega,
      itens:         orc.itens,
      token:         orc.token_aprovacao,
      pdfBuffer,
    });
  }
}

// Resposta via link de e-mail (token)
async function processarRespostaToken(token, resposta) {
  const { rows } = await db.query(
    `SELECT id, status FROM orcamentos WHERE token_aprovacao=$1`, [token]
  );
  if (!rows[0]) return { erro: ['Link inválido ou expirado'] };
  const orc = rows[0];

  if (!['enviado'].includes(orc.status)) {
    return { erro: [`Orçamento já foi ${orc.status}`] };
  }

  const novoStatus = resposta === 'aprovado' ? 'aprovado' : 'reprovado';
  return mudarStatus(orc.id, novoStatus, { [`${novoStatus}_via`]: 'email' });
}

// Processa resposta WA: SIM/NÃO com confirmação em 2 etapas
// Retorna { mensagem } para enviar ao cliente, ou null se não havia orçamento pendente
async function processarRespostaWA(phone, texto) {
  const norm = texto.trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  const isSim = norm === 'SIM';
  const isNao = norm === 'NAO' || norm === 'NÃO' || norm === 'NAO';

  if (!isSim && !isNao) return null;

  const { rows } = await db.query(
    `SELECT oc.orcamento_id, oc.aguardando_confirmacao, oc.ultima_intencao,
            o.numero, o.total, o.status,
            (SELECT numero_os FROM orders WHERE orcamento_id = o.id ORDER BY created_at LIMIT 1) AS pedido_numero
     FROM orcamento_confirmacao_wa oc
     JOIN orcamentos o ON o.id = oc.orcamento_id
     WHERE oc.phone = $1 AND oc.expires_at > NOW()`,
    [phone]
  );
  if (!rows.length) return null;

  const { orcamento_id, aguardando_confirmacao, ultima_intencao, numero, total, status, pedido_numero } = rows[0];
  const refPedido = pedido_numero || numero;
  const totalFmt = `R$ ${parseFloat(total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`;

  if (status !== 'enviado') {
    await db.query('DELETE FROM orcamento_confirmacao_wa WHERE phone=$1', [phone]);
    return { mensagem: `O Pedido #${refPedido} já está *${status}*. Obrigado!` };
  }

  if (!aguardando_confirmacao) {
    // 1ª etapa: registra intenção e pede confirmação
    const intencao = isSim ? 'aprovado' : 'reprovado';
    const verbo    = isSim ? 'aprovar'  : 'reprovar';
    await db.query(
      `UPDATE orcamento_confirmacao_wa
       SET aguardando_confirmacao=true, ultima_intencao=$1, expires_at=NOW() + INTERVAL '30 minutes'
       WHERE phone=$2`,
      [intencao, phone]
    );
    return {
      mensagem:
        `Confirmando: deseja *${verbo}* o Pedido *#${refPedido}* no valor de *${totalFmt}*?\n\n` +
        `Responda *SIM* para confirmar ou *NÃO* para cancelar.`,
    };
  }

  // 2ª etapa: processa definitivamente
  await db.query('DELETE FROM orcamento_confirmacao_wa WHERE phone=$1', [phone]);

  if (isSim) {
    await mudarStatus(orcamento_id, ultima_intencao, { [`${ultima_intencao}_via`]: 'whatsapp' });
    const verboPassado = ultima_intencao === 'aprovado' ? 'aprovado' : 'reprovado';
    return { mensagem: `✅ Pedido #${refPedido} *${verboPassado}* com sucesso! Obrigado, em breve entraremos em contato.` };
  } else {
    return { mensagem: `Ok! Nenhuma alteração feita. Se precisar de ajuda, fale com nossa equipe.` };
  }
}

async function reprovar(id, reprovado_via) {
  const orc = await buscarPorId(id);
  if (!orc) return { erro: ['Orçamento não encontrado'] };
  if (orc.status !== 'enviado') return { erro: ['Orçamento precisa estar "enviado" para ser reprovado'] };
  return mudarStatus(id, 'reprovado', { reprovado_via: reprovado_via || 'manual' });
}

async function aprovar(id, aprovado_via) {
  const existing = await buscarPorId(id);
  if (!existing) return { erro: ['Orçamento não encontrado'] };
  if (existing.status !== 'enviado') return { erro: ['Orçamento precisa estar com status "enviado" para ser aprovado'] };

  const updates = ['status = $1', 'updated_at = NOW()', 'aprovado_em = NOW()'];
  const params = ['aprovado'];
  if (aprovado_via) { params.push(aprovado_via); updates.push(`aprovado_via = $${params.length}`); }
  params.push(id);

  const r = await db.query(
    `UPDATE orcamentos SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  const orcamento = r.rows[0];

  // Sync pedido → aprovado (OS de CV será criada via aprovação de arte por item)
  _syncPedidoStatus(id, 'aprovado');
  _notifyVendedorResposta(id, 'aprovado');

  if (global.io) global.io.emit('orcamento_aprovado', { orcamento_id: id });

  return { orcamento };
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
              (SELECT numero_os FROM orders WHERE orcamento_id = o.id ORDER BY created_at LIMIT 1) AS pedido_numero,
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

      _syncPedidoStatus(id, 'enviado'); // reutiliza map: aguardando_pagamento via campo direto abaixo
      await db.query(`UPDATE orders SET status='aguardando_pagamento', updated_at=NOW() WHERE orcamento_id=$1 AND status NOT IN ('pago','cancelado')`, [id]);
      return { tipo: 'boleto', parcelas, intervaloDias, boletos: boletosGerados, valor };
    } else if (tipo === 'pix') {
      const txid = crypto.randomBytes(16).toString('hex').slice(0, 32);
      const pix = await c6bank.criarPixCobranca({
        txid,
        valor,
        nomeDevedor: nomeSacado,
        cpfCnpjDevedor: cpfCnpj,
        solicitacao: `${seuNumero} - Gráfica LKL`,
      });
      await db.query(
        `UPDATE orcamentos SET tipo_cobranca='pix', status_pagamento='aguardando_pagamento',
         pix_txid=$1, pix_copia_cola=$2, updated_at=NOW() WHERE id=$3`,
        [pix.txid, pix.pixCopiaECola, id]
      );
      await db.query(`UPDATE orders SET status='aguardando_pagamento', updated_at=NOW() WHERE orcamento_id=$1 AND status NOT IN ('pago','cancelado')`, [id]);
      return { tipo: 'pix', txid: pix.txid, pixCopiaECola: pix.pixCopiaECola, valor };
    } else {
      // link_mp — Mercado Pago checkout
      const pref = await mercadopago.criarPreference({
        titulo: `Orçamento #${orc.numero} — Gráfica LKL`,
        valor,
        orcamentoNumero: orc.numero,
        clienteNome: nomeSacado,
        clienteEmail: orc.cliente_email,
        maxParcelas: parcelas,
      });
      await db.query(
        `UPDATE orcamentos SET tipo_cobranca='link_mp', status_pagamento='aguardando_pagamento',
         mp_preference_id=$1, mp_checkout_url=$2, updated_at=NOW() WHERE id=$3`,
        [pref.preferenceId, pref.checkoutUrl, id]
      );
      await db.query(`UPDATE orders SET status='aguardando_pagamento', updated_at=NOW() WHERE orcamento_id=$1 AND status NOT IN ('pago','cancelado')`, [id]);
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

  // Sync pedido → pago
  await db.query(
    `UPDATE orders SET status='pago', updated_at=NOW() WHERE orcamento_id=$1 AND status NOT IN ('cancelado')`,
    [orcId]
  );

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

// Reconstrói order_items (espelho) do pedido vinculado a partir de orcamento_itens (canônico)
async function _rebuildOrderItems(orcamentoId) {
  try {
    const ped = await db.query('SELECT id FROM orders WHERE orcamento_id=$1 LIMIT 1', [orcamentoId]);
    const pedidoId = ped.rows[0]?.id;
    if (!pedidoId) return;
    const itens = await db.query(
      'SELECT produto, descricao, quantidade, especificacao, valor_unitario, valor_total FROM orcamento_itens WHERE orcamento_id=$1 ORDER BY codigo',
      [orcamentoId]
    );
    await db.query('DELETE FROM order_items WHERE order_id=$1', [pedidoId]);
    for (const it of itens.rows) {
      await db.query(
        `INSERT INTO order_items (order_id, produto, quantidade, especificacao, valor_unitario, valor_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [pedidoId, it.produto || it.descricao, it.quantidade, it.especificacao || null, it.valor_unitario || 0, it.valor_total || 0]
      );
    }
    const p = itens.rows[0];
    if (p) {
      await db.query('UPDATE orders SET produto=$1, quantidade=$2, updated_at=NOW() WHERE id=$3',
        [p.produto || p.descricao, p.quantidade, pedidoId]);
    }
  } catch (e) {
    console.warn('[REBUILD-ORDER-ITEMS]', e.message);
  }
}

// ── Arte por item ─────────────────────────────────────────────────────────────

const APROVACAO_ARTE_EXATO = ['ok', 'sim', 'pode', 'aprovo'];          // mensagem precisa ser exatamente essa palavra
const APROVACAO_ARTE_INC = ['aprovado', 'aprovada', 'confirmo', 'autorizo']; // pode aparecer no meio do texto

async function enviarArteItem(itemId, arquivo_url) {
  const r = await db.query(
    `SELECT oi.id, oi.produto, oi.descricao, oi.orcamento_id,
            c.celular AS cliente_celular, c.nome AS cliente_nome,
            (SELECT numero_os FROM orders WHERE orcamento_id = oi.orcamento_id ORDER BY created_at LIMIT 1) AS pedido_numero
     FROM orcamento_itens oi
     LEFT JOIN orcamentos o ON o.id = oi.orcamento_id
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE oi.id = $1`, [itemId]
  );
  const item = r.rows[0];
  if (!item) return { erro: ['Item não encontrado'] };

  const nomeItem = item.produto || item.descricao || 'item';
  const refPed = item.pedido_numero || '';

  // Sem celular: não há como enviar; registra status enviada (comportamento anterior).
  if (!item.cliente_celular) {
    await db.query(
      `UPDATE orcamento_itens SET arte_status='enviada', arte_arquivo_url=$1, arte_enviada_em=NOW() WHERE id=$2`,
      [arquivo_url, itemId]
    );
    return { ok: true, item_id: itemId, status: 'enviada' };
  }

  const publicUrl = `${process.env.BASE_URL || 'https://app.graficalkl.com.br'}${arquivo_url}`;
  const caption = `Olá! Segue a arte do *Pedido #${refPed}* (${nomeItem}) para sua aprovação.\n\nResponda *APROVADO* para confirmar ou envie os ajustes desejados.`;
  const fallbackTexto = `Olá! Segue a arte do seu *Pedido #${refPed}* (${nomeItem}): ${publicUrl}\n\nResponda *APROVADO* para confirmar ou envie os ajustes desejados.`;

  const envio = await conversas.enviarClienteImagem(item.cliente_celular, publicUrl, caption, {
    mediaRef: arquivo_url,
    legenda: `Arte Pedido #${refPed}`,
    fallbackTexto,
  });

  if (envio.ok) {
    await db.query(
      `UPDATE orcamento_itens SET arte_status='enviada', arte_arquivo_url=$1, arte_enviada_em=NOW() WHERE id=$2`,
      [arquivo_url, itemId]
    );
    return { ok: true, item_id: itemId, status: 'enviada' };
  }

  await db.query(
    `UPDATE orcamento_itens SET arte_status='erro_envio', arte_arquivo_url=$1, arte_enviada_em=NULL WHERE id=$2`,
    [arquivo_url, itemId]
  );
  console.warn('[ARTE] Falha total ao enviar arte do item', itemId);
  return { erro: ['Falha ao enviar arte ao cliente'], item_id: itemId, status: 'erro_envio' };
}

async function responderArteItem(phone, mensagem) {
  const celular = String(phone || '').replace(/\D/g, '');
  if (!celular) return null;
  const pend = await db.query(
    `SELECT oi.id, oi.orcamento_id, oi.produto, oi.tipo_producao, o.vendedor_id,
            (SELECT numero_os FROM orders WHERE orcamento_id = oi.orcamento_id ORDER BY created_at LIMIT 1) AS pedido_numero
     FROM orcamento_itens oi
     JOIN orcamentos o ON o.id = oi.orcamento_id
     JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE oi.arte_status='enviada' AND (c.celular LIKE $1 OR c.celular LIKE $2)
     ORDER BY oi.arte_enviada_em DESC LIMIT 1`,
    [`%${celular.slice(-9)}`, `%${celular}`]
  );
  const item = pend.rows[0];
  if (!item) return null;
  const texto = String(mensagem || '').trim().toLowerCase();
  const negado = /\bn[aã]o\b/.test(texto);
  const aprovado = !negado && (APROVACAO_ARTE_INC.some(kw => texto.includes(kw)) || APROVACAO_ARTE_EXATO.includes(texto));
  const refPed = item.pedido_numero || '';
  if (aprovado) {
    await db.query(`UPDATE orcamento_itens SET arte_status='aprovada', arte_aprovada_em=NOW() WHERE id=$1`, [item.id]);
    if (item.tipo_producao === 'COMUNICAÇÃO VISUAL') {
      osService.criarOSComunicacaoVisual(item.orcamento_id).catch(e => console.warn('[OS-CV-ARTE]', e.message));
    }
    return { aprovado: true, item_id: item.id, resposta: `Arte aprovada! ✅ Seu *Pedido #${refPed}* seguirá para produção. Obrigado! 🖨️` };
  }
  await db.query(`UPDATE orcamento_itens SET arte_status='reprovada', arte_comentario=$1 WHERE id=$2`, [String(mensagem || '').trim(), item.id]);
  if (item.vendedor_id) {
    fcm.sendToUser(item.vendedor_id, { title: `Arte com ajustes — Pedido #${refPed}`, body: `${item.produto || 'Item'}: cliente pediu alterações`, data: { orcamento_id: item.orcamento_id } }).catch(() => {});
  }
  return { aprovado: false, item_id: item.id, resposta: `Anotado! ✏️ Vamos ajustar a arte e te enviar uma nova versão em breve.` };
}

async function listarArtesPendentes() {
  const r = await db.query(
    `SELECT oi.id, oi.produto, oi.descricao, oi.tipo_producao, oi.arte_status, oi.arte_arquivo_url, oi.arte_comentario,
            o.id AS orcamento_id, o.numero AS numero_orcamento,
            c.nome AS cliente_nome,
            (SELECT numero_os FROM orders WHERE orcamento_id = o.id ORDER BY created_at LIMIT 1) AS pedido_numero
     FROM orcamento_itens oi
     JOIN orcamentos o ON o.id = oi.orcamento_id
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE o.status='aprovado' AND oi.arte_status <> 'aprovada'
     ORDER BY o.numero DESC, oi.codigo`
  );
  return r.rows;
}

module.exports = { listar, buscarPorId, criar, precificar, mudarStatus, concluir, reenviar, aprovar, reprovar, processarRespostaToken, processarRespostaWA, cobrar, confirmarPagamento, cancelarBoleto, cancelarBoletoDireto, cancelarPix, cancelarLinkMp, _rebuildOrderItems, enviarArteItem, responderArteItem, listarArtesPendentes };
