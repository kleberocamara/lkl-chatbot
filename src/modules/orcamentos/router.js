const express = require('express');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');

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
    const vendedor_id = req.user.role === 'vendedor' ? req.user.id : req.query.vendedor_id;
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
    if (result.erro) return res.status(400).json({ errors: result.erro });
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
    if (result.erro) return res.status(400).json({ errors: result.erro });
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
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
