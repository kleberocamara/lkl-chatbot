const express = require('express');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');

const router = express.Router();

router.get('/dre', requireRole('admin', 'gestor', 'financeiro'), async (req, res) => {
  try {
    const result = await service.dre({ inicio: req.query.inicio, fim: req.query.fim });
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/fluxo-caixa', requireRole('admin', 'gestor', 'financeiro'), async (req, res) => {
  try {
    const result = await service.fluxoCaixa({ dias: req.query.dias });
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/metas', requireRole('admin', 'gestor', 'financeiro'), async (req, res) => {
  try {
    const result = await service.metaMes({ ano: req.query.ano, mes: req.query.mes });
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/metas', requireRole('admin', 'gestor', 'financeiro'), async (req, res) => {
  try {
    const result = await service.salvarMeta(req.body || {});
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result.meta);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/indicadores', requireRole('admin', 'gestor', 'financeiro'), async (req, res) => {
  try {
    const result = await service.indicadores({ ano: req.query.ano, mes: req.query.mes });
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/insights', requireRole('admin', 'gestor', 'financeiro'), async (req, res) => {
  try {
    res.json(await service.ultimoInsight());
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/insights', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.gerarInsight();
    res.status(201).json(result);
  } catch (err) {
    console.error('[INSIGHTS]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao gerar análise' });
  }
});

module.exports = router;
