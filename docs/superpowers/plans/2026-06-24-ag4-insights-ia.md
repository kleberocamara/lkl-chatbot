# AG-4 — Insights IA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gerar sob demanda uma análise financeira em linguagem natural (DRE + Fluxo + Metas) via Claude API, salvando o último resultado, no bloco "Insights" da aba Análises.

**Architecture:** Tabela `insights_financeiros` (migration 040). Estende `src/modules/analises/` com um helper de chamada à Claude API (`fetch` nativo), `gerarInsight` e `ultimoInsight` + rotas. Frontend: nova pill "Insights" com botão de geração e exibição do último.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), Claude API (`claude-haiku-4-5` via fetch), vanilla-JS dashboard. Sem postgres local — `node --check` + smoke E2E no VPS.

**Convenções/Fatos verificados:**
- `ANTHROPIC_API_KEY` JÁ está no `.env` do VPS (validada: API responde com `claude-haiku-4-5`, header `anthropic-version: 2023-06-01`, `x-api-key`).
- Migrations `sql/migrations/NNN_*.sql`; próximo número livre: **040**. Tabela nova → user da app; se erro de permissão, `sudo -u postgres psql -d lkl_chatbot`.
- `src/modules/analises/service.js` exporta `{ dre, fluxoCaixa, salvarMeta, metaMes }`; `router.js` tem as rotas de dre/fluxo-caixa/metas e importa `requireRole`+`service`. Módulo em `/api/v2/analises`.
- VPS: root@2.25.147.243, /var/www/lkl-chatbot, DB `lkl_chatbot`. Deploy rsync; restart `pm2 restart lkl-chatbot --update-env`; node `node -r dotenv/config -e '<js>'`.
- Dashboard: aba Análises com sub-nav `analisesSub('dre'|'fluxo'|'metas')`, seções `#ag-*`, botões `#agtab-*`. Helpers `api`, `escHtml`, `showToast`.
- Node do VPS tem `fetch` global (Node 18+); o smoke da chave usou `fetch` com sucesso.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:**
- Create: `sql/migrations/040_insights.sql`
- Modify: `src/modules/analises/service.js` — `_chamarClaude`, `gerarInsight`, `ultimoInsight`.
- Modify: `src/modules/analises/router.js` — `GET/POST /insights`.
- Modify: `public/dashboard.html` — pill Insights + bloco.

---

### Task 1: Migration 040 — tabela `insights_financeiros`

**Files:**
- Create: `sql/migrations/040_insights.sql`

- [ ] **Step 1: Escrever a migration**

Create `sql/migrations/040_insights.sql`:
```sql
-- AG-4: insights financeiros gerados por IA
CREATE TABLE IF NOT EXISTS insights_financeiros (
  id         SERIAL PRIMARY KEY,
  gerado_em  TIMESTAMPTZ DEFAULT now(),
  periodo    VARCHAR(7),
  conteudo   TEXT NOT NULL,
  contexto   JSONB
);
```

- [ ] **Step 2: Aplicar no VPS**

```bash
rsync -az sql/migrations/040_insights.sql root@2.25.147.243:/var/www/lkl-chatbot/sql/migrations/040_insights.sql
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && psql \$DATABASE_URL -f sql/migrations/040_insights.sql 2>/dev/null || sudo -u postgres psql -d lkl_chatbot -f /var/www/lkl-chatbot/sql/migrations/040_insights.sql"
```
Expected: `CREATE TABLE` sem erro.

- [ ] **Step 3: Verificar**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && psql \$DATABASE_URL -c '\d insights_financeiros' 2>/dev/null || sudo -u postgres psql -d lkl_chatbot -c '\d insights_financeiros'"
```
Expected: tabela com id/gerado_em/periodo/conteudo/contexto.

- [ ] **Step 4: Commit**

```bash
git add sql/migrations/040_insights.sql
git commit -m "feat(analises): migration 040 — tabela insights_financeiros

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Backend — helper Claude + `gerarInsight` + `ultimoInsight` + rotas

**Files:**
- Modify: `src/modules/analises/service.js`
- Modify: `src/modules/analises/router.js`

- [ ] **Step 1: Adicionar o helper e as funções ao service**

Em `src/modules/analises/service.js`, antes do `module.exports`, adicionar:
```js
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
```
E trocar o `module.exports` para:
```js
module.exports = { dre, fluxoCaixa, salvarMeta, metaMes, gerarInsight, ultimoInsight };
```

- [ ] **Step 2: Adicionar as rotas**

Em `src/modules/analises/router.js`, antes de `module.exports = router;`, adicionar:
```js
router.get('/insights', requireRole('admin', 'gestor', 'financeiro'), async (req, res) => {
  try {
    res.json(await service.ultimoInsight());
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/insights', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.gerarInsight();
    res.status(201).json(result);
  } catch (err) {
    console.error('[INSIGHTS]', err.message);
    res.status(500).json({ error: err.message || 'Erro ao gerar análise' });
  }
});
```

- [ ] **Step 3: node --check**

```bash
node --check src/modules/analises/service.js && node --check src/modules/analises/router.js && echo OK
```
Expected: `OK`.

- [ ] **Step 4: Deploy + smoke (chamada real à IA — custa centavos)**

```bash
rsync -az src/modules/analises/ root@2.25.147.243:/var/www/lkl-chatbot/src/modules/analises/
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const s=require('./src/modules/analises/service');
(async()=>{
  const g=await s.gerarInsight();
  console.log('GERADO em', g.gerado_em, 'periodo', g.periodo);
  console.log('---'); console.log(g.conteudo.slice(0,400)); console.log('---');
  const u=await s.ultimoInsight();
  console.log('ULTIMO existe:', !!u, '| len:', u? u.conteudo.length : 0);
  process.exit(0);
})().catch(e=>{console.error('ERRO', e.message);process.exit(1)});
\""
```
Expected: imprime "GERADO em …", um trecho da análise em PT-BR (3 blocos), e "ULTIMO existe: true". Se imprimir "ANTHROPIC_API_KEY não configurada", a env não carregou — confirmar `grep ANTHROPIC_API_KEY /var/www/lkl-chatbot/.env`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/analises/
git commit -m "feat(analises): insights IA (claude-haiku-4-5) — gerarInsight/ultimoInsight + rotas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — pill "Insights" + bloco

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Investigar a sub-nav**

```bash
grep -n "agtab-metas\|function analisesSub\|id=\"ag-metas\"\|'dre','fluxo','metas'\|function showToast" public/dashboard.html | head
```
Confirmar a sub-nav (pills), o array de seções dentro de `analisesSub`, e onde fecha `#ag-metas`.

- [ ] **Step 2: Adicionar a pill e a seção**

Adicionar o botão (junto das pills DRE/Fluxo/Metas):
```html
<button id="agtab-insights" class="btn btn-outline" onclick="analisesSub('insights')">Insights</button>
```
Após o fechamento de `<div id="ag-metas">…</div>`, adicionar:
```html
<div id="ag-insights" style="display:none">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
    <div id="insight-data" style="font-size:12px;color:#777"></div>
    <button class="btn btn-primary" id="insight-btn" onclick="gerarInsightUI()">✨ Gerar nova análise</button>
  </div>
  <div id="insight-conteudo" style="background:#fff;border:0.5px solid #e8eaf6;border-radius:12px;padding:16px 18px;font-size:14px;line-height:1.6;white-space:pre-wrap;color:#333">Carregando…</div>
</div>
```

- [ ] **Step 3: Atualizar `analisesSub` + funções**

Localizar `function analisesSub` e incluir `'insights'` no array de seções e disparar o load. Substituir o trecho do array por:
```js
  ['dre','fluxo','metas','insights'].forEach(s => {
    const sec = document.getElementById('ag-' + s);
    const tab = document.getElementById('agtab-' + s);
    if (sec) sec.style.display = (s === secao) ? '' : 'none';
    if (tab) tab.className = 'btn ' + (s === secao ? 'btn-primary' : 'btn-outline');
  });
```
E, no fim de `analisesSub`, adicionar:
```js
  if (secao === 'insights') loadInsight();
```
Adicionar as funções:
```js
function _renderInsightMd(txt) {
  let h = (txt || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return h;
}
async function loadInsight() {
  const box = document.getElementById('insight-conteudo');
  const dt = document.getElementById('insight-data');
  const r = await api('/api/v2/analises/insights');
  if (!r || r.error) { box.textContent = 'Nenhuma análise ainda — clique em "Gerar nova análise".'; dt.textContent=''; return; }
  if (!r.conteudo) { box.textContent = 'Nenhuma análise ainda — clique em "Gerar nova análise".'; dt.textContent=''; return; }
  box.innerHTML = _renderInsightMd(r.conteudo);
  dt.textContent = 'Gerado em ' + new Date(r.gerado_em).toLocaleString('pt-BR');
}
async function gerarInsightUI() {
  const btn = document.getElementById('insight-btn');
  const box = document.getElementById('insight-conteudo');
  btn.disabled = true; const lbl = btn.textContent; btn.textContent = 'Analisando…';
  box.textContent = 'Analisando os números…';
  const r = await api('/api/v2/analises/insights', { method:'POST' });
  btn.disabled = false; btn.textContent = lbl;
  if (!r || r.error || r.errors) { showToast('Erro: ' + (r?.error || r?.errors?.[0] || 'falha na IA')); box.textContent = 'Não foi possível gerar a análise.'; return; }
  box.innerHTML = _renderInsightMd(r.conteudo);
  document.getElementById('insight-data').textContent = 'Gerado em ' + new Date(r.gerado_em).toLocaleString('pt-BR');
  showToast('✅ Análise gerada');
}
```
(Confirmar `showToast` e que `analisesSub` continua única.)

- [ ] **Step 4: Deploy + verificação (gera de verdade — custa centavos)**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
No painel: aba Análises → pill Insights → "Gerar nova análise" → texto aparece (3 blocos) + data; trocar de aba e voltar mostra o último salvo. Reportar.

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(analises): pill Insights IA + bloco (gerar/exibir última análise)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Atualizar memória do projeto

**Files:**
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Registrar**

Marcar "AG-4 Insights IA: CONCLUÍDO — 2026-06-24": tabela insights_financeiros (migration 040); módulo analises _chamarClaude (fetch api.anthropic.com, model claude-haiku-4-5, anthropic-version 2023-06-01, x-api-key do .env) + gerarInsight (coleta dre+fluxoCaixa(90)+metaMes, prompt PT-BR 3 blocos, salva) + ultimoInsight; rotas GET /analises/insights (admin/gestor/financeiro) e POST (admin/gestor, sob demanda). Frontend: pill Insights (#ag-insights) com botão "Gerar nova análise" + exibição do último com data. ANTHROPIC_API_KEY no .env do VPS (validada). Marcar Análises Gerenciais como COMPLETA (4/4 blocos: DRE, Fluxo, Metas, Insights). Próxima migration livre: 041. Lembrete de segurança: a ANTHROPIC_API_KEY foi colada no chat — recomendar rotacioná-la.

- [ ] **Step 2: Sem commit** (memória fora do git).

---

## Notas de verificação final

- O smoke da Task 2 e a verificação da Task 3 fazem chamadas REAIS à Claude API (custo de centavos cada). É esperado.
- Se a env var não carregar no processo do pm2, rodar `pm2 restart lkl-chatbot --update-env` (já incluído nos comandos).
- O modelo é `claude-haiku-4-5`; em caso de erro de modelo inexistente, conferir o id e ajustar.
