# DRE em Cascata (Análise Vertical) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir a DRE atual (receita − lista plana de despesas = resultado) por uma cascata contábil de 12 linhas (Receita Bruta → Receita Líquida → Margem de Contribuição → Lucro Bruto → EBITDA → Lucro Líquido), cada linha com valor e percentual sobre a Receita Bruta, com detalhamento expansível por categoria.

**Architecture:** Backend: `dre()` em `src/modules/analises/service.js` faz as mesmas 2 queries de hoje (receita por competência de entrega, despesas por `categoria_dre`), mas mapeia o resultado agrupado num array `linhas` fixo, calculando subtotais em cascata e percentual (`valor / receita_bruta * 100`) em cada linha. `gerarInsight()` (que consome `dre()`) é ajustado para ler o novo formato. Frontend: `renderDre()` em `public/dashboard.html` troca a lista de barras horizontais por uma cascata clicável/expansível, reaproveitando `_kpiCard`/`escHtml` já existentes.

**Tech Stack:** Node.js/Express, PostgreSQL, Jest, vanilla JS em `public/dashboard.html`.

---

### Task 1: `dre()` — cascata com subtotais e percentuais

**Files:**
- Modify: `src/modules/analises/service.js:13-55` (função `dre`) e `src/modules/analises/service.js:152-190` (função `gerarInsight`, que consome o retorno de `dre()`)
- Test: `tests/analises-dre.test.js` (reescrita completa)

- [ ] **Step 1: Reescrever os testes existentes para o novo formato**

Substitua todo o conteúdo de `tests/analises-dre.test.js`:

```js
const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { dre } = require('../src/modules/analises/service');

function linha(r, id) { return r.linhas.find(l => l.id === id); }

describe('dre — receita pela última entrega do pedido', () => {
  afterEach(() => jest.clearAllMocks());

  test('usa a query de entregas (não mais pago_em de orçamentos)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ receita: 5000 }] })
      .mockResolvedValueOnce({ rows: [] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(linha(r, 'receita_bruta').valor).toBe(5000);
    const receitaSql = db.query.mock.calls[0][0];
    expect(receitaSql).toMatch(/os_historico/);
    expect(receitaSql).toMatch(/para_status = 'entregue'/);
    expect(receitaSql).toMatch(/total_os = e\.os_entregues/);
    expect(receitaSql).not.toMatch(/status_pagamento/);
  });
});

describe('dre — despesas por competência', () => {
  afterEach(() => jest.clearAllMocks());

  test('despesa pendente (não paga) dentro da competência do período conta', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ receita: 0 }] })
      .mockResolvedValueOnce({ rows: [{ categoria: 'CUSTOS DE PRODUÇÃO (CPV)', valor: 900 }] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(linha(r, 'cpv').valor).toBe(-900);
    const despesasSql = db.query.mock.calls[1][0];
    expect(despesasSql).toMatch(/cp\.competencia BETWEEN/);
    expect(despesasSql).not.toMatch(/pago_em/);
    expect(despesasSql).toMatch(/status != 'cancelado'/);
  });
});

describe('dre — cascata completa', () => {
  afterEach(() => jest.clearAllMocks());

  test('cada subtotal soma corretamente a partir das linhas de dedução', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ receita: 10000 }] })
      .mockResolvedValueOnce({ rows: [
        { categoria: 'DEDUÇÕES DE VENDAS', valor: 600 },
        { categoria: 'CUSTOS DE PRODUÇÃO (CPV)', valor: 3000 },
        { categoria: 'DEDUÇÕES E DESPESAS COMERCIAIS', valor: 900 },
        { categoria: 'MÃO DE OBRA DIRETA (MOD)', valor: 1200 },
        { categoria: 'CUSTOS OPERACIONAIS DA FÁBRICA', valor: 300 },
        { categoria: 'OCUPAÇÃO E INFRAESTRUTURA', valor: 800 },
        { categoria: 'SEGUROS', valor: 100 },
        { categoria: 'DESPESAS FINANCEIRAS', valor: 200 },
      ] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(linha(r, 'receita_bruta').valor).toBe(10000);
    expect(linha(r, 'deducoes_vendas').valor).toBe(-600);
    expect(linha(r, 'receita_liquida').valor).toBe(9400);
    expect(linha(r, 'cpv').valor).toBe(-3000);
    expect(linha(r, 'despesas_comerciais').valor).toBe(-900);
    expect(linha(r, 'margem_contribuicao').valor).toBe(5500);
    expect(linha(r, 'custos_fixos_producao').valor).toBe(-1500);
    expect(linha(r, 'lucro_bruto').valor).toBe(4000);
    expect(linha(r, 'despesas_operacionais').valor).toBe(-900);
    expect(linha(r, 'ebitda').valor).toBe(3100);
    expect(linha(r, 'resultado_financeiro').valor).toBe(-200);
    expect(linha(r, 'impostos_lucro').valor).toBe(0);
    expect(linha(r, 'lucro_liquido').valor).toBe(2900);
    expect(r.margem_liquida).toBeCloseTo(2900 / 9400, 4);
  });

  test('linha com detalhamento traz cada categoria; linha sem lançamento fica sem detalhamento', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ receita: 10000 }] })
      .mockResolvedValueOnce({ rows: [
        { categoria: 'MÃO DE OBRA DIRETA (MOD)', valor: 1200 },
      ] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    const custosFixos = linha(r, 'custos_fixos_producao');
    expect(custosFixos.valor).toBe(-1200);
    expect(custosFixos.detalhamento).toEqual([
      { categoria: 'MÃO DE OBRA DIRETA (MOD)', valor: -1200, percentual: -12 },
    ]);

    const cpv = linha(r, 'cpv');
    expect(cpv.valor).toBe(0);
    expect(cpv.detalhamento).toBeUndefined();
  });

  test('receita_bruta = 0 → todos os percentuais retornam 0, sem erro de divisão', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ receita: 0 }] })
      .mockResolvedValueOnce({ rows: [{ categoria: 'CUSTOS DE PRODUÇÃO (CPV)', valor: 500 }] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(r.linhas.every(l => Number.isFinite(l.percentual))).toBe(true);
    expect(linha(r, 'lucro_liquido').percentual).toBe(0);
    expect(r.margem_liquida).toBe(0);
  });

  test('período sem nenhuma despesa → todas as linhas de dedução ficam com valor 0, sem detalhamento', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ receita: 5000 }] })
      .mockResolvedValueOnce({ rows: [] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    r.linhas.filter(l => l.tipo === 'deducao').forEach(l => {
      expect(l.valor).toBe(0);
      expect(l.detalhamento).toBeUndefined();
    });
    expect(linha(r, 'lucro_liquido').valor).toBe(5000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/analises-dre.test.js --verbose`
Expected: FAIL — o `dre()` atual devolve `{receita, despesas, total_despesas, resultado, margem}`, não `{linhas, margem_liquida}`; `linha(r, 'receita_bruta')` retorna `undefined`.

- [ ] **Step 3: Implementar a cascata**

Substitua a função `dre()` em `src/modules/analises/service.js:13-55` (mantém `_mesCorrente`/`DATE_RE` como estão, acima dela):

```js
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
    const valor = -categorias.reduce((s, c) => s + (porCategoria[c] || 0), 0);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/analises-dre.test.js --verbose`
Expected: PASS (todos os testes do arquivo)

- [ ] **Step 5: Atualizar `gerarInsight()` para o novo formato**

`gerarInsight()` (`src/modules/analises/service.js:152-190` antes desta mudança) usa `d.receita`, `d.despesas`, `d.total_despesas`, `d.resultado`, `d.margem` — campos que não existem mais no retorno de `dre()`. Substitua o trecho que monta a string `user` (mantém `_chamarClaude`, o `INSERT` em `insights_financeiros` e o resto igual):

```js
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
```

Não existe teste automatizado para `gerarInsight()` no projeto (chama a API do Claude — não mockado em nenhum arquivo hoje); a verificação aqui é por leitura cuidadosa comparando com a assinatura nova de `dre()`, mesmo padrão já usado no restante do arquivo.

- [ ] **Step 6: Rodar a suíte completa do arquivo para checar regressão**

Run: `npx jest tests/analises-dre.test.js --verbose`
Expected: PASS (7 testes: 1 receita + 1 despesas + 5 da cascata completa)

- [ ] **Step 7: Commit**

```bash
git add src/modules/analises/service.js tests/analises-dre.test.js
git commit -m "feat(analises): DRE em cascata com subtotais e percentual sobre receita bruta"
```

---

### Task 2: Frontend — cascata expansível em `dashboard.html`

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Reescrever `renderDre()`**

Em `public/dashboard.html`, localize a função `renderDre(r)` (por volta da linha 5284-5314):

```js
function renderDre(r) {
  const fmt = v => 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2});
  const corRes = r.resultado >= 0 ? '#2e7d32' : '#c62828';
  document.getElementById('dre-kpis').innerHTML =
    _kpiCard('Receita', fmt(r.receita)) +
    _kpiCard('Despesas', fmt(r.total_despesas), '#e65100') +
    _kpiCard('Resultado', fmt(r.resultado), corRes) +
    _kpiCard('Margem', (r.margem*100).toFixed(1) + '%', corRes);
  const max = Math.max(1, ...r.despesas.map(d => d.valor));
  const linhas = r.despesas.length ? r.despesas.map(d => {
    const pct = r.total_despesas > 0 ? (d.valor / r.total_despesas * 100) : 0;
    const w = (d.valor / max * 100);
    return `<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px">
        <span>${escHtml(d.categoria)}</span>
        <span style="color:#555">${fmt(d.valor)} · ${pct.toFixed(1)}%</span>
      </div>
      <div style="background:#f0f0f0;border-radius:6px;height:8px;overflow:hidden">
        <div style="background:#e65100;height:8px;width:${w}%"></div>
      </div></div>`;
  }).join('') : '<p style="color:#999;padding:12px">Sem despesas no período</p>';
  document.getElementById('dre-despesas').innerHTML = `
    <div style="background:#fff;border:0.5px solid #e8eaf6;border-radius:12px;padding:14px 16px">
      <div style="font-weight:700;color:#3949ab;font-size:13px;margin-bottom:10px">DESPESAS POR CATEGORIA</div>
      ${linhas}
      <div style="border-top:0.5px solid #eee;margin-top:10px;padding-top:10px;display:flex;justify-content:space-between;font-weight:600">
        <span>Receita ${fmt(r.receita)} − Despesas ${fmt(r.total_despesas)}</span>
        <span style="color:${corRes}">= ${fmt(r.resultado)}</span>
      </div>
    </div>`;
}
```

Substitua por:

```js
function renderDre(r) {
  const fmt = v => 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2});
  const pctFmt = v => Number(v||0).toFixed(1) + '%';
  const achar = id => r.linhas.find(l => l.id === id);
  const lucroLiquido = achar('lucro_liquido');
  const corRes = lucroLiquido && lucroLiquido.valor >= 0 ? '#2e7d32' : '#c62828';

  const receitaLiquida = achar('receita_liquida');
  const margemContrib = achar('margem_contribuicao');
  const ebitda = achar('ebitda');
  document.getElementById('dre-kpis').innerHTML =
    _kpiCard('Receita Líquida', fmt(receitaLiquida ? receitaLiquida.valor : 0)) +
    _kpiCard('Margem de Contribuição', fmt(margemContrib ? margemContrib.valor : 0)) +
    _kpiCard('EBITDA / LAJIDA', fmt(ebitda ? ebitda.valor : 0)) +
    _kpiCard('Lucro Líquido', fmt(lucroLiquido ? lucroLiquido.valor : 0) + ` (${(r.margem_liquida*100).toFixed(1)}%)`, corRes);

  const estiloLinha = tipo => {
    if (tipo === 'subtotal') return 'background:var(--bg-secondary,#f5f5f7);font-weight:600;font-size:14px;padding:10px 14px';
    if (tipo === 'final') return 'background:#e8f5e9;font-weight:700;font-size:15px;padding:12px 14px';
    return 'padding:8px 14px 8px 24px;font-size:13px';
  };

  const linhasHtml = r.linhas.map((l, i) => {
    const cor = l.tipo === 'final' ? corRes : (l.valor < 0 ? '#666' : 'inherit');
    const temDetalhamento = Array.isArray(l.detalhamento) && l.detalhamento.length > 0;
    const detId = `dre-det-${l.id}`;
    const seta = temDetalhamento ? `<span id="${detId}-seta" style="margin-right:6px;display:inline-block;width:10px">▸</span>` : '';
    const clickAttr = temDetalhamento ? ` onclick="dreToggleLinha('${l.id}')"` : '';
    const detalhamentoHtml = temDetalhamento ? `<div id="${detId}" style="display:none;background:#fafafa">
      ${l.detalhamento.map(d => `<div style="display:flex;justify-content:space-between;padding:4px 14px 4px 40px;font-size:12px;color:#666">
        <span>${escHtml(d.categoria)}</span><span>${pctFmt(d.percentual)} · ${fmt(d.valor)}</span>
      </div>`).join('')}
    </div>` : '';
    return `<div style="display:flex;justify-content:space-between;align-items:center;border-top:${i===0?'none':'0.5px solid #eee'};${estiloLinha(l.tipo)};cursor:${temDetalhamento?'pointer':'default'}"${clickAttr}>
        <span style="color:${cor}">${seta}${escHtml(l.label)}</span>
        <span style="color:${cor}">${pctFmt(l.percentual)} · ${fmt(l.valor)}</span>
      </div>${detalhamentoHtml}`;
  }).join('');

  document.getElementById('dre-despesas').innerHTML = `
    <div style="background:#fff;border:0.5px solid #e8eaf6;border-radius:12px;overflow:hidden">
      ${linhasHtml}
    </div>`;
}

function dreToggleLinha(id) {
  const det = document.getElementById(`dre-det-${id}`);
  const seta = document.getElementById(`dre-det-${id}-seta`);
  if (!det) return;
  const aberto = det.style.display === 'block';
  det.style.display = aberto ? 'none' : 'block';
  if (seta) seta.textContent = aberto ? '▸' : '▾';
}
```

- [ ] **Step 2: Verificar que `dreAplicar()` continua compatível**

`dreAplicar()` (por volta da linha 5277-5283) já só faz `api(...)` e chama `renderDre(r)` — não referencia nenhum campo específico do formato antigo (`r.receita`, `r.despesas`, etc.), então não precisa de mudança. Confirme isso lendo a função antes de seguir — se ela tiver alguma referência direta a campos antigos que não notamos, ajuste também.

- [ ] **Step 3: Verificar que não sobrou nenhuma referência ao formato antigo**

Run: `grep -n "r\.receita\b\|r\.despesas\b\|r\.total_despesas\b\|r\.resultado\b\|r\.margem\b" public/dashboard.html`
Expected: nenhuma ocorrência dentro do bloco de `renderDre`/`dreAplicar` (pode haver falsos positivos em outras partes do arquivo com variáveis `r` de outras funções — confirme que são de outros contextos, não da DRE).

- [ ] **Step 4: Checar sintaxe**

Run: `node -e "new Function(require('fs').readFileSync('public/dashboard.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"`
Expected: sem erro. Se houver mais de uma tag `<script>`, confirme com `grep -n '<script'` qual contém `renderDre`/`dreToggleLinha` e valide essa.

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(dashboard): DRE em cascata expansivel com percentual por linha"
```

---

### Task 3: Deploy no VPS

**Files:** nenhum (só deploy)

- [ ] **Step 1: Rodar a suíte local**

Run: `npx jest tests/analises-dre.test.js --verbose`
Expected: todos PASS.

Run: `npx jest 2>&1 | tail -10`
Expected: mesma baseline de falhas pré-existentes (testes de integração que dependem de Postgres real, não afetados por esta mudança) — confirmar que a contagem de falhas não aumentou.

- [ ] **Step 2: Pedir confirmação do usuário antes de deployar**

Esse deploy toca produção — confirmar com o usuário (AskUserQuestion) antes do rsync/pm2 restart, seguindo o padrão já estabelecido no projeto.

- [ ] **Step 3: Deploy**

```bash
rsync -R -av src/modules/analises/service.js public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```

- [ ] **Step 4: Smoke test em produção**

```bash
ssh root@2.25.147.243 "pm2 logs lkl-chatbot --lines 30 --nostream"
```
Expected: processo online, sem erro no restart.

Depois, verificar manualmente em `https://app.graficalkl.com.br/dashboard` → Análises Gerenciais → DRE: cascata aparece com os 12 níveis, percentuais fazem sentido, clique em linhas com detalhamento abre/fecha a sublista, KPIs do topo batem com a linha correspondente na cascata.

---

## Fora de escopo (reafirmado do spec)

- Fluxo de Caixa (spec/plano separado, incluindo o bug do "atrasado" fora da tabela semanal).
- Cálculo automático de impostos (sobre faturamento ou sobre lucro) — `impostos_lucro` permanece fixo em 0.
- Comparação com mês anterior / período anterior.
- `metaMes()` não muda (usa base de receita por `aprovado_em`, propositalmente diferente).
