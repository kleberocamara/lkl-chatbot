const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;

// ctx = { faixas, acabamentos, markup_percent } ; opts = { quantidade, prazo_horas, selecionados }
function calcularRevenda(ctx, opts) {
  const qtd = Number(opts.quantidade) > 0 ? Number(opts.quantidade) : 1;
  const prazo = Number(opts.prazo_horas);
  const doPrazo = (ctx.faixas || [])
    .filter((f) => Number(f.prazo_horas) === prazo)
    .sort((a, b) => a.quantidade - b.quantidade);
  if (!doPrazo.length) return null;

  const faixa = doPrazo.find((f) => f.quantidade >= qtd) || doPrazo[doPrazo.length - 1];
  const base = Number(faixa.preco_total);

  const selecionados = new Set(opts.selecionados || []);
  const acab = (ctx.acabamentos || [])
    .filter((a) => selecionados.has(a.nome))
    .reduce((s, a) => s + Number(a.preco), 0);

  const markup = Number(ctx.markup_percent) || 0;
  const total = round2((base + acab) * (1 + markup / 100));
  const valor_unitario = round4(total / qtd);
  const memoria = `Faixa ${faixa.quantidade}un/${prazo}h R$ ${round2(base)}`
    + (acab ? ` + acab R$ ${round2(acab)}` : '')
    + ` ×(1+${markup}%) = R$ ${total} (un R$ ${valor_unitario})`;

  return { valor_unitario, valor_total: total, memoria, faixa_usada: faixa.quantidade };
}

module.exports = { calcularRevenda, round2 };
