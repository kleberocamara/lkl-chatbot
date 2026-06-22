const express = require('express');
const service = require('./service');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { page, limit, busca, status } = req.query;
    res.json(await service.listar({ page: parseInt(page)||1, limit: parseInt(limit)||20, busca, status }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const f = await service.buscarPorId(req.params.id);
    if (!f) return res.status(404).json({ error: 'Fornecedor não encontrado' });
    res.json(f);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/', async (req, res) => {
  try {
    const result = await service.criar(req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result.fornecedor);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.put('/:id', async (req, res) => {
  try {
    const result = await service.atualizar(req.params.id, req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result.fornecedor);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const result = await service.atualizar(req.params.id, req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result.fornecedor);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
