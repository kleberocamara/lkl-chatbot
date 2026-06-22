const db = require('../../db');
const fcm = require('../../services/fcm');
const whatsapp = require('../../services/whatsapp');

const STATUS_VALIDOS = ['aguardando', 'arte_final', 'aguardando_aprovacao_arte', 'impressao', 'acabamento', 'embalagem', 'pronto', 'entregue', 'cancelado'];

const APROVACAO_KEYWORDS = ['aprovado', 'aprovada', 'aprovo', 'ok', 'sim', 'pode', 'confirmo', 'certo', 'perfeito', 'ótimo', 'otimo', 'aceito', 'gostei', 'ficou bom', 'ficou ótimo'];

async function enviarArte(id, { arquivo_url }) {
  if (!arquivo_url) return { erro: ['arquivo_url é obrigatório'] };

  const existing = await db.query(
    `SELECT os.*, c.celular AS cliente_celular, c.nome AS cliente_nome,
            o.numero AS numero_orcamento
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
  const msg = `Olá! Segue a arte para aprovação do pedido *ORC #${os.numero_orcamento}* (OS #${os.numero_os}).\n\nResponda *APROVADO* para confirmar ou envie suas alterações.`;
  whatsapp.sendImage(os.cliente_celular, publicUrl, msg).catch(e =>
    console.warn('[WA-ARTE] Falha ao enviar imagem:', e.message)
  );

  return { os: { ...os, status: 'aguardando_aprovacao_arte', arte_arquivo_url: arquivo_url } };
}

async function processarRespostaArte(phone, mensagem) {
  const celular = phone.replace(/\D/g, '');
  const osPendente = await db.query(
    `SELECT os.id, os.numero_os, os.orcamento_id, o.numero AS numero_orcamento
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
    return { aprovado: true, os_id: os.id, numero_os: os.numero_os, resposta: `Arte aprovada! ✅ Seu pedido OS #${os.numero_os} seguiu para impressão. Entraremos em contato quando estiver pronto. 🖨️` };
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

async function listar({ page = 1, limit = 20, status, orcamento_id } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';

  if (status) { params.push(status); where += ` AND os.status = $${params.length}`; }
  if (orcamento_id) { params.push(orcamento_id); where += ` AND os.orcamento_id = $${params.length}`; }

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT os.id, os.numero_os, os.status, os.tipo_servico, os.tipo_produto,
              os.previsao_entrega, os.quantidade, os.data_inicio, os.data_conclusao,
              os.created_at, os.updated_at,
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
            u.name AS responsavel_nome
     FROM ordens_servico os
     LEFT JOIN clientes_lkl cdir ON cdir.id = os.cliente_id
     LEFT JOIN orcamentos o ON o.id = os.orcamento_id
     LEFT JOIN clientes_lkl cli ON cli.id = o.cliente_id
     LEFT JOIN users u ON u.id = os.responsavel_id
     WHERE os.id = $1`,
    [id]
  );
  if (!r.rows[0]) return null;
  const os = r.rows[0];

  const itens = await db.query(
    `SELECT oi.id, oi.descricao, oi.quantidade, oi.tipo_producao,
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
            mat.codigo AS material_codigo, mat.nome AS material_nome
     FROM os_materiais m
     LEFT JOIN materiais mat ON mat.id = m.material_id
     WHERE m.os_id = $1 ORDER BY m.via`,
    [id]
  );
  return { ...os, itens: itens.rows, especificacoes: especs.rows, materiais: mats.rows };
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

async function entregar(id, { nome_recebedor, foto_url }) {
  if (!nome_recebedor || !nome_recebedor.trim())
    return { erro: ['nome_recebedor é obrigatório'] };
  if (!foto_url)
    return { erro: ['foto do documento é obrigatória'] };

  const r = await db.query(
    `UPDATE ordens_servico
     SET status='entregue', entrega_nome_recebedor=$1, entrega_foto_url=$2,
         data_conclusao=NOW(), updated_at=NOW()
     WHERE id=$3 AND status='pronto'
     RETURNING *`,
    [nome_recebedor.trim(), foto_url, id]
  );
  if (!r.rows[0])
    return { erro: ['OS não encontrada ou não está no status "pronto"'] };

  const os = r.rows[0];

  // Check if all OSs of this orcamento are done
  const pendentes = await db.query(
    `SELECT COUNT(*) FROM ordens_servico
     WHERE orcamento_id=$1 AND status NOT IN ('entregue','cancelado')`,
    [os.orcamento_id]
  );
  if (parseInt(pendentes.rows[0].count) === 0 && global.io) {
    global.io.emit('servico_concluido', { orcamento_id: os.orcamento_id });
  }

  // FCM push to vendedor
  const orc = await db.query(
    'SELECT vendedor_id, numero FROM orcamentos WHERE id=$1',
    [os.orcamento_id]
  );
  if (orc.rows[0]?.vendedor_id) {
    fcm.sendToUser(orc.rows[0].vendedor_id, {
      title: `ORC #${orc.rows[0].numero} — Entregue 🎉`,
      body: `OS #${os.numero_os} entregue para ${nome_recebedor.trim()}`,
      data: { os_id: id, orcamento_id: os.orcamento_id, status: 'entregue' },
    }).catch(() => {});
  }

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
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)`,
    [orcamentoId]
  );
  if (!itens.rows.length) return null;

  const orc = await db.query('SELECT cliente_id, prazo_entrega FROM orcamentos WHERE id=$1', [orcamentoId]);
  const clienteId = orc.rows[0]?.cliente_id || null;
  const qtdTotal = itens.rows.reduce((s, i) => s + (parseInt(i.quantidade) || 0), 0);

  const osR = await db.query(
    `INSERT INTO ordens_servico (orcamento_id, status, tipo_servico, cliente_id, quantidade)
     VALUES ($1, 'aguardando', 'comunicacao_visual', $2, $3) RETURNING id, numero_os`,
    [orcamentoId, clienteId, qtdTotal]
  );
  const osId = osR.rows[0].id;
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
     WHERE oi.id = ANY($1) AND orc.status='aprovado' AND oi.tipo_producao='OFFSET'
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
     VALUES ('aguardando','offset',$1,$2,$3,$4,$5,$6) RETURNING id, numero_os`,
    [tipo_produto || null, clienteId, qtdTotal, previsao_entrega || null, observacao || null, userId || null]
  );
  const osId = osR.rows[0].id;

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
    'numeracao_final','formato_corte_alt','formato_corte_larg','imagem_alt','imagem_larg',
    'imagens_folha','imagens_impressao','cores_tintas'];
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
      await db.query(
        `INSERT INTO os_materiais (os_id, via, material_id, descricao, cor_papel, cores_tintas, tipo_impressao, cores_frente, cores_verso)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [osId, m.via || via, m.material_id || null, m.descricao || null, m.cor_papel || null,
         m.cores_tintas || null, m.tipo_impressao || null,
         m.cores_frente != null && m.cores_frente !== '' ? parseInt(m.cores_frente) : null,
         m.cores_verso  != null && m.cores_verso  !== '' ? parseInt(m.cores_verso)  : null]
      );
      via++;
    }
  }
  const os = await buscarPorId(osId);
  return { os };
}

module.exports = { listar, buscarPorId, atualizarStatus, entregar, enviarArte, processarRespostaArte, criarOSComunicacaoVisual, itensOffsetDisponiveis, criarOSOffset, atualizarFichaProducao };
