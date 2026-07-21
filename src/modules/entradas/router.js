const express = require('express');
const multer = require('multer');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');
const submissaoService = require('../portal-fornecedor/submissao-service');
const db = require('../../db');

const router = express.Router();
const uploadXml = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// POST /preview — recebe o XML (multipart campo "xml") e devolve a pré-visualização
router.post('/preview', requireRole('admin', 'gestor'), uploadXml.single('xml'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo XML não enviado' });
    const result = await service.preview(req.file.buffer.toString('utf8'));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'XML inválido' });
  }
});

// POST / — confirma a entrada
router.post('/', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.confirmar({ ...req.body });
    if (result.erro) {
      const dup = result.erro.some(e => e.includes('já lançada'));
      return res.status(dup ? 409 : 400).json({ errors: result.erro });
    }
    res.status(201).json(result.entrada);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// POST /:id/estornar
router.post('/:id/estornar', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.estornar(req.params.id, { userId: req.user.id });
    if (result.erro) {
      const nf = result.erro.some(e => e.includes('não encontrada'));
      return res.status(nf ? 404 : 400).json({ errors: result.erro });
    }
    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/', requireRole('admin', 'gestor'), async (req, res) => {
  try { res.json(await service.listar()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// GET /pre-preenchido/:submissaoId — devolve os dados de uma submissão do portal do
// fornecedor no mesmo formato do preview de importação de XML de NF-e (abrirPreviewNfe),
// pra reaproveitar o mesmo modal do painel.
router.get('/pre-preenchido/:submissaoId', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const sub = await submissaoService.buscarSubmissaoDetalhe(req.params.submissaoId);
    if (!sub) return res.status(404).json({ error: 'Submissão não encontrada' });
    const forn = await db.query('SELECT id, nome FROM fornecedores WHERE id = $1', [sub.fornecedor_id]);
    res.json({
      chave: null,
      nnf: sub.nnf,
      emitida_em: sub.emitida_em,
      valor_total: sub.valor_total,
      fornecedor: forn.rows[0] || null,
      itens: sub.itens.map(it => ({
        xprod: it.produto, cprod: null, cean: null, ucom: 'UN',
        qcom: Number(it.quantidade), vun: Number(it.valor_unitario), material_id: null,
      })),
      fornecedor_submissao_id: sub.id,
      boletos: sub.boletos.map(b => ({ linha_digitavel: b.linha_digitavel, valor: Number(b.valor), vencimento: b.vencimento })),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/:id', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const e = await service.buscarPorId(req.params.id);
    if (!e) return res.status(404).json({ error: 'Entrada não encontrada' });
    res.json(e);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
