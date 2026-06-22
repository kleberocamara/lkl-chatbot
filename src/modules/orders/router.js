const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { page, limit, status, cliente_id, origin_channel, busca } = req.query;
    const opts = {
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50,
      status, cliente_id, origin_channel, busca,
    };
    if (req.user.role === 'vendedor') opts.vendedorId = req.user.id;
    const result = await service.listar(opts);
    res.json({ data: result.orders, total: result.total, page: result.page, limit: result.limit });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const order = await service.buscarPorId(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido não encontrado' });
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

// Edição do pedido (contato do cliente + observações/prazo)
router.patch('/:id',
  requireRole('admin', 'gestor', 'atendente'),
  async (req, res) => {
    try {
      const result = await service.atualizarPedido(req.params.id, req.body);
      if (result.erro) return res.status(400).json({ errors: result.erro });
      res.json(result.order);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
  }
);

router.patch('/:id/status',
  requireRole('admin', 'gestor', 'atendente', 'operador', 'analista', 'financeiro'),
  async (req, res) => {
    try {
      const { status } = req.body;
      if (!status) return res.status(400).json({ error: 'status é obrigatório' });
      const result = await service.atualizarStatus(req.params.id, status);
      if (result.erro) return res.status(400).json({ errors: result.erro });
      res.json(result.order);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
  }
);

module.exports = router;
