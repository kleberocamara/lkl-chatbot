const express = require('express');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');
const { gerarOrcamentoPDF } = require('../../services/pdf');
const whatsapp = require('../../services/whatsapp');

const router = express.Router();

// POST / — create orçamento (any authenticated user)
router.post('/', async (req, res) => {
  try {
    const { cliente_id, condicao_pagamento, validade_dias, prazo_entrega, observacao, itens } = req.body;
    const result = await service.criar({
      cliente_id,
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

// PATCH /:id/enviar — admin only
router.patch('/:id/enviar', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.mudarStatus(req.params.id, 'enviado');
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrado'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    // WhatsApp notification (fire-and-forget)
    service.buscarPorId(req.params.id).then(orc => {
      if (orc?.cliente_celular) {
        const msg =
          `Olá! A LKL Gráfica enviou uma proposta para você.\n\n` +
          `*Proposta/Orçamento #${orc.numero}*\n` +
          `Validade: ${orc.validade_dias || 35} dias\n` +
          `Prazo de entrega: ${orc.prazo_entrega || 'A combinar'}\n\n` +
          `Para aprovar, responda *SIM* ou entre em contato conosco.`;
        whatsapp.sendMessage(orc.cliente_celular, msg).catch(e =>
          console.warn('[WA] Falha ao notificar cliente:', e.message)
        );
      }
    }).catch(() => {});
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PATCH /:id/aprovar — admin only
router.patch('/:id/aprovar', requireRole('admin'), async (req, res) => {
  try {
    const { aprovado_via } = req.body || {};
    const result = await service.aprovar(req.params.id, aprovado_via);
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

// PATCH /:id/cancelar — admin only
router.patch('/:id/cancelar', requireRole('admin'), async (req, res) => {
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
      headers: { Authorization: `Bearer ${token}`, 'partner-software-name': 'LKL Grafica', 'partner-software-version': '1.0.0' },
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
        'partner-software-name': 'LKL Grafica',
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
        msg = `Olá! Segue o boleto referente ao *ORC #${orc.numero}* — LKL Gráfica.\n\n` +
              `💰 *Valor:* R$ ${result.valor.toFixed(2).replace('.', ',')}\n` +
              `📅 *Vencimento:* ${new Date(result.dataVencimento + 'T12:00:00').toLocaleDateString('pt-BR')}\n\n` +
              `*Linha digitável:*\n${result.linhaDigitavel}\n\n` +
              (result.pdfUrl ? `PDF: ${result.pdfUrl}\n\n` : '') +
              `Em caso de dúvidas, entre em contato conosco. Obrigado! 😊`;
      } else {
        msg = `Olá! Segue a cobrança PIX referente ao *ORC #${orc.numero}* — LKL Gráfica.\n\n` +
              `💰 *Valor:* R$ ${result.valor.toFixed(2).replace('.', ',')}\n\n` +
              `*PIX Copia e Cola:*\n${result.pixCopiaECola}\n\n` +
              `Cole o código no app do seu banco para pagar. Obrigado! 😊`;
      }
      whatsapp.sendMessage(orc.cliente_celular, msg).catch(e =>
        console.warn('[WA-COBRAR] Falha:', e.message)
      );
    }).catch(() => {});

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ── CRUD de itens ─────────────────────────────────────────────────────────────
const db = require('../../db/index');

router.post('/:id/itens', requireRole('admin','gestor','atendente'), async (req, res) => {
  try {
    const { descricao, quantidade, valor_unitario, valor_total } = req.body;
    if (!descricao || !quantidade) return res.status(400).json({ erro: ['descricao e quantidade são obrigatórios'] });
    const { rows } = await db.query(
      `INSERT INTO orcamento_itens (orcamento_id, descricao, quantidade, valor_unitario, valor_total)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, descricao, quantidade, valor_unitario || 0, valor_total || 0]
    );
    // recalc total no orçamento
    await db.query(
      `UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`,
      [req.params.id]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ erro: [e.message] }); }
});

router.patch('/:id/itens/:itemId', requireRole('admin','gestor','atendente'), async (req, res) => {
  try {
    const { descricao, quantidade, valor_unitario, valor_total } = req.body;
    const { rows } = await db.query(
      `UPDATE orcamento_itens SET descricao=COALESCE($1,descricao), quantidade=COALESCE($2,quantidade),
       valor_unitario=COALESCE($3,valor_unitario), valor_total=COALESCE($4,valor_total)
       WHERE id=$5 AND orcamento_id=$6 RETURNING *`,
      [descricao, quantidade, valor_unitario, valor_total, req.params.itemId, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ erro: ['Item não encontrado'] });
    await db.query(
      `UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ erro: [e.message] }); }
});

router.delete('/:id/itens/:itemId', requireRole('admin','gestor'), async (req, res) => {
  try {
    await db.query(`DELETE FROM orcamento_itens WHERE id=$1 AND orcamento_id=$2`, [req.params.itemId, req.params.id]);
    await db.query(
      `UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: [e.message] }); }
});

module.exports = router;
