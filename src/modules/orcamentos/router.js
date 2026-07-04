const express = require('express');
const { requireRole } = require('../../middleware/auth');
const { tipoProducaoDoItemRevenda } = require('../../constants/produtos');
const service = require('./service');
const { gerarOrcamentoPDF } = require('../../services/pdf');
const whatsapp = require('../../services/whatsapp');
const conversas = require('../../services/conversas');
const multer = require('multer');
const path = require('path');
const _arteStorage = multer.diskStorage({
  destination: path.join(__dirname, '../../../public/uploads/artes'),
  filename: (req, file, cb) => cb(null, `arte_orc_${Date.now()}_${Math.round(Math.random()*1e6)}${path.extname(file.originalname)}`),
});
const _uploadArte = multer({ storage: _arteStorage, limits: { fileSize: 15 * 1024 * 1024 } });

const router = express.Router();

// GET /resposta?token=xxx&r=aprovado|reprovado — rota PÚBLICA (link do e-mail)
router.get('/resposta', async (req, res) => {
  const { token, r } = req.query;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!token || !UUID_RE.test(token) || !['aprovado', 'reprovado'].includes(r)) {
    return res.status(400).send('Link inválido.');
  }
  let result;
  try {
    result = await service.processarRespostaToken(token, r);
  } catch (e) {
    console.error('[ORC-RESPOSTA]', e.message);
    return res.status(500).send(`<html><body style="font-family:Arial;text-align:center;padding:60px">
      <h2>⚠️ Não foi possível processar sua resposta agora</h2>
      <p>Tente novamente em instantes ou fale com a Gráfica LKL.</p>
    </body></html>`);
  }
  if (result.erro) {
    return res.send(`<html><body style="font-family:Arial;text-align:center;padding:60px">
      <h2>⚠️ ${result.erro[0]}</h2>
      <p>Entre em contato com a Gráfica LKL se precisar de ajuda.</p>
    </body></html>`);
  }
  const msg = r === 'aprovado'
    ? '✅ Orçamento aprovado! Nossa equipe entrará em contato em breve.'
    : '❌ Orçamento reprovado. Entre em contato conosco se desejar renegociar.';
  res.send(`<html><body style="font-family:Arial;text-align:center;padding:60px;background:#f5f5f5">
    <div style="max-width:480px;margin:0 auto;background:white;border-radius:12px;padding:40px;box-shadow:0 2px 12px rgba(0,0,0,.1)">
      <img src="https://app.graficalkl.com.br/logo.png" alt="Gráfica LKL" style="height:60px;margin-bottom:24px" onerror="this.style.display='none'">
      <h2 style="color:${r === 'aprovado' ? '#2e7d32' : '#c62828'}">${msg}</h2>
      <p style="color:#555">Obrigado por utilizar a Gráfica LKL!</p>
    </div>
  </body></html>`);
});

// POST / — create orçamento (any authenticated user)
router.post('/', async (req, res) => {
  try {
    const { cliente_id, pedido_id, condicao_pagamento, validade_dias, prazo_entrega, observacao, itens } = req.body;
    const result = await service.criar({
      cliente_id,
      pedido_id: pedido_id || null,
      vendedor_id: req.user.id,
      condicao_pagamento,
      validade_dias,
      prazo_entrega,
      observacao,
      itens,
    });
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET / — list; vendedor sees only their own
router.get('/', async (req, res) => {
  try {
    const { page, limit, status, cliente_id } = req.query;
    let vendedor_id;
    if (req.user.role === 'vendedor') {
      vendedor_id = req.user.id;
    } else if (req.user.role === 'admin') {
      vendedor_id = req.query.vendedor_id || undefined;
    }
    const result = await service.listar({
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      status,
      vendedor_id,
      cliente_id,
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /artes/pendentes — lista itens com arte pendente
router.get('/artes/pendentes', requireRole('admin','gestor','atendente','analista'), async (req, res) => {
  try { res.json({ data: await service.listarArtesPendentes() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id — detail
router.get('/:id', async (req, res) => {
  try {
    const orcamento = await service.buscarPorId(req.params.id);
    if (!orcamento) return res.status(404).json({ error: 'Orçamento não encontrado' });
    res.json(orcamento);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PATCH /:id/precificar — admin only
router.patch('/:id/precificar', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.precificar(req.params.id, req.body.itens || []);
    if (!result) return res.status(404).json({ error: 'Orçamento não encontrado' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PATCH /:id/concluir — analista, gestor, admin
// Marca como concluído e dispara envio imediato (WA + e-mail)
router.patch('/:id/concluir', requireRole('admin', 'gestor', 'analista', 'atendente'), async (req, res) => {
  try {
    const result = await service.concluir(req.params.id, req.user.id);
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrado'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /:id/reenviar — reenvia notificações (e-mail/WhatsApp) do orçamento já enviado
router.post('/:id/reenviar', requireRole('admin', 'gestor', 'analista', 'atendente'), async (req, res) => {
  try {
    const result = await service.reenviar(req.params.id);
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrado'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PATCH /:id/aprovar — atendente, analista, gestor, admin (aprovação manual)
router.patch('/:id/aprovar', requireRole('admin', 'gestor', 'analista', 'atendente'), async (req, res) => {
  try {
    const { aprovado_via } = req.body || {};
    const result = await service.aprovar(req.params.id, aprovado_via || 'manual');
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrado'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PATCH /:id/reprovar — atendente, analista, gestor, admin
router.patch('/:id/reprovar', requireRole('admin', 'gestor', 'analista', 'atendente'), async (req, res) => {
  try {
    const { reprovado_via } = req.body || {};
    const result = await service.reprovar(req.params.id, reprovado_via || 'manual');
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrado'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PATCH /:id/cancelar — gestor, admin
router.patch('/:id/cancelar', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.mudarStatus(req.params.id, 'cancelado');
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrado'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /:id/boletos/:boletoId/cancelar — cancela parcela específica (admin)
router.post('/:id/boletos/:boletoId/cancelar', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.cancelarBoleto(req.params.id, req.params.boletoId);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result);
  } catch (err) {
    console.error('[CANCELAR-BOLETO]', err);
    res.status(500).json({ error: 'Erro interno ao cancelar boleto' });
  }
});

// POST /:id/boleto/cancelar — cancela cobrança do orçamento (legado ou parcela única) (admin)
router.post('/:id/boleto/cancelar', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.cancelarBoletoDireto(req.params.id);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result);
  } catch (err) {
    console.error('[CANCELAR-BOLETO-DIRETO]', err);
    res.status(500).json({ error: 'Erro interno ao cancelar boleto' });
  }
});

// POST /:id/pix/cancelar — cancela cobrança PIX (admin)
router.post('/:id/pix/cancelar', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.cancelarPix(req.params.id);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result);
  } catch (err) {
    console.error('[CANCELAR-PIX]', err);
    res.status(500).json({ error: 'Erro interno ao cancelar PIX' });
  }
});

// POST /:id/link_mp/cancelar — cancela link MP (admin)
router.post('/:id/link_mp/cancelar', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.cancelarLinkMp(req.params.id);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result);
  } catch (err) {
    console.error('[CANCELAR-LINK-MP]', err);
    res.status(500).json({ error: 'Erro interno ao cancelar link MP' });
  }
});

// GET /:id/pdf — generate PDF quote
router.get('/:id/pdf', async (req, res) => {
  const orc = await service.buscarPorId(req.params.id);
  if (!orc) return res.status(404).json({ error: 'Orçamento não encontrado' });
  try {
    const buffer = await gerarOrcamentoPDF(orc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="orcamento-${orc.numero}.pdf"`);
    res.send(buffer);
  } catch (e) {
    console.error('[PDF]', e.message);
    res.status(500).json({ error: 'Erro ao gerar PDF' });
  }
});

// GET /:id/boleto/:parcela/pdf — proxy PDF de parcela específica
router.get('/:id/boleto/:parcela/pdf', requireRole('admin'), async (req, res) => {
  try {
    const db = require('../../db');
    const r = await db.query(
      'SELECT boleto_id, parcela, total_parcelas FROM orcamento_boletos WHERE orcamento_id=$1 AND parcela=$2',
      [req.params.id, req.params.parcela]
    );
    if (!r.rows[0]?.boleto_id) return res.status(404).json({ error: 'Parcela não encontrada' });
    const { boleto_id, parcela, total_parcelas } = r.rows[0];

    const c6bank = require('../../services/c6bank');
    const axios = require('axios');
    const BASE_URL = process.env.C6_BASE_URL || 'https://baas-api-sandbox.c6bank.info';
    const token = await c6bank._getAccessToken();
    const agent = c6bank._getAgent();

    const pdfRes = await axios.get(`${BASE_URL}/v1/bank_slips/${boleto_id}/pdf`, {
      httpsAgent: agent,
      headers: { Authorization: `Bearer ${token}`, 'partner-software-name': 'Grafica LKL', 'partner-software-version': '1.0.0' },
      responseType: 'arraybuffer',
    });

    const orc = await db.query('SELECT numero FROM orcamentos WHERE id=$1', [req.params.id]);
    const num = orc.rows[0]?.numero || req.params.id;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="boleto-orc${num}-parcela${parcela}de${total_parcelas}.pdf"`);
    res.send(Buffer.from(pdfRes.data));
  } catch (e) {
    console.error('[BOLETO-PARCELA-PDF]', e.message);
    res.status(500).json({ error: `Erro ao baixar PDF: ${e.message}` });
  }
});

// GET /:id/boleto/pdf — proxy PDF do boleto C6 Bank (requer auth mTLS)
router.get('/:id/boleto/pdf', requireRole('admin'), async (req, res) => {
  try {
    const db = require('../../db');
    const r = await db.query('SELECT boleto_id, numero FROM orcamentos WHERE id = $1', [req.params.id]);
    if (!r.rows[0]?.boleto_id) return res.status(404).json({ error: 'Boleto não encontrado para este orçamento' });
    const { boleto_id, numero } = r.rows[0];

    const c6bank = require('../../services/c6bank');
    const axios = require('axios');
    const https = require('https');
    const fs = require('fs');
    const BASE_URL = process.env.C6_BASE_URL || 'https://baas-api-sandbox.c6bank.info';

    // Reusar agent e token do módulo c6bank
    const token = await c6bank._getAccessToken();
    const agent = c6bank._getAgent();

    const pdfRes = await axios.get(`${BASE_URL}/v1/bank_slips/${boleto_id}/pdf`, {
      httpsAgent: agent,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'partner-software-name': 'Grafica LKL',
        'partner-software-version': '1.0.0',
      },
      responseType: 'arraybuffer',
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="boleto-orc${numero}.pdf"`);
    res.send(Buffer.from(pdfRes.data));
  } catch (e) {
    console.error('[BOLETO-PDF]', e.message);
    res.status(500).json({ error: `Erro ao baixar PDF do boleto: ${e.message}` });
  }
});

// POST /:id/cobrar — admin gera cobrança (boleto ou pix)
router.post('/:id/cobrar', requireRole('admin'), async (req, res) => {
  try {
    const { tipo, dataVencimento, parcelas, intervaloDias } = req.body || {};
    if (!tipo) return res.status(400).json({ errors: ['tipo é obrigatório (boleto ou pix)'] });
    const result = await service.cobrar(req.params.id, tipo, dataVencimento, parcelas, intervaloDias);
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrado'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }

    // Envia dados de pagamento ao cliente via WhatsApp (fire-and-forget)
    service.buscarPorId(req.params.id).then(orc => {
      if (!orc?.cliente_celular) return;
      let msg;
      if (result.tipo === 'boleto') {
        msg = `Olá! Segue o boleto referente ao *Pedido #${orc.pedido_numero || orc.numero}* — Gráfica LKL.\n\n` +
              `💰 *Valor:* R$ ${result.valor.toFixed(2).replace('.', ',')}\n` +
              `📅 *Vencimento:* ${new Date(result.dataVencimento + 'T12:00:00').toLocaleDateString('pt-BR')}\n\n` +
              `*Linha digitável:*\n${result.linhaDigitavel}\n\n` +
              (result.pdfUrl ? `PDF: ${result.pdfUrl}\n\n` : '') +
              `Em caso de dúvidas, entre em contato conosco. Obrigado! 😊`;
      } else if (result.tipo === 'link_mp') {
        msg = `Olá! Segue o link de pagamento referente ao *Pedido #${orc.pedido_numero || orc.numero}* — Gráfica LKL.\n\n` +
              `💰 *Valor:* R$ ${result.valor.toFixed(2).replace('.', ',')}\n\n` +
              `Pague com cartão, PIX ou boleto neste link:\n${result.checkoutUrl}\n\n` +
              `Qualquer dúvida, é só chamar. Obrigado! 😊`;
      } else {
        msg = `Olá! Segue a cobrança PIX referente ao *Pedido #${orc.pedido_numero || orc.numero}* — Gráfica LKL.\n\n` +
              `💰 *Valor:* R$ ${result.valor.toFixed(2).replace('.', ',')}\n\n` +
              `*PIX Copia e Cola:*\n${result.pixCopiaECola}\n\n` +
              `Cole o código no app do seu banco para pagar. Obrigado! 😊`;
      }
      conversas.enviarClienteTexto(orc.cliente_celular, msg, { nome: orc.cliente_nome }).catch(e =>
        console.warn('[WA-COBRAR] Falha:', e.message)
      );
      conversas.sairDeAguardandoHumano(orc.cliente_celular, { para: 'resolved', motivo: 'cobranca_enviada' })
        .catch(e => console.warn('[AUTO-RESOLVE] cobrança:', e.message));
    }).catch(() => {});

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── CRUD de itens ─────────────────────────────────────────────────────────────
const db = require('../../db/index');
const precificacao = require('../precificacao/service');
const revendaService = require('../revenda/service');

router.post('/:id/itens', requireRole('admin','gestor','atendente'), async (req, res) => {
  try {
    const { produto, tipo_producao, especificacao, quantidade, largura_cm, altura_cm, material_id, tem_arte, recalcular,
            revenda_produto_id, revenda_prazo_horas, revenda_acabamentos } = req.body;
    let { descricao, valor_unitario, valor_total } = req.body;
    if (produto) descricao = especificacao ? `${produto} — ${especificacao}` : produto;
    if (!descricao || !quantidade) return res.status(400).json({ erro: ['produto/descrição e quantidade são obrigatórios'] });

    // Auto-precificação: só quando não veio valor explícito (ou recalcular=true)
    let preco_origem = 'manual', preco_memoria = null;
    let tp = tipo_producao || null;
    if (revenda_produto_id) {
      const rp = (await db.query('SELECT estrategia, tipo_servico FROM revenda_produtos WHERE id=$1', [revenda_produto_id])).rows[0];
      tp = tipoProducaoDoItemRevenda(rp?.estrategia, rp?.tipo_servico);
    }
    const semValor = (valor_unitario == null && valor_total == null);
    if (semValor || recalcular) {
      let calc = null;
      if (revenda_produto_id) {
        calc = await revendaService.precificarItemRevenda({ revenda_produto_id, quantidade, prazo_horas: revenda_prazo_horas, acabamentos: revenda_acabamentos, largura_cm, altura_cm });
      } else {
        calc = await precificacao.precificarItem({ produto, material_id, quantidade, largura_cm, altura_cm });
      }
      if (calc) {
        valor_unitario = calc.valor_unitario;
        valor_total = calc.valor_total;
        preco_origem = 'auto';
        preco_memoria = calc.memoria;
      }
    }

    const cod = await db.query('SELECT COALESCE(MAX(codigo),0)+1 AS c FROM orcamento_itens WHERE orcamento_id=$1', [req.params.id]);
    const { rows } = await db.query(
      `INSERT INTO orcamento_itens (orcamento_id, codigo, produto, especificacao, descricao, tipo_producao, quantidade, valor_unitario, valor_total, largura_cm, altura_cm, material_id, tem_arte, preco_origem, preco_memoria, revenda_produto_id, revenda_prazo_horas, revenda_acabamentos)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [req.params.id, cod.rows[0].c, produto || null, especificacao || null, descricao, tp,
       quantidade, valor_unitario || 0, valor_total || 0,
       largura_cm || null, altura_cm || null, material_id || null, !!tem_arte, preco_origem, preco_memoria,
       revenda_produto_id || null, revenda_prazo_horas || null,
       (Array.isArray(revenda_acabamentos) ? JSON.stringify(revenda_acabamentos) : '[]')]
    );
    await db.query(`UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`, [req.params.id]);
    await service._rebuildOrderItems(req.params.id);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ erro: [e.message] }); }
});

router.patch('/:id/itens/:itemId', requireRole('admin','gestor','atendente'), async (req, res) => {
  try {
    const { produto, tipo_producao, especificacao, quantidade, largura_cm, altura_cm, material_id, tem_arte, recalcular,
            revenda_produto_id, revenda_prazo_horas, revenda_acabamentos } = req.body;
    let { descricao, valor_unitario, valor_total } = req.body;
    if (produto !== undefined) descricao = especificacao ? `${produto} — ${especificacao}` : produto;

    let tpPatch = tipo_producao ?? null;
    const revIdPatch = revenda_produto_id !== undefined ? revenda_produto_id : null;
    if (revIdPatch) {
      const rp = (await db.query('SELECT estrategia, tipo_servico FROM revenda_produtos WHERE id=$1', [revIdPatch])).rows[0];
      tpPatch = tipoProducaoDoItemRevenda(rp?.estrategia, rp?.tipo_servico);
    }

    let preco_origem = null, preco_memoria = null; // null = COALESCE mantém o atual
    const valorExplicito = (valor_unitario != null || valor_total != null);
    if (valorExplicito) {
      preco_origem = 'manual';
      preco_memoria = null;
    } else if (recalcular) {
      // Carrega o estado atual do item para preencher campos faltantes no cálculo
      const cur = await db.query('SELECT produto, material_id, quantidade, largura_cm, altura_cm, revenda_produto_id, revenda_prazo_horas, revenda_acabamentos FROM orcamento_itens WHERE id=$1 AND orcamento_id=$2', [req.params.itemId, req.params.id]);
      const it = cur.rows[0] || {};
      let calc = null;
      const revId = revenda_produto_id ?? it.revenda_produto_id;
      if (revId) {
        calc = await revendaService.precificarItemRevenda({
          revenda_produto_id: revId,
          quantidade: quantidade ?? it.quantidade,
          prazo_horas: revenda_prazo_horas ?? it.revenda_prazo_horas,
          acabamentos: revenda_acabamentos ?? it.revenda_acabamentos,
          largura_cm: largura_cm ?? it.largura_cm,
          altura_cm: altura_cm ?? it.altura_cm,
        });
      } else {
        calc = await precificacao.precificarItem({
          produto: produto ?? it.produto,
          material_id: material_id ?? it.material_id,
          quantidade: quantidade ?? it.quantidade,
          largura_cm: largura_cm ?? it.largura_cm,
          altura_cm: altura_cm ?? it.altura_cm,
        });
      }
      if (calc) {
        valor_unitario = calc.valor_unitario;
        valor_total = calc.valor_total;
        preco_origem = 'auto';
        preco_memoria = calc.memoria;
      }
    }

    const { rows } = await db.query(
      `UPDATE orcamento_itens SET
         produto=COALESCE($1,produto), especificacao=COALESCE($2,especificacao),
         descricao=COALESCE($3,descricao), tipo_producao=COALESCE($4,tipo_producao),
         quantidade=COALESCE($5,quantidade), valor_unitario=COALESCE($6,valor_unitario), valor_total=COALESCE($7,valor_total),
         largura_cm=COALESCE($8,largura_cm), altura_cm=COALESCE($9,altura_cm), material_id=COALESCE($10,material_id),
         tem_arte=COALESCE($11,tem_arte),
         preco_origem=COALESCE($14,preco_origem),
         preco_memoria=CASE WHEN $14 IS NULL THEN preco_memoria ELSE $15 END,
         revenda_produto_id=COALESCE($16,revenda_produto_id),
         revenda_prazo_horas=COALESCE($17,revenda_prazo_horas),
         revenda_acabamentos=COALESCE($18,revenda_acabamentos)
       WHERE id=$12 AND orcamento_id=$13 RETURNING *`,
      [produto ?? null, especificacao ?? null, descricao ?? null, tpPatch,
       quantidade ?? null, valor_unitario ?? null, valor_total ?? null,
       largura_cm ?? null, altura_cm ?? null, material_id ?? null,
       (tem_arte === undefined ? null : !!tem_arte),
       req.params.itemId, req.params.id, preco_origem, preco_memoria,
       revenda_produto_id ?? null, revenda_prazo_horas ?? null,
       (revenda_acabamentos ? JSON.stringify(revenda_acabamentos) : null)]
    );
    if (!rows[0]) return res.status(404).json({ erro: ['Item não encontrado'] });
    await db.query(`UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`, [req.params.id]);
    await service._rebuildOrderItems(req.params.id);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ erro: [e.message] }); }
});

router.post('/:id/itens/:itemId/arte', requireRole('admin','gestor','atendente','analista'), _uploadArte.single('arte'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo de arte é obrigatório (campo "arte")' });
    const arquivo_url = `/uploads/artes/${req.file.filename}`;
    const result = await service.enviarArteItem(req.params.itemId, arquivo_url);
    if (result?.erro) return res.status(404).json({ errors: result.erro });
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/itens/:itemId', requireRole('admin','gestor'), async (req, res) => {
  try {
    await db.query(`DELETE FROM orcamento_itens WHERE id=$1 AND orcamento_id=$2`, [req.params.itemId, req.params.id]);
    await db.query(
      `UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`,
      [req.params.id]
    );
    await service._rebuildOrderItems(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: [e.message] }); }
});

module.exports = router;
