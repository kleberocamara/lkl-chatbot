const express = require('express');
const service = require('./service');
const router = express.Router();

// Otimizador de imposição
router.get('/melhor-corte', async (req, res) => {
  try {
    const result = await service.melhorCorte(req.query);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (e) { console.error('[MELHOR-CORTE]', e); res.status(500).json({ error: 'Erro interno' }); }
});

// Lista de formatos cadastrados
router.get('/', async (req, res) => {
  try {
    res.json(await service.listar());
  } catch (e) { console.error('[FORMATOS]', e); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
