// src/modules/nfe/service.js
const db = require('../../db');
const { pool } = require('../../db');
const { emitirNfe, gerarDanfe } = require('../../services/nfe');

const C_MUN_CAPITAL = {
  RJ: '3304557', SP: '3550308', MG: '3106200', ES: '3205309',
  BA: '2927408', PE: '2611606', CE: '2304400', RS: '4314902',
  PR: '4106902', SC: '4205407',
};

async function proximoNumero(cnpj) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      'UPDATE nfe_sequencia SET ultimo_numero = ultimo_numero + 1 WHERE cnpj = $1 RETURNING ultimo_numero',
      [cnpj]
    );
    await client.query('COMMIT');
    return r.rows[0].ultimo_numero;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function emitir(orcamentoId, body) {
  const { cnpj_emitente, cfop, ncm_por_item, frete_por_conta, frete_valor, transportador } = body;

  if (!cnpj_emitente || !cfop || !ncm_por_item) {
    return { erro: ['cnpj_emitente, cfop e ncm_por_item são obrigatórios'] };
  }

  const cnpjsValidos = ['19296723000108', '44448899000185'];
  if (!cnpjsValidos.includes(cnpj_emitente)) {
    return { erro: ['cnpj_emitente inválido'] };
  }

  const orcR = await db.query(
    `SELECT o.id, o.numero, o.status, o.status_pagamento,
            o.boleto_vencimento, o.pago_em,
            c.nome AS cliente_nome, c.cpf_cnpj, c.celular,
            c.logradouro, c.numero AS c_numero,
            c.bairro, c.cep, c.cidade AS municipio, c.uf,
            CASE WHEN c.contribuinte_icms = 'sim' THEN 'ISENTO' ELSE 'ISENTO' END AS cliente_ie
     FROM orcamentos o
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE o.id = $1`,
    [orcamentoId]
  );
  if (!orcR.rows[0]) return { erro: ['Orçamento não encontrado'] };
  const orc = orcR.rows[0];
  if (orc.status !== 'aprovado') return { erro: ['Orçamento precisa estar aprovado'] };

  const osR = await db.query(
    `SELECT COUNT(*) AS total FROM ordens_servico WHERE orcamento_id = $1 AND status = 'entregue'`,
    [orcamentoId]
  );
  if (parseInt(osR.rows[0].total) === 0) {
    return { erro: ['Nenhuma OS entregue para este orçamento'] };
  }

  const itensR = await db.query(
    'SELECT * FROM orcamento_itens WHERE orcamento_id = $1 ORDER BY codigo',
    [orcamentoId]
  );
  const itens = itensR.rows;

  for (const item of itens) {
    if (!ncm_por_item[String(item.id)] && !ncm_por_item[String(item.codigo)]) {
      return { erro: [`NCM não informado para item ${item.codigo}: ${item.descricao}`] };
    }
  }

  const uf_dest = orc.uf || 'RJ';
  const c_mun_dest = C_MUN_CAPITAL[uf_dest] || '3301702';

  const duplicatas = [];
  if (orc.boleto_vencimento) {
    duplicatas.push({
      numero: '001',
      vencimento: new Date(orc.boleto_vencimento).toISOString().split('T')[0],
      valor: itens.reduce((s, i) => s + parseFloat(i.valor_total || 0), 0),
    });
  }

  const numero = await proximoNumero(cnpj_emitente);

  const dadosSidecar = {
    cnpj_emitente,
    numero,
    cfop,
    ncm_por_item,
    frete_por_conta: frete_por_conta || '9',
    frete_valor: parseFloat(frete_valor) || 0,
    transportador: transportador || null,
    duplicatas,
    destinatario: {
      nome: orc.cliente_nome || 'NAO IDENTIFICADO',
      cpf_cnpj: (orc.cpf_cnpj || '').replace(/\D/g, ''),
      logradouro: orc.logradouro || 'NAO INFORMADO',
      numero: orc.c_numero || 'SN',
      complemento: '',
      bairro: orc.bairro || 'NAO INFORMADO',
      cep: (orc.cep || '').replace(/\D/g, ''),
      municipio: orc.municipio || 'Duque de Caxias',
      uf: uf_dest,
      c_mun: c_mun_dest,
      fone: orc.celular || '',
      ie: orc.cliente_ie || '',
    },
    itens: itens.map(i => ({
      id: i.id,
      codigo: i.codigo,
      descricao: i.descricao,
      unidade: i.unidade || 'UN',
      quantidade: parseFloat(i.quantidade),
      valor_unitario: parseFloat(i.valor_unitario),
      valor_total: parseFloat(i.valor_total),
    })),
  };

  const nfeR = await db.query(
    `INSERT INTO nfe (orcamento_id, cnpj_emitente, numero, cfop, ncm_por_item,
      frete_por_conta, frete_valor, transportador, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendente') RETURNING id`,
    [orcamentoId, cnpj_emitente, numero, cfop, JSON.stringify(ncm_por_item),
     frete_por_conta || '9', parseFloat(frete_valor) || 0,
     transportador ? JSON.stringify(transportador) : null]
  );
  const nfeId = nfeR.rows[0].id;

  try {
    const resultado = await emitirNfe(dadosSidecar);

    if (resultado.status === 'autorizada') {
      const danfePath = await gerarDanfe(resultado.xml, resultado.chave);
      await db.query(
        `UPDATE nfe SET status='autorizada', chave=$1, protocolo=$2, xml=$3,
         danfe_path=$4, emitido_em=NOW(), updated_at=NOW() WHERE id=$5`,
        [resultado.chave, resultado.protocolo, resultado.xml, danfePath, nfeId]
      );
      return { id: nfeId, chave: resultado.chave, protocolo: resultado.protocolo,
               status: 'autorizada', danfe_url: danfePath };
    } else {
      await db.query(
        `UPDATE nfe SET status='erro', updated_at=NOW() WHERE id=$1`, [nfeId]
      );
      return { erro: [resultado.erro || `Rejeição SEFAZ: ${resultado.c_stat} - ${resultado.x_motivo}`] };
    }
  } catch (e) {
    await db.query(`UPDATE nfe SET status='erro', updated_at=NOW() WHERE id=$1`, [nfeId]);
    console.error('[NFE-EMITIR]', e.message);
    return { erro: [`Erro na emissão: ${e.message}`] };
  }
}

async function listarPorOrcamento(orcamentoId) {
  const r = await db.query(
    `SELECT id, cnpj_emitente, numero, serie, chave, protocolo, status,
            danfe_path, cfop, emitido_em, created_at
     FROM nfe WHERE orcamento_id = $1 ORDER BY created_at DESC`,
    [orcamentoId]
  );
  return r.rows;
}

module.exports = { emitir, listarPorOrcamento };
