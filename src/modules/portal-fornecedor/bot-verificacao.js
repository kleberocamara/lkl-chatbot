const db = require('../../db');

function validarChavePix(chave) {
  if (!chave) return false;
  const soDigitos = chave.replace(/\D/g, '');
  const ehCpfCnpj = soDigitos.length === 11 || soDigitos.length === 14;
  const ehEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(chave);
  const ehTelefone = /^\+55\d{10,11}$/.test(chave);
  const ehAleatoria = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chave);
  return ehCpfCnpj || ehEmail || ehTelefone || ehAleatoria;
}

function validarLinhaDigitavel(linha) {
  if (!linha) return false;
  return linha.replace(/\D/g, '').length >= 44;
}

function dadosBancariosMudaram(anterior, atual) {
  if (atual.tipo_pagamento === 'pix') {
    return anterior.pix_chave !== null && anterior.pix_chave !== atual.pix_chave;
  }
  if (atual.tipo_pagamento === 'ted') {
    const camposIguais = anterior.ted_banco_codigo === atual.ted_banco_codigo
      && anterior.ted_agencia === atual.ted_agencia
      && anterior.ted_conta === atual.ted_conta
      && anterior.ted_documento === atual.ted_documento;
    const anteriorTinhaTed = anterior.ted_banco_codigo !== null;
    return anteriorTinhaTed && !camposIguais;
  }
  return false;
}

async function verificarSubmissao(fornecedorId, dados) {
  const alertas = [];

  if (dados.tipo_pagamento === 'pix' && !validarChavePix(dados.pix_chave)) {
    alertas.push('pix_formato_invalido');
  }
  if (dados.tipo_pagamento === 'boleto') {
    for (const b of dados.boletos || []) {
      if (!validarLinhaDigitavel(b.linha_digitavel)) alertas.push('boleto_linha_invalida');
    }
  }

  const dup = await db.query(
    `SELECT id FROM fornecedor_submissoes WHERE fornecedor_id = $1 AND nnf = $2 AND status != 'rejeitada'`,
    [fornecedorId, dados.nnf]
  );
  if (dup.rows.length) alertas.push('duplicidade_nf');

  if (['pix', 'ted'].includes(dados.tipo_pagamento)) {
    const ultima = await db.query(
      `SELECT pix_chave, ted_banco_codigo, ted_agencia, ted_conta, ted_documento
       FROM fornecedor_submissoes
       WHERE fornecedor_id = $1 AND tipo_pagamento = $2 AND status = 'aceita'
       ORDER BY criada_em DESC LIMIT 1`,
      [fornecedorId, dados.tipo_pagamento]
    );
    if (ultima.rows.length && dadosBancariosMudaram(ultima.rows[0], dados)) {
      alertas.push('dado_bancario_mudou');
    }
  }

  return { alertas };
}

module.exports = { verificarSubmissao, validarChavePix, validarLinhaDigitavel, dadosBancariosMudaram };
