const db = require('../../db');

function _mesCorrente() {
  const n = new Date();
  const inicio = new Date(n.getFullYear(), n.getMonth(), 1);
  const fim = new Date(n.getFullYear(), n.getMonth() + 1, 0);
  const fmt = d => d.toISOString().slice(0, 10);
  return { inicio: fmt(inicio), fim: fmt(fim) };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function dre({ inicio, fim } = {}) {
  if (!inicio || !fim) { const m = _mesCorrente(); inicio = inicio || m.inicio; fim = fim || m.fim; }
  if (!DATE_RE.test(inicio) || !DATE_RE.test(fim)) return { erro: ['Datas inválidas (use YYYY-MM-DD)'] };
  if (fim < inicio) return { erro: ['Data final menor que a inicial'] };

  const recR = await db.query(
    `SELECT COALESCE(SUM(total),0) AS receita
     FROM orcamentos WHERE status_pagamento = 'pago' AND pago_em::date BETWEEN $1 AND $2`,
    [inicio, fim]);
  const receita = Number(recR.rows[0].receita);

  const despR = await db.query(
    `SELECT tipo_despesa AS categoria, COALESCE(SUM(valor),0) AS valor
     FROM contas_pagar WHERE status = 'pago' AND pago_em::date BETWEEN $1 AND $2
     GROUP BY tipo_despesa ORDER BY valor DESC`,
    [inicio, fim]);
  const despesas = despR.rows.map(r => ({ categoria: r.categoria, valor: Number(r.valor) }));
  const total_despesas = despesas.reduce((s, d) => s + d.valor, 0);

  const resultado = receita - total_despesas;
  const margem = receita > 0 ? resultado / receita : 0;

  return { periodo: { inicio, fim }, receita, despesas, total_despesas, resultado, margem };
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

  const desp = d.despesas.map(x => `  - ${x.categoria}: ${_brl(x.valor)}`).join('\n') || '  (sem despesas)';
  const user =
`Dados financeiros da Gráfica LKL (mês ${periodo}):

DRE (regime de caixa):
- Receita recebida: ${_brl(d.receita)}
- Despesas pagas: ${_brl(d.total_despesas)}
${desp}
- Resultado: ${_brl(d.resultado)} (margem ${(d.margem * 100).toFixed(1)}%)

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
