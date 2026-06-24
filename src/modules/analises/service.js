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

module.exports = { dre, fluxoCaixa, salvarMeta, metaMes };
