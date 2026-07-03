# Chatbot — Treino de produtos/materiais + melhorias no chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o chatbot mais assertivo (sugere materiais, padroniza dimensões em metros) e melhorar o chat do painel (datas nas mensagens + auto-liberação de conversas paradas para o bot reengajar o cliente).

**Architecture:** Parte A é só texto no `SYSTEM_PROMPT` de `src/ai/agent.js`. Parte B toca `public/dashboard.html` (datas), uma migration (`049`), `src/services/followup.js` (job de reengajamento + função pura de elegibilidade) e `src/webhook/handler.js` (reset do flag no inbound).

**Tech Stack:** Node.js + Express + PostgreSQL (pg), OpenAI, Jest, vanilla-JS `dashboard.html`, WhatsApp (`sendMessage`).

**Design de referência:** `docs/superpowers/specs/2026-07-03-chatbot-treino-produtos-e-melhorias-chat-design.md`

**Convenções:** sem Postgres local (funções puras testadas com Jest; integração via smoke no VPS). Migrations numeradas em `sql/migrations/`, aplicadas manualmente no VPS (DB **lkl_chatbot**). Deploy: rsync + `pm2 restart lkl-chatbot --update-env` no VPS `2.25.147.243` (`/var/www/lkl-chatbot`). `npm test` = jest --runInBand; testes em `tests/`. Próxima migration livre: **049**. Não há `agent_prompt` customizado no banco (o `SYSTEM_PROMPT` do código roda em produção).

---

## File Structure

- **Modify:** `src/ai/agent.js` — acrescenta regras 14/15 ao `SYSTEM_PROMPT`; exporta `SYSTEM_PROMPT`.
- **Create:** `tests/agent-prompt.test.js` — sanidade do prompt (âncoras).
- **Modify:** `public/dashboard.html` — `loadMessages` (datas + separador de dia) + CSS `.msg-day-sep`.
- **Create:** `sql/migrations/049_conversations_reengajado.sql` — coluna `reengajado_em`.
- **Modify:** `src/services/followup.js` — `deveReengajar` (pura) + `processReengajamentos` + chamada no `startScheduler` + export.
- **Create:** `tests/reengajamento.test.js` — testes de `deveReengajar`.
- **Modify:** `src/webhook/handler.js` — reset de `reengajado_em` no inbound.

---

## Task 1: Parte A — Prompt de materiais + normalização em metros

**Files:**
- Modify: `src/ai/agent.js:79` (fim do `SYSTEM_PROMPT`) e `src/ai/agent.js:300` (export)
- Test: `tests/agent-prompt.test.js`

- [ ] **Step 1: Escrever o teste de sanidade (falha)**

Create `tests/agent-prompt.test.js`:

```js
const { SYSTEM_PROMPT } = require('../src/ai/agent');

describe('SYSTEM_PROMPT — regras de treino AO', () => {
  test('exporta o prompt', () => {
    expect(typeof SYSTEM_PROMPT).toBe('string');
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(500);
  });
  test('contém o guia de materiais', () => {
    expect(SYSTEM_PROMPT).toMatch(/GUIA DE MATERIAIS/);
    expect(SYSTEM_PROMPT).toMatch(/lona 440/i);
  });
  test('contém a regra de normalização em metros', () => {
    expect(SYSTEM_PROMPT).toMatch(/METRO/);
    expect(SYSTEM_PROMPT).toMatch(/0,30m/);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/agent-prompt.test.js`
Expected: FAIL — `SYSTEM_PROMPT` é `undefined` (não exportado).

- [ ] **Step 3: Exportar `SYSTEM_PROMPT`**

In `src/ai/agent.js`, change the last line from:
```js
module.exports = { processMessage };
```
to:
```js
module.exports = { processMessage, SYSTEM_PROMPT };
```

- [ ] **Step 4: Acrescentar as regras 14 e 15 ao prompt**

In `src/ai/agent.js`, the `SYSTEM_PROMPT` template literal ends at line 79 with `...deixe em branco.` immediately followed by the closing `` ` ``. Insert the following text **right before** that closing backtick (i.e., append after `deixe em branco.`):

```
14. GUIA DE MATERIAIS — sugira quando o cliente não souber (NÃO invente material fora do guia):
   Quando o cliente não souber ou tiver dúvida sobre material/acabamento ("não sei", "o que vocês recomendam?", "tanto faz"), NÃO pergunte de forma aberta — SUGIRA a opção padrão abaixo e confirme de leve. Ex.: "Pra banner a gente usa lona 440g. Prefere acabamento fosco ou brilho? 😊"
   | Serviço                    | Sugestão padrão   | Variações comuns                                  |
   |----------------------------|-------------------|---------------------------------------------------|
   | Banner                     | lona 440g         | fosco / brilho                                    |
   | Adesivo / Adesivação       | vinil fosco       | vinil brilho, vinil transparente, vinil perfurado |
   | Lona (fachada/faixa)       | lona 440g         | com ilhós / bastão                                |
   | Cartão de visita           | couché 300g       | verniz total, laminação fosca/brilho              |
   | Folder / Folheto / Flyer   | couché 150g       | couché 115g / 170g                                |
   | Cartaz                     | couché 150g       | —                                                 |
   | Placa / Sinalização        | ACM 3mm           | PS 2mm, PVC expandido                             |
   | Painel ACM                 | ACM 3mm           | —                                                 |
   | Wind Banner                | tecido (sublimação)| P / M / G                                        |
   Se o cliente pedir algo fora do guia, registre o que ele descreveu e deixe a equipe ajustar. NUNCA trave esperando o cliente saber termos técnicos.
15. UNIDADE PADRÃO = METRO (regra obrigatória para dimensões):
   - Toda dimensão é registrada em METROS com vírgula: "1,20m x 1,20m", "0,30m x 0,45m". NUNCA misture metro e centímetro na mesma medida.
   - Se o cliente informar cm ou mm, CONVERTA e CONFIRME antes de seguir. Ex.: "Só confirmando: 30cm × 45cm = 0,30m × 0,45m, certo? 😊" (30cm→0,30m; 1200mm→1,20m; 90x120cm→0,90m × 1,20m).
   - SEMPRE confirme as dimensões com o cliente antes do resumo.
   - Ao chamar registrar_pedido, o campo "dimensoes" (e o de cada objeto em "itens") DEVE vir sempre em metros no formato "L,LLm x A,AAm".
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `npx jest tests/agent-prompt.test.js`
Expected: PASS (3 testes).

- [ ] **Step 6: Rodar a suíte de revenda/produtos para garantir que agent.js ainda carrega**

Run: `node -e "require('./src/ai/agent'); console.log('ok')"`
Expected: imprime `ok` (o módulo carrega sem erro de sintaxe).

- [ ] **Step 7: Commit**

```bash
git add src/ai/agent.js tests/agent-prompt.test.js
git commit -m "feat(chatbot): guia de materiais + normalização de dimensões em metros no prompt"
```

---

## Task 2: Parte B.1 — Datas nas mensagens + separador de dia

**Files:**
- Modify: `public/dashboard.html` (CSS perto de `.msg-time` na linha 149; render em `loadMessages` linhas 3172-3209)

- [ ] **Step 1: Adicionar o CSS do separador de dia**

In `public/dashboard.html`, find the line (149):
```
  .msg-time { font-size: 10px; opacity: .6; margin-top: 4px; }
```
Replace with:
```
  .msg-time { font-size: 10px; opacity: .6; margin-top: 4px; }
  .msg-day-sep { align-self: center; margin: 12px 0 6px; font-size: 11px; color: var(--muted); background: rgba(0,0,0,.05); padding: 2px 12px; border-radius: 10px; }
```

- [ ] **Step 2: Trocar o render das mensagens para incluir data e separador**

In `public/dashboard.html`, in `loadMessages`, replace the block that renders the messages (the `${messages.map(m => ` … `).join('')}` at lines 3173-3209) with a version that (a) inserts a day separator when the day changes, and (b) shows the date on the time stamp for messages not from today. Replace the entire `${messages.map(m => ` ... `).join('')}` expression with:

```
      ${(() => {
        const hoje = new Date().toDateString();
        let ultimoDia = null;
        return messages.map(m => {
          const d = new Date(m.created_at);
          const diaStr = d.toDateString();
          let sep = '';
          if (diaStr !== ultimoDia) {
            ultimoDia = diaStr;
            sep = `<div class="msg-day-sep">${d.toLocaleDateString('pt-BR',{day:'numeric',month:'long'})}</div>`;
          }
          const carimbo = diaStr === hoje
            ? d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})
            : d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'}) + ' ' + d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
          const autor = m.sent_by === 'human' ? '· ' + (m.sent_by_name || 'Analista') : m.sent_by === 'ai' ? '· IA' : '';
          return sep + `
        <div style="display:flex;flex-direction:column;align-items:${m.direction==='inbound'?'flex-start':'flex-end'}">
          <div class="msg msg-${m.direction} ${m.sent_by === 'human' ? 'human' : ''}">
            ${(()=>{
              const txt = m.content || '';
              const mediaMatch = txt.match(/\[([^\]]+) recebido:\s*([^\s|\]]+)(?:\s*\|\s*([^\]]*))?\]/i);
              if (mediaMatch) {
                const tipo = mediaMatch[1].toLowerCase();
                const fileRef = mediaMatch[2].trim();
                const fileName = (mediaMatch[3] || '').trim();
                const isLocal = fileRef.startsWith('/api/file/') || fileRef.startsWith('/uploads/');
                const icon = tipo === 'imagem' ? '🖼️' : tipo === 'vídeo' || tipo === 'video' ? '🎥' : tipo === 'áudio' || tipo === 'audio' ? '🎵' : '📎';
                const label = fileName || tipo;
                if (isLocal) {
                  if (tipo === 'imagem') {
                    return `<a href="${fileRef}" target="_blank"><img src="${fileRef}" style="max-width:220px;max-height:220px;border-radius:8px;display:block;cursor:pointer"><br><small style="opacity:.7;font-size:11px">${escHtml(label)}</small></a>`;
                  } else if (tipo === 'áudio' || tipo === 'audio') {
                    return `<div>${icon} <small style="opacity:.7">${escHtml(label)}</small><br><audio controls style="max-width:220px;margin-top:4px"><source src="${fileRef}"></audio></div>`;
                  } else if (tipo === 'vídeo' || tipo === 'video') {
                    return `<div>${icon} <small style="opacity:.7">${escHtml(label)}</small><br><video controls style="max-width:220px;border-radius:8px;margin-top:4px"><source src="${fileRef}"></video></div>`;
                  } else {
                    return `<a href="${fileRef}" target="_blank" download style="color:inherit;text-decoration:none"><div style="background:rgba(255,255,255,.15);border-radius:8px;padding:10px 14px;display:inline-flex;align-items:center;gap:8px">${icon} <span style="text-decoration:underline;font-size:13px">${escHtml(label)}</span></div></a>`;
                  }
                }
                return `<div style="background:rgba(255,255,255,.15);border-radius:8px;padding:10px 14px;display:inline-flex;align-items:center;gap:10px">
                  ${icon} <span style="font-size:13px">${escHtml(label)}</span>
                  <button onclick="openMedia('${fileRef}','${tipo}')" style="background:rgba(255,255,255,.25);border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;color:inherit">Ver / Baixar</button>
                </div>`;
              }
              return escHtml(txt);
            })()}
            <div class="msg-time">${carimbo} ${autor}</div>
          </div>
        </div>`;
        }).join('');
      })()}
```

- [ ] **Step 3: Verificar as edições**

Run: `grep -n "msg-day-sep\|const carimbo\|day:'numeric',month:'long'" public/dashboard.html`
Expected: o CSS `.msg-day-sep`, o `const carimbo` e o separador `day:'numeric',month:'long'` presentes.

- [ ] **Step 4: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(chat): data nas mensagens + separador de dia no painel"
```

---

## Task 3: Parte B.2a — Migration 049 + função pura `deveReengajar`

**Files:**
- Create: `sql/migrations/049_conversations_reengajado.sql`
- Modify: `src/services/followup.js` (add `deveReengajar` + export)
- Test: `tests/reengajamento.test.js`

- [ ] **Step 1: Escrever a migration**

Create `sql/migrations/049_conversations_reengajado.sql`:

```sql
-- Chatbot: flag para reengajar uma conversa parada em aguardando_humano (auto-liberação após 2 dias).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS reengajado_em TIMESTAMPTZ;
```

- [ ] **Step 2: Escrever o teste de `deveReengajar` (falha)**

Create `tests/reengajamento.test.js`:

```js
const { deveReengajar } = require('../src/services/followup');

const agora = new Date('2026-07-03T15:00:00Z'); // dia útil (sexta), 12h SP
const h72 = new Date('2026-06-30T12:00:00Z');   // ~3 dias antes
const h1  = new Date('2026-07-03T14:00:00Z');   // 1h antes

const base = { status: 'aguardando_humano', pedido_numero: null, reengajado_em: null, ultima_msg_at: h72 };

describe('deveReengajar', () => {
  test('elegível: aguardando_humano, sem pedido, sem flag, >48h', () => {
    expect(deveReengajar(base, agora)).toBe(true);
  });
  test('não elegível: outro status', () => {
    expect(deveReengajar({ ...base, status: 'active' }, agora)).toBe(false);
  });
  test('não elegível: pedido já registrado', () => {
    expect(deveReengajar({ ...base, pedido_numero: 42 }, agora)).toBe(false);
  });
  test('não elegível: já reengajado', () => {
    expect(deveReengajar({ ...base, reengajado_em: h72 }, agora)).toBe(false);
  });
  test('não elegível: última mensagem há menos de 48h', () => {
    expect(deveReengajar({ ...base, ultima_msg_at: h1 }, agora)).toBe(false);
  });
  test('não elegível: sem última mensagem', () => {
    expect(deveReengajar({ ...base, ultima_msg_at: null }, agora)).toBe(false);
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npx jest tests/reengajamento.test.js`
Expected: FAIL — `deveReengajar is not a function`.

- [ ] **Step 4: Implementar `deveReengajar` em `followup.js`**

In `src/services/followup.js`, add this function just before the `startScheduler` function (before line 183 `// Inicia o scheduler`):

```js
const REENGAJAR_APOS_MS = 48 * 3600 * 1000;

// Função pura: a conversa deve ser reengajada pelo bot? (após 2 dias parada em aguardando_humano,
// sem pedido registrado — o próximo passo é do cliente).
function deveReengajar(conv, agora) {
  if (!conv || conv.status !== 'aguardando_humano') return false;
  if (conv.pedido_numero != null) return false;   // pedido já registrado → espera a equipe
  if (conv.reengajado_em != null) return false;    // já reengajado nesta parada
  if (!conv.ultima_msg_at) return false;
  const ultima = new Date(conv.ultima_msg_at).getTime();
  return (agora.getTime() - ultima) > REENGAJAR_APOS_MS;
}
```

- [ ] **Step 5: Exportar `deveReengajar`**

In `src/services/followup.js`, change the `module.exports` line (190) from:
```js
module.exports = { scheduleFollowUps, cancelPendingFollowUps, processFollowUps, startScheduler, calcScheduledAt };
```
to:
```js
module.exports = { scheduleFollowUps, cancelPendingFollowUps, processFollowUps, startScheduler, calcScheduledAt, deveReengajar };
```

- [ ] **Step 6: Rodar o teste e confirmar que passa**

Run: `npx jest tests/reengajamento.test.js`
Expected: PASS (6 testes).

- [ ] **Step 7: Commit**

```bash
git add sql/migrations/049_conversations_reengajado.sql src/services/followup.js tests/reengajamento.test.js
git commit -m "feat(chat): migration 049 reengajado_em + deveReengajar (pura) + testes"
```

---

## Task 4: Parte B.2b — Job de reengajamento + reset no inbound

**Files:**
- Modify: `src/services/followup.js` (add `processReengajamentos` + chamada no `startScheduler`)
- Modify: `src/webhook/handler.js:78` (reset de `reengajado_em`)

- [ ] **Step 1: Implementar `processReengajamentos` em `followup.js`**

In `src/services/followup.js`, at the very top of the file, the module already requires `db`, `sendMessage`, `log`. Confirm the OpenAI client — add this near the top requires (after the existing `require`s at lines 1-3):

```js
const OpenAI = require('openai');
const _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
```

Then add this function right after `deveReengajar` (from Task 3):

```js
// Gera e envia a mensagem de reengajamento para conversas paradas 2+ dias em aguardando_humano.
async function processReengajamentos() {
  const agora = new Date();
  // Só em dia útil e horário comercial (9h–18h SP) — reusa os helpers de fuso.
  if (isWeekendSP(agora)) return;
  const horaSP = getHourSP(agora);
  if (horaSP < 9 || horaSP >= 18) return;

  const cand = await db.query(`
    SELECT c.id, c.ai_context, c.reengajado_em, c.pedido_numero, c.status, ct.phone,
           (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) AS ultima_msg_at
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.status = 'aguardando_humano'
      AND c.pedido_numero IS NULL
      AND c.reengajado_em IS NULL
  `);

  for (const conv of cand.rows) {
    if (!deveReengajar(conv, agora)) continue;
    try {
      const historico = Array.isArray(conv.ai_context) ? conv.ai_context.slice(-20) : [];
      let mensagem = 'Oi! 😊 Voltando aqui pra te ajudar a finalizar seu orçamento na Gráfica LKL. Ainda tem interesse?';
      try {
        const r = await _openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o',
          messages: [
            { role: 'system', content: 'Você é o assistente da Gráfica LKL. Escreva UMA mensagem curta e simpática de reengajamento em português BR, retomando de onde a conversa parou: cite o produto/serviço em questão (se houver no histórico) e pergunte se o cliente ainda tem interesse em seguir com o orçamento. Não invente preços. Máx. 2 frases.' },
            ...historico,
            { role: 'user', content: '[SISTEMA] Gere agora a mensagem de reengajamento.' },
          ],
          temperature: 0.7,
          max_tokens: 200,
        });
        const gerada = r.choices?.[0]?.message?.content?.trim();
        if (gerada) mensagem = gerada;
      } catch (e) {
        console.warn('[REENGAJAMENTO] OpenAI falhou, usando template:', e.message);
      }

      await sendMessage(conv.phone, mensagem);
      await db.query(
        `INSERT INTO messages (conversation_id, contact_id, content, direction, sent_by)
         SELECT $1, c.contact_id, $2, 'outbound', 'ai' FROM conversations c WHERE c.id = $1`,
        [conv.id, mensagem]
      );
      await db.query(
        `UPDATE conversations SET status = 'active', reengajado_em = NOW(), updated_at = NOW() WHERE id = $1`,
        [conv.id]
      );
      await log('reengajamento', `Reengajamento enviado para ${conv.phone}`, { conversationId: conv.id });
      if (global.io) global.io.emit('conversation_updated', { conversationId: conv.id });
    } catch (err) {
      console.error(`[REENGAJAMENTO] Erro na conversa ${conv.id}:`, err.message);
      // Não consome o flag: tenta na próxima rodada.
    }
  }
}
```

- [ ] **Step 2: Chamar `processReengajamentos` no scheduler**

In `src/services/followup.js`, in `startScheduler`, the `setInterval` currently only calls `processFollowUps`. Replace the `setInterval` block (lines 187-189) with:

```js
  setInterval(() => {
    processFollowUps().catch(err => console.error('[follow-up] Erro no scheduler:', err.message));
    processReengajamentos().catch(err => console.error('[reengajamento] Erro no scheduler:', err.message));
  }, 60 * 1000);
```

- [ ] **Step 3: Exportar `processReengajamentos`**

In `src/services/followup.js`, update the `module.exports` line to include `processReengajamentos`:
```js
module.exports = { scheduleFollowUps, cancelPendingFollowUps, processFollowUps, startScheduler, calcScheduledAt, deveReengajar, processReengajamentos };
```

- [ ] **Step 4: Reset do flag no inbound (`handler.js`)**

In `src/webhook/handler.js`, right after the `saveMessage(...)` call at line 78 (the inbound save), add a line to clear the flag so a future stall can reengage again:

```js
  await db.query('UPDATE conversations SET reengajado_em = NULL WHERE id = $1 AND reengajado_em IS NOT NULL', [conversation.id]);
```

- [ ] **Step 5: Garantir que os módulos carregam e a suíte passa**

Run: `node -e "require('./src/services/followup'); require('./src/webhook/handler'); console.log('ok')"`
Expected: imprime `ok`.

Run: `npx jest tests/reengajamento.test.js tests/agent-prompt.test.js`
Expected: PASS (todos).

- [ ] **Step 6: Commit**

```bash
git add src/services/followup.js src/webhook/handler.js
git commit -m "feat(chat): job de reengajamento (2 dias) + reset do flag no inbound"
```

---

## Task 5: Deploy VPS + smoke + memória

**Files:** nenhum código novo — deploy e verificação.

- [ ] **Step 1: Aplicar a migration 049 no VPS**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -f -" < sql/migrations/049_conversations_reengajado.sql
```
Expected: `ALTER TABLE`. Conferir:
```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c '\d conversations'" | grep reengajado_em
```
Expected: coluna `reengajado_em | timestamp with time zone`.

- [ ] **Step 2: Rsync do código**

```bash
rsync -avz src/ai/agent.js root@2.25.147.243:/var/www/lkl-chatbot/src/ai/agent.js
rsync -avz src/services/followup.js root@2.25.147.243:/var/www/lkl-chatbot/src/services/followup.js
rsync -avz src/webhook/handler.js root@2.25.147.243:/var/www/lkl-chatbot/src/webhook/handler.js
rsync -avz public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
Expected: transferências sem erro.

- [ ] **Step 3: Restart do app**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1; sleep 2; pm2 list | grep lkl-chatbot"
```
Expected: `online`.

- [ ] **Step 4: Smoke da elegibilidade (SQL sintético)**

Forjar uma conversa elegível e conferir o SELECT do job (sem enviar WhatsApp — só valida a query/coluna):
```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot" <<'SQL'
BEGIN;
INSERT INTO contacts (phone) VALUES ('SMOKE-REENG-000') RETURNING id \gset
INSERT INTO conversations (contact_id, status) VALUES (:'id','aguardando_humano') RETURNING id AS conv \gset
INSERT INTO messages (conversation_id, contact_id, content, direction, sent_by, created_at)
  VALUES (:'conv', :'id', 'quero um banner', 'inbound', 'ai', NOW() - INTERVAL '3 days');
-- espelha o SELECT do job:
SELECT c.id, c.pedido_numero, c.reengajado_em,
       (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) AS ultima_msg_at
FROM conversations c
WHERE c.status='aguardando_humano' AND c.pedido_numero IS NULL AND c.reengajado_em IS NULL AND c.id = :'conv';
ROLLBACK;
SQL
```
Expected: retorna a conversa com `ultima_msg_at` ~3 dias atrás, `pedido_numero` e `reengajado_em` nulos — ou seja, seria pega pelo job. `ROLLBACK` limpa.

- [ ] **Step 5: Smoke do prompt em produção**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -e \"const {SYSTEM_PROMPT}=require('./src/ai/agent'); console.log(/GUIA DE MATERIAIS/.test(SYSTEM_PROMPT) && /METRO/.test(SYSTEM_PROMPT) ? 'PROMPT_OK' : 'PROMPT_FALTANDO')\""
```
Expected: `PROMPT_OK`.

- [ ] **Step 6: Validação manual (opcional, pelo usuário)**

Pelo painel/WhatsApp: (a) abrir uma conversa e conferir data + separador de dia nas mensagens; (b) mandar "quero um banner 90x120 cm, não sei o material" e ver o bot sugerir lona 440g e confirmar "0,90m × 1,20m".

- [ ] **Step 7: Atualizar a memória do projeto**

Registrar em `project_sprint_status.md` (memória) o novo item: chatbot ganhou guia de materiais + normalização de dimensões em metros no `SYSTEM_PROMPT` (exportado p/ teste de sanidade); chat mostra data + separador de dia; job de reengajamento (`followup.js` `processReengajamentos` + `deveReengajar`) libera conversas `aguardando_humano` sem `pedido_numero` paradas >48h → bot reassume e reengaja (migration 049 `conversations.reengajado_em`; reset do flag no inbound do `handler.js`). Próxima migration livre: 050.

- [ ] **Step 8: Encerrar a branch**

Usar `superpowers:finishing-a-development-branch`.

---

## Self-Review

**1. Spec coverage:**
- A.1 guia de materiais → Task 1 (regra 14). ✓
- A.2 normalização metros + confirmação → Task 1 (regra 15). ✓
- A.3 cliente sem precisão → Task 1 (regra 14, "sugira/não trave"). ✓
- Teste de sanidade do prompt → Task 1 (`agent-prompt.test.js`) + export. ✓
- B.1 data nas mensagens + separador de dia + CSS → Task 2. ✓
- B.2 migration 049 `reengajado_em` → Task 3. ✓
- B.2 `deveReengajar` (status, pedido_numero IS NULL, flag, 48h) + testes → Task 3. ✓
- B.2 job (horário comercial, gera msg c/ contexto, envia, flip active + flag, log/emit, falha não consome flag) → Task 4. ✓
- B.2 reset do flag no inbound → Task 4. ✓
- Deploy + smoke + memória → Task 5. ✓

**2. Placeholder scan:** sem TBD/TODO; todo passo com código traz o código completo. ✓

**3. Type consistency:** `deveReengajar(conv, agora)` e as chaves `status`/`pedido_numero`/`reengajado_em`/`ultima_msg_at` idênticas entre Task 3 (função/teste) e Task 4 (SELECT do job). `SYSTEM_PROMPT` exportado (Task 1) e consumido no smoke (Task 5). `reengajado_em` consistente em migration/job/handler. ✓
