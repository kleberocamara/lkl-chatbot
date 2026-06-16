const express = require('express');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');

const router = express.Router();

// GET / — list OSs (any authenticated user)
router.get('/', async (req, res) => {
  try {
    const { page, limit, status, orcamento_id } = req.query;
    const result = await service.listar({
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      status,
      orcamento_id,
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /:id — detail (any authenticated user)
router.get('/:id', async (req, res) => {
  try {
    const os = await service.buscarPorId(req.params.id);
    if (!os) return res.status(404).json({ error: 'OS não encontrada' });
    res.json(os);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PATCH /:id/status — admin ou operador
router.patch('/:id/status', requireRole('admin', 'operador'), async (req, res) => {
  try {
    const { status, responsavel_id } = req.body;
    if (!status) return res.status(400).json({ errors: ['status é obrigatório'] });
    const result = await service.atualizarStatus(req.params.id, status, responsavel_id);
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrada'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
