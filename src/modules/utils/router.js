const express = require('express');
const axios = require('axios');
const { requireAuthApi } = require('../../middleware/auth');

const router = express.Router();

router.get('/cep/:cep', requireAuthApi, async (req, res) => {
  const cep = req.params.cep.replace(/\D/g, '');
  if (cep.length !== 8) return res.status(400).json({ error: 'CEP inválido — deve ter 8 dígitos' });
  try {
    const { data } = await axios.get(`https://viacep.com.br/ws/${cep}/json/`, { timeout: 5000 });
    if (data.erro) return res.status(404).json({ error: 'CEP não encontrado' });
    res.json({
      cep: data.cep,
      logradouro: data.logradouro,
      bairro: data.bairro,
      cidade: data.localidade,
      uf: data.uf,
    });
  } catch {
    res.status(502).json({ error: 'Falha ao consultar ViaCEP — tente novamente' });
  }
});

module.exports = router;
