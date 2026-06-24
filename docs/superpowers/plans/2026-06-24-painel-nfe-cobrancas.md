# NF-e e Cobranças no Painel Unificado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir os placeholders das abas "NF-e" e "Cobranças" do dashboard por abas de gestão nativas (KPIs + cartões + ações), reutilizando os endpoints existentes.

**Architecture:** Apenas `public/dashboard.html`. Cada aba carrega `GET /api/v2/orcamentos` uma vez e deriva KPIs + lista no front. Ações reusam os endpoints de `/api/v2/nfe/*` e `/api/v2/orcamentos/:id/cobrar` + cancels. Os modais pesados (emissão NF-e, cobrança) são PORTADOS de `public/pwa/admin.html`, adaptando a assinatura de `api()` e o mecanismo de modal.

**Tech Stack:** HTML/vanilla-JS no dashboard. Sem backend, sem migration. Verificação manual no painel (sem `node --check` — só front).

**Convenções/Fatos verificados:**
- Deploy: `rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html`. (Restart NÃO é necessário para mudança só de estático, mas pode rodar `pm2 restart` por garantia.)
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **IMPORTANTE — duas assinaturas de `api()` diferentes:**
  - No `dashboard.html`: `api(path, opts)` estilo fetch → `await api('/api/v2/...', { method:'POST', body: JSON.stringify(payload) })`. Auth é cookie-session (`credentials:'include'` embutido). Confirmar lendo a função `api` no dashboard.
  - No `admin.html` (origem dos modais portados): `api('POST', '/url', body)` (método primeiro, body objeto). Ao portar, CONVERTER toda chamada para a assinatura do dashboard.
- Modal do dashboard: `showModal(title, html, width)` injeta em `#generic-modal`; fecha com `closeModal()`. (Confirmar lendo; algumas telas usam `#modal-cadastro`/`fecharModalCadastro` — usar o que `showModal` realmente faz.)
- `GET /api/v2/orcamentos` retorna por orçamento: `id, numero, status, total, cliente_nome, status_pagamento, tipo_cobranca, nfe_status` (só 'autorizada' ou null), `nfe_id` (id da NF autorizada ou null), `tem_os_entregue` (bool), `boletos_parcelas[]` (cada: `parcela, total_parcelas, boleto_id, linha_digitavel, pdf_url, vencimento, valor`).
- A listagem por padrão pagina (limit 20). Para as abas, buscar com `?limit=500` para abranger o conjunto.
- Placeholders a substituir: `#page-nfe` e `#page-cobrancas` no dashboard. NAV já tem entradas `nfe` e `cobrancas`. `showPage(id)` tem um dict `loaders`.
- Endpoints NF-e: `POST /api/v2/nfe/:orcId/emitir` (payload em admin.html `submeterNfe`, ~linha 1243: `{ cnpj_emitente, cfop, ncm_por_item, frete_por_conta, frete_valor, transportador }`); `GET /api/v2/nfe/danfe/:id`; `POST /api/v2/nfe/:nfeId/cancelar` (body `{ justificativa }`); `POST /api/v2/nfe/:nfeId/corrigir` (body `{ correcao }`); `POST /api/v2/nfe/inutilizar`.
- Endpoint cobrança: `POST /api/v2/orcamentos/:id/cobrar` body `{ tipo, parcelas, dataVencimento, intervaloDias }` (tipo: 'boleto'|'pix'|'link_mp'); cancels: `POST /:id/boleto/cancelar`, `/:id/pix/cancelar`, `/:id/link_mp/cancelar`.

**File Structure:** todas as mudanças em `public/dashboard.html`.

---

## FASE 1 — Aba NF-e

### Task 1: Aba NF-e — KPIs + lista de cartões

**Files:**
- Modify: `public/dashboard.html` (bloco `#page-nfe`, dict `loaders`, novas funções JS)

- [ ] **Step 1: Ler os padrões reais**

Run:
```bash
grep -n "page-nfe\|page-cobrancas\|loaders\|function api\|function showModal\|function closeModal\|function showToast\|function escHtml\|orcBadge\|ORC_STATUS" public/dashboard.html | head -40
```
Confirmar: (a) o HTML atual de `#page-nfe`; (b) a assinatura real de `api(path,opts)`; (c) `showModal/closeModal`; (d) helpers `showToast/escHtml`; (e) como `showPage` chama os loaders.

- [ ] **Step 2: Substituir o conteúdo de `#page-nfe`**

Trocar o miolo do `<div class="page" id="page-nfe">` (hoje um placeholder) por:
```html
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
  <div style="display:flex;align-items:center;gap:10px"><span style="font-size:20px">📄</span><h2 style="margin:0">NF-e</h2></div>
  <div style="display:flex;gap:8px">
    <input id="nfe-busca" placeholder="Buscar cliente / nº" oninput="renderNfeLista()" style="width:180px">
    <button class="btn btn-outline" onclick="abrirInutilizarNfe()">Inutilizar numeração</button>
  </div>
</div>
<div id="nfe-kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px"></div>
<div id="nfe-lista"><div style="text-align:center;padding:40px;color:#999">Carregando...</div></div>
```

- [ ] **Step 3: Registrar o loader**

No dict `loaders` de `showPage`, adicionar:
```js
    nfe: () => loadNfeMain(),
```

- [ ] **Step 4: Funções de carga + KPIs + lista**

Adicionar (adaptar helpers aos nomes reais do Step 1):
```js
let _nfeOrcs = [];
function _kpiCard(label, valor, cor) {
  return `<div style="background:var(--bg-secondary,#f5f5f7);border-radius:8px;padding:14px 16px">
    <div style="font-size:13px;color:#777">${label}</div>
    <div style="font-size:24px;font-weight:600;${cor?`color:${cor}`:''}">${valor}</div></div>`;
}
async function loadNfeMain() {
  const r = await api('/api/v2/orcamentos?limit=500');
  const all = r?.data || r?.orcamentos || r?.items || (Array.isArray(r) ? r : []);
  // faturáveis: concluídos/entregues/aprovados
  _nfeOrcs = all.filter(o => ['concluido','entregue','aprovado'].includes(o.status) || o.tem_os_entregue || o.nfe_status);
  renderNfeKpis(); renderNfeLista();
}
function _mesCorrente(d) { if (!d) return false; const x = new Date(d); const n = new Date(); return x.getMonth() === n.getMonth() && x.getFullYear() === n.getFullYear(); }
function renderNfeKpis() {
  const emitidas = _nfeOrcs.filter(o => o.nfe_status === 'autorizada');
  const faturadoMes = emitidas.filter(o => _mesCorrente(o.updated_at || o.created_at)).reduce((s,o)=>s+Number(o.total||0),0);
  const aFaturar = _nfeOrcs.filter(o => !o.nfe_status).length;
  document.getElementById('nfe-kpis').innerHTML =
    _kpiCard('Faturado no mês', 'R$ ' + faturadoMes.toLocaleString('pt-BR',{minimumFractionDigits:2})) +
    _kpiCard('NF-e emitidas', emitidas.length) +
    _kpiCard('A faturar', aFaturar, '#e65100');
}
function _pillNfe(o) {
  if (o.nfe_status === 'autorizada') return '<span style="font-size:11px;background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:20px">Emitida</span>';
  return '<span style="font-size:11px;background:#f1f1f1;color:#777;padding:2px 8px;border-radius:20px">Sem NF</span>';
}
function renderNfeLista() {
  const q = (document.getElementById('nfe-busca')?.value || '').toLowerCase();
  const list = _nfeOrcs.filter(o => !q || (`${o.numero} ${o.cliente_nome||''}`.toLowerCase().includes(q)));
  const box = document.getElementById('nfe-lista');
  if (!list.length) { box.innerHTML = '<p style="color:#999;padding:20px">Nenhum orçamento a faturar</p>'; return; }
  box.innerHTML = list.map(o => {
    const acoes = o.nfe_status === 'autorizada'
      ? `<a class="btn btn-outline" href="/api/v2/nfe/danfe/${o.nfe_id}" target="_blank" style="padding:6px 10px;text-decoration:none">DANFE</a>
         <button class="btn btn-outline" onclick="abrirCceNfe('${o.nfe_id}')" style="padding:6px 10px">CC-e</button>
         <button class="btn btn-outline" onclick="abrirCancelarNfe('${o.nfe_id}')" style="padding:6px 10px;color:#c62828">Cancelar</button>`
      : `<button class="btn btn-primary" onclick="abrirEmitirNfe('${o.id}')" style="padding:6px 10px">Emitir NF-e</button>`;
    return `<div style="background:#fff;border:0.5px solid #e8eaf6;border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:14px;margin-bottom:8px">
      <div style="width:40px;height:40px;border-radius:50%;background:#eef;display:flex;align-items:center;justify-content:center">📄</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600">#${o.numero||'—'} · ${escHtml(o.cliente_nome||'—')}</div>
        <div style="font-size:12px;color:#777">${o.status} ${_pillNfe(o)}</div>
      </div>
      <div style="font-weight:600;white-space:nowrap">R$ ${Number(o.total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>
      <div style="display:flex;gap:6px">${acoes}</div>
    </div>`;
  }).join('');
}
```
NOTA: confirmar no Step 1 a chave real da lista retornada por `api('/api/v2/orcamentos')` (o service retorna `{ data, total, page, limit }` — provavelmente `r.data`). Ajustar a linha `const all = ...` para a chave correta.

- [ ] **Step 5: Deploy + verificação**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
Abrir o painel (admin), ir na aba NF-e e confirmar: KPIs aparecem, lista de faturáveis carrega, pill de status correta. (Verificação visual; reportar o que viu.)

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(painel): aba NF-e — KPIs + lista de faturáveis

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Aba NF-e — modais de ação (emitir / DANFE / CC-e / cancelar / inutilizar)

**Files:**
- Modify: `public/dashboard.html`
- Reference (PORTAR de): `public/pwa/admin.html`

- [ ] **Step 1: Ler os modais de origem no admin.html**

Run:
```bash
grep -n "function abrirModalNfe\|function submeterNfe\|function abrirModalCancelarNfe\|function submitCancelarNfe\|function abrirModalCceNfe\|function submitCceNfe\|inutilizar\|_nfeItens" public/pwa/admin.html
```
Ler os blocos: `abrirModalNfe` (monta o form de emissão — emitente, CFOP, NCM por item, frete, transportador), `submeterNfe` (POST `/api/v2/nfe/:orcId/emitir` com `{ cnpj_emitente, cfop, ncm_por_item, frete_por_conta, frete_valor, transportador }`), cancelar (`/:nfeId/cancelar` body `{justificativa}`), CC-e (`/:nfeId/corrigir` body `{correcao}`), inutilizar (`/inutilizar`).

- [ ] **Step 2: Portar o modal de emissão**

Criar `abrirEmitirNfe(orcId)` no dashboard que:
- Busca os dados necessários (itens do orçamento p/ NCM) via `api('/api/v2/orcamentos/'+orcId)`.
- Monta o MESMO formulário do `abrirModalNfe` do admin (emitente Factor/LKL select, CFOP default, NCM por item, frete `frete_por_conta` + valor + transportador condicional), injetado com `showModal('Emitir NF-e', html, '640px')`.
- O submit replica `submeterNfe`, mas usando a assinatura do dashboard:
  ```js
  const data = await api(`/api/v2/nfe/${orcId}/emitir`, { method:'POST', body: JSON.stringify(body) });
  ```
  onde `body` = `{ cnpj_emitente, cfop, ncm_por_item, frete_por_conta, frete_valor, transportador }` montado igual ao admin.
- Em sucesso (`data.status === 'autorizada'`): mostra chave/protocolo + link DANFE (`data.danfe_url` ou `/api/v2/nfe/danfe/${data.id}`), `showToast('✅ NF-e autorizada')`, fecha e `loadNfeMain()`. Em erro: mostra `data.errors||[data.error]`.

- [ ] **Step 3: Portar cancelar / CC-e / inutilizar**

Criar:
```js
function abrirCancelarNfe(nfeId) {
  const html = `<p>Justificativa do cancelamento (mín. 15 caracteres):</p>
    <textarea id="nfe-just" rows="3" style="width:100%"></textarea>
    <button class="btn btn-primary" style="margin-top:10px" onclick="submitCancelarNfe('${nfeId}')">Cancelar NF-e</button>`;
  showModal('Cancelar NF-e', html, '480px');
}
async function submitCancelarNfe(nfeId) {
  const justificativa = document.getElementById('nfe-just').value.trim();
  if (justificativa.length < 15) { showToast('Justificativa precisa de ao menos 15 caracteres'); return; }
  const res = await api(`/api/v2/nfe/${nfeId}/cancelar`, { method:'POST', body: JSON.stringify({ justificativa }) });
  if (res?.errors || res?.error) { showToast('Erro: ' + (res.errors?.[0]||res.error)); return; }
  closeModal(); showToast('NF-e cancelada'); loadNfeMain();
}
function abrirCceNfe(nfeId) {
  const html = `<p>Texto da correção (mín. 15 caracteres):</p>
    <textarea id="nfe-cce" rows="3" style="width:100%"></textarea>
    <button class="btn btn-primary" style="margin-top:10px" onclick="submitCceNfe('${nfeId}')">Enviar CC-e</button>`;
  showModal('Carta de Correção', html, '480px');
}
async function submitCceNfe(nfeId) {
  const correcao = document.getElementById('nfe-cce').value.trim();
  if (correcao.length < 15) { showToast('Correção precisa de ao menos 15 caracteres'); return; }
  const res = await api(`/api/v2/nfe/${nfeId}/corrigir`, { method:'POST', body: JSON.stringify({ correcao }) });
  if (res?.errors || res?.error) { showToast('Erro: ' + (res.errors?.[0]||res.error)); return; }
  closeModal(); showToast('CC-e enviada'); loadNfeMain();
}
function abrirInutilizarNfe() {
  const html = `<p>Inutilizar faixa de numeração (justificativa + faixa). Verifique os campos exigidos pelo backend no admin.html.</p>
    <label>Justificativa<textarea id="inut-just" rows="2" style="width:100%"></textarea></label>
    <div style="display:flex;gap:8px;margin-top:8px">
      <label style="flex:1">Número inicial<input id="inut-ini" type="number" style="width:100%"></label>
      <label style="flex:1">Número final<input id="inut-fim" type="number" style="width:100%"></label>
    </div>
    <button class="btn btn-primary" style="margin-top:10px" onclick="submitInutilizar()">Inutilizar</button>`;
  showModal('Inutilizar numeração', html, '480px');
}
async function submitInutilizar() {
  const justificativa = document.getElementById('inut-just').value.trim();
  const numero_inicial = parseInt(document.getElementById('inut-ini').value);
  const numero_final = parseInt(document.getElementById('inut-fim').value);
  if (justificativa.length < 15 || !numero_inicial || !numero_final) { showToast('Preencha justificativa (15+) e a faixa'); return; }
  const res = await api('/api/v2/nfe/inutilizar', { method:'POST', body: JSON.stringify({ justificativa, numero_inicial, numero_final }) });
  if (res?.errors || res?.error) { showToast('Erro: ' + (res.errors?.[0]||res.error)); return; }
  closeModal(); showToast('Numeração inutilizada');
}
```
IMPORTANTE: ler em `admin.html` os nomes EXATOS dos campos esperados por `/inutilizar` e `/corrigir` (ex.: o backend pode esperar `correcao` ou `texto_correcao`, e a inutilização pode exigir `serie`/`ano`). AJUSTAR os payloads acima aos nomes reais antes de finalizar.

- [ ] **Step 4: Deploy + verificação manual (homologação)**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
No painel: emitir uma NF-e de homologação por um orçamento faturável; abrir DANFE; testar cancelar/CC-e. Reportar o resultado observado.

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(painel): aba NF-e — modais emitir/DANFE/CC-e/cancelar/inutilizar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## FASE 2 — Aba Cobranças

### Task 3: Aba Cobranças — KPIs (com Recebimentos a vencer) + lista

**Files:**
- Modify: `public/dashboard.html` (bloco `#page-cobrancas`, loader, funções)

- [ ] **Step 1: Substituir o conteúdo de `#page-cobrancas`**

```html
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
  <div style="display:flex;align-items:center;gap:10px"><span style="font-size:20px">💳</span><h2 style="margin:0">Cobranças</h2></div>
  <div style="display:flex;gap:8px">
    <input id="cob-busca" placeholder="Buscar cliente / nº" oninput="renderCobLista()" style="width:180px">
    <select id="cob-filtro" onchange="renderCobLista()" style="width:150px">
      <option value="">Todos</option><option value="aguardando_pagamento">Aguardando</option><option value="pago">Pago</option><option value="vencidas">Vencidas</option>
    </select>
  </div>
</div>
<div id="cob-kpis" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px"></div>
<div id="cob-lista"><div style="text-align:center;padding:40px;color:#999">Carregando...</div></div>
```

- [ ] **Step 2: Registrar o loader**

```js
    cobrancas: () => loadCobrancasMain(),
```

- [ ] **Step 3: Carga + KPIs + filtro de horizonte**

```js
let _cobOrcs = [];
async function loadCobrancasMain() {
  const r = await api('/api/v2/orcamentos?limit=500');
  const all = r?.data || r?.orcamentos || r?.items || (Array.isArray(r) ? r : []);
  _cobOrcs = all.filter(o => o.status === 'aprovado' || o.status_pagamento || (o.boletos_parcelas||[]).length);
  renderCobKpis(); renderCobLista();
}
function _parcelasAbertas(o) {
  // parcelas em aberto = orçamento não pago; usa boletos_parcelas se houver
  if (o.status_pagamento === 'pago') return [];
  return (o.boletos_parcelas || []);
}
function _diasAteHoje(venc) { const d = new Date(venc + 'T12:00:00'); const h = new Date(); h.setHours(0,0,0,0); return Math.floor((d - h) / 86400000); }
function renderCobKpis() {
  let aReceber = 0, vencidas = 0;
  _cobOrcs.forEach(o => {
    if (o.status_pagamento === 'pago') return;
    const ps = _parcelasAbertas(o);
    if (ps.length) ps.forEach(p => { aReceber += Number(p.valor||0); if (_diasAteHoje(p.vencimento) < 0) vencidas += Number(p.valor||0); });
    else if (o.status_pagamento === 'aguardando_pagamento') aReceber += Number(o.total||0);
  });
  const recebidoMes = _cobOrcs.filter(o => o.status_pagamento === 'pago' && _mesCorrente(o.updated_at||o.created_at)).reduce((s,o)=>s+Number(o.total||0),0);
  const horizonte = parseInt(document.getElementById('cob-horizonte')?.value || '5');
  const aVencer = _vencerNoHorizonte(horizonte);
  document.getElementById('cob-kpis').innerHTML =
    _kpiCard('A receber', 'R$ ' + aReceber.toLocaleString('pt-BR',{minimumFractionDigits:2})) +
    _kpiCard('Recebido no mês', 'R$ ' + recebidoMes.toLocaleString('pt-BR',{minimumFractionDigits:2}), '#2e7d32') +
    _kpiCard('Vencidas', 'R$ ' + vencidas.toLocaleString('pt-BR',{minimumFractionDigits:2}), '#c62828') +
    `<div style="background:var(--bg-secondary,#f5f5f7);border-radius:8px;padding:14px 16px">
       <div style="display:flex;justify-content:space-between;align-items:center">
         <span style="font-size:13px;color:#777">Recebimentos a vencer</span>
         <select id="cob-horizonte" onchange="renderCobKpis()" style="font-size:12px;padding:2px 4px">
           <option value="1">1d</option><option value="2">2d</option><option value="5" selected>5d</option><option value="10">10d</option><option value="30">30d</option>
         </select>
       </div>
       <div style="font-size:24px;font-weight:600" id="cob-avencer">R$ ${aVencer.toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>
     </div>`;
  // preserva o horizonte selecionado após re-render
  const sel = document.getElementById('cob-horizonte'); if (sel) sel.value = String(horizonte);
}
function _vencerNoHorizonte(n) {
  let total = 0;
  _cobOrcs.forEach(o => {
    if (o.status_pagamento === 'pago') return;
    (o.boletos_parcelas || []).forEach(p => { const d = _diasAteHoje(p.vencimento); if (d >= 0 && d <= n) total += Number(p.valor||0); });
  });
  return total;
}
```

- [ ] **Step 4: Lista de cartões**

```js
function _pillPag(o) {
  if (o.status_pagamento === 'pago') return '<span style="font-size:11px;background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:20px">Pago</span>';
  const venc = (o.boletos_parcelas||[]).some(p => _diasAteHoje(p.vencimento) < 0);
  if (o.status_pagamento === 'aguardando_pagamento') return venc
    ? '<span style="font-size:11px;background:#fce4ec;color:#c62828;padding:2px 8px;border-radius:20px">Vencida</span>'
    : '<span style="font-size:11px;background:#fff3e0;color:#e65100;padding:2px 8px;border-radius:20px">Aguardando</span>';
  return '<span style="font-size:11px;background:#f1f1f1;color:#777;padding:2px 8px;border-radius:20px">Sem cobrança</span>';
}
function _iconeCob(o) {
  const t = o.tipo_cobranca;
  if (t === 'boleto') return '🏷'; if (t === 'pix') return '⚡'; if (t === 'link_mp') return '💳'; return '💰';
}
function renderCobLista() {
  const q = (document.getElementById('cob-busca')?.value || '').toLowerCase();
  const f = document.getElementById('cob-filtro')?.value || '';
  let list = _cobOrcs.filter(o => !q || `${o.numero} ${o.cliente_nome||''}`.toLowerCase().includes(q));
  if (f === 'pago') list = list.filter(o => o.status_pagamento === 'pago');
  else if (f === 'aguardando_pagamento') list = list.filter(o => o.status_pagamento === 'aguardando_pagamento');
  else if (f === 'vencidas') list = list.filter(o => (o.boletos_parcelas||[]).some(p => _diasAteHoje(p.vencimento) < 0) && o.status_pagamento !== 'pago');
  const box = document.getElementById('cob-lista');
  if (!list.length) { box.innerHTML = '<p style="color:#999;padding:20px">Nenhuma cobrança</p>'; return; }
  box.innerHTML = list.map(o => {
    const linha = (o.boletos_parcelas||[])[0]?.linha_digitavel;
    let acoes;
    if (o.status_pagamento === 'pago') acoes = '';
    else if (o.status_pagamento === 'aguardando_pagamento') {
      const copiar = linha ? `<button class="btn btn-outline" onclick="copiarLinha('${linha}')" style="padding:6px 8px">Copiar</button>` : '';
      const cancela = o.tipo_cobranca === 'pix' ? 'pix/cancelar' : o.tipo_cobranca === 'link_mp' ? 'link_mp/cancelar' : 'boleto/cancelar';
      acoes = `${copiar}<button class="btn btn-outline" onclick="cancelarCob('${o.id}','${cancela}')" style="padding:6px 10px;color:#c62828">Cancelar</button>`;
    } else {
      acoes = `<button class="btn btn-outline" onclick="abrirGerarCob('${o.id}','boleto')" style="padding:6px 10px">Boleto</button>
               <button class="btn btn-outline" onclick="abrirGerarCob('${o.id}','pix')" style="padding:6px 10px">PIX</button>
               <button class="btn btn-outline" onclick="abrirGerarCob('${o.id}','link_mp')" style="padding:6px 10px">Link MP</button>`;
    }
    const det = o.tipo_cobranca ? `${o.tipo_cobranca}${(o.boletos_parcelas||[]).length>1?' · '+o.boletos_parcelas.length+'x':''}` : 'Sem cobrança gerada';
    return `<div style="background:#fff;border:0.5px solid #e8eaf6;border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:14px;margin-bottom:8px">
      <div style="width:40px;height:40px;border-radius:50%;background:#eef;display:flex;align-items:center;justify-content:center">${_iconeCob(o)}</div>
      <div style="flex:1;min-width:0"><div style="font-weight:600">#${o.numero||'—'} · ${escHtml(o.cliente_nome||'—')}</div>
        <div style="font-size:12px;color:#777">${det} ${_pillPag(o)}</div></div>
      <div style="font-weight:600;white-space:nowrap">R$ ${Number(o.total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>
      <div style="display:flex;gap:6px">${acoes}</div>
    </div>`;
  }).join('');
}
function copiarLinha(linha) { navigator.clipboard?.writeText(linha); showToast('Linha digitável copiada'); }
async function cancelarCob(orcId, path) {
  if (!confirm('Cancelar esta cobrança?')) return;
  const res = await api(`/api/v2/orcamentos/${orcId}/${path}`, { method:'POST' });
  if (res?.errors || res?.error) { showToast('Erro: ' + (res.errors?.[0]||res.error)); return; }
  showToast('Cobrança cancelada'); loadCobrancasMain();
}
```

- [ ] **Step 5: Deploy + verificação**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
No painel: aba Cobranças → KPIs corretos; trocar o horizonte (1/2/5/10/30) recalcula "Recebimentos a vencer"; filtros e busca funcionam. Reportar.

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(painel): aba Cobranças — KPIs (com recebimentos a vencer) + lista

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Aba Cobranças — modal de geração de cobrança

**Files:**
- Modify: `public/dashboard.html`
- Reference: `public/pwa/admin.html` (`gerarCobranca`, ~linha 424)

- [ ] **Step 1: Implementar `abrirGerarCob` com formulário (substitui os prompt do admin)**

```js
function abrirGerarCob(orcId, tipo) {
  const label = tipo === 'boleto' ? 'Boleto' : tipo === 'pix' ? 'PIX' : 'Link MP';
  const hoje = new Date(); hoje.setDate(hoje.getDate()+7); const venc = hoje.toISOString().split('T')[0];
  let campos;
  if (tipo === 'boleto') {
    campos = `
      <label>Nº de parcelas (1–24)<input id="gc-parc" type="number" min="1" max="24" value="1" style="width:100%"></label>
      <label style="display:block;margin-top:8px">Vencimento da 1ª parcela<input id="gc-venc" type="date" value="${venc}" style="width:100%"></label>
      <label style="display:block;margin-top:8px">Intervalo entre parcelas (dias)<input id="gc-int" type="number" min="1" value="30" style="width:100%"></label>`;
  } else if (tipo === 'link_mp') {
    campos = `<label>Máx. de parcelas no cartão<select id="gc-parc" style="width:100%">
      <option value="1">1x</option><option value="2">2x</option><option value="3">3x</option><option value="6">6x</option><option value="12" selected>12x</option></select></label>`;
  } else {
    campos = `<p>Gerar PIX para este orçamento e enviar ao cliente via WhatsApp?</p>`;
  }
  showModal(`Gerar ${label}`, `${campos}<button class="btn btn-primary" style="margin-top:12px" onclick="submitGerarCob('${orcId}','${tipo}')">Gerar ${label}</button>`, '460px');
}
async function submitGerarCob(orcId, tipo) {
  let payload = { tipo };
  if (tipo === 'boleto') {
    const parcelas = parseInt(document.getElementById('gc-parc').value);
    const dataVencimento = document.getElementById('gc-venc').value;
    const intervaloDias = parseInt(document.getElementById('gc-int').value) || 30;
    if (!parcelas || parcelas < 1 || parcelas > 24) { showToast('Parcelas inválidas (1–24)'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataVencimento)) { showToast('Vencimento inválido'); return; }
    payload = { tipo, parcelas, dataVencimento, intervaloDias };
  } else if (tipo === 'link_mp') {
    payload = { tipo, parcelas: parseInt(document.getElementById('gc-parc').value) || 12 };
  }
  const res = await api(`/api/v2/orcamentos/${orcId}/cobrar`, { method:'POST', body: JSON.stringify(payload) });
  if (res?.errors || res?.error) { showToast('Erro: ' + (res.errors?.[0]||res.error)); return; }
  closeModal();
  showToast(`✅ ${tipo === 'link_mp' ? 'Link MP gerado — copie e envie' : tipo.toUpperCase()+' gerado e enviado ao cliente'}`);
  loadCobrancasMain();
}
```

- [ ] **Step 2: Deploy + verificação (sandbox)**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
No painel: gerar um boleto sandbox por um orçamento aprovado (modal com parcelas/vencimento), confirmar que aparece como Aguardando + copiar linha + cancelar. Reportar.

- [ ] **Step 3: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(painel): aba Cobranças — modal de geração (boleto/PIX/Link MP) com formulário

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Atualizar memória do projeto

**Files:**
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Registrar**

Adicionar: "Painel unificado — NF-e e Cobranças: CONCLUÍDO — 2026-06-24. Abas nativas no dashboard.html (KPIs + cartões + modais com formulário), reusando /api/v2/nfe/* e /api/v2/orcamentos/:id/cobrar (sem backend novo). Cobranças tem KPI 'Recebimentos a vencer' com horizonte 1/2/5/10/30 dias (cálculo no front sobre boletos_parcelas.vencimento). Próximo: Análises Gerenciais (DRE/Fluxo/Metas/IA) — spec própria."

- [ ] **Step 2: Sem commit** (memória fora do git).

---

## Notas de verificação final

- As duas abas dependem da chave correta do retorno de `GET /api/v2/orcamentos` (provavelmente `r.data`) — confirmar no Step 1 da Task 1 e ajustar em ambas.
- Conferir que os nomes de campo dos payloads de `/inutilizar` e `/corrigir` batem com o backend (ler admin.html) antes de finalizar a Task 2.
- KPIs e "Recebimentos a vencer" são cálculo no front; arredondar valores exibidos com `toLocaleString('pt-BR',{minimumFractionDigits:2})`.
