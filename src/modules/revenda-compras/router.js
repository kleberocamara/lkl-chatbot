const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();
const equipe = requireRole('admin', 'gestor', 'atendente');
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); } };

router.get('/a-comprar', equipe, wrap(async (req, res) => res.json(await service.itensACompra())));

router.get('/', equipe, wrap(async (req, res) => res.json(await service.listar({ status: req.query.status }))));

router.get('/:id', equipe, wrap(async (req, res) => {
  const c = await service.detalhe(req.params.id);
  if (!c) return res.status(404).json({ error: 'Compra não encontrada' });
  res.json(c);
}));

router.post('/', equipe, wrap(async (req, res) => {
  const r = await service.criarCompra(req.body, req.user?.id);
  if (r.erro) return res.status(400).json({ errors: r.erro });
  res.status(201).json(r.item);
}));

router.patch('/:id/receber', equipe, wrap(async (req, res) => {
  const r = await service.receber(req.params.id, req.user?.id);
  if (r.erro) return res.status(400).json({ errors: r.erro });
  res.json(r.item);
}));

module.exports = router;
