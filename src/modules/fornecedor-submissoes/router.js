const express = require('express');
const router = express.Router();
const { requireRole } = require('../../middleware/auth');
const submissaoService = require('../portal-fornecedor/submissao-service');

router.get('/', async (req, res) => {
  try {
    const r = await submissaoService.listarFila({ status: req.query.status });
    res.json(r);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await submissaoService.buscarSubmissaoDetalhe(req.params.id);
    if (!r) return res.status(404).json({ error: 'Submissão não encontrada' });
    res.json(r);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/:id/aprovar-dado-bancario', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const r = await submissaoService.aprovarDadoBancario(req.params.id, req.user.id);
    if (r.erro) return res.status(400).json({ erro: r.erro });
    res.json(r);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
