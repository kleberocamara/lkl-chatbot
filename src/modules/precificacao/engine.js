// Motor de precificação — funções puras (sem acesso a banco).

const round2 = (x) => Math.round(x * 100) / 100;
const qtdOf = (item) => (Number(item.quantidade) > 0 ? Number(item.quantidade) : 1);
const temDims = (item) => Number(item.largura_cm) > 0 && Number(item.altura_cm) > 0;

// Escolhe, entre as bobinas, a mais econômica (menor largura imputada por item),
// descontando a folga de corte g (cm) entre imagens vizinhas.
// Retorna { largura_cm, n, largura_util_cm } ou null se nenhuma comporta a arte.
function escolherBobina(larguraArteCm, g, bobinas) {
  const gap = Number(g) > 0 ? Number(g) : 0;
  let melhor = null;
  for (const b of bobinas || []) {
    const Lb = Number(b.largura_cm);
    if (!(Lb > 0)) continue;
    const n = Math.floor((Lb + gap) / (larguraArteCm + gap));
    if (n < 1) continue; // arte não cabe nem 1 vez
    const larguraUtil = Lb / n;
    if (!melhor || larguraUtil < melhor.largura_util_cm) {
      melhor = { largura_cm: Lb, n, largura_util_cm: larguraUtil };
    }
  }
  return melhor;
}

function calcularItem(regra, item, ctx = {}) {
  const metodo = regra && regra.metodo_calculo;
  const qtd = qtdOf(item);

  if (metodo === 'fixo') {
    const vu = round2(Number(regra.preco_base) || 0);
    const vt = round2(vu * qtd);
    return { valor_unitario: vu, valor_total: vt,
      memoria: `R$ ${vu}/un × ${qtd} = R$ ${vt}` };
  }

  if (metodo === 'm2') {
    if (!temDims(item)) return null;
    let area = (item.largura_cm / 100) * (item.altura_cm / 100);
    if (Number(regra.m2_minimo) > 0) area = Math.max(area, Number(regra.m2_minimo));
    const vu = round2(area * (Number(regra.preco_base) || 0));
    const vt = round2(vu * qtd);
    return { valor_unitario: vu, valor_total: vt,
      memoria: `${item.largura_cm / 100}m × ${item.altura_cm / 100}m = ${round2(area)}m² × R$ ${regra.preco_base}/m² = R$ ${vu}/un × ${qtd} = R$ ${vt}` };
  }

  if (metodo === 'm2_bobina') {
    if (!temDims(item)) return null;
    const b = escolherBobina(Number(item.largura_cm), regra.espaco_corte_cm, ctx.bobinas);
    if (!b) return null;
    const area = (b.largura_util_cm / 100) * (item.altura_cm / 100);
    const vu = round2(area * (Number(regra.preco_base) || 0));
    const vt = round2(vu * qtd);
    return { valor_unitario: vu, valor_total: vt,
      memoria: `Bobina ${b.largura_cm / 100}m (${b.n} por largura, folga ${Number(regra.espaco_corte_cm) || 0}cm) → ${round2(b.largura_util_cm / 100)}m × ${item.altura_cm / 100}m = ${round2(area)}m² × R$ ${regra.preco_base}/m² = R$ ${vu}/un × ${qtd} = R$ ${vt}` };
  }

  if (metodo === 'faixa') {
    const faixa = (ctx.faixas || []).find(
      (f) => qtd >= Number(f.qtd_min) && (f.qtd_max == null || qtd <= Number(f.qtd_max))
    );
    if (!faixa) return null;
    const vu = round2(Number(faixa.preco_unitario));
    const vt = round2(vu * qtd);
    return { valor_unitario: vu, valor_total: vt,
      memoria: `Faixa ${faixa.qtd_min}–${faixa.qtd_max ?? '∞'}: R$ ${vu}/un × ${qtd} = R$ ${vt}` };
  }

  if (metodo === 'revenda') {
    if (!ctx.precoRevenda) return null;
    const vu = round2(Number(ctx.precoRevenda.preco_unitario));
    const vt = round2(vu * qtd);
    return { valor_unitario: vu, valor_total: vt,
      memoria: `Revenda (sinc. ${ctx.precoRevenda.sincronizado_em}): R$ ${vu}/un × ${qtd} = R$ ${vt}` };
  }

  // manual ou método desconhecido
  return null;
}

module.exports = { calcularItem, escolherBobina, round2 };
