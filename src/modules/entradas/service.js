const db = require('../../db');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { format, addDays } = require('date-fns');
const contasPagarService = require('../contas-pagar/service');

// Parsing puro do XML de uma NF-e de compra → estrutura normalizada
function parseNfeCompra(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });
  let doc;
  try { doc = parser.parse(xml); } catch (e) { throw new Error('XML de NF-e inválido'); }
  const nfe = doc?.nfeProc?.NFe || doc?.NFe;
  const inf = nfe?.infNFe;
  if (!inf) throw new Error('XML de NF-e inválido');
  const chave = String(inf['@_Id'] || '').replace(/^NFe/i, '').replace(/\D/g, '').slice(0, 44) || null;
  const emit = inf.emit || {};
  const ide = inf.ide || {};
  const tot = inf.total?.ICMSTot || {};
  const dets = Array.isArray(inf.det) ? inf.det : (inf.det ? [inf.det] : []);
  const itens = dets.map(d => {
    const p = d.prod || {};
    const ceanRaw = p.cEAN != null ? String(p.cEAN) : '';
    const cean = (ceanRaw && !/SEM\s*GTIN/i.test(ceanRaw)) ? ceanRaw : null;
    return {
      cprod: p.cProd != null ? String(p.cProd) : null,
      cean,
      xprod: p.xProd || null,
      ucom: p.uCom || null,
      qcom: p.qCom != null ? parseFloat(p.qCom) : null,
      vun: p.vUnCom != null ? parseFloat(p.vUnCom) : null,
      vprod: p.vProd != null ? parseFloat(p.vProd) : null,
      ncm: p.NCM != null ? String(p.NCM) : null,
    };
  });
  const dh = ide.dhEmi || ide.dEmi || null;
  return {
    emitente: { cnpj: emit.CNPJ != null ? String(emit.CNPJ) : null, nome: emit.xNome || null },
    nnf: ide.nNF != null ? String(ide.nNF) : null,
    chave,
    emitida_em: dh ? String(dh).slice(0, 10) : null,
    valor_total: tot.vNF != null ? parseFloat(tot.vNF) : null,
    itens,
  };
}

function _soDigitos(s) { return (s || '').replace(/\D/g, ''); }

// Parse + casa fornecedor (CNPJ) e cada item (EAN/código). NÃO grava.
async function preview(xml) {
  const nf = parseNfeCompra(xml);
  let fornecedor = null;
  if (nf.emitente.cnpj) {
    const f = await db.query(
      `SELECT id, nome, cnpj FROM fornecedores WHERE regexp_replace(COALESCE(cnpj,''),'\\D','','g') = $1 LIMIT 1`,
      [_soDigitos(nf.emitente.cnpj)]);
    fornecedor = f.rows[0] || null;
  }
  const itens = [];
  for (const it of nf.itens) {
    let material = null;
    if (it.cean) {
      const m = await db.query('SELECT id, nome, codigo, codigo_barras, fator_entrada, estoque_atual FROM materiais WHERE codigo_barras = $1 LIMIT 1', [it.cean]);
      material = m.rows[0] || null;
    }
    if (!material && it.cprod) {
      const m = await db.query('SELECT id, nome, codigo, codigo_barras, fator_entrada, estoque_atual FROM materiais WHERE codigo = $1 LIMIT 1', [it.cprod]);
      material = m.rows[0] || null;
    }
    itens.push({
      ...it,
      material_id: material ? material.id : null,
      material_nome: material ? material.nome : null,
      fator: material && material.fator_entrada != null ? Number(material.fator_entrada) : 1,
    });
  }
  return { ...nf, fornecedor, fornecedor_cnpj: nf.emitente.cnpj, fornecedor_nome: nf.emitente.nome, itens };
}

// Confirma a entrada: grava cabeçalho+itens, dá entrada no estoque e recalcula custo médio.
async function confirmar({ chave, nnf, emitida_em, valor_total, fornecedor_id, itens, fornecedor_submissao_id, boletos }) {
  if (!Array.isArray(itens)) return { erro: ['itens é obrigatório'] };
  if (chave) {
    const dup = await db.query('SELECT id FROM entradas_estoque WHERE chave = $1', [chave]);
    if (dup.rows[0]) return { erro: ['NF já lançada'] };
  }
  if (fornecedor_submissao_id) {
    const sub = await db.query('SELECT status, entrada_estoque_id FROM fornecedor_submissoes WHERE id = $1', [fornecedor_submissao_id]);
    if (sub.rows[0]?.status === 'aceita') return { erro: ['Essa submissão já foi aceita — recarregue a fila de submissões'] };
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const ent = await client.query(
      `INSERT INTO entradas_estoque (fornecedor_id, nnf, chave, emitida_em, valor_total, status, criada_por)
       VALUES ($1,$2,$3,$4,$5,'lancada',$6) RETURNING *`,
      [fornecedor_id || null, nnf || null, chave || null, emitida_em || null, valor_total || null, null]);
    const entrada = ent.rows[0];
    for (const it of itens) {
      const fator = it.fator != null && it.fator !== '' ? Number(it.fator) : 1;
      const qcom = it.qcom != null ? Number(it.qcom) : 0;
      const vun = it.vun != null ? Number(it.vun) : 0;
      const qtdEstoque = qcom * fator;
      const custoUnit = fator > 0 ? vun / fator : vun;
      await client.query(
        `INSERT INTO entradas_estoque_itens (entrada_id, material_id, cprod, cean, xprod, ucom, qcom, vun, fator_aplicado, quantidade_estoque, custo_unit_estoque)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [entrada.id, it.material_id || null, it.cprod || null, it.cean || null, it.xprod || null, it.ucom || null,
         qcom, vun, fator, qtdEstoque, custoUnit]);
      if (it.material_id) {
        await client.query(
          `UPDATE materiais SET
             custo_medio = CASE WHEN (COALESCE(estoque_atual,0) + $2) > 0
                THEN (COALESCE(estoque_atual,0)*COALESCE(custo_medio,0) + $2*$3) / (COALESCE(estoque_atual,0) + $2)
                ELSE $3 END,
             estoque_atual = COALESCE(estoque_atual,0) + $2,
             updated_at = NOW()
           WHERE id = $1`,
          [it.material_id, qtdEstoque, custoUnit]);
      }
    }
    await client.query('COMMIT');

    if (fornecedor_id && valor_total) {
      try {
        const fornecedorR = await db.query('SELECT nome FROM fornecedores WHERE id=$1', [fornecedor_id]);
        let dataBase = emitida_em ? new Date(`${emitida_em}T00:00:00`) : new Date();
        if (isNaN(dataBase)) dataBase = new Date();
        const vencimentoProvisorio = format(addDays(dataBase, 30), 'yyyy-MM-dd');

        if (Array.isArray(boletos) && boletos.length > 1) {
          const parcelaGrupoId = crypto.randomUUID();
          for (let i = 0; i < boletos.length; i++) {
            await contasPagarService.criarOuReconciliarContaPagar({
              fornecedorId: fornecedor_id,
              fornecedorNome: fornecedorR.rows[0]?.nome || null,
              descricao: `NF ${nnf || 's/nº'} — boleto ${i + 1}/${boletos.length}`,
              valor: boletos[i].valor,
              vencimento: boletos[i].vencimento || vencimentoProvisorio,
              linhaDigitavel: boletos[i].linha_digitavel,
              tipoEntrada: 'entrada_estoque',
              parcelaGrupoId, parcelaNumero: i + 1, parcelaTotal: boletos.length,
            });
          }
        } else {
          const conta = await contasPagarService.criarOuReconciliarContaPagar({
            fornecedorId: fornecedor_id,
            fornecedorNome: fornecedorR.rows[0]?.nome || null,
            descricao: `NF ${nnf || 's/nº'} — entrada de estoque`,
            valor: (Array.isArray(boletos) && boletos.length === 1) ? boletos[0].valor : valor_total,
            vencimento: (Array.isArray(boletos) && boletos.length === 1) ? (boletos[0].vencimento || vencimentoProvisorio) : vencimentoProvisorio,
            linhaDigitavel: (Array.isArray(boletos) && boletos.length === 1) ? boletos[0].linha_digitavel : undefined,
            tipoEntrada: 'entrada_estoque',
          });
          if (!fornecedor_submissao_id) {
            await db.query('UPDATE entradas_estoque SET conta_pagar_id=$1 WHERE id=$2', [conta.id, entrada.id]);
          }
        }

        if (fornecedor_submissao_id) {
          await db.query('UPDATE entradas_estoque SET fornecedor_submissao_id=$1 WHERE id=$2', [fornecedor_submissao_id, entrada.id]);
          await db.query(
            `UPDATE fornecedor_submissoes SET status = 'aceita', entrada_estoque_id=$1, revisada_em=NOW() WHERE id=$2`,
            [entrada.id, fornecedor_submissao_id]
          );
        }
      } catch (e) {
        console.error('[ENTRADAS] Erro ao gerar conta a pagar da NF:', e.message);
      }
    }

    return { entrada };
  } catch (e) {
    await client.query('ROLLBACK');
    return { erro: [e.message] };
  } finally {
    client.release();
  }
}

async function estornar(entradaId, { userId } = {}) {
  const e = await db.query('SELECT id, status FROM entradas_estoque WHERE id=$1', [entradaId]);
  if (!e.rows[0]) return { erro: ['Entrada não encontrada'] };
  if (e.rows[0].status === 'estornada') return { erro: ['Entrada já estornada'] };
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const itens = await client.query('SELECT material_id, quantidade_estoque FROM entradas_estoque_itens WHERE entrada_id=$1', [entradaId]);
    for (const it of itens.rows) {
      if (it.material_id) {
        await client.query('UPDATE materiais SET estoque_atual = COALESCE(estoque_atual,0) - $1, updated_at=NOW() WHERE id=$2',
          [it.quantidade_estoque, it.material_id]);
      }
    }
    await client.query(`UPDATE entradas_estoque SET status='estornada', estornada_em=NOW(), estornada_por=$1 WHERE id=$2`,
      [userId || null, entradaId]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    return { erro: [err.message] };
  } finally {
    client.release();
  }
}

async function listar() {
  const r = await db.query(
    `SELECT e.*, f.nome AS fornecedor_nome
     FROM entradas_estoque e LEFT JOIN fornecedores f ON f.id = e.fornecedor_id
     ORDER BY e.criada_em DESC LIMIT 100`);
  return { entradas: r.rows };
}

async function buscarPorId(id) {
  const e = await db.query(
    `SELECT e.*, f.nome AS fornecedor_nome FROM entradas_estoque e
     LEFT JOIN fornecedores f ON f.id=e.fornecedor_id WHERE e.id=$1`, [id]);
  if (!e.rows[0]) return null;
  const itens = await db.query(
    `SELECT ei.*, m.nome AS material_nome FROM entradas_estoque_itens ei
     LEFT JOIN materiais m ON m.id=ei.material_id WHERE ei.entrada_id=$1`, [id]);
  return { ...e.rows[0], itens: itens.rows };
}

module.exports = { parseNfeCompra, preview, confirmar, estornar, listar, buscarPorId };
