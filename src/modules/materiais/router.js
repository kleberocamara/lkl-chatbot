const express = require('express');
const service = require('./service');

const router = express.Router();

router.get('/', async (req, res) => {
  try { res.json(await service.listar(req.query)); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const m = await service.buscarPorId(req.params.id);
    if (!m) return res.status(404).json({ error: 'Material não encontrado' });
    res.json(m);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/', async (req, res) => {
  try {
    const result = await service.criar(req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result.material);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.patch('/:id/estoque', async (req, res) => {
  try {
    const { quantidade, tipo } = req.body;
    if (!quantidade || !['entrada', 'saida'].includes(tipo))
      return res.status(400).json({ error: 'quantidade e tipo (entrada|saida) são obrigatórios' });
    const result = await service.atualizarEstoque(req.params.id, quantidade, tipo);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result.material);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
