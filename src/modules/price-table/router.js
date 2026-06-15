const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();

router.get('/catalogo', async (req, res) => {
  try { res.json(await service.listarCatalogo()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/calcular', async (req, res) => {
  try {
    const { produto, acabamento, quantidade } = req.query;
    if (!produto || !quantidade)
      return res.status(400).json({ error: 'produto e quantidade são obrigatórios' });
    const preco = await service.calcularPreco(produto, acabamento, parseInt(quantidade));
    if (!preco)
      return res.status(404).json({ error: 'Nenhuma faixa de preço encontrada para esses parâmetros' });
    res.json(preco);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/', requireRole('admin', 'gestor'), async (req, res) => {
  try { res.json(await service.listarTodos()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.criar(req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result.item);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.put('/:id', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.atualizar(req.params.id, req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result.item);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
