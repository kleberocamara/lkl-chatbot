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

// POST /:id/cobrar — admin gera cobrança (boleto ou pix)
router.post('/:id/cobrar', requireRole('admin'), async (req, res) => {
  try {
    const { tipo } = req.body || {};
    if (!tipo) return res.status(400).json({ errors: ['tipo é obrigatório (boleto ou pix)'] });
    const result = await service.cobrar(req.params.id, tipo);
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

module.exports = router;
