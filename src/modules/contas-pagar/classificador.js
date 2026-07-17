const db = require('../../db');

// Fallback por palavra-chave — só usado quando o fornecedor é novo/sem memória.
// Tipos sem termo léxico natural (Pró-Labore, Depreciação etc.) ficam de fora —
// só a memória de fornecedor ou a classificação manual resolvem esses.
// Códigos alinhados à planilha "TIPOS DE DESPESAS.xlsx" (migration 055 — CHAPAS OFFSET
// e INSUMOS COMUNICAÇAO VISUAL entraram nas posições 3/4, empurrando os códigos seguintes em +2).
const KEYWORDS = {
  '01': ['PAPEL', 'SUBSTRATO', 'COUCHE', 'COUCHÊ', 'OFFSET'],
  '02': ['TINTA', 'QUIMICO', 'QUÍMICO', 'TONER'],
  '15': ['MANUTENCAO', 'MANUTENÇÃO', 'CONSERTO', 'PECA', 'PEÇA', 'MAQUINA', 'MÁQUINA'],
  '18': ['SABESP', 'COPASA', 'AGUA', 'ÁGUA'],
  '19': ['ENEL', 'CEMIG', 'LUZ', 'ENERGIA'],
  '20': ['VIVO', 'CLARO', 'TIM', 'INTERNET', 'TELEFONIA'],
  '29': ['HOSPEDAGEM', 'DOMINIO', 'DOMÍNIO', 'SAAS', 'ASSINATURA', 'SOFTWARE'],
  '31': ['POSTO', 'COMBUSTIVEL', 'COMBUSTÍVEL', 'GASOLINA', 'ETANOL'],
  '32': ['PEDAGIO', 'PEDÁGIO', 'SEM PARAR', 'CONECTCAR'],
};

function _normTexto(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function classificarPorPalavraChave(texto) {
  const norm = _normTexto(texto);
  for (const [codigo, palavras] of Object.entries(KEYWORDS)) {
    if (palavras.some(p => norm.includes(_normTexto(p)))) return codigo;
  }
  return null;
}

async function _tipoDespesaIdPorCodigo(codigo) {
  const r = await db.query('SELECT id FROM tipos_despesa WHERE codigo = $1', [codigo]);
  return r.rows[0]?.id || null;
}

// Função pública, usada por DDA / manual / entrada de estoque / WhatsApp.
async function classificarDespesa({ fornecedorId, nomeFornecedor, descricao }) {
  if (fornecedorId) {
    const f = await db.query('SELECT tipo_despesa_padrao_id FROM fornecedores WHERE id = $1', [fornecedorId]);
    if (f.rows[0]?.tipo_despesa_padrao_id) {
      return { tipo_despesa_id: f.rows[0].tipo_despesa_padrao_id, origem: 'fornecedor' };
    }
  }
  const codigo = classificarPorPalavraChave(`${nomeFornecedor || ''} ${descricao || ''}`);
  if (codigo) {
    const id = await _tipoDespesaIdPorCodigo(codigo);
    if (id) return { tipo_despesa_id: id, origem: 'keyword' };
  }
  return { tipo_despesa_id: null, origem: 'nenhum' };
}

module.exports = { classificarPorPalavraChave, classificarDespesa };
