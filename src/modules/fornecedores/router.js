const express = require('express');
const service = require('./service');
const db = require('../../db');
const authService = require('../portal-fornecedor/auth-service');
const email = require('../../services/email');
const whatsapp = require('../../services/whatsapp');

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

function celularParaWhatsapp(celular) {
  const d = String(celular || '').replace(/\D/g, '');
  if (!d) return null;
  return d.startsWith('55') ? d : '55' + d;
}

router.post('/:id/portal/liberar', async (req, res) => {
  try {
    const forn = await db.query('SELECT id, nome, email, celular FROM fornecedores WHERE id = $1', [req.params.id]);
    if (!forn.rows[0]) return res.status(404).json({ error: 'Fornecedor não encontrado' });
    const { nome, email: fornEmail, celular } = forn.rows[0];
    if (!fornEmail) return res.status(400).json({ error: 'Cadastre o e-mail do fornecedor antes de liberar o acesso ao portal' });

    const { conviteToken } = await authService.criarConvite(req.params.id, fornEmail);
    const baseUrl = process.env.BASE_URL || 'https://app.graficalkl.com.br';
    const conviteUrl = `${baseUrl}/portal-fornecedor/definir-senha.html?token=${conviteToken}`;

    const avisos = [];
    let enviadoEmail = false;
    let enviadoWhatsapp = false;

    try {
      await email.enviarConvitePortalFornecedor({ email: fornEmail, nome, conviteUrl });
      enviadoEmail = true;
    } catch (e) {
      console.error('[FORNECEDORES] Falha ao enviar e-mail de convite:', e.message);
      avisos.push('Falha ao enviar e-mail: ' + e.message);
    }

    const numeroWhatsapp = celularParaWhatsapp(celular);
    if (numeroWhatsapp) {
      try {
        await whatsapp.sendMessage(numeroWhatsapp,
          `🏭 *Gráfica LKL — Portal do Fornecedor*\n\nOlá, ${nome}! Seu acesso ao Portal do Fornecedor foi liberado.\n\nDefina sua senha e acesse: ${conviteUrl}\n\nEsse link é válido por 7 dias.`);
        enviadoWhatsapp = true;
      } catch (e) {
        console.error('[FORNECEDORES] Falha ao enviar WhatsApp de convite:', e.message);
        avisos.push('Falha ao enviar WhatsApp: ' + e.message);
      }
    } else {
      avisos.push('Sem celular cadastrado — WhatsApp não enviado');
    }

    res.json({ ok: true, conviteUrl, enviadoEmail, enviadoWhatsapp, avisos });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
