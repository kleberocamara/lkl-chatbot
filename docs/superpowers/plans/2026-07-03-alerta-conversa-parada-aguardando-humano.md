# Alerta de conversa parada em aguardando_humano (2h) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evidenciar (painel) e alertar (push FCM) quando uma conversa em `aguardando_humano` fica 2h+ parada sem resposta da equipe.

**Architecture:** Função pura de elegibilidade + job no agendador de 60s (`followup.js`) que dispara push via novo `fcm.sendToRoles`. Flag `conversations.alerta_humano_em` (migration 050) garante um push por parada, resetado quando um humano responde/resolve. Front do `dashboard.html` mostra pastilha de tempo, ordena paradas no topo, conta no filtro e deixa o badge do menu vermelho.

**Tech Stack:** Node.js + Express + PostgreSQL (pg), firebase-admin (FCM), socket.io, Jest, vanilla-JS `dashboard.html`.

**Design de referência:** `docs/superpowers/specs/2026-07-03-alerta-conversa-parada-aguardando-humano-design.md`

**Convenções:** sem Postgres local (funções puras testadas com Jest; integração via smoke no VPS). Migrations numeradas em `sql/migrations/`, aplicadas manualmente no VPS (DB **lkl_chatbot**). Deploy: rsync + `pm2 restart lkl-chatbot --update-env` no VPS `2.25.147.243` (`/var/www/lkl-chatbot`). `npm test` = jest --runInBand. Próxima migration livre: **050**.

---

## File Structure

- **Create:** `sql/migrations/050_conversations_alerta_humano.sql` — coluna `alerta_humano_em`.
- **Modify:** `src/services/followup.js` — `deveAlertarHumano` (pura) + `processAlertasHumano` (job) + chamada no `startScheduler` + exports.
- **Create:** `tests/alerta-humano.test.js` — testes de `deveAlertarHumano`.
- **Modify:** `src/services/fcm.js` — helper `sendToRoles`.
- **Modify:** `src/dashboard/api.js` — reset do flag (reply/resolve/orcamento-enviado/orcamento-aprovado) + `stalledHuman` no stats.
- **Modify:** `public/dashboard.html` — pastilha + ordenação + contador no filtro + badge vermelho + beep/toast no socket.

---

## Task 1: Migration 050 + função pura `deveAlertarHumano`

**Files:**
- Create: `sql/migrations/050_conversations_alerta_humano.sql`
- Modify: `src/services/followup.js`
- Test: `tests/alerta-humano.test.js`

- [ ] **Step 1: Escrever a migration**

Create `sql/migrations/050_conversations_alerta_humano.sql`:
```sql
-- Alerta de conversa parada em aguardando_humano: flag para disparar o push uma vez por parada.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS alerta_humano_em TIMESTAMPTZ;
```

- [ ] **Step 2: Escrever o teste (falha)**

Create `tests/alerta-humano.test.js`:
```js
const { deveAlertarHumano } = require('../src/services/followup');

const agora = new Date('2026-07-03T15:00:00Z');
const h3 = new Date('2026-07-03T11:30:00Z'); // 3.5h antes
const h1 = new Date('2026-07-03T14:00:00Z'); // 1h antes

const base = { status: 'aguardando_humano', alerta_humano_em: null, ultima_msg_at: h3 };

describe('deveAlertarHumano', () => {
  test('elegível: aguardando_humano, sem flag, >2h', () => {
    expect(deveAlertarHumano(base, agora)).toBe(true);
  });
  test('não elegível: outro status', () => {
    expect(deveAlertarHumano({ ...base, status: 'active' }, agora)).toBe(false);
  });
  test('não elegível: já alertado', () => {
    expect(deveAlertarHumano({ ...base, alerta_humano_em: h3 }, agora)).toBe(false);
  });
  test('não elegível: última mensagem há menos de 2h', () => {
    expect(deveAlertarHumano({ ...base, ultima_msg_at: h1 }, agora)).toBe(false);
  });
  test('não elegível: sem última mensagem', () => {
    expect(deveAlertarHumano({ ...base, ultima_msg_at: null }, agora)).toBe(false);
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npx jest tests/alerta-humano.test.js`
Expected: FAIL — `deveAlertarHumano is not a function`.

- [ ] **Step 4: Implementar `deveAlertarHumano`**

In `src/services/followup.js`, add this immediately after the `deveReengajar` function (before the `// Inicia o scheduler` comment / `processReengajamentos` block — anywhere among the other pure/job functions is fine, but keep it before `startScheduler`):
```js
const ALERTA_HUMANO_APOS_MS = 2 * 3600 * 1000;

// Função pura: a conversa deve gerar alerta à equipe? (parada 2h+ em aguardando_humano, sem alerta ainda).
function deveAlertarHumano(conv, agora) {
  if (!conv || conv.status !== 'aguardando_humano') return false;
  if (conv.alerta_humano_em != null) return false;
  if (!conv.ultima_msg_at) return false;
  return (agora.getTime() - new Date(conv.ultima_msg_at).getTime()) > ALERTA_HUMANO_APOS_MS;
}
```

- [ ] **Step 5: Exportar `deveAlertarHumano`**

In `src/services/followup.js`, update the final `module.exports` to include `deveAlertarHumano`. It currently is:
```js
module.exports = { scheduleFollowUps, cancelPendingFollowUps, processFollowUps, startScheduler, calcScheduledAt, deveReengajar, processReengajamentos };
```
Change to:
```js
module.exports = { scheduleFollowUps, cancelPendingFollowUps, processFollowUps, startScheduler, calcScheduledAt, deveReengajar, processReengajamentos, deveAlertarHumano };
```

- [ ] **Step 6: Rodar o teste e confirmar que passa**

Run: `npx jest tests/alerta-humano.test.js`
Expected: PASS (5 testes).

- [ ] **Step 7: Commit**

```bash
git add sql/migrations/050_conversations_alerta_humano.sql src/services/followup.js tests/alerta-humano.test.js
git commit -m "feat(chat): migration 050 alerta_humano_em + deveAlertarHumano (pura) + testes"
```

---

## Task 2: `fcm.sendToRoles` + job `processAlertasHumano`

**Files:**
- Modify: `src/services/fcm.js` (helper + export)
- Modify: `src/services/followup.js` (job + wire no scheduler + export)

- [ ] **Step 1: Adicionar `sendToRoles` no `fcm.js`**

In `src/services/fcm.js`, add this function right before the `module.exports` line:
```js
// Envia o mesmo push a todos os usuários cujos papéis estão na lista (reusa sendToUser).
async function sendToRoles(roles, payload) {
  if (!initialized) return;
  const { rows } = await db.query(
    `SELECT DISTINCT dt.user_id FROM device_tokens dt
     JOIN users u ON u.id = dt.user_id
     WHERE u.role = ANY($1)`,
    [roles]
  );
  for (const r of rows) {
    try { await sendToUser(r.user_id, payload); }
    catch (e) { console.warn('[FCM sendToRoles]', e.message); }
  }
}
```
And change the export line from:
```js
module.exports = { init, sendToUser };
```
to:
```js
module.exports = { init, sendToUser, sendToRoles };
```

- [ ] **Step 2: Requerer o fcm no `followup.js`**

In `src/services/followup.js`, near the top requires (after the existing `const { log } = require('./logger');` and the OpenAI requires added earlier), add:
```js
const fcm = require('./fcm');
```

- [ ] **Step 3: Implementar `processAlertasHumano`**

In `src/services/followup.js`, add this function right after `deveAlertarHumano` (from Task 1):
```js
// Detecta conversas paradas 2h+ em aguardando_humano e dispara UM push à equipe (horário comercial).
async function processAlertasHumano() {
  const agora = new Date();
  if (isWeekendSP(agora)) return;
  const horaSP = getHourSP(agora);
  if (horaSP < 9 || horaSP >= 18) return;

  const cand = await db.query(`
    SELECT c.id, c.status, c.alerta_humano_em, ct.name, ct.phone,
           (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) AS ultima_msg_at
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.status = 'aguardando_humano'
      AND c.alerta_humano_em IS NULL
  `);

  for (const conv of cand.rows) {
    if (!deveAlertarHumano(conv, agora)) continue;
    try {
      const horas = Math.floor((agora.getTime() - new Date(conv.ultima_msg_at).getTime()) / 3600000);
      const nome = conv.name || conv.phone;
      await fcm.sendToRoles(['admin', 'gestor', 'analista', 'atendente'], {
        title: '⏱ Cliente aguardando',
        body: `Cliente ${nome} aguarda retorno há ${horas}h`,
        data: { conversationId: conv.id, tipo: 'alerta_humano' },
      });
      await db.query('UPDATE conversations SET alerta_humano_em = NOW() WHERE id = $1', [conv.id]);
      await log('alerta_humano', `Alerta de parada (${horas}h) enviado — ${conv.phone}`, { conversationId: conv.id });
      if (global.io) global.io.emit('alerta_humano', { conversationId: conv.id, nome, horas });
    } catch (err) {
      console.error(`[ALERTA-HUMANO] Erro na conversa ${conv.id}:`, err.message);
      // Não grava o flag: tenta na próxima rodada.
    }
  }
}
```

- [ ] **Step 4: Chamar no scheduler**

In `src/services/followup.js`, inside `startScheduler`, the `setInterval` currently calls `processFollowUps` and `processReengajamentos`. Replace that `setInterval` block with:
```js
  setInterval(() => {
    processFollowUps().catch(err => console.error('[follow-up] Erro no scheduler:', err.message));
    processReengajamentos().catch(err => console.error('[reengajamento] Erro no scheduler:', err.message));
    processAlertasHumano().catch(err => console.error('[alerta-humano] Erro no scheduler:', err.message));
  }, 60 * 1000);
```

- [ ] **Step 5: Exportar `processAlertasHumano`**

In `src/services/followup.js`, add `processAlertasHumano` to the `module.exports` (which after Task 1 ends with `..., deveAlertarHumano }`):
```js
module.exports = { scheduleFollowUps, cancelPendingFollowUps, processFollowUps, startScheduler, calcScheduledAt, deveReengajar, processReengajamentos, deveAlertarHumano, processAlertasHumano };
```

- [ ] **Step 6: Verificar carga dos módulos e testes**

Run: `OPENAI_API_KEY=x node -e "require('./src/services/fcm'); require('./src/services/followup'); console.log('ok')"`
Expected: `ok`.

Run: `npx jest tests/alerta-humano.test.js tests/reengajamento.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/fcm.js src/services/followup.js
git commit -m "feat(chat): fcm.sendToRoles + job processAlertasHumano (push 2h à equipe)"
```

---

## Task 3: Reset do flag + contador `stalledHuman` (api.js)

**Files:**
- Modify: `src/dashboard/api.js` (rota `/dashboard/stats` linhas 40-56; rotas `reply` 103-125, `orcamento-enviado` 128-154, `orcamento-aprovado` 157-172, `resolve` 175-183)

- [ ] **Step 1: Adicionar `stalledHuman` ao stats**

In `src/dashboard/api.js`, in the `/dashboard/stats` route, replace the `Promise.all([...])` block and the `res.json({...})` (lines 41-55) with a version that also computes `stalledHuman`:
```js
  const [contacts, conversations, todayMessages, waitingHuman, stalledHuman, logs] = await Promise.all([
    db.query('SELECT COUNT(*) FROM contacts'),
    db.query('SELECT COUNT(*) FROM conversations'),
    db.query(`SELECT COUNT(*) FROM messages WHERE created_at >= CURRENT_DATE`),
    db.query(`SELECT COUNT(*) FROM conversations WHERE status = 'aguardando_humano'`),
    db.query(`SELECT COUNT(*) FROM conversations c
              WHERE c.status = 'aguardando_humano'
                AND (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) < NOW() - INTERVAL '2 hours'`),
    db.query(`SELECT event_type, description, created_at, metadata FROM activity_logs ORDER BY created_at DESC LIMIT 50`),
  ]);

  res.json({
    totalContacts: parseInt(contacts.rows[0].count),
    totalConversations: parseInt(conversations.rows[0].count),
    todayMessages: parseInt(todayMessages.rows[0].count),
    waitingHuman: parseInt(waitingHuman.rows[0].count),
    stalledHuman: parseInt(stalledHuman.rows[0].count),
    recentLogs: logs.rows,
  });
```

- [ ] **Step 2: Reset do flag na resposta humana (`reply`)**

In `src/dashboard/api.js`, in the `POST /conversations/:id/reply` route, right after the `INSERT INTO messages (... 'human' ...)` query (the `await db.query(... sent_by, sent_by_name ...)` at lines 114-117), add:
```js
  await db.query('UPDATE conversations SET alerta_humano_em = NULL WHERE id = $1 AND alerta_humano_em IS NOT NULL', [convId]);
```

- [ ] **Step 3: Reset ao sair de aguardando_humano (`orcamento-enviado` e `resolve`)**

In `src/dashboard/api.js`, in `POST /conversations/:id/orcamento-enviado`, the UPDATE sets `status = 'orcamento_enviado'`. Add `alerta_humano_em = NULL` to it. Replace:
```js
    `UPDATE conversations SET status = 'orcamento_enviado', pedido_status = 'orcamento_enviado',
     orcamento_enviado_at = $1, updated_at = NOW() WHERE id = $2`,
```
with:
```js
    `UPDATE conversations SET status = 'orcamento_enviado', pedido_status = 'orcamento_enviado',
     orcamento_enviado_at = $1, alerta_humano_em = NULL, updated_at = NOW() WHERE id = $2`,
```

In `POST /conversations/:id/resolve`, replace:
```js
    `UPDATE conversations SET status = 'resolved', resolved_at = NOW(), updated_at = NOW() WHERE id = $1`,
```
with:
```js
    `UPDATE conversations SET status = 'resolved', resolved_at = NOW(), alerta_humano_em = NULL, updated_at = NOW() WHERE id = $1`,
```

- [ ] **Step 4: Reset ao (re)entrar em aguardando_humano por aprovação (`orcamento-aprovado`)**

In `src/dashboard/api.js`, in `POST /conversations/:id/orcamento-aprovado`, replace:
```js
    `UPDATE conversations SET pedido_status = 'orcamento_aprovado', status = 'aguardando_humano', updated_at = NOW() WHERE id = $1`,
```
with:
```js
    `UPDATE conversations SET pedido_status = 'orcamento_aprovado', status = 'aguardando_humano', alerta_humano_em = NULL, updated_at = NOW() WHERE id = $1`,
```
(Zera o flag para que uma nova parada de 2h nesse estado gere alerta.)

- [ ] **Step 5: Verificar carga do módulo**

Run: `OPENAI_API_KEY=x node -e "require('./src/dashboard/api'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/api.js
git commit -m "feat(chat): stalledHuman no stats + reset de alerta_humano_em (reply/resolve/orçamento)"
```

---

## Task 4: Front do painel — pastilha + ordenação + contador + badge + beep

**Files:**
- Modify: `public/dashboard.html` (CSS perto de `.badge-waiting` linha 54; `renderConversations` 3099-3114; filtro tab botão ~302; `updateDashboard` 3063-3065; handlers de socket ~918-928)

- [ ] **Step 1: CSS da pastilha de parada**

In `public/dashboard.html`, find (line 149 area) the `.msg-day-sep` line added earlier (or the `.msg-time` line) and add a new rule after it:
```
  .conv-stalled { background: #d32f2f; color: #fff; font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 9px; margin-left: 6px; white-space: nowrap; }
```

- [ ] **Step 2: Helper de horas paradas + pastilha + ordenação em `renderConversations`**

In `public/dashboard.html`, replace the entire `renderConversations` function (lines 3099-3114) with:
```js
function _horasParada(c) {
  if (c.status !== 'aguardando_humano') return 0;
  const ts = c.last_message_at || c.started_at;
  if (!ts) return 0;
  return (Date.now() - new Date(ts).getTime()) / 3600000;
}

function renderConversations(list) {
  const ul = document.getElementById('convList');
  const arr = [...list];
  // paradas (>2h) primeiro, da mais antiga para a mais recente
  arr.sort((a, b) => {
    const pa = _horasParada(a) >= 2, pb = _horasParada(b) >= 2;
    if (pa && pb) return _horasParada(b) - _horasParada(a);
    if (pa) return -1;
    if (pb) return 1;
    return 0;
  });
  ul.innerHTML = arr.map(c => {
    const h = _horasParada(c);
    const pastilha = h >= 2 ? `<span class="conv-stalled">⏱ parada há ${Math.floor(h)}h</span>` : '';
    return `
    <li class="conv-item ${c.id === currentConvId ? 'selected' : ''}" onclick="openConversation('${c.id}', this)">
      <div class="conv-avatar">${(c.name || c.profile_name || c.phone)[0].toUpperCase()}</div>
      <div class="conv-info">
        <div class="conv-name">${c.name || c.profile_name || c.phone}${pastilha}</div>
        <div class="conv-preview">${c.last_message || 'Sem mensagens'}</div>
      </div>
      <div class="conv-meta">
        <div class="conv-time">${timeAgo(c.last_message_at || c.started_at)}</div>
        <span class="status-badge status-${c.status}">${convStatusLabel(c.status)}</span>
      </div>
    </li>`;
  }).join('') || '<li style="padding:20px;text-align:center;color:var(--muted);font-size:13px">Nenhuma conversa encontrada</li>';

  // contador no filtro "Aguardando"
  const nParadas = arr.filter(c => _horasParada(c) >= 2).length;
  const tabAg = document.querySelector('.filter-tab[onclick*="aguardando_humano"]');
  if (tabAg) {
    tabAg.textContent = nParadas > 0 ? `Aguardando (${nParadas})` : 'Aguardando';
    tabAg.style.color = nParadas > 0 ? '#d32f2f' : '';
    tabAg.style.fontWeight = nParadas > 0 ? '700' : '';
  }
}
```

- [ ] **Step 3: Badge do menu vermelho por `stalledHuman`**

In `public/dashboard.html`, in `updateDashboard`, replace the waitingBadge block (lines 3063-3065):
```js
  const badge = document.getElementById('waitingBadge');
  if (data.waitingHuman > 0) { badge.style.display = ''; badge.textContent = data.waitingHuman; }
  else badge.style.display = 'none';
```
with:
```js
  const badge = document.getElementById('waitingBadge');
  const paradas = data.stalledHuman || 0;
  if (paradas > 0) { badge.style.display = ''; badge.textContent = paradas; badge.style.background = '#d32f2f'; }
  else if (data.waitingHuman > 0) { badge.style.display = ''; badge.textContent = data.waitingHuman; badge.style.background = ''; }
  else badge.style.display = 'none';
```

- [ ] **Step 4: Beep/toast no socket `alerta_humano`**

In `public/dashboard.html`, find the socket handlers block (around lines 918-928, where `socket.on('conversation_updated', ...)` is registered). Add a new handler right after the `conversation_updated` handler:
```js
  socket.on('alerta_humano', (data) => {
    if (document.getElementById('page-conversations').classList.contains('active')) loadConversations();
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.1;
      o.start(); o.stop(ctx.currentTime + 0.2);
    } catch (e) {}
    if (typeof showToast === 'function') showToast(`⏱ ${data.nome || 'Cliente'} aguarda retorno há ${data.horas}h`);
  });
```

- [ ] **Step 5: Verificar as edições**

Run: `grep -n "conv-stalled\|_horasParada\|stalledHuman\|socket.on('alerta_humano'" public/dashboard.html`
Expected: CSS `.conv-stalled`, `_horasParada`, uso de `stalledHuman` no badge, e o handler `alerta_humano`.

Run: `grep -c "function renderConversations" public/dashboard.html`
Expected: `1` (sem duplicação).

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(chat): painel evidencia conversa parada (pastilha, ordenação, contador, badge, beep)"
```

---

## Task 5: Deploy VPS + smoke + memória

**Files:** nenhum código novo — deploy e verificação.

- [ ] **Step 1: Aplicar a migration 050 no VPS**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -f -" < sql/migrations/050_conversations_alerta_humano.sql
```
Expected: `ALTER TABLE`. Conferir:
```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c '\d conversations'" | grep alerta_humano_em
```
Expected: coluna `alerta_humano_em | timestamp with time zone`.

- [ ] **Step 2: Rsync do código**

```bash
rsync -avz src/services/fcm.js root@2.25.147.243:/var/www/lkl-chatbot/src/services/fcm.js
rsync -avz src/services/followup.js root@2.25.147.243:/var/www/lkl-chatbot/src/services/followup.js
rsync -avz src/dashboard/api.js root@2.25.147.243:/var/www/lkl-chatbot/src/dashboard/api.js
rsync -avz public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
Expected: transferências sem erro.

- [ ] **Step 3: Restart do app**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1; sleep 2; pm2 list | grep lkl-chatbot"
```
Expected: `online`. Conferir que não crashou no boot:
```bash
ssh root@2.25.147.243 "pm2 logs lkl-chatbot --lines 5 --nostream 2>/dev/null | grep -iE 'error|throw' || echo '(sem erros)'"
```

- [ ] **Step 4: Smoke da elegibilidade + sendToRoles (SQL sintético)**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot" <<'SQL'
BEGIN;
INSERT INTO contacts (phone, name) VALUES ('SMOKE-ALERTA-000','ZZTeste Alerta') RETURNING id \gset
INSERT INTO conversations (contact_id, status) VALUES (:'id','aguardando_humano') RETURNING id AS conv \gset
INSERT INTO messages (conversation_id, contact_id, content, direction, sent_by, created_at)
  VALUES (:'conv', :'id', 'ola', 'inbound', 'ai', NOW() - INTERVAL '3 hours');
-- espelha o SELECT do job:
SELECT c.id, ct.name,
       (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) AS ultima_msg_at
FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
WHERE c.status='aguardando_humano' AND c.alerta_humano_em IS NULL AND c.id = :'conv';
-- conta stalledHuman (deve incluir a nossa):
SELECT COUNT(*) AS stalled FROM conversations c
WHERE c.status='aguardando_humano'
  AND (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id=c.id) < NOW() - INTERVAL '2 hours';
ROLLBACK;
SQL
```
Expected: a conversa aparece com `ultima_msg_at` ~3h atrás; `stalled` ≥ 1. `ROLLBACK` limpa.

- [ ] **Step 5: Conferir o helper `sendToRoles` (quantos user_ids seriam alvo)**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -t -c \"SELECT COUNT(DISTINCT dt.user_id) FROM device_tokens dt JOIN users u ON u.id=dt.user_id WHERE u.role = ANY(ARRAY['admin','gestor','analista','atendente']);\""
```
Expected: um número (≥ 0) — quantos atendentes com token receberiam o push. (Se 0, o push não envia; painel segue evidenciando.)

- [ ] **Step 6: Validação manual (opcional, pelo usuário)**

No painel: abrir a aba Conversas e conferir a pastilha `⏱ parada há Xh`, a ordenação das paradas no topo, `Aguardando (N)` e o badge vermelho no menu.

- [ ] **Step 7: Atualizar a memória do projeto**

Registrar em `project_sprint_status.md` (memória): alerta de conversa parada em `aguardando_humano` >2h — migration 050 `conversations.alerta_humano_em`; `followup.js` `deveAlertarHumano` (pura) + `processAlertasHumano` (job no scheduler, horário comercial 9-18h SP dia útil, push único via novo `fcm.sendToRoles(['admin','gestor','analista','atendente'])`, flag evita repetir); reset do flag em `dashboard/api.js` (reply/resolve/orcamento-enviado/orcamento-aprovado); stats ganhou `stalledHuman`; painel mostra pastilha/ordenação/contador/badge vermelho + beep/toast no socket `alerta_humano`. Próxima migration livre: 051.

- [ ] **Step 8: Encerrar a branch**

Usar `superpowers:finishing-a-development-branch`.

---

## Self-Review

**1. Spec coverage:**
- Gatilho status+2h última msg → Task 1 (`deveAlertarHumano`) + Task 2 (SELECT do job). ✓
- Migration 050 `alerta_humano_em` → Task 1. ✓
- Push único, horário comercial, à equipe via `sendToRoles` → Task 2. ✓
- Reset do flag (reply/resolve/orçamento-enviado/aprovado) → Task 3. ✓
- `stalledHuman` no stats → Task 3. ✓
- Painel: pastilha + ordenação + contador no filtro → Task 4 (Steps 1-2). ✓
- Badge do menu vermelho por `stalledHuman` → Task 4 (Step 3). ✓
- Beep/toast no socket `alerta_humano` → Task 4 (Step 4). ✓
- Deploy + smoke + memória → Task 5. ✓

**2. Placeholder scan:** sem TBD/TODO; todo passo de código traz o código completo. ✓

**3. Type consistency:** `deveAlertarHumano(conv, agora)` e chaves `status`/`alerta_humano_em`/`ultima_msg_at` idênticas entre Task 1 (função/teste) e Task 2 (SELECT). `sendToRoles(roles, payload)` definido na Task 2 Step 1 e chamado na Task 2 Step 3. `stalledHuman` definido na Task 3 Step 1 e consumido na Task 4 Step 3. Evento socket `alerta_humano` emitido na Task 2 Step 3 e ouvido na Task 4 Step 4. `alerta_humano_em` consistente em migration/job/resets. ✓
