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
  // OSs não-canceladas foram entregues (última entrega define o mês), não quando
  // o cliente pagou. Considera os dois caminhos de vínculo OS→orçamento: direto
  // (ordens_servico.orcamento_id, usado por OS de Comunicação Visual) e indireto
  // (os_itens → orcamento_itens.orcamento_id, único caminho pra OS offset/revenda,
  // que podem cobrir itens de vários orçamentos e por isso não gravam orcamento_id).
  const recR = await db.query(
    `WITH os_do_orcamento AS (
       SELECT DISTINCT orcamento_id, os_id FROM (
         SELECT os.orcamento_id, os.id AS os_id
         FROM ordens_servico os
         WHERE os.orcamento_id IS NOT NULL AND os.status != 'cancelado'
         UNION
         SELECT oi.orcamento_id, os.id AS os_id
         FROM os_itens oit
         JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
         JOIN ordens_servico os ON os.id = oit.os_id
         WHERE os.status != 'cancelado'
       ) t
     ),
     entregas AS (
       SELECT p.orcamento_id,
              COUNT(*) AS total_os,
              COUNT(*) FILTER (WHERE os.status = 'entregue') AS os_entregues,
              MAX(h.em) AS ultima_entrega
       FROM os_do_orcamento p
       JOIN ordens_servico os ON os.id = p.os_id
       LEFT JOIN LATERAL (
         SELECT em FROM os_historico hh WHERE hh.os_id = os.id AND hh.para_status = 'entregue' ORDER BY hh.em DESC LIMIT 1
       ) h ON true
       GROUP BY p.orcamento_id
     )
     SELECT o.numero, c.nome AS cliente, o.total,
            to_char(e.ultima_entrega::date, 'DD/MM/YYYY') AS data_entrega
     FROM orcamentos o
     JOIN entregas e ON e.orcamento_id = o.id
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE e.total_os = e.os_entregues AND e.ultima_entrega::date BETWEEN $1 AND $2
     ORDER BY e.ultima_entrega`,
    [inicio, fim]);
  const receita_bruta = recR.rows.reduce((s, r) => s + Number(r.total), 0);

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

  const categoriasMapeadas = new Set(CASCATA_DEDUCOES.flatMap(b => b.categorias));
  const categoriasSemBucket = Object.keys(porCategoria).filter(c => !categoriasMapeadas.has(c));
  if (categoriasSemBucket.length) {
    console.warn('[analises.dre] categoria_dre sem bucket mapeado em CASCATA_DEDUCOES (despesas ausentes do DRE):', categoriasSemBucket.join(', '));
  }

  const pct = v => receita_bruta > 0 ? Math.round((v / receita_bruta) * 1000) / 10 : 0;

  function bucketPorId(id) {
    const def = CASCATA_DEDUCOES.find(b => b.id === id);
    return bucket(def);
  }

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

  const detalhamentoReceita = recR.rows.map(r => {
    const valor = Number(r.total);
    return { categoria: `#${r.numero} — ${r.cliente || 'Cliente não identificado'} (${r.data_entrega})`, valor, percentual: pct(valor) };
  });

  const linhas = [];
  const receitaBrutaLinha = { id: 'receita_bruta', label: 'Receita Bruta de Vendas', valor: receita_bruta, percentual: pct(receita_bruta), tipo: 'base' };
  if (detalhamentoReceita.length) receitaBrutaLinha.detalhamento = detalhamentoReceita;
  linhas.push(receitaBrutaLinha);

  const deducoesVendas = bucketPorId('deducoes_vendas');
  linhas.push(deducoesVendas);
  const receita_liquida = receita_bruta + deducoesVendas.valor;
  linhas.push({ id: 'receita_liquida', label: 'Receita Líquida de Vendas', valor: receita_liquida, percentual: pct(receita_liquida), tipo: 'subtotal' });

  const cpv = bucketPorId('cpv');
  const despesasComerciais = bucketPorId('despesas_comerciais');
  linhas.push(cpv, despesasComerciais);
  const margem_contribuicao = receita_liquida + cpv.valor + despesasComerciais.valor;
  linhas.push({ id: 'margem_contribuicao', label: 'Margem de Contribuição Bruta', valor: margem_contribuicao, percentual: pct(margem_contribuicao), tipo: 'subtotal' });

  const custosFixosProducao = bucketPorId('custos_fixos_producao');
  linhas.push(custosFixosProducao);
  const lucro_bruto = margem_contribuicao + custosFixosProducao.valor;
  linhas.push({ id: 'lucro_bruto', label: 'Lucro Bruto', valor: lucro_bruto, percentual: pct(lucro_bruto), tipo: 'subtotal' });

  const despesasOperacionais = bucketPorId('despesas_operacionais');
  linhas.push(despesasOperacionais);
  const ebitda = lucro_bruto + despesasOperacionais.valor;
  linhas.push({ id: 'ebitda', label: 'EBITDA / LAJIDA', valor: ebitda, percentual: pct(ebitda), tipo: 'subtotal' });

  const resultadoFinanceiro = bucketPorId('resultado_financeiro');
  linhas.push(resultadoFinanceiro);
  linhas.push({ id: 'impostos_lucro', label: 'Impostos sobre o Lucro', valor: 0, percentual: 0, tipo: 'deducao' });

  const lucro_liquido = ebitda + resultadoFinanceiro.valor;
  linhas.push({ id: 'lucro_liquido', label: 'Lucro Líquido do Período', valor: lucro_liquido, percentual: pct(lucro_liquido), tipo: 'final' });

  const margem_liquida = receita_liquida > 0 ? lucro_liquido / receita_liquida : 0;

  return { periodo: { inicio, fim }, linhas, margem_liquida };
}

async function fluxoCaixa({ dias } = {}) {
  const d = [30, 60, 90].includes(Number(dias)) ? Number(dias) : 90;

  // Busca os lançamentos individuais (não só o agregado) — a soma de cada semana é calculada
  // a partir deles mesmos, então a tabela consegue expandir pra mostrar a lista plana de
  // entradas/saídas que compõem aquela semana.
  const entRItens = await db.query(
    `SELECT date_trunc('week', ob.vencimento)::date AS semana, ob.vencimento AS data, ob.valor,
            o.numero, c.nome AS cliente, ob.parcela, ob.total_parcelas
     FROM orcamento_boletos ob
     JOIN orcamentos o ON o.id = ob.orcamento_id
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE ob.status = 'aguardando' AND ob.vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::interval
     ORDER BY ob.vencimento`, [String(d)]);
  // PIX e link Mercado Pago não têm vencimento (são cobrança à vista) — usa a data de envio da
  // cobrança pra bucketizar na semana certa. Só entra na tabela se foi enviada de hoje pra frente;
  // enviada antes de hoje e ainda não paga conta como atrasado (ver atrPixMp abaixo).
  const entPixMpItens = await db.query(
    `SELECT date_trunc('week', COALESCE(o.enviado_em, o.created_at))::date AS semana,
            COALESCE(o.enviado_em, o.created_at) AS data, o.total AS valor, o.numero, o.tipo_cobranca, c.nome AS cliente
     FROM orcamentos o
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE o.status_pagamento = 'aguardando_pagamento' AND o.tipo_cobranca IN ('pix','link_mp')
       AND COALESCE(o.enviado_em, o.created_at) BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::interval
     ORDER BY COALESCE(o.enviado_em, o.created_at)`, [String(d)]);
  const saiRItens = await db.query(
    `SELECT date_trunc('week', vencimento)::date AS semana, vencimento AS data, valor, descricao, fornecedor
     FROM contas_pagar
     WHERE status IN ('pendente','agendado','vencido') AND vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::interval
     ORDER BY vencimento`, [String(d)]);

  const keyOf = v => v instanceof Date ? v.toISOString().slice(0,10) : String(v);
  const map = {};
  const ensure = k => (map[k] = map[k] || { entradas: 0, saidas: 0, itens: [] });

  for (const r of entRItens.rows) {
    const bucket = ensure(keyOf(r.semana));
    const valor = Number(r.valor);
    bucket.entradas += valor;
    const parcelaTxt = r.total_parcelas > 1 ? ` (parcela ${r.parcela}/${r.total_parcelas})` : '';
    bucket.itens.push({
      tipo: 'entrada', origem: 'boleto',
      descricao: `Pedido #${r.numero} — ${r.cliente || 'Cliente não identificado'}${parcelaTxt}`,
      valor, data: keyOf(r.data),
    });
  }
  for (const r of entPixMpItens.rows) {
    const bucket = ensure(keyOf(r.semana));
    const valor = Number(r.valor);
    bucket.entradas += valor;
    const label = r.tipo_cobranca === 'pix' ? 'PIX' : 'Link Mercado Pago';
    bucket.itens.push({
      tipo: 'entrada', origem: r.tipo_cobranca,
      descricao: `Pedido #${r.numero} — ${r.cliente || 'Cliente não identificado'} (${label})`,
      valor, data: keyOf(r.data),
    });
  }
  for (const r of saiRItens.rows) {
    const bucket = ensure(keyOf(r.semana));
    const valor = Number(r.valor);
    bucket.saidas += valor;
    bucket.itens.push({
      tipo: 'saida', origem: 'conta_pagar',
      descricao: r.fornecedor ? `${r.descricao} — ${r.fornecedor}` : r.descricao,
      valor, data: keyOf(r.data),
    });
  }

  const semanas = Object.keys(map).sort().map(k => {
    const inicio = k;
    const fimD = new Date(k + 'T00:00:00'); fimD.setDate(fimD.getDate() + 6);
    const fim = fimD.toISOString().slice(0,10);
    const { entradas, saidas } = map[k];
    const itens = [...map[k].itens].sort((a, b) => a.data < b.data ? -1 : a.data > b.data ? 1 : 0);
    return { inicio, fim, entradas, saidas, liquido: entradas - saidas, itens };
  });

  const totalEnt = semanas.reduce((s,x)=>s+x.entradas,0);
  const totalSai = semanas.reduce((s,x)=>s+x.saidas,0);

  const atrR = await db.query(
    `SELECT COALESCE(SUM(valor),0) AS total FROM orcamento_boletos WHERE status='aguardando' AND vencimento < CURRENT_DATE`);
  const atrPixMp = await db.query(
    `SELECT COALESCE(SUM(total),0) AS total FROM orcamentos
     WHERE status_pagamento = 'aguardando_pagamento' AND tipo_cobranca IN ('pix','link_mp')
       AND COALESCE(enviado_em, created_at) < CURRENT_DATE`);
  const atrP = await db.query(
    `SELECT COALESCE(SUM(valor),0) AS total FROM contas_pagar WHERE status IN ('pendente','agendado','vencido') AND vencimento < CURRENT_DATE`);

  return {
    dias: d, semanas,
    total_entradas: totalEnt, total_saidas: totalSai,
    atrasado_receber: Number(atrR.rows[0].total) + Number(atrPixMp.rows[0].total),
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
