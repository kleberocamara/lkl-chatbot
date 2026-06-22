const express = require('express');
const service = require('./service');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { page, limit, busca, q, status } = req.query;
    const result = await service.listar({ page: parseInt(page) || 1, limit: parseInt(limit) || 20, busca: busca || q, status });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Busca cliente pelo celular ou pelo WhatsApp (contacts.phone)
router.get('/por-telefone', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone é obrigatório' });
  try {
    const db = require('../../db');
    const digits = phone.replace(/\D/g, '');
    const r = await db.query(
      `SELECT cl.id, cl.nome, cl.celular, cl.email, ct.phone AS whatsapp
       FROM clientes_lkl cl
       LEFT JOIN contacts ct ON ct.id = cl.contact_id
       WHERE REGEXP_REPLACE(cl.celular, '[^0-9]', '', 'g') LIKE $1
          OR REGEXP_REPLACE(ct.phone,   '[^0-9]', '', 'g') LIKE $1
       LIMIT 5`,
      [`%${digits}`]
    );
    res.json(r.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/busca', async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'Parâmetro q é obrigatório' });
  try {
    const result = await service.listar({ busca: req.query.q, limit: 10 });
    res.json(result.clientes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const cliente = await service.buscarPorId(req.params.id);
    if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });
    res.json(cliente);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/', async (req, res) => {
  try {
    const result = await service.criar(req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result.cliente);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const result = await service.atualizar(req.params.id, req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result.cliente);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const result = await service.atualizar(req.params.id, req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result.cliente);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
