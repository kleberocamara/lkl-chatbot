const express = require('express');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');

const router = express.Router();

// GET / — lista (qualquer autenticado: operador/atendente montam a OS)
router.get('/', async (req, res) => {
  try {
    const { busca, status, page, limit } = req.query;
    res.json(await service.listar({ busca, status, page: parseInt(page) || 1, limit: parseInt(limit) || 50 }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const m = await service.buscarPorId(req.params.id);
    if (!m) return res.status(404).json({ error: 'Máquina não encontrada' });
    res.json(m);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.criar(req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result.maquina);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.patch('/:id', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.atualizar(req.params.id, req.body);
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrada'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result.maquina);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
