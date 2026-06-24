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

module.exports = { dre };
