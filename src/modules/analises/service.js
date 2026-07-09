const db = require('../../db');

function _mesCorrente() {
  const n = new Date();
  const inicio = new Date(n.getFullYear(), n.getMonth(), 1);
  const fim = new Date(n.getFullYear(), n.getMonth() + 1, 0);
  const fmt = d => d.toISOString().slice(0, 10);
  return { inicio: fmt(inicio), fim: fmt(fim) };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CASCATA_DEDUCOES = [
  { id: 'deducoes_vendas', label: 'Deduções de Vendas', categorias: ['DEDUÇÕES DE VENDAS'] },
  { id: 'cpv', label: 'Custos de Produção (CPV)', categorias: ['CUSTOS DE PRODUÇÃO (CPV)'] },
  { id: 'despesas_comerciais', label: 'Deduções e Despesas Comerciais', categorias: ['DEDUÇÕES E DESPESAS COMERCIAIS'] },
  { id: 'custos_fixos_producao', label: 'Custos Fixos de Produção', categorias: ['MÃO DE OBRA DIRETA (MOD)', 'CUSTOS OPERACIONAIS DA FÁBRICA'] },
  { id: 'despesas_operacionais', label: 'Despesas Operacionais', categorias: ['OCUPAÇÃO E INFRAESTRUTURA', 'PESSOAL E ADMINISTRAÇÃO', 'SERVIÇOS PROFISSIONAIS', 'SEGUROS', 'LOGÍSTICA E DESLOCAMENTO', 'VIAGENS E REPRESENTAÇÃO', 'OUTROS'] },
  { id: 'resultado_financeiro', label: 'Resultado Financeiro', categorias: ['DESPESAS FINANCEIRAS'] },
];

async function dre({ inicio, fim } = {}) {
  if (!inicio || !fim) { const m = _mesCorrente(); inicio = inicio || m.inicio; fim = fim || m.fim; }
  if (!DATE_RE.test(inicio) || !DATE_RE.test(fim)) return { erro: ['Datas inválidas (use YYYY-MM-DD)'] };
  if (fim < inicio) return { erro: ['Data final menor que a inicial'] };

  // Receita por competência: um orçamento só conta no mês em que TODAS as suas
  // OSs foram entregues (última entrega define o mês), não quando o cliente pagou.
  const recR = await db.query(
    `WITH entregas AS (
       SELECT os.orcamento_id,
              COUNT(*) AS total_os,
              COUNT(*) FILTER (WHERE os.status = 'entregue') AS os_entregues,
              MAX(h.em) AS ultima_entrega
       FROM ordens_servico os
       LEFT JOIN LATERAL (
         SELECT em FROM os_historico h WHERE h.os_id = os.id AND h.para_status = 'entregue' ORDER BY h.em DESC LIMIT 1
       ) h ON true
       GROUP BY os.orcamento_id
     )
     SELECT COALESCE(SUM(o.total),0) AS receita
     FROM orcamentos o
     JOIN entregas e ON e.orcamento_id = o.id
     WHERE e.total_os = e.os_entregues AND e.ultima_entrega::date BETWEEN $1 AND $2`,
    [inicio, fim]);
  const receita_bruta = Number(recR.rows[0].receita);

  // Despesa por competência: conta assim que lançada/incorrida, esteja paga ou não.
  // Só exclui canceladas (nunca aconteceram de verdade).
  const despR = await db.query(
    `SELECT td.categoria_dre AS categoria, COALESCE(SUM(cp.valor),0) AS valor
     FROM contas_pagar cp
     JOIN tipos_despesa td ON td.id = cp.tipo_despesa_id
     WHERE cp.status != 'cancelado' AND cp.competencia BETWEEN $1 AND $2
     GROUP BY td.categoria_dre`,
    [inicio, fim]);
  const porCategoria = {};
  for (const r of despR.rows) porCategoria[r.categoria] = Number(r.valor);

  const pct = v => receita_bruta > 0 ? Math.round((v / receita_bruta) * 1000) / 10 : 0;

  function bucket({ id, label, categorias }) {
    const detalhamento = categorias
      .filter(c => porCategoria[c])
      .map(c => ({ categoria: c, valor: -porCategoria[c], percentual: pct(-porCategoria[c]) }));
    const soma = categorias.reduce((s, c) => s + (porCategoria[c] || 0), 0);
    const valor = soma === 0 ? 0 : -soma;
    const linhaBucket = { id, label, valor, percentual: pct(valor), tipo: 'deducao' };
    if (detalhamento.length) linhaBucket.detalhamento = detalhamento;
    return linhaBucket;
  }

  const linhas = [];
  linhas.push({ id: 'receita_bruta', label: 'Receita Bruta de Vendas', valor: receita_bruta, percentual: pct(receita_bruta), tipo: 'base' });

  const deducoesVendas = bucket(CASCATA_DEDUCOES[0]);
  linhas.push(deducoesVendas);
  const receita_liquida = receita_bruta + deducoesVendas.valor;
  linhas.push({ id: 'receita_liquida', label: 'Receita Líquida de Vendas', valor: receita_liquida, percentual: pct(receita_liquida), tipo: 'subtotal' });

  const cpv = bucket(CASCATA_DEDUCOES[1]);
  const despesasComerciais = bucket(CASCATA_DEDUCOES[2]);
  linhas.push(cpv, despesasComerciais);
  const margem_contribuicao = receita_liquida + cpv.valor + despesasComerciais.valor;
  linhas.push({ id: 'margem_contribuicao', label: 'Margem de Contribuição Bruta', valor: margem_contribuicao, percentual: pct(margem_contribuicao), tipo: 'subtotal' });

  const custosFixosProducao = bucket(CASCATA_DEDUCOES[3]);
  linhas.push(custosFixosProducao);
  const lucro_bruto = margem_contribuicao + custosFixosProducao.valor;
  linhas.push({ id: 'lucro_bruto', label: 'Lucro Bruto', valor: lucro_bruto, percentual: pct(lucro_bruto), tipo: 'subtotal' });

  const despesasOperacionais = bucket(CASCATA_DEDUCOES[4]);
  linhas.push(despesasOperacionais);
  const ebitda = lucro_bruto + despesasOperacionais.valor;
  linhas.push({ id: 'ebitda', label: 'EBITDA / LAJIDA', valor: ebitda, percentual: pct(ebitda), tipo: 'subtotal' });

  const resultadoFinanceiro = bucket(CASCATA_DEDUCOES[5]);
  linhas.push(resultadoFinanceiro);
  linhas.push({ id: 'impostos_lucro', label: 'Impostos sobre o Lucro', valor: 0, percentual: 0, tipo: 'deducao' });

  const lucro_liquido = ebitda + resultadoFinanceiro.valor;
  linhas.push({ id: 'lucro_liquido', label: 'Lucro Líquido do Período', valor: lucro_liquido, percentual: pct(lucro_liquido), tipo: 'final' });

  const margem_liquida = receita_liquida > 0 ? lucro_liquido / receita_liquida : 0;

  return { periodo: { inicio, fim }, linhas, margem_liquida };
}

async function fluxoCaixa({ dias } = {}) {
  const d = [30, 60, 90].includes(Number(dias)) ? Number(dias) : 90;
  const entR = await db.query(
    `SELECT date_trunc('week', vencimento)::date AS semana, COALESCE(SUM(valor),0) AS total
     FROM orcamento_boletos
     WHERE status = 'aguardando' AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::interval
     GROUP BY 1`, [String(d)]);
  const saiR = await db.query(
    `SELECT date_trunc('week', vencimento)::date AS semana, COALESCE(SUM(valor),0) AS total
     FROM contas_pagar
     WHERE status IN ('pendente','agendado','vencido') AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::interval
     GROUP BY 1`, [String(d)]);

  const map = {};
  for (const r of entR.rows) { const k = r.semana instanceof Date ? r.semana.toISOString().slice(0,10) : String(r.semana); (map[k] = map[k] || { entradas:0, saidas:0 }).entradas = Number(r.total); }
  for (const r of saiR.rows) { const k = r.semana instanceof Date ? r.semana.toISOString().slice(0,10) : String(r.semana); (map[k] = map[k] || { entradas:0, saidas:0 }).saidas = Number(r.total); }
  const semanas = Object.keys(map).sort().map(k => {
    const inicio = k;
    const fimD = new Date(k + 'T00:00:00'); fimD.setDate(fimD.getDate() + 6);
    const fim = fimD.toISOString().slice(0,10);
    const entradas = map[k].entradas, saidas = map[k].saidas;
    return { inicio, fim, entradas, saidas, liquido: entradas - saidas };
  });

  const totalEnt = semanas.reduce((s,x)=>s+x.entradas,0);
  const totalSai = semanas.reduce((s,x)=>s+x.saidas,0);

  const atrR = await db.query(
    `SELECT COALESCE(SUM(valor),0) AS total FROM orcamento_boletos WHERE status='aguardando' AND vencimento < CURRENT_DATE`);
  const atrP = await db.query(
    `SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar WHERE status IN ('pendente','agendado','vencido') AND vencimento < CURRENT_DATE`);

  return {
    dias: d, semanas,
    total_entradas: totalEnt, total_saidas: totalSai,
    atrasado_receber: Number(atrR.rows[0].total),
    atrasado_pagar: Number(atrP.rows[0].total),
  };
}

function _intervaloMes(ano, mes) {
  const ini = new Date(ano, mes - 1, 1);
  const fim = new Date(ano, mes, 0);
  const fmt = d => d.toISOString().slice(0, 10);
  return { inicio: fmt(ini), fim: fmt(fim) };
}

async function salvarMeta({ ano, mes, valor }) {
  ano = parseInt(ano); mes = parseInt(mes); valor = parseFloat(valor);
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2100) return { erro: ['Ano inválido'] };
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) return { erro: ['Mês inválido (1-12)'] };
  if (!(valor >= 0)) return { erro: ['Valor da meta inválido'] };
  const r = await db.query(
    `INSERT INTO metas (ano, mes, valor_meta) VALUES ($1,$2,$3)
     ON CONFLICT (ano, mes) DO UPDATE SET valor_meta = EXCLUDED.valor_meta, updated_at = now()
     RETURNING *`, [ano, mes, valor]);
  return { meta: r.rows[0] };
}

async function metaMes({ ano, mes } = {}) {
  const n = new Date();
  ano = ano ? parseInt(ano) : n.getFullYear();
  mes = mes ? parseInt(mes) : (n.getMonth() + 1);
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) return { erro: ['Mês inválido (1-12)'] };
  const { inicio, fim } = _intervaloMes(ano, mes);
  const mR = await db.query('SELECT valor_meta FROM metas WHERE ano=$1 AND mes=$2', [ano, mes]);
  const meta = mR.rows[0] ? Number(mR.rows[0].valor_meta) : null;
  const rR = await db.query(
    `SELECT COALESCE(SUM(total),0) AS realizado FROM orcamentos
     WHERE aprovado_em::date BETWEEN $1 AND $2 AND status NOT IN ('cancelado','reprovado')`,
    [inicio, fim]);
  const realizado = Number(rR.rows[0].realizado);
  const percentual = meta && meta > 0 ? realizado / meta : 0;
  return { ano, mes, meta, realizado, percentual };
}

const ANTHROPIC_MODEL = 'claude-haiku-4-5';

async function _chamarClaude(system, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY não configurada');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 900, system, messages: [{ role: 'user', content: user }] }),
  });
  const json = await resp.json();
  if (json.error) throw new Error('Claude API: ' + (json.error.message || JSON.stringify(json.error)));
  const txt = json.content && json.content[0] && json.content[0].text;
  if (!txt) throw new Error('Resposta vazia da IA');
  return txt;
}

function _brl(v) { return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }

async function gerarInsight() {
  const d = await dre({});
  const f = await fluxoCaixa({ dias: 90 });
  const m = await metaMes({});
  const periodo = `${d.periodo.inicio.slice(0, 7)}`;

  const receitaBruta = d.linhas.find(l => l.id === 'receita_bruta').valor;
  const lucroLiquido = d.linhas.find(l => l.id === 'lucro_liquido').valor;
  const linhasDeducao = d.linhas.filter(l => l.tipo === 'deducao' && l.valor !== 0);
  const totalDespesas = -linhasDeducao.reduce((s, l) => s + l.valor, 0);
  const desp = linhasDeducao.map(x => `  - ${x.label}: ${_brl(-x.valor)}`).join('\n') || '  (sem despesas)';

  const user =
`Dados financeiros da Gráfica LKL (mês ${periodo}):

DRE (regime de competência):
- Receita bruta: ${_brl(receitaBruta)}
- Despesas totais: ${_brl(totalDespesas)}
${desp}
- Lucro líquido: ${_brl(lucroLiquido)} (margem ${(d.margem_liquida * 100).toFixed(1)}%)

Metas:
- Meta do mês: ${m.meta != null ? _brl(m.meta) : 'não definida'}
- Vendido (orçamentos aprovados): ${_brl(m.realizado)}${m.meta ? ` (${(m.percentual * 100).toFixed(1)}% da meta)` : ''}

Fluxo de caixa (próx. 90 dias):
- Total a receber: ${_brl(f.total_entradas)}
- Total a pagar: ${_brl(f.total_saidas)}
- Atrasado a receber: ${_brl(f.atrasado_receber)}
- Atrasado a pagar: ${_brl(f.atrasado_pagar)}

Analise estes números e responda em português, de forma concisa e prática, em 3 blocos curtos:
1) Situação atual
2) Pontos de atenção
3) Recomendações práticas`;

  const system = 'Você é um analista financeiro de uma gráfica de pequeno porte. Seja direto, objetivo e prático. Responda em português do Brasil, sem jargão excessivo.';
  const conteudo = await _chamarClaude(system, user);

  const r = await db.query(
    `INSERT INTO insights_financeiros (periodo, conteudo, contexto) VALUES ($1,$2,$3) RETURNING gerado_em`,
    [periodo, conteudo, JSON.stringify({ dre: d, fluxo: f, meta: m })]);
  return { conteudo, gerado_em: r.rows[0].gerado_em, periodo };
}

async function ultimoInsight() {
  const r = await db.query('SELECT conteudo, gerado_em, periodo FROM insights_financeiros ORDER BY gerado_em DESC LIMIT 1');
  return r.rows[0] || null;
}

module.exports = { dre, fluxoCaixa, salvarMeta, metaMes, gerarInsight, ultimoInsight };
