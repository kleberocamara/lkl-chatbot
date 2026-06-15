function validarCPF(cpf) {
  const c = cpf.replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(c[i]) * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 === 10 || d1 === 11) d1 = 0;
  if (d1 !== parseInt(c[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(c[i]) * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 === 10 || d2 === 11) d2 = 0;
  return d2 === parseInt(c[10]);
}

function validarCNPJ(cnpj) {
  const c = cnpj.replace(/\D/g, '');
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (c, n) => {
    let sum = 0, pos = n - 7;
    for (let i = n; i >= 1; i--) {
      sum += parseInt(c[n - i]) * pos--;
      if (pos < 2) pos = 9;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(c, 12) === parseInt(c[12]) && calc(c, 13) === parseInt(c[13]);
}

function validarCelular(cel) {
  const c = cel.replace(/\D/g, '');
  if (c.length !== 11) return false;
  const ddd = parseInt(c.substring(0, 2));
  return ddd >= 11 && ddd <= 99 && c[2] === '9';
}

function calcularScoreCompletude(cliente) {
  let score = 0;
  if (cliente.nome) score += 20;
  if (cliente.cpf_cnpj) score += 20;
  if (cliente.celular) score += 20;
  if (cliente.email) score += 15;
  if (cliente.cep) score += 10;
  if (cliente.logradouro) score += 10;
  if (cliente.bairro) score += 5;
  return score;
}

module.exports = { validarCPF, validarCNPJ, validarCelular, calcularScoreCompletude };
