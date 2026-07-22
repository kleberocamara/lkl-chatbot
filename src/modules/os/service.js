const db = require('../../db');
const fcm = require('../../services/fcm');
const whatsapp = require('../../services/whatsapp');
const { proximaFase, pedidoStatusDaOS, podeAvancarPedido } = require('../../constants/fluxoProducao');

const STATUS_VALIDOS = ['corte', 'impressao', 'acabamento', 'entrega', 'entregue', 'cancelado'];

const APROVACAO_KEYWORDS = ['aprovado', 'aprovada', 'aprovo', 'ok', 'sim', 'pode', 'confirmo', 'certo', 'perfeito', 'ótimo', 'otimo', 'aceito', 'gostei', 'ficou bom', 'ficou ótimo'];

async function enviarArte(id, { arquivo_url }) {
  if (!arquivo_url) return { erro: ['arquivo_url é obrigatório'] };

  const existing = await db.query(
    `SELECT os.*, c.celular AS cliente_celular, c.nome AS cliente_nome,
            o.numero AS numero_orcamento,
            COALESCE(
              (SELECT o2.numero_os FROM orders o2 WHERE o2.orcamento_id = os.orcamento_id ORDER BY o2.created_at LIMIT 1),
              (SELECT o3.numero_os FROM os_itens oit JOIN orcamento_itens oi2 ON oi2.id = oit.orcamento_item_id JOIN orders o3 ON o3.orcamento_id = oi2.orcamento_id WHERE oit.os_id = os.id ORDER BY o3.created_at LIMIT 1)
            ) AS numero_pedido
     FROM ordens_servico os
     LEFT JOIN orcamentos o ON o.id = os.orcamento_id
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE os.id = $1`,
    [id]
  );
  if (!existing.rows[0]) return { erro: ['OS não encontrada'] };
  const os = existing.rows[0];
  if (os.status !== 'arte_final') return { erro: ['OS precisa estar no status arte_final para enviar arte'] };
  if (!os.cliente_celular) return { erro: ['Cliente sem celular cadastrado'] };

  const publicUrl = `${process.env.BASE_URL}/uploads/artes/${arquivo_url.split('/').pop()}`;

  await db.query(
    `UPDATE ordens_servico
     SET status='aguardando_aprovacao_arte', arte_arquivo_url=$1, arte_enviada_em=NOW(), updated_at=NOW()
     WHERE id=$2`,
    [arquivo_url, id]
  );

  // Envia imagem via WhatsApp (fire-and-forget)
  const msg = `Olá! Segue a arte para aprovação do *Pedido #${os.numero_pedido || os.numero_orcamento}*.\n\nResponda *APROVADO* para confirmar ou envie suas alterações.`;
  whatsapp.sendImage(os.cliente_celular, publicUrl, msg).catch(e =>
    console.warn('[WA-ARTE] Falha ao enviar imagem:', e.message)
  );

  return { os: { ...os, status: 'aguardando_aprovacao_arte', arte_arquivo_url: arquivo_url } };
}

async function processarRespostaArte(phone, mensagem) {
  const celular = phone.replace(/\D/g, '');
  const osPendente = await db.query(
    `SELECT os.id, os.numero_os, os.orcamento_id, o.numero AS numero_orcamento,
            COALESCE(
              (SELECT o2.numero_os FROM orders o2 WHERE o2.orcamento_id = os.orcamento_id ORDER BY o2.created_at LIMIT 1),
              (SELECT o3.numero_os FROM os_itens oit JOIN orcamento_itens oi2 ON oi2.id = oit.orcamento_item_id JOIN orders o3 ON o3.orcamento_id = oi2.orcamento_id WHERE oit.os_id = os.id ORDER BY o3.created_at LIMIT 1)
            ) AS numero_pedido
     FROM ordens_servico os
     LEFT JOIN orcamentos o ON o.id = os.orcamento_id
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE os.status = 'aguardando_aprovacao_arte'
       AND (c.celular LIKE $1 OR c.celular LIKE $2)
     ORDER BY os.arte_enviada_em DESC
     LIMIT 1`,
    [`%${celular.slice(-9)}`, `%${celular}`]
  );
  if (!osPendente.rows[0]) return null;

  const os = osPendente.rows[0];
  const texto = mensagem.trim().toLowerCase();
  const aprovado = APROVACAO_KEYWORDS.some(kw => texto.includes(kw));

  if (aprovado) {
    await db.query(
      `UPDATE ordens_servico
       SET status='impressao', arte_aprovada_em=NOW(), data_inicio=COALESCE(data_inicio, NOW()), updated_at=NOW()
       WHERE id=$1`,
      [os.id]
    );
    // FCM ao vendedor
    const orcR = await db.query('SELECT vendedor_id FROM orcamentos WHERE id=$1', [os.orcamento_id]);
    if (orcR.rows[0]?.vendedor_id) {
      fcm.sendToUser(orcR.rows[0].vendedor_id, {
        title: `ORC #${os.numero_orcamento} — Arte aprovada ✅`,
        body: `OS #${os.numero_os} seguiu para impressão`,
        data: { os_id: os.id, status: 'impressao' },
      }).catch(() => {});
    }
    return { aprovado: true, os_id: os.id, numero_os: os.numero_os, resposta: `Arte aprovada! ✅ Seu *Pedido #${os.numero_pedido || os.numero_os}* seguiu para impressão. Entraremos em contato quando estiver pronto. 🖨️` };
  } else {
    await db.query(
      `UPDATE ordens_servico
       SET status='arte_final', arte_aprovacao_comentario=$1, updated_at=NOW()
       WHERE id=$2`,
      [mensagem.trim(), os.id]
    );
    return { aprovado: false, os_id: os.id, numero_os: os.numero_os, resposta: `Anotado! ✏️ Nosso time de arte vai realizar as alterações e enviará uma nova versão em breve.` };
  }
}

async function avancarFase(osId, userId) {
  const osR = await db.query(
    'SELECT id, numero_os, status, tipo_servico, orcamento_id, data_inicio FROM ordens_servico WHERE id=$1',
    [osId]
  );
  if (!osR.rows[0]) return { erro: ['OS não encontrada'] };
  const os = osR.rows[0];

  const proximo = proximaFase(os.tipo_servico, os.status);
  if (!proximo) {
    return { erro: [`OS já está em fase terminal (${os.status}) ou tipo de serviço desconhecido`] };
  }

  const updates = ['status=$1', 'updated_at=NOW()'];
  const params = [proximo];

  const firstPhases = new Set(['corte', 'impressao']);
  if (firstPhases.has(proximo) && !os.data_inicio) {
    updates.push('data_inicio=NOW()');
  }
  if (proximo === 'entregue') {
    updates.push('data_conclusao=NOW()');
  }

  params.push(osId);
  const r = await db.query(
    `UPDATE ordens_servico SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
    params
  );
  const updatedOs = r.rows[0];

  db.query(
    `INSERT INTO os_historico (os_id, de_status, para_status, usuario_id) VALUES ($1,$2,$3,$4)`,
    [osId, os.status, proximo, userId || null]
  ).catch(e => console.warn('[OS-HIST]', e.message));

  if (proximo === 'impressao' && os.status !== 'impressao') {
    baixarMateriais(osId, { userId }).catch(e =>
      console.warn('[OS-3C avancarFase]', e.message)
    );
  }

  const fcmLabels = {
    corte:     'Em corte ✂️',
    impressao: 'Em impressão 🖨️',
    acabamento:'Em acabamento ✂️',
    entrega:   'Pronto para entrega 📦',
    entregue:  'Entregue 🎉',
  };
  const label = fcmLabels[proximo];
  if (proximo === 'entregue' || label) {
    orcamentosAfetadosPorOS(osId).then(async (orcIds) => {
      for (const orcId of orcIds) {
        if (proximo === 'entregue') {
          const statuses = await statusOSsDoOrcamento(orcId);
          if (statuses.length && statuses.every(s => s === 'entregue') && global.io) {
            global.io.emit('servico_concluido', { orcamento_id: orcId });
          }
        }
        if (label) {
          const orcR = await db.query('SELECT vendedor_id, numero FROM orcamentos WHERE id=$1', [orcId]);
          if (orcR.rows[0]?.vendedor_id) {
            fcm.sendToUser(orcR.rows[0].vendedor_id, {
              title: `ORC #${orcR.rows[0].numero} — ${label}`,
              body: `OS #${updatedOs.numero_os} atualizada`,
              data: { os_id: osId, orcamento_id: orcId, status: proximo },
            }).catch(() => {});
          }
        }
      }
    }).catch(() => {});
  }

  if (global.io) global.io.emit('os_status', { os_id: osId, status: proximo });

  sincronizarPedidoPorOS(osId).catch(e => console.warn('[SYNC-PEDIDO avancarFase]', e.message));

  return { os: updatedOs };
}

async function historico(osId) {
  const r = await db.query(
    `SELECT h.id, h.de_status, h.para_status, h.em, u.name AS usuario_nome
     FROM os_historico h
     LEFT JOIN users u ON u.id = h.usuario_id
     WHERE h.os_id = $1
     ORDER BY h.em ASC`,
    [osId]
  );
  return r.rows;
}

async function listar({ page = 1, limit = 20, status, orcamento_id } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';

  if (status) { params.push(status); where += ` AND os.status = $${params.length}`; }
  if (orcamento_id) {
    params.push(orcamento_id);
    where += ` AND (os.orcamento_id = $${params.length} OR os.id IN (
      SELECT oit.os_id FROM os_itens oit JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id WHERE oi.orcamento_id = $${params.length}
    ))`;
  }

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT os.id, os.numero_os, os.status, os.tipo_servico, os.tipo_produto,
              COALESCE(
              (SELECT o2.numero_os FROM orders o2 WHERE o2.orcamento_id = os.orcamento_id ORDER BY o2.created_at LIMIT 1),
              (SELECT o3.numero_os FROM os_itens oit JOIN orcamento_itens oi2 ON oi2.id = oit.orcamento_item_id JOIN orders o3 ON o3.orcamento_id = oi2.orcamento_id WHERE oit.os_id = os.id ORDER BY o3.created_at LIMIT 1)
            ) AS numero_pedido,
              os.previsao_entrega, os.quantidade, os.data_inicio, os.data_conclusao,
              os.created_at, os.updated_at, os.maquina_id,
              (os.maquina_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM os_materiais m WHERE m.os_id = os.id AND m.folhas_total > 0
               )) AS ficha_pronta,
              COALESCE(cli.nome, cdir.nome) AS cliente_nome,
              u.name AS responsavel_nome,
              (SELECT COUNT(*) FROM os_itens oit WHERE oit.os_id = os.id) AS itens_count,
              (SELECT oi.descricao FROM os_itens oit
                 JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
                 WHERE oit.os_id = os.id ORDER BY oi.codigo LIMIT 1) AS item_descricao
       FROM ordens_servico os
       LEFT JOIN clientes_lkl cdir ON cdir.id = os.cliente_id
       LEFT JOIN orcamentos o ON o.id = os.orcamento_id
       LEFT JOIN clientes_lkl cli ON cli.id = o.cliente_id
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
            COALESCE(cli.nome, cdir.nome) AS cliente_nome,
            o.numero AS numero_orcamento,
            COALESCE(
              (SELECT o2.numero_os FROM orders o2 WHERE o2.orcamento_id = os.orcamento_id ORDER BY o2.created_at LIMIT 1),
              (SELECT o3.numero_os FROM os_itens oit JOIN orcamento_itens oi2 ON oi2.id = oit.orcamento_item_id JOIN orders o3 ON o3.orcamento_id = oi2.orcamento_id WHERE oit.os_id = os.id ORDER BY o3.created_at LIMIT 1)
            ) AS numero_pedido,
            u.name AS responsavel_nome,
            mq.nome AS maquina_nome,
            op.nome AS operador_nome
     FROM ordens_servico os
     LEFT JOIN clientes_lkl cdir ON cdir.id = os.cliente_id
     LEFT JOIN orcamentos o ON o.id = os.orcamento_id
     LEFT JOIN clientes_lkl cli ON cli.id = o.cliente_id
     LEFT JOIN users u ON u.id = os.responsavel_id
     LEFT JOIN maquinas mq ON mq.id = os.maquina_id
     LEFT JOIN funcionarios op ON op.id = os.operador_id
     WHERE os.id = $1`,
    [id]
  );
  if (!r.rows[0]) return null;
  const os = r.rows[0];

  const itens = await db.query(
    `SELECT oi.id, oi.descricao, oi.quantidade, oi.tipo_producao,
            oi.produto, oi.arte_arquivo_url, oi.arte_status,
            orc.numero AS numero_orcamento, cl.nome AS cliente_nome
     FROM os_itens oit
     JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
     JOIN orcamentos orc ON orc.id = oi.orcamento_id
     LEFT JOIN clientes_lkl cl ON cl.id = orc.cliente_id
     WHERE oit.os_id = $1 ORDER BY oi.codigo`,
    [id]
  );
  const especs = await db.query(
    `SELECT e.id, e.nome FROM os_especificacoes oe
     JOIN especificacoes e ON e.id = oe.especificacao_id
     WHERE oe.os_id = $1 ORDER BY e.nome`,
    [id]
  );
  const mats = await db.query(
    `SELECT m.id, m.via, m.material_id, m.descricao, m.cor_papel, m.cores_tintas,
            m.tipo_impressao, m.cores_frente, m.cores_verso,
            m.folhas_a_cortar, m.perda_percentual, m.folhas_total,
            mat.codigo AS material_codigo, mat.nome AS material_nome
     FROM os_materiais m
     LEFT JOIN materiais mat ON mat.id = m.material_id
     WHERE m.os_id = $1 ORDER BY m.via`,
    [id]
  );
  const reqR = await db.query(
    `SELECT * FROM os_requisicoes WHERE os_id=$1 ORDER BY criada_em DESC LIMIT 1`, [id]);
  let requisicao = null;
  let requisicao_itens = [];
  if (reqR.rows[0]) {
    const reqItens = await db.query(
      `SELECT ri.*, m.nome AS material_nome, m.estoque_atual
       FROM os_requisicao_itens ri JOIN materiais m ON m.id = ri.material_id
       WHERE ri.requisicao_id=$1`, [reqR.rows[0].id]);
    requisicao = reqR.rows[0];
    requisicao_itens = reqItens.rows;
  }
  return { ...os, itens: itens.rows, especificacoes: especs.rows, materiais: mats.rows, requisicao, requisicao_itens };
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

  if (['corte', 'impressao'].includes(novoStatus)) {
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

  if (novoStatus === 'impressao' && os.status !== 'impressao') {
    baixarMateriais(id, { userId: responsavel_id }).catch(e =>
      console.warn('[OS-3C atualizarStatus]', e.message)
    );
  }

  // Se entregue, checa se todas as OS não-canceladas do(s) orçamento(s) afetados
  // (pelos dois caminhos de vínculo) estão concluídas; envia FCM ao(s) vendedor(es).
  const labels = {
    corte:     'Em corte ✂️',
    impressao: 'Em impressão 🖨️',
    acabamento:'Em acabamento ✂️',
    entrega:   'Pronto para entrega 📦',
    entregue:  'Entregue 🎉',
  };
  const label = labels[novoStatus];
  if (novoStatus === 'entregue' || label) {
    const orcIds = await orcamentosAfetadosPorOS(id);
    for (const orcId of orcIds) {
      if (novoStatus === 'entregue') {
        const statuses = await statusOSsDoOrcamento(orcId);
        if (statuses.length && statuses.every(s => s === 'entregue') && global.io) {
          global.io.emit('servico_concluido', { orcamento_id: orcId });
        }
      }
      if (label) {
        const orcR = await db.query('SELECT vendedor_id, numero FROM orcamentos WHERE id=$1', [orcId]);
        if (orcR.rows[0]?.vendedor_id) {
          fcm.sendToUser(orcR.rows[0].vendedor_id, {
            title: `ORC #${orcR.rows[0].numero} — ${label}`,
            body: `OS #${updatedOs.numero_os} atualizada`,
            data: { os_id: id, orcamento_id: orcId, status: novoStatus },
          }).catch(() => {});
        }
      }
    }
  }

  db.query(
    `INSERT INTO os_historico (os_id, de_status, para_status, usuario_id) VALUES ($1,$2,$3,$4)`,
    [id, os.status, novoStatus, responsavel_id || null]
  ).catch(e => console.warn('[OS-HIST atualizarStatus]', e.message));

  sincronizarPedidoPorOS(id).catch(e => console.warn('[SYNC-PEDIDO atualizarStatus]', e.message));

  return { os: updatedOs };
}

async function entregar(id, { nome_recebedor, foto_url, userId }) {
  if (!nome_recebedor || !nome_recebedor.trim())
    return { erro: ['nome_recebedor é obrigatório'] };
  if (!foto_url)
    return { erro: ['foto do documento é obrigatória'] };

  const r = await db.query(
    `UPDATE ordens_servico
     SET status='entregue', entrega_nome_recebedor=$1, entrega_foto_url=$2,
         data_conclusao=NOW(), updated_at=NOW()
     WHERE id=$3 AND status='entrega'
     RETURNING *`,
    [nome_recebedor.trim(), foto_url, id]
  );
  if (!r.rows[0])
    return { erro: ['OS não encontrada ou não está no status "entrega"'] };

  const os = r.rows[0];

  db.query(
    `INSERT INTO os_historico (os_id, de_status, para_status, usuario_id) VALUES ($1,$2,$3,$4)`,
    [id, 'entrega', 'entregue', userId || null]
  ).catch(e => console.warn('[OS-HIST entregar]', e.message));

  // Checa se todas as OS não-canceladas do(s) orçamento(s) afetados (pelos dois
  // caminhos de vínculo) estão concluídas; envia FCM ao(s) vendedor(es).
  const orcIds = await orcamentosAfetadosPorOS(id);
  for (const orcId of orcIds) {
    const statuses = await statusOSsDoOrcamento(orcId);
    if (statuses.length && statuses.every(s => s === 'entregue') && global.io) {
      global.io.emit('servico_concluido', { orcamento_id: orcId });
    }
    const orcR = await db.query('SELECT vendedor_id, numero FROM orcamentos WHERE id=$1', [orcId]);
    if (orcR.rows[0]?.vendedor_id) {
      fcm.sendToUser(orcR.rows[0].vendedor_id, {
        title: `ORC #${orcR.rows[0].numero} — Entregue 🎉`,
        body: `OS #${os.numero_os} entregue para ${nome_recebedor.trim()}`,
        data: { os_id: id, orcamento_id: orcId, status: 'entregue' },
      }).catch(() => {});
    }
  }

  sincronizarPedidoPorOS(id).catch(e => console.warn('[SYNC-PEDIDO entregar]', e.message));

  return { os };
}

// Cria 1 OS com TODOS os itens de Comunicação Visual de um orçamento aprovado.
// Idempotente: ignora itens que já estão em alguma OS.
async function criarOSComunicacaoVisual(orcamentoId) {
  const itens = await db.query(
    `SELECT oi.id, oi.quantidade
     FROM orcamento_itens oi
     WHERE oi.orcamento_id = $1
       AND oi.tipo_producao = 'COMUNICAÇÃO VISUAL'
       AND oi.arte_status = 'aprovada'
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)`,
    [orcamentoId]
  );
  if (!itens.rows.length) return null;

  const orc = await db.query('SELECT cliente_id, prazo_entrega FROM orcamentos WHERE id=$1', [orcamentoId]);
  const clienteId = orc.rows[0]?.cliente_id || null;
  const qtdTotal = itens.rows.reduce((s, i) => s + (parseInt(i.quantidade) || 0), 0);

  const osR = await db.query(
    `INSERT INTO ordens_servico (orcamento_id, status, tipo_servico, cliente_id, quantidade)
     VALUES ($1, 'impressao', 'comunicacao_visual', $2, $3) RETURNING id, numero_os`,
    [orcamentoId, clienteId, qtdTotal]
  );
  const osId = osR.rows[0].id;

  db.query(
    `INSERT INTO os_historico (os_id, de_status, para_status, usuario_id) VALUES ($1,$2,$3,$4)`,
    [osId, null, 'impressao', null]
  ).catch(() => {});

  for (const it of itens.rows) {
    await db.query(`INSERT INTO os_itens (os_id, orcamento_item_id) VALUES ($1,$2)`, [osId, it.id]);
  }
  if (global.io) global.io.emit('nova_os', { os_id: osId, orcamento_id: orcamentoId });
  return { os_id: osId, numero_os: osR.rows[0].numero_os, itens: itens.rows.length };
}

// Itens OFFSET de orçamentos aprovados que ainda não estão em nenhuma OS
async function itensOffsetDisponiveis() {
  const r = await db.query(
    `SELECT oi.id, oi.descricao, oi.quantidade,
            orc.id AS orcamento_id, orc.numero AS numero_orcamento,
            cl.id AS cliente_id, cl.nome AS cliente_nome
     FROM orcamento_itens oi
     JOIN orcamentos orc ON orc.id = oi.orcamento_id
     LEFT JOIN clientes_lkl cl ON cl.id = orc.cliente_id
     WHERE orc.status = 'aprovado'
       AND oi.tipo_producao = 'OFFSET'
       AND oi.arte_status = 'aprovada'
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)
     ORDER BY cl.nome, orc.numero, oi.codigo`
  );
  return r.rows;
}

// Cria 1 OS offset agrupando N itens (de qualquer cliente/orçamento) + especificações
async function criarOSOffset({ item_ids, especificacoes, observacao, tipo_produto, previsao_entrega }, userId) {
  if (!Array.isArray(item_ids) || item_ids.length === 0) return { erro: ['Selecione ao menos 1 item'] };

  const val = await db.query(
    `SELECT oi.id, oi.quantidade, orc.cliente_id
     FROM orcamento_itens oi JOIN orcamentos orc ON orc.id = oi.orcamento_id
     WHERE oi.id = ANY($1) AND orc.status='aprovado' AND oi.tipo_producao='OFFSET' AND oi.arte_status='aprovada'
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)`,
    [item_ids]
  );
  if (val.rows.length !== item_ids.length) {
    return { erro: ['Um ou mais itens são inválidos, não são offset aprovados ou já estão em outra OS'] };
  }

  const clientes = [...new Set(val.rows.map(r => r.cliente_id).filter(Boolean))];
  const clienteId = clientes.length === 1 ? clientes[0] : null; // null = OS multi-cliente
  const qtdTotal = val.rows.reduce((s, i) => s + (parseInt(i.quantidade) || 0), 0);

  const osR = await db.query(
    `INSERT INTO ordens_servico
       (status, tipo_servico, tipo_produto, cliente_id, quantidade, previsao_entrega, observacao_interna, responsavel_id)
     VALUES ('corte','offset',$1,$2,$3,$4,$5,$6) RETURNING id, numero_os`,
    [tipo_produto || null, clienteId, qtdTotal, previsao_entrega || null, observacao || null, userId || null]
  );
  const osId = osR.rows[0].id;

  db.query(
    `INSERT INTO os_historico (os_id, de_status, para_status, usuario_id) VALUES ($1,$2,$3,$4)`,
    [osId, null, 'corte', userId || null]
  ).catch(() => {});

  for (const it of val.rows) {
    await db.query(`INSERT INTO os_itens (os_id, orcamento_item_id) VALUES ($1,$2)`, [osId, it.id]);
  }
  if (Array.isArray(especificacoes)) {
    for (const eid of especificacoes) {
      await db.query(`INSERT INTO os_especificacoes (os_id, especificacao_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [osId, eid]);
    }
  }
  if (global.io) global.io.emit('nova_os', { os_id: osId });
  return { os_id: osId, numero_os: osR.rows[0].numero_os, itens: val.rows.length };
}

// Atualiza a ficha de produção da OS e substitui as vias/materiais
async function atualizarFichaProducao(osId, dados) {
  const COLS = ['nro_jogos','nro_vias','tipo_unidade','frente_verso','numeracao_inicial',
    'numeracao_final','formato_corte','formato_corte_alt','formato_corte_larg','imagem_alt','imagem_larg',
    'imagens_folha','imagens_impressao','total_impressoes','cores_tintas','maquina_id','operador_id'];
  const sets = [], vals = [];
  for (const c of COLS) {
    if (dados[c] !== undefined) { vals.push(dados[c] === '' ? null : dados[c]); sets.push(`${c}=$${vals.length}`); }
  }
  if (sets.length) {
    vals.push(osId);
    const r = await db.query(
      `UPDATE ordens_servico SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING id`, vals);
    if (!r.rows[0]) return { erro: ['OS não encontrada'] };
  } else {
    const r = await db.query('SELECT id FROM ordens_servico WHERE id=$1', [osId]);
    if (!r.rows[0]) return { erro: ['OS não encontrada'] };
  }

  if (Array.isArray(dados.materiais)) {
    await db.query('DELETE FROM os_materiais WHERE os_id=$1', [osId]);
    let via = 1;
    for (const m of dados.materiais) {
      const _int = v => (v != null && v !== '' ? parseInt(v) : null);
      const _num = v => (v != null && v !== '' ? parseFloat(v) : null);
      await db.query(
        `INSERT INTO os_materiais (os_id, via, material_id, descricao, cor_papel, cores_tintas, tipo_impressao, cores_frente, cores_verso, folhas_a_cortar, perda_percentual, folhas_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [osId, m.via || via, m.material_id || null, m.descricao || null, m.cor_papel || null,
         m.cores_tintas || null, m.tipo_impressao || null,
         _int(m.cores_frente), _int(m.cores_verso),
         _int(m.folhas_a_cortar), _num(m.perda_percentual), _int(m.folhas_total)]
      );
      via++;
    }
  }
  const os = await buscarPorId(osId);
  return { os };
}

// OS-3C: coleta o consumo de materiais da OS (offset; CV é adicionado na fase 2)
async function _coletarConsumo(client, osId) {
  const consumo = []; // { material_id, quantidade, unidade }
  // Fonte OFFSET: vias da ficha com material e folhas_a_cortar
  const off = await client.query(
    `SELECT material_id, folhas_a_cortar FROM os_materiais
     WHERE os_id=$1 AND material_id IS NOT NULL AND folhas_a_cortar > 0`, [osId]);
  for (const r of off.rows) {
    consumo.push({ material_id: r.material_id, quantidade: Number(r.folhas_a_cortar), unidade: 'folha' });
  }
  // Fonte CV: itens da OS com material e dimensões → m²
  const cv = await client.query(
    `SELECT oi.material_id,
            (oi.largura_cm/100.0) * (oi.altura_cm/100.0) * oi.quantidade AS m2
     FROM os_itens si
     JOIN orcamento_itens oi ON oi.id = si.orcamento_item_id
     WHERE si.os_id = $1
       AND oi.material_id IS NOT NULL
       AND oi.largura_cm > 0 AND oi.altura_cm > 0 AND oi.quantidade > 0`, [osId]);
  for (const r of cv.rows) {
    consumo.push({ material_id: r.material_id, quantidade: Math.round(Number(r.m2) * 1000) / 1000, unidade: 'm2' });
  }
  return consumo;
}

async function baixarMateriais(osId, { userId } = {}) {
  const osR = await db.query('SELECT id FROM ordens_servico WHERE id=$1', [osId]);
  if (!osR.rows[0]) return { erro: ['OS não encontrada'] };
  const ativa = await db.query(`SELECT id FROM os_requisicoes WHERE os_id=$1 AND status='baixada'`, [osId]);
  if (ativa.rows[0]) {
    const itens = await db.query('SELECT * FROM os_requisicao_itens WHERE requisicao_id=$1', [ativa.rows[0].id]);
    return { requisicao: { id: ativa.rows[0].id, status: 'baixada' }, itens: itens.rows, jaExistia: true };
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const consumo = await _coletarConsumo(client, osId);
    const req = await client.query(
      `INSERT INTO os_requisicoes (os_id, status, criada_por) VALUES ($1,'baixada',$2) RETURNING *`,
      [osId, userId || null]);
    const requisicao = req.rows[0];
    const itens = [];
    for (const c of consumo) {
      await client.query('UPDATE materiais SET estoque_atual = estoque_atual - $1, updated_at=NOW() WHERE id=$2',
        [c.quantidade, c.material_id]);
      const it = await client.query(
        `INSERT INTO os_requisicao_itens (requisicao_id, material_id, quantidade, unidade)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [requisicao.id, c.material_id, c.quantidade, c.unidade]);
      itens.push(it.rows[0]);
    }
    await client.query('COMMIT');
    return { requisicao, itens, ignorados: consumo.length === 0 };
  } catch (e) {
    await client.query('ROLLBACK');
    return { erro: [e.message] };
  } finally {
    client.release();
  }
}

async function estornarRequisicao(osId, { userId } = {}) {
  const reqR = await db.query(`SELECT id FROM os_requisicoes WHERE os_id=$1 AND status='baixada'`, [osId]);
  if (!reqR.rows[0]) return { erro: ['Nenhuma requisição ativa para estornar'] };
  const requisicaoId = reqR.rows[0].id;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const itens = await client.query('SELECT material_id, quantidade FROM os_requisicao_itens WHERE requisicao_id=$1', [requisicaoId]);
    for (const it of itens.rows) {
      await client.query('UPDATE materiais SET estoque_atual = estoque_atual + $1, updated_at=NOW() WHERE id=$2',
        [it.quantidade, it.material_id]);
    }
    await client.query(`UPDATE os_requisicoes SET status='estornada', estornada_em=NOW(), estornada_por=$1 WHERE id=$2`,
      [userId || null, requisicaoId]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    return { erro: [e.message] };
  } finally {
    client.release();
  }
}

// Resolve os orçamentos afetados por uma OS pelos dois caminhos de vínculo:
// direto (ordens_servico.orcamento_id) e via itens (os_itens → orcamento_itens).
async function orcamentosAfetadosPorOS(osId) {
  const r = await db.query(
    `SELECT orcamento_id FROM (
       SELECT orcamento_id FROM ordens_servico WHERE id=$1 AND orcamento_id IS NOT NULL
       UNION
       SELECT oi.orcamento_id FROM os_itens oit
         JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
         WHERE oit.os_id=$1
     ) t WHERE orcamento_id IS NOT NULL`,
    [osId]
  );
  return r.rows.map(x => x.orcamento_id);
}

// Status de todas as OS não canceladas de um orçamento (dois caminhos).
async function statusOSsDoOrcamento(orcamentoId) {
  const r = await db.query(
    `SELECT DISTINCT os.id, os.status FROM ordens_servico os
     WHERE os.status != 'cancelado' AND (
       os.orcamento_id = $1
       OR os.id IN (SELECT oit.os_id FROM os_itens oit
                    JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
                    WHERE oi.orcamento_id = $1)
     )`,
    [orcamentoId]
  );
  return r.rows.map(x => x.status);
}

// Sincroniza o(s) pedido(s) afetado(s) por uma OS que mudou de fase.
async function sincronizarPedidoPorOS(osId) {
  const orcs = await orcamentosAfetadosPorOS(osId);
  for (const orcId of orcs) {
    const statuses = await statusOSsDoOrcamento(orcId);
    const alvo = pedidoStatusDaOS(statuses);
    if (!alvo) continue;
    const oR = await db.query('SELECT id, status FROM orders WHERE orcamento_id=$1', [orcId]);
    const order = oR.rows[0];
    if (!order) continue;
    if (!podeAvancarPedido(order.status, alvo)) continue;
    await db.query('UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2', [alvo, order.id]);
    if (global.io) global.io.emit('order_status_update', { orderId: order.id, status: alvo });
  }
}

module.exports = { listar, buscarPorId, atualizarStatus, avancarFase, historico, entregar, enviarArte, processarRespostaArte, criarOSComunicacaoVisual, itensOffsetDisponiveis, criarOSOffset, atualizarFichaProducao, baixarMateriais, estornarRequisicao };
