# AG-2 — Fluxo de Caixa — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Projetar o fluxo de caixa futuro por semana (entradas a receber × saídas a pagar) com saldo acumulado a partir de um saldo inicial, na aba Análises.

**Architecture:** Estende o módulo `src/modules/analises/` (AG-1) com `fluxoCaixa({dias})` + rota `GET /analises/fluxo-caixa`. Frontend: introduz sub-navegação por pills em `#page-analises` (DRE | Fluxo de Caixa) e adiciona o bloco de fluxo. Sem migration.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), vanilla-JS dashboard. Sem postgres local — `node --check` + smoke E2E no VPS.

**Convenções/Fatos verificados:**
- `const db = require('../../db')`; `db.query`. `src/modules/analises/service.js` já existe (exporta `dre`); `router.js` já existe com `GET /dre`. Módulo registrado em `/api/v2/analises`.
- `orcamento_boletos`: `vencimento DATE`, `valor NUMERIC(12,2)`, `status` ('aguardando'|'pago'|'cancelado').
- `contas_pagar`: `vencimento DATE`, `valor NUMERIC(10,2)`, `status` ('pendente'|'agendado'|'pago'|'vencido'|'cancelado').
- VPS: root@2.25.147.243, /var/www/lkl-chatbot, DB `lkl_chatbot`. Deploy via rsync; restart `pm2 restart lkl-chatbot --update-env`; node `node -r dotenv/config -e '<js>'`.
- Dashboard: `api(path,opts)` fetch-style (cookie-session); `#page-analises` hoje tem o bloco DRE (AG-1) com funções `loadAnalisesMain`/`drePeriodo`/`dreAplicar`/`renderDre`; helper `_kpiCard(label,valor,cor)`, `escHtml`; `showPage`+`loaders` (já tem `analises`).
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:**
- Modify: `src/modules/analises/service.js` — `fluxoCaixa`.
- Modify: `src/modules/analises/router.js` — `GET /fluxo-caixa`.
- Modify: `public/dashboard.html` — sub-nav DRE|Fluxo + bloco de fluxo.

---

### Task 1: Backend — `fluxoCaixa` no service + rota

**Files:**
- Modify: `src/modules/analises/service.js`
- Modify: `src/modules/analises/router.js`

- [ ] **Step 1: Adicionar `fluxoCaixa` ao service**

Em `src/modules/analises/service.js`, antes do `module.exports`, adicionar:

```js
async function fluxoCaixa({ dias } = {}) {
  const d = [30, 60, 90].includes(Number(dias)) ? Number(dias) : 90;
  // Entradas previstas por semana (segunda-feira como chave)
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
```

- [ ] **Step 2: Exportar `fluxoCaixa`**

Trocar o `module.exports` de `src/modules/analises/service.js` para:
```js
module.exports = { dre, fluxoCaixa };
```

- [ ] **Step 3: Adicionar a rota**

Em `src/modules/analises/router.js`, antes de `module.exports = router;`, adicionar:
```js
router.get('/fluxo-caixa', requireRole('admin', 'gestor', 'financeiro'), async (req, res) => {
  try {
    const result = await service.fluxoCaixa({ dias: req.query.dias });
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
```

- [ ] **Step 4: node --check**

```bash
node --check src/modules/analises/service.js && node --check src/modules/analises/router.js && echo OK
```
Expected: `OK`.

- [ ] **Step 5: Deploy + smoke**

```bash
rsync -az src/modules/analises/ root@2.25.147.243:/var/www/lkl-chatbot/src/modules/analises/
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const s=require('./src/modules/analises/service');
s.fluxoCaixa({dias:90}).then(r=>{ console.log(JSON.stringify(r)); process.exit(0); }).catch(e=>{console.error(e.message);process.exit(1)});
\""
```
Expected: imprime `{ dias:90, semanas:[...], total_entradas, total_saidas, atrasado_receber, atrasado_pagar }` (valores podem ser 0 sem dados — aceitável; o importante é não dar erro de SQL).

- [ ] **Step 6: Commit**

```bash
git add src/modules/analises/
git commit -m "feat(analises): fluxoCaixa semanal (a receber x a pagar) + GET /analises/fluxo-caixa

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Frontend — sub-nav DRE|Fluxo + bloco de fluxo de caixa

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Investigar o bloco DRE atual**

```bash
grep -n "page-analises\|loadAnalisesMain\|drePeriodo\|dreAplicar\|renderDre\|function _kpiCard" public/dashboard.html | head
```
Ler o HTML atual de `#page-analises` (todo o conteúdo do DRE construído no AG-1) e a função `loadAnalisesMain`.

- [ ] **Step 2: Envolver o DRE num sub-bloco e adicionar a sub-nav + bloco do fluxo**

Reestruturar o `#page-analises`: adicionar no topo um sub-menu em pills e envolver o conteúdo DRE atual numa `div id="ag-dre"`, criando uma `div id="ag-fluxo"` irmã (oculta por padrão). Inserir, logo após a abertura de `<div class="page" id="page-analises">`:
```html
<div style="display:flex;gap:8px;margin-bottom:14px">
  <button id="agtab-dre" class="btn btn-primary" onclick="analisesSub('dre')">DRE</button>
  <button id="agtab-fluxo" class="btn btn-outline" onclick="analisesSub('fluxo')">Fluxo de Caixa</button>
</div>
<div id="ag-dre">
  <!-- (todo o conteúdo DRE existente — seletor de período, #dre-kpis, #dre-despesas — fica AQUI dentro) -->
</div>
<div id="ag-fluxo" style="display:none">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
    <span style="font-size:13px;color:#777">Horizonte</span>
    <select id="fx-dias" onchange="loadFluxo()" style="width:110px"><option value="30">30 dias</option><option value="60">60 dias</option><option value="90" selected>90 dias</option></select>
    <span style="font-size:13px;color:#777">Saldo inicial</span>
    <input id="fx-saldo" type="number" step="0.01" value="0" oninput="renderFluxoTabela()" style="width:130px">
  </div>
  <div id="fx-kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px"></div>
  <div id="fx-tabela"></div>
</div>
```
IMPORTANTE: mover o conteúdo DRE existente para DENTRO de `#ag-dre` (não duplicar). Os ids `dre-ini`/`dre-kpis`/`dre-despesas` continuam os mesmos.

- [ ] **Step 3: Funções de sub-nav + fluxo**

Adicionar (reutilizar `_kpiCard`/`escHtml`):
```js
let _fluxoData = null;
function analisesSub(secao) {
  document.getElementById('ag-dre').style.display = secao === 'dre' ? '' : 'none';
  document.getElementById('ag-fluxo').style.display = secao === 'fluxo' ? '' : 'none';
  document.getElementById('agtab-dre').className = 'btn ' + (secao === 'dre' ? 'btn-primary' : 'btn-outline');
  document.getElementById('agtab-fluxo').className = 'btn ' + (secao === 'fluxo' ? 'btn-primary' : 'btn-outline');
  if (secao === 'fluxo' && !_fluxoData) loadFluxo();
}
async function loadFluxo() {
  const dias = document.getElementById('fx-dias').value;
  const r = await api(`/api/v2/analises/fluxo-caixa?dias=${dias}`);
  if (!r || r.errors || r.error) { document.getElementById('fx-tabela').innerHTML = '<p style="color:#c00">Erro ao carregar fluxo</p>'; return; }
  _fluxoData = r;
  renderFluxoKpis(); renderFluxoTabela();
}
function renderFluxoKpis() {
  const r = _fluxoData; const fmt = v => 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2});
  document.getElementById('fx-kpis').innerHTML =
    _kpiCard('Total a receber', fmt(r.total_entradas), '#2e7d32') +
    _kpiCard('Total a pagar', fmt(r.total_saidas), '#e65100') +
    _kpiCard('Atrasado a receber', fmt(r.atrasado_receber), '#c62828') +
    _kpiCard('Atrasado a pagar', fmt(r.atrasado_pagar), '#c62828');
}
function renderFluxoTabela() {
  if (!_fluxoData) return;
  const fmt = v => 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2});
  const fmtD = s => { const d = new Date(s+'T00:00:00'); return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}); };
  let saldo = parseFloat(document.getElementById('fx-saldo').value) || 0;
  const linhas = _fluxoData.semanas.length ? _fluxoData.semanas.map(s => {
    saldo += s.liquido;
    const corL = s.liquido >= 0 ? '#2e7d32' : '#c62828';
    const corS = saldo >= 0 ? '#2e7d32' : '#c62828';
    return `<tr style="border-bottom:0.5px solid #eee">
      <td style="padding:6px 8px">${fmtD(s.inicio)}–${fmtD(s.fim)}</td>
      <td style="padding:6px 8px;text-align:right;color:#2e7d32">${fmt(s.entradas)}</td>
      <td style="padding:6px 8px;text-align:right;color:#e65100">${fmt(s.saidas)}</td>
      <td style="padding:6px 8px;text-align:right;color:${corL}">${fmt(s.liquido)}</td>
      <td style="padding:6px 8px;text-align:right;font-weight:600;color:${corS}">${fmt(saldo)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" style="padding:14px;color:#999;text-align:center">Sem lançamentos no período</td></tr>';
  document.getElementById('fx-tabela').innerHTML = `
    <div style="background:#fff;border:0.5px solid #e8eaf6;border-radius:12px;padding:8px 4px;overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="color:#777;text-align:left">
          <th style="padding:6px 8px">Semana</th>
          <th style="padding:6px 8px;text-align:right">Entradas</th>
          <th style="padding:6px 8px;text-align:right">Saídas</th>
          <th style="padding:6px 8px;text-align:right">Líquido</th>
          <th style="padding:6px 8px;text-align:right">Saldo acumulado</th>
        </tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`;
}
```

- [ ] **Step 4: Garantir que ao abrir a aba o DRE continua o padrão**

`loadAnalisesMain` (do AG-1) continua carregando o DRE por padrão; a aba abre na seção DRE (pill DRE ativa). Não é preciso alterar `loadAnalisesMain` além de garantir que o markup do DRE está dentro de `#ag-dre`. Se necessário, no fim de `loadAnalisesMain`, deixar a sub-nav consistente chamando `analisesSub('dre')` antes do load — opcional.

- [ ] **Step 5: Deploy + verificação**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
No painel: aba Análises → alternar DRE/Fluxo pelas pills; em Fluxo, trocar horizonte (30/60/90) recarrega; trocar saldo inicial recalcula o saldo acumulado; cards-resumo corretos. Reportar.

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(analises): sub-nav DRE|Fluxo + bloco de fluxo de caixa semanal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Atualizar memória do projeto

**Files:**
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Registrar**

Marcar "AG-2 Fluxo de Caixa: CONCLUÍDO — 2026-06-24": fluxoCaixa({dias}) no módulo analises (GET /analises/fluxo-caixa) — entradas=orcamento_boletos status='aguardando' por semana (date_trunc week), saídas=contas_pagar status pendente/agendado/vencido por semana, na janela hoje..hoje+dias (30/60/90); atrasado_receber/atrasado_pagar (vencimento<hoje). Frontend: sub-nav DRE|Fluxo em #page-analises (analisesSub); bloco fluxo (loadFluxo/renderFluxoKpis/renderFluxoTabela) com horizonte + saldo inicial (acumulado no front). Remover AG-2 da fila. Próximos: AG-3 Metas, AG-4 Insights IA.

- [ ] **Step 2: Sem commit** (memória fora do git).

---

## Notas de verificação final

- Confirmar que `date_trunc('week', ...)` agrupa como esperado (semana começando na segunda) — aceitável para a visão semanal.
- O saldo acumulado é só no front (parte do "Saldo inicial"); trocar o saldo não refaz a requisição.
- Valores monetários via `toLocaleString('pt-BR',{minimumFractionDigits:2})`.
