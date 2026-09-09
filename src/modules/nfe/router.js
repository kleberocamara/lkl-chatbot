// src/modules/nfe/router.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');

const router = express.Router();

// Inutilização (sem nfe_id específico — deve ficar antes de /:nfe_id)
router.post('/inutilizar', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.inutilizar(req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) {
    console.error('[NFE-INUTILIZAR]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

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

// Cancelamento
router.post('/:nfe_id/cancelar', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.cancelar(req.params.nfe_id, req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) {
    console.error('[NFE-CANCELAR]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Carta de Correção
router.post('/:nfe_id/corrigir', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.corrigir(req.params.nfe_id, req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) {
    console.error('[NFE-CORRIGIR]', err);
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

// PDF da carta de correção (DACCE). Gera na hora e reaproveita o arquivo em
// chamadas seguintes; sem `seq`, entrega a carta mais recente da NF-e.
router.get('/cce/:id', requireRole('admin', 'operador'), async (req, res) => {
  try {
    const db = require('../../db');
    const r = await db.query(
      `SELECT n.chave, n.cnpj_emitente, n.xml,
              e.xml_evento, e.protocolo,
              ROW_NUMBER() OVER (ORDER BY e.id) AS n_seq
         FROM nfe n JOIN nfe_eventos e ON e.nfe_id = n.id
        WHERE n.id = $1 AND e.tipo = 'cc_e' AND e.c_stat = '135'
        ORDER BY e.id`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'CC-e não encontrada' });

    const seq = req.query.seq ? parseInt(req.query.seq, 10) : null;
    const evento = seq
      ? r.rows.find((row) => Number(row.n_seq) === seq)
      : r.rows[r.rows.length - 1];
    if (!evento) return res.status(404).json({ error: 'Sequência de CC-e não encontrada' });
    if (!evento.xml_evento) return res.status(404).json({ error: 'XML do evento não armazenado' });

    const { gerarDacce } = require('../../services/nfe');
    const filePath = await gerarDacce({
      xmlEvento: evento.xml_evento,
      chave: evento.chave,
      nSeq: evento.n_seq,
      cnpjEmitente: evento.cnpj_emitente,
      destinatario: destinatarioDoXml(evento.xml),
      protocolo: evento.protocolo,
    });
    res.download(filePath, `CCe-${evento.chave}-${evento.n_seq}.pdf`);
  } catch (err) {
    console.error('[NFE-CCE-PDF]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// O XML do evento só traz a chave da NF-e, então o destinatário vem do XML da nota.
function destinatarioDoXml(xml) {
  if (!xml) return null;
  const dest = /<dest\b[\s\S]*?<\/dest>/.exec(xml)?.[0];
  if (!dest) return null;
  const tag = (nome) => {
    const m = new RegExp(`<${nome}>([^<]*)</${nome}>`).exec(dest);
    return m ? m[1].trim() : '';
  };
  return {
    nome: tag('xNome'),
    cpf_cnpj: tag('CNPJ') || tag('CPF'),
    logradouro: tag('xLgr'),
    numero: tag('nro'),
    bairro: tag('xBairro'),
    municipio: tag('xMun'),
    uf: tag('UF'),
  };
}

router.get('/xml/:id', requireRole('admin', 'operador'), async (req, res) => {
  try {
    const r = await require('../../db').query(
      'SELECT xml, chave FROM nfe WHERE id = $1', [req.params.id]
    );
    if (!r.rows[0] || !r.rows[0].xml) {
      return res.status(404).json({ error: 'XML não encontrado' });
    }
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="NFe-${r.rows[0].chave}.xml"`);
    res.send(r.rows[0].xml);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
