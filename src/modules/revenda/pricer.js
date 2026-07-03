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

  const faixa = doPrazo.find((f) => f.quantidade >= qtd) || doPrazo[doPrazo.length - 1];
  const base = Number(faixa.preco_total);

  const selecionados = new Set(opts.selecionados || []);
  const acab = (ctx.acabamentos || [])
    .filter((a) => selecionados.has(a.nome))
    .reduce((s, a) => s + Number(a.preco), 0);

  const markup = Number(ctx.markup_percent) || 0;
  const dobra = custoDobraMilheiro({
    dobras: opts.dobras, quantidade: faixa.quantidade,
    base: ctx.dobra_base != null ? ctx.dobra_base : 10,
    adicional: ctx.dobra_adicional != null ? ctx.dobra_adicional : 5,
  });
  const total = round2((base + acab + dobra) * (1 + markup / 100));
  const valor_unitario = round4(total / qtd);
  const memoria = `Faixa ${faixa.quantidade}un/${prazo}h R$ ${round2(base)}`
    + (acab ? ` + acab R$ ${round2(acab)}` : '')
    + (dobra ? ` + dobra R$ ${round2(dobra)}` : '')
    + ` ×(1+${markup}%) = R$ ${total} (un R$ ${valor_unitario})`;

  return { valor_unitario, valor_total: total, memoria, faixa_usada: faixa.quantidade };
}

function calcularInternoM2(ctx, item) {
  const larg = Number(item.largura_cm), alt = Number(item.altura_cm);
  if (!(larg > 0) || !(alt > 0)) return null;
  const b = engine.escolherBobina(larg, ctx.espaco_corte_cm, ctx.bobinas);
  if (!b) return null;
  const qtd = Number(item.quantidade) > 0 ? Number(item.quantidade) : 1;
  const area = (b.largura_util_cm / 100) * (alt / 100);
  const pm2 = Number(ctx.preco_m2) || 0;
  const vu = round2(area * pm2);
  const vt = round2(vu * qtd);
  const memoria = `Bobina ${b.largura_cm / 100}m (${b.n} por largura) → ${round2(b.largura_util_cm / 100)}m × ${alt / 100}m = ${round2(area)}m² × R$ ${pm2}/m² = R$ ${vu}/un × ${qtd} = R$ ${vt}`;
  return { valor_unitario: vu, valor_total: vt, memoria, bobina_cm: b.largura_cm };
}

module.exports = { calcularRevenda, round2, calcularInternoM2, custoDobraMilheiro };
