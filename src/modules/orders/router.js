const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { page, limit, status, cliente_id, origin_channel } = req.query;
    res.json(await service.listar({
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      status,
      cliente_id,
      origin_channel,
    }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const order = await service.buscarPorId(req.params.id);
    if (!order) return res.status(404).json({ error: 'OS não encontrada' });
    res.json(order);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/', async (req, res) => {
  try {
    const result = await service.criarOrder(req.body, req.user.id);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result.order);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.patch('/:id/status', requireRole('admin', 'gestor', 'atendente', 'operador', 'analyst'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status é obrigatório' });
    const result = await service.atualizarStatus(req.params.id, status);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result.order);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
