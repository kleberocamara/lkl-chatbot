const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { requireAuthFornecedor } = require('../../middleware/auth');
const authService = require('./auth-service');
const submissaoService = require('./submissao-service');
const ocr = require('../contas-pagar/ocr');

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../../../public/uploads/fornecedor-submissoes'),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ── Rotas públicas ──────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: 'email e senha são obrigatórios' });
  const r = await authService.login(email, senha);
  if (r.erro) return res.status(401).json({ error: r.erro[0] });
  res.json({ token: r.token });
});

router.post('/definir-senha', async (req, res) => {
  const { token, senha } = req.body;
  if (!token || !senha) return res.status(400).json({ error: 'token e senha são obrigatórios' });
  const r = await authService.definirSenha(token, senha);
  if (r.erro) return res.status(400).json({ error: r.erro[0] });
  res.json({ ok: true });
});

// ── Rotas do fornecedor autenticado ─────────────────────────────────────────

router.use(requireAuthFornecedor);

router.post('/nf/extrair', upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const dados = await ocr.extrairDadosNFCompra(req.file.path);
  if (!dados) return res.status(422).json({ error: 'Não consegui ler os dados da NF — preencha manualmente' });
  res.json({ ...dados, arquivo_nf_path: `/uploads/fornecedor-submissoes/${req.file.filename}` });
});

router.post('/boleto/extrair', upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const arquivo_path = `/uploads/fornecedor-submissoes/${req.file.filename}`;
  const dados = await ocr.extrairLinhaDigitavel(req.file.path);
  if (!dados) {
    return res.status(422).json({ error: 'Não consegui ler a linha digitável — preencha manualmente', arquivo_path });
  }
  res.json({ ...dados, arquivo_path });
});

router.post('/submissoes', async (req, res) => {
  try {
    const { submissao, alertas } = await submissaoService.criarSubmissao(req.fornecedor.fornecedorId, req.body);
    res.status(201).json({ submissao, alertas });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/submissoes', async (req, res) => {
  const r = await submissaoService.listarMinhasSubmissoes(req.fornecedor.fornecedorId);
  res.json(r);
});

module.exports = router;
