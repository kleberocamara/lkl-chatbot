const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  try { res.json(await service.listar(req.query)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const f = await service.buscarPorId(req.params.id);
    if (!f) return res.status(404).json({ error: 'Funcionário não encontrado' });
    res.json(f);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.criar(req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result.funcionario);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.patch('/:id', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.atualizar(req.params.id, req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result.funcionario);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
