const db = require('../../db');
const { XMLParser } = require('fast-xml-parser');

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

module.exports = { parseNfeCompra };
