const express = require('express');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');

const router = express.Router();
const admin = requireRole('admin');

router.post('/sincronizar', admin, async (req, res) => {
  try {
    const { start_date, end_date } = req.body || {};
    const r = await service.sincronizar({ startDate: start_date, endDate: end_date });
    res.json(r);
  } catch (err) {
    console.error('[CONCILIACAO]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/lancamentos', admin, async (req, res) => {
  try {
    const { status, start_date, end_date } = req.query;
    const r = await service.listarLancamentos({ status, startDate: start_date, endDate: end_date });
    res.json(r);
  } catch (err) {
    console.error('[CONCILIACAO]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/sem-correspondencia-banco', admin, async (req, res) => {
  try {
    const dias = req.query.dias ? parseInt(req.query.dias) : 30;
    const r = await service.semCorrespondenciaNoBanco({ dias });
    res.json(r);
  } catch (err) {
    console.error('[CONCILIACAO]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/:id/vincular', admin, async (req, res) => {
  try {
    const { tipo, alvo_id } = req.body || {};
    const r = await service.vincularManual(req.params.id, tipo, alvo_id);
    if (r.erro) return res.status(400).json({ erro: r.erro });
    res.json(r);
  } catch (err) {
    console.error('[CONCILIACAO]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/:id/ignorar', admin, async (req, res) => {
  try {
    const r = await service.ignorar(req.params.id);
    if (r.erro) return res.status(400).json({ erro: r.erro });
    res.json(r);
  } catch (err) {
    console.error('[CONCILIACAO]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
