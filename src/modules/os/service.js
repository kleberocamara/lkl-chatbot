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
  return { ...os, itens: itens.rows, especificacoes: especs.rows };
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

module.exports = { listar, buscarPorId, atualizarStatus, entregar, enviarArte, processarRespostaArte };
