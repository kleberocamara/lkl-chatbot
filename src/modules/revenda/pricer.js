const engine = require('../precificacao/engine');
const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;

// Custo da dobra pela regra da Graficonauta: (base + adicional*(dobras-1)) por MILHEIRO.
function custoDobraMilheiro({ dobras, quantidade, base, adicional }) {
  const d = Number(dobras) || 0;
  if (d < 1) return 0;
  const tarifa = Number(base) + Number(adicional) * (d - 1);
  return round2(tarifa * (Number(quantidade) / 1000));
}

// ctx = { faixas, acabamentos, markup_percent } ; opts = { quantidade, prazo_horas, selecionados }
function calcularRevenda(ctx, opts) {
  const qtd = Number(opts.quantidade) > 0 ? Number(opts.quantidade) : 1;
  const prazo = Number(opts.prazo_horas);
  const doPrazo = (ctx.faixas || [])
    .filter((f) => Number(f.prazo_horas) === prazo)
    .sort((a, b) => a.quantidade - b.quantidade);
  if (!doPrazo.length) return null;

  const faixaExata = doPrazo.find((f) => f.quantidade >= qtd);
  // Quantidade pedida excede a maior faixa cadastrada: escala linearmente a partir do
  // preço unitário da maior faixa em vez de tratar o preço da faixa como se cobrisse o
  // pedido inteiro (bug anterior gerava preço muito abaixo do real para qtd > faixa máx).
  const maiorFaixa = doPrazo[doPrazo.length - 1];
  const extrapolado = !faixaExata;
  const faixa = faixaExata || maiorFaixa;
  const base = extrapolado
    ? (Number(maiorFaixa.preco_total) / maiorFaixa.quantidade) * qtd
    : Number(faixa.preco_total);

  const selecionados = new Set(opts.selecionados || []);
  const acab = (ctx.acabamentos || [])
    .filter((a) => selecionados.has(a.nome))
    .reduce((s, a) => s + Number(a.preco), 0);

  const markup = Number(ctx.markup_percent) || 0;
  const dobra = custoDobraMilheiro({
    dobras: opts.dobras, quantidade: extrapolado ? qtd : faixa.quantidade,
    base: ctx.dobra_base != null ? ctx.dobra_base : 10,
    adicional: ctx.dobra_adicional != null ? ctx.dobra_adicional : 5,
  });
  const total = round2((base + acab + dobra) * (1 + markup / 100));
  const valor_unitario = round4(total / qtd);
  const memoria = extrapolado
    ? `Qtd ${qtd}un acima da maior faixa cadastrada (${maiorFaixa.quantidade}un/${prazo}h R$ ${round2(Number(maiorFaixa.preco_total))}) — escalado linearmente para R$ ${round2(base)}`
      + (acab ? ` + acab R$ ${round2(acab)}` : '')
      + (dobra ? ` + dobra R$ ${round2(dobra)}` : '')
      + ` ×(1+${markup}%) = R$ ${total} (un R$ ${valor_unitario})`
    : `Faixa ${faixa.quantidade}un/${prazo}h R$ ${round2(base)}`
      + (acab ? ` + acab R$ ${round2(acab)}` : '')
      + (dobra ? ` + dobra R$ ${round2(dobra)}` : '')
      + ` ×(1+${markup}%) = R$ ${total} (un R$ ${valor_unitario})`;

  return { valor_unitario, valor_total: total, memoria, faixa_usada: faixa.quantidade, extrapolado };
}

function calcularInternoM2(ctx, item) {
  const larg = Number(item.largura_cm), alt = Number(item.altura_cm);
  if (!(larg > 0) || !(alt > 0)) return null;
  const qtd = Number(item.quantidade) > 0 ? Number(item.quantidade) : 1;
  const b = engine.escolherBobinaComRotacao(larg, alt, ctx.espaco_corte_cm, ctx.bobinas, qtd);
  if (!b) return null;
  const comprimento = b.comprimento_cm;
  const area = (b.largura_util_cm / 100) * (comprimento / 100);
  const pm2 = Number(ctx.preco_m2) || 0;
  const areaBruta = area * qtd;
  const areaCobrada = Math.max(areaBruta, 1); // mínimo de 1m² por linha do orçamento
  const vt = round2(areaCobrada * pm2);
  const vu = round2(vt / qtd);
  const minAplicado = areaCobrada > areaBruta;
  const memoria = `Bobina ${b.largura_cm / 100}m (${b.n} por largura) → ${round2(b.largura_util_cm / 100)}m × ${comprimento / 100}m = ${round2(area)}m²/un × ${qtd} = ${round2(areaBruta)}m²${minAplicado ? ' → mínimo de 1m²/linha aplicado' : ''} × R$ ${pm2}/m² = R$ ${vt}`;
  return { valor_unitario: vu, valor_total: vt, memoria, bobina_cm: b.largura_cm };
}

module.exports = { calcularRevenda, round2, calcularInternoM2, custoDobraMilheiro };
