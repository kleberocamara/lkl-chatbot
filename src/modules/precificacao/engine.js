// Motor de precificação — funções puras (sem acesso a banco).

const round2 = (x) => Math.round(x * 100) / 100;
const qtdOf = (item) => (Number(item.quantidade) > 0 ? Number(item.quantidade) : 1);
const temDims = (item) => Number(item.largura_cm) > 0 && Number(item.altura_cm) > 0;

// Escolhe, entre as bobinas, a mais econômica (menor largura imputada por item),
// descontando a folga de corte g (cm) entre imagens vizinhas. Se `quantidade` for informada,
// o número de peças "por largura" (n) nunca excede a quantidade realmente pedida — não faz
// sentido dividir o custo da largura entre cópias hipotéticas que não serão produzidas.
// Retorna { largura_cm, n, largura_util_cm } ou null se nenhuma comporta a arte.
function escolherBobina(larguraArteCm, g, bobinas, quantidade) {
  const gap = Number(g) > 0 ? Number(g) : 0;
  const qtdLimite = Number(quantidade) > 0 ? Number(quantidade) : Infinity;
  let melhor = null;
  for (const b of bobinas || []) {
    const Lb = Number(b.largura_cm);
    if (!(Lb > 0)) continue;
    const nCapacidade = Math.floor((Lb + gap) / (larguraArteCm + gap));
    if (nCapacidade < 1) continue; // arte não cabe nem 1 vez
    const n = Math.min(nCapacidade, qtdLimite);
    const larguraUtil = Lb / n;
    if (!melhor || larguraUtil < melhor.largura_util_cm) {
      melhor = { largura_cm: Lb, n, largura_util_cm: larguraUtil };
    }
  }
  return melhor;
}

// Tenta as duas orientações (normal e girada) e escolhe a de MENOR ÁREA TOTAL resultante
// (não só menor largura imputada — o comprimento muda entre as orientações, então precisa
// comparar a área final, não só a largura). Empate → prefere a orientação original (normal).
// Retorna { largura_cm, n, largura_util_cm, comprimento_cm } ou null.
function escolherBobinaComRotacao(largura_cm, altura_cm, g, bobinas, quantidade) {
  const normal = escolherBobina(Number(largura_cm), g, bobinas, quantidade);
  const girada = escolherBobina(Number(altura_cm), g, bobinas, quantidade);
  const areaNormal = normal ? normal.largura_util_cm * Number(altura_cm) : Infinity;
  const areaGirada = girada ? girada.largura_util_cm * Number(largura_cm) : Infinity;
  if (normal && girada) {
    return areaGirada < areaNormal
      ? { ...girada, comprimento_cm: Number(largura_cm) }
      : { ...normal, comprimento_cm: Number(altura_cm) };
  }
  if (normal) return { ...normal, comprimento_cm: Number(altura_cm) };
  if (girada) return { ...girada, comprimento_cm: Number(largura_cm) };
  return null;
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

module.exports = { calcularItem, escolherBobina, escolherBobinaComRotacao, round2 };
