// src/modules/nfe/router.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');

const router = express.Router();

router.post('/:orcamento_id/emitir', requireRole('admin', 'operador'), async (req, res) => {
  try {
    const result = await service.emitir(req.params.orcamento_id, req.body);
    if (result.erro) return res.status(result.erro[0].includes('não encontrado') ? 404 : 400).json({ errors: result.erro });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/:orcamento_id', requireRole('admin', 'operador'), async (req, res) => {
  try {
    const notas = await service.listarPorOrcamento(req.params.orcamento_id);
    res.json(notas);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.get('/danfe/:id', requireRole('admin', 'operador'), async (req, res) => {
  try {
    const r = await require('../../db').query(
      'SELECT danfe_path, chave FROM nfe WHERE id = $1', [req.params.id]
    );
    if (!r.rows[0] || !r.rows[0].danfe_path) {
      return res.status(404).json({ error: 'DANFE não encontrado' });
    }
    const filePath = path.join(__dirname, '../../../public', r.rows[0].danfe_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
    res.download(filePath, `DANFE-${r.rows[0].chave}.pdf`);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
