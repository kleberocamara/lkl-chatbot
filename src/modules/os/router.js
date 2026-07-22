const express = require('express');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');
const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: path.join(__dirname, '../../../public/uploads/entregas'),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Apenas imagens são aceitas'));
  },
});

const uploadArtes = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../../../public/uploads/artes'),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Apenas imagens são aceitas'));
  },
});

const router = express.Router();

// GET / — list OSs (any authenticated user)
router.get('/', async (req, res) => {
  try {
    const { page, limit, status, orcamento_id } = req.query;
    const result = await service.listar({
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 20,
      status,
      orcamento_id,
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Itens offset aprovados sem OS (fila de agrupamento)
router.get('/itens-disponiveis', requireRole('admin','gestor','analista'), async (req, res) => {
  try {
    const itens = await service.itensOffsetDisponiveis();
    res.json(itens);
  } catch (e) { console.error('[OS-DISP]', e); res.status(500).json({ error: 'Erro interno' }); }
});

// Cria OS offset agrupada
router.post('/', requireRole('admin','gestor','analista'), async (req, res) => {
  try {
    const result = await service.criarOSOffset(req.body, req.user.id);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result);
  } catch (e) { console.error('[OS-CRIAR]', e); res.status(500).json({ error: 'Erro interno' }); }
});

// GET /:id — detail (any authenticated user)
router.get('/:id', async (req, res) => {
  try {
    const os = await service.buscarPorId(req.params.id);
    if (!os) return res.status(404).json({ error: 'OS não encontrada' });
    res.json(os);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PATCH /:id/status — admin ou operador
router.patch('/:id/status', requireRole('admin', 'operador', 'atendente', 'analista'), async (req, res) => {
  try {
    const { status, responsavel_id } = req.body;
    if (!status) return res.status(400).json({ errors: ['status é obrigatório'] });
    const result = await service.atualizarStatus(req.params.id, status, responsavel_id);
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrada'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PATCH /:id/avancar — avança a OS para a próxima fase (board de produção)
router.patch('/:id/avancar', requireRole('admin', 'operador', 'gestor', 'atendente', 'analista'), async (req, res) => {
  try {
    const result = await service.avancarFase(req.params.id, req.user.id);
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrada'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result);
  } catch (err) {
    console.error('[OS-AVANCAR]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /:id/historico — histórico de fases da OS
router.get('/:id/historico', async (req, res) => {
  try {
    const rows = await service.historico(req.params.id);
    res.json(rows);
  } catch (err) {
    console.error('[OS-HIST]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// PATCH /:id/enviar-arte — atendente/admin envia imagem da arte ao cliente via WhatsApp
router.patch('/:id/enviar-arte', requireRole('admin', 'atendente', 'analista'), uploadArtes.single('arte'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ errors: ['Arquivo de arte é obrigatório'] });
    const arquivo_url = `/uploads/artes/${req.file.filename}`;
    const result = await service.enviarArte(req.params.id, { arquivo_url });
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrada'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Ficha de produção offset (parâmetros + vias/materiais)
router.patch('/:id/producao', requireRole('admin','gestor','analista','operador'), async (req, res) => {
  try {
    const result = await service.atualizarFichaProducao(req.params.id, req.body);
    if (result.erro) {
      const nf = result.erro.some(e => e.includes('não encontrada'));
      return res.status(nf ? 404 : 400).json(nf ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result.os);
  } catch (e) { console.error('[OS-PRODUCAO]', e); res.status(500).json({ error: 'Erro interno' }); }
});

// OS-3C: baixa manual de materiais
router.post('/:id/requisicao', requireRole('admin','gestor','atendente','analista'), async (req, res) => {
  try {
    const result = await service.baixarMateriais(req.params.id, { userId: req.user.id });
    if (result.erro) {
      const nf = result.erro.some(e => e.includes('não encontrada'));
      return res.status(nf ? 404 : 400).json(nf ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.status(201).json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// OS-3C: estorno da requisição ativa
router.post('/:id/requisicao/estornar', requireRole('admin','gestor'), async (req, res) => {
  try {
    const result = await service.estornarRequisicao(req.params.id, { userId: req.user.id });
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// PATCH /:id/entregar — motorista ou admin
router.patch('/:id/entregar', requireRole('admin', 'motorista'), upload.single('foto_documento'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ errors: ['foto_documento é obrigatória'] });
    const foto_url = `/uploads/entregas/${req.file.filename}`;
    const { nome_recebedor } = req.body;
    const result = await service.entregar(req.params.id, { nome_recebedor, foto_url, userId: req.user.id });
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrada'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
