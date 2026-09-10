// Código IBGE do município, exigido pela SEFAZ no cMun do destinatário.
//
// A tabela (src/data/municipios-ibge.json) é o retorno de
// servicodados.ibge.gov.br/api/v1/localidades/municipios normalizado para
// "UF:NOME SEM ACENTO" -> código. Fica embutida de propósito: emissão de NF-e
// não pode depender de uma chamada de rede que pode estar fora do ar.
const TABELA = require('../data/municipios-ibge.json');

// Usado só quando o município não é reconhecido — melhor uma NF com o código da
// capital (que a SEFAZ aceita) do que uma emissão bloqueada.
const CAPITAL_POR_UF = {
  AC: '1200401', AL: '2704302', AM: '1302603', AP: '1600303', BA: '2927408',
  CE: '2304400', DF: '5300108', ES: '3205309', GO: '5208707', MA: '2111300',
  MG: '3106200', MS: '5002704', MT: '5103403', PA: '1501402', PB: '2507507',
  PE: '2611606', PI: '2211001', PR: '4106902', RJ: '3304557', RN: '2408102',
  RO: '1100205', RR: '1400100', RS: '4314902', SC: '4205407', SE: '2800308',
  SP: '3550308', TO: '1721000',
};

function _chave(municipio, uf) {
  const nome = String(municipio || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  return `${String(uf || '').toUpperCase()}:${nome}`;
}

// Devolve { c_mun, exato }. `exato` false significa que caiu na capital da UF —
// quem chama pode logar para o cadastro ser corrigido.
function resolverMunicipio(municipio, uf) {
  const codigo = TABELA[_chave(municipio, uf)];
  if (codigo) return { c_mun: codigo, exato: true };
  return { c_mun: CAPITAL_POR_UF[String(uf || '').toUpperCase()] || '3301702', exato: false };
}

module.exports = { resolverMunicipio };
