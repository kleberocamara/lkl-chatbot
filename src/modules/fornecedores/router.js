const express = require('express');
const service = require('./service');
const db = require('../../db');
const authService = require('../portal-fornecedor/auth-service');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { page, limit, busca, status } = req.query;
    res.json(await service.listar({ page: parseInt(page)||1, limit: parseInt(limit)||20, busca, status }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const f = await service.buscarPorId(req.params.id);
    if (!f) return res.status(404).json({ error: 'Fornecedor não encontrado' });
    res.json(f);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/', async (req, res) => {
  try {
    const result = await service.criar(req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result.fornecedor);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.put('/:id', async (req, res) => {
  try {
    const result = await service.atualizar(req.params.id, req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result.fornecedor);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.patch('/:id', async (req, res) => {
  try {
    const result = await service.atualizar(req.params.id, req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result.fornecedor);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/:id/portal/liberar', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email é obrigatório' });
    const forn = await db.query('SELECT id, nome FROM fornecedores WHERE id = $1', [req.params.id]);
    if (!forn.rows[0]) return res.status(404).json({ error: 'Fornecedor não encontrado' });
    const { conviteToken } = await authService.criarConvite(req.params.id, email);
    const baseUrl = process.env.BASE_URL || 'https://app.graficalkl.com.br';
    res.json({ ok: true, conviteUrl: `${baseUrl}/portal-fornecedor/definir-senha.html?token=${conviteToken}` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
