const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();
const adminGestor = requireRole('admin', 'gestor');
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); } };

router.get('/categorias', adminGestor, wrap(async (req, res) => res.json(await service.listarCategorias())));
router.post('/categorias', adminGestor, wrap(async (req, res) => {
  const r = await service.criarCategoria(req.body); if (r.erro) return res.status(400).json({ errors: r.erro }); res.status(201).json(r.item);
}));
router.put('/categorias/:id', adminGestor, wrap(async (req, res) => {
  const r = await service.atualizarCategoria(req.params.id, req.body); if (r.erro) return res.status(400).json({ errors: r.erro }); res.json(r.item);
}));

router.get('/produtos', wrap(async (req, res) => res.json(await service.listarProdutos({ busca: req.query.busca }))));
router.get('/produtos/:id', wrap(async (req, res) => {
  const p = await service.detalheProduto(req.params.id); if (!p) return res.status(404).json({ error: 'Produto não encontrado' }); res.json(p);
}));
router.post('/produtos', adminGestor, wrap(async (req, res) => {
  const r = await service.criarProduto(req.body); if (r.erro) return res.status(400).json({ errors: r.erro }); res.status(201).json(r.item);
}));
router.put('/produtos/:id', adminGestor, wrap(async (req, res) => {
  const r = await service.atualizarProduto(req.params.id, req.body); if (r.erro) return res.status(400).json({ errors: r.erro }); res.json(r.item);
}));

// Sugestões de tamanho ligeiramente menor e mais barato (ver service).
// Consultado na tela de Novo Pedido antes de salvar, para o atendente poder
// oferecer a troca ao cliente. Sem alternativa vantajosa, responde { sugestao: null }.
router.post('/sugestao-tamanho', wrap(async (req, res) => {
  const r = await service.sugerirTamanhosAlternativos(req.body || {});
  res.json({ sugestao: r });
}));

router.post('/sincronizar', adminGestor, wrap(async (req, res) => {
  const r = await service.dispararSync(); if (r.erro) return res.status(409).json({ errors: r.erro }); res.json({ ok: true });
}));
router.get('/sync/status', wrap(async (req, res) => res.json(await service.statusSync())));

router.get('/config', wrap(async (req, res) => res.json(await service.getConfig())));
router.put('/config', adminGestor, wrap(async (req, res) => res.json((await service.setConfig(req.body)).item)));

router.post('/preview', wrap(async (req, res) => {
  const { revenda_produto_id, quantidade, prazo_horas, acabamentos, largura_cm, altura_cm } = req.body;
  const r = await service.precificarItemRevenda({ revenda_produto_id, quantidade, prazo_horas, acabamentos, largura_cm, altura_cm });
  if (!r) return res.json({ auto: false });
  res.json({ auto: true, ...r });
}));

module.exports = router;
