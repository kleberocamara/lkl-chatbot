const express = require('express');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');

const router = express.Router();
const admin = requireRole('admin');

// KPIs
router.get('/kpis', admin, async (req, res) => {
  try { res.json(await service.kpis()); }
  catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Tipos de despesa (taxonomia)
router.get('/tipos-despesa', admin, async (req, res) => {
  try { res.json(await service.listarTiposDespesa()); }
  catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Sugestão de classificação automática
router.get('/sugerir-tipo', admin, async (req, res) => {
  try {
    const { fornecedor_id, fornecedor, descricao } = req.query;
    res.json(await service.sugerirTipoDespesa({ fornecedor_id, fornecedor, descricao }));
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Listar
router.get('/', admin, async (req, res) => {
  try {
    const { status, tipo_despesa_id, vencimento_de, vencimento_ate, dias } = req.query;
    res.json(await service.listar({
      status, tipo_despesa_id, vencimento_de, vencimento_ate,
      dias: dias !== undefined ? parseInt(dias) : undefined,
    }));
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Criar
router.post('/', admin, async (req, res) => {
  try {
    const result = await service.criar(req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.status(201).json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Criar recorrente
router.post('/recorrente', admin, async (req, res) => {
  try {
    const result = await service.criarRecorrente(req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.status(201).json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Criar parcelado
router.post('/parcelado', admin, async (req, res) => {
  try {
    const result = await service.criarParcelado(req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.status(201).json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Converter conta existente em parcelado
router.post('/:id/parcelar', admin, async (req, res) => {
  try {
    const result = await service.converterEmParcelado(req.params.id, req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.status(201).json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Sincronizar DDA
router.get('/dda/sync', admin, async (req, res) => {
  try { res.json(await service.sincronizarDDA()); }
  catch (err) { console.error('[CONTAS-PAGAR-DDA]', err); res.status(500).json({ error: 'Erro ao sincronizar DDA' }); }
});

// Listar histórico de lotes
router.get('/lotes', admin, async (req, res) => {
  try { res.json(await service.listarLotes()); }
  catch (err) { console.error('[CONTAS-PAGAR-LOTE]', err); res.status(500).json({ error: 'Erro ao listar lotes' }); }
});

// Criar lote C6
router.post('/lote', admin, async (req, res) => {
  try {
    const { ids, uploaderName } = req.body;
    const result = await service.criarLoteC6(ids, uploaderName);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.status(201).json(result);
  } catch (err) { console.error('[CONTAS-PAGAR-LOTE]', err); res.status(500).json({ error: 'Erro ao criar lote' }); }
});

// Consultar lote
router.get('/lote/:groupId', admin, async (req, res) => {
  try { res.json(await service.consultarLoteC6(req.params.groupId)); }
  catch (err) { console.error('[CONTAS-PAGAR-LOTE]', err); res.status(500).json({ error: 'Erro ao consultar lote' }); }
});

// Remover item do lote
router.delete('/lote/:groupId/item/:itemId', admin, async (req, res) => {
  try {
    const result = await service.removerItemLoteC6(req.params.groupId, req.params.itemId);
    res.json(result);
  } catch (err) { console.error('[CONTAS-PAGAR-LOTE]', err); res.status(500).json({ error: 'Erro ao remover item' }); }
});

// Submeter lote
router.post('/lote/:groupId/submeter', admin, async (req, res) => {
  try {
    const result = await service.submeterLoteC6(req.params.groupId, req.body.uploaderName);
    res.json(result);
  } catch (err) { console.error('[CONTAS-PAGAR-LOTE]', err); res.status(500).json({ error: 'Erro ao submeter lote' }); }
});

// Reconciliar manual
router.post('/reconciliar', admin, async (req, res) => {
  try { res.json(await service.reconciliar()); }
  catch (err) { console.error('[CONTAS-PAGAR-RECONCILIAR]', err); res.status(500).json({ error: 'Erro ao reconciliar' }); }
});

// Editar
router.patch('/:id', admin, async (req, res) => {
  try {
    const result = await service.editar(req.params.id, req.body);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Pagar manualmente
router.patch('/:id/pagar', admin, async (req, res) => {
  try {
    const result = await service.pagarManual(req.params.id);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Cancelar
router.delete('/:id', admin, async (req, res) => {
  try {
    const result = await service.cancelar(req.params.id);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result);
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
