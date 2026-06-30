const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();
const adminGestor = requireRole('admin', 'gestor');

// Preview de cálculo (qualquer role autenticada) — não grava nada.
router.post('/preview', async (req, res) => {
  try {
    const { produto, material_id, quantidade, largura_cm, altura_cm } = req.body;
    const r = await service.precificarItem({ produto, material_id, quantidade, largura_cm, altura_cm });
    if (!r) return res.json({ auto: false }); // sem regra/sem cálculo → manual
    res.json({ auto: true, ...r });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// Regras
router.get('/regras', adminGestor, async (req, res) => {
  try { res.json(await service.listarRegras()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
router.post('/regras', adminGestor, async (req, res) => {
  try {
    const r = await service.criarRegra(req.body);
    if (r.erro) return res.status(400).json({ errors: r.erro });
    res.status(201).json(r.item);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
router.put('/regras/:id', adminGestor, async (req, res) => {
  try {
    const r = await service.atualizarRegra(req.params.id, req.body);
    if (r.erro) return res.status(400).json({ errors: r.erro });
    res.json(r.item);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// Faixas
router.get('/regras/:id/faixas', adminGestor, async (req, res) => {
  try { res.json(await service.listarFaixas(req.params.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
router.post('/regras/:id/faixas', adminGestor, async (req, res) => {
  try {
    const r = await service.criarFaixa(req.params.id, req.body);
    if (r.erro) return res.status(400).json({ errors: r.erro });
    res.status(201).json(r.item);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
router.delete('/faixas/:id', adminGestor, async (req, res) => {
  try { res.json(await service.removerFaixa(req.params.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// Bobinas por material
router.get('/materiais/:id/bobinas', adminGestor, async (req, res) => {
  try { res.json(await service.listarBobinas(req.params.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
router.post('/materiais/:id/bobinas', adminGestor, async (req, res) => {
  try {
    const r = await service.criarBobina(req.params.id, req.body);
    if (r.erro) return res.status(400).json({ errors: r.erro });
    res.status(201).json(r.item);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
router.delete('/bobinas/:id', adminGestor, async (req, res) => {
  try { res.json(await service.removerBobina(req.params.id)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
