# Botões Aprovar/Reprovar na arte — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O envio da arte ao cliente passa a incluir botões interativos do WhatsApp (✅ Aprovar / ✏️ Reprovar); o clique é roteado pelo `id` do botão (não pelo texto), e Reprovar pede a descrição do ajuste sem finalizar.

**Architecture:** Novo `whatsapp.sendInteractiveButtons` envia mensagem `interactive/button` (header de imagem OU texto + corpo + botões). `conversas.enviarClienteImagem` ganha `opts.buttons` com fallback em cascata (imagem+botões → texto+botões → texto puro). `orcamentos/service.js` ganha `responderArteBotao(phone, buttonId)` compartilhando a busca do item pendente com `responderArteItem`. O webhook passa a tratar `msg.type === 'interactive'` e roteia pelo `buttonId` via `handleInboundMessage`.

**Tech Stack:** Node.js, WhatsApp Cloud API (axios), PostgreSQL, socket.io, Jest.

**Sem migration.**

---

## File Structure

- **Modify** `src/services/whatsapp.js` — add `sendInteractiveButtons(to, { headerImage, headerText, bodyText, buttons })`; export it.
- **Create** `tests/whatsapp-interactive.test.js` — verifica o payload do `interactive` (mock axios).
- **Modify** `src/services/conversas.js` — `enviarClienteImagem` aceita `opts.buttons`; extrai helper `_enviarComRetry`.
- **Modify** `tests/conversas.test.js` — testes de `enviarClienteImagem` com botões.
- **Modify** `src/modules/orcamentos/service.js` — extrai `_acharArtePendente` + `_aprovarArteItem` (compartilhados), adiciona `responderArteBotao`, passa `buttons` no `enviarArteItem`; exporta `responderArteBotao`.
- **Modify** `tests/modules/arte-envio.test.js` — testes de `responderArteBotao`.
- **Modify** `src/webhook/handler.js` — `handleInboundMessage` ganha 5º parâmetro `buttonId`; intercepta botões de arte.
- **Modify** `src/webhook/routes.js` — trata `msg.type === 'interactive'`.

---

## Task 1: `whatsapp.sendInteractiveButtons`

**Files:**
- Modify: `src/services/whatsapp.js` (add function + export at line 109)
- Test: `tests/whatsapp-interactive.test.js` (create)

- [ ] **Step 1: Escrever o teste que falha**

Create `tests/whatsapp-interactive.test.js`:

```javascript
jest.mock('axios');
const axios = require('axios');
const { sendInteractiveButtons } = require('../src/services/whatsapp');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok';
  axios.post.mockResolvedValue({});
});

test('header de imagem + 2 botões monta o payload interactive/button', async () => {
  await sendInteractiveButtons('5521999', {
    headerImage: 'https://x/a.png',
    bodyText: 'corpo',
    buttons: [{ id: 'arte_aprovar', title: '✅ Aprovar' }, { id: 'arte_reprovar', title: '✏️ Reprovar' }],
  });
  const [url, payload] = axios.post.mock.calls[0];
  expect(url).toMatch(/123\/messages/);
  expect(payload.type).toBe('interactive');
  expect(payload.interactive.type).toBe('button');
  expect(payload.interactive.header).toEqual({ type: 'image', image: { link: 'https://x/a.png' } });
  expect(payload.interactive.body.text).toBe('corpo');
  expect(payload.interactive.action.buttons).toEqual([
    { type: 'reply', reply: { id: 'arte_aprovar', title: '✅ Aprovar' } },
    { type: 'reply', reply: { id: 'arte_reprovar', title: '✏️ Reprovar' } },
  ]);
});

test('sem headerImage → sem header no payload', async () => {
  await sendInteractiveButtons('5521999', { bodyText: 'corpo', buttons: [{ id: 'a', title: 'A' }] });
  const payload = axios.post.mock.calls[0][1];
  expect(payload.interactive.header).toBeUndefined();
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest tests/whatsapp-interactive.test.js --runInBand`
Expected: FAIL (`sendInteractiveButtons is not a function`).

- [ ] **Step 3: Implementar a função**

In `src/services/whatsapp.js`, add before `module.exports` (line 109):

```javascript
// Envia mensagem interativa com botões de resposta (até 3).
// opts: { headerImage?, headerText?, bodyText, buttons: [{ id, title }] }
async function sendInteractiveButtons(to, { headerImage, headerText, bodyText, buttons }) {
  const url = `${BASE_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const interactive = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: (buttons || []).map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
    },
  };
  if (headerImage) interactive.header = { type: 'image', image: { link: headerImage } };
  else if (headerText) interactive.header = { type: 'text', text: headerText };

  await axios.post(url, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive,
  }, {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}
```

Update the export line (currently line 109):

```javascript
module.exports = { sendMessage, sendImage, sendInteractiveButtons, sendTemplate, markAsRead, getMediaUrl, downloadMedia };
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx jest tests/whatsapp-interactive.test.js --runInBand`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add src/services/whatsapp.js tests/whatsapp-interactive.test.js
git commit -m "feat(whatsapp): sendInteractiveButtons (mensagem interativa com botões de resposta)"
```

---

## Task 2: `conversas.enviarClienteImagem` aceita `opts.buttons`

**Files:**
- Modify: `src/services/conversas.js`
- Test: `tests/conversas.test.js`

- [ ] **Step 1: Adicionar testes que falham**

First, update the whatsapp mock at the TOP of `tests/conversas.test.js` to include `sendInteractiveButtons`. Change:

```javascript
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn(), sendImage: jest.fn() }));
```

to:

```javascript
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn(), sendImage: jest.fn(), sendInteractiveButtons: jest.fn() }));
```

Then append these tests to `tests/conversas.test.js`:

```javascript
describe('enviarClienteImagem com botões', () => {
  const botoes = [{ id: 'arte_aprovar', title: '✅ Aprovar' }, { id: 'arte_reprovar', title: '✏️ Reprovar' }];

  test('imagem+botões OK → interativo com header de imagem, registra mídia, via=imagem', async () => {
    whatsapp.sendInteractiveButtons.mockResolvedValueOnce();
    mockRegistroOK();
    const r = await conversas.enviarClienteImagem('21988596449', 'https://app/uploads/a.png', 'corpo',
      { mediaRef: '/uploads/a.png', legenda: 'Arte Pedido #12', buttons: botoes, delayMs: 0 });
    expect(r).toEqual(expect.objectContaining({ ok: true, via: 'imagem' }));
    const call = whatsapp.sendInteractiveButtons.mock.calls[0];
    expect(call[0]).toBe('21988596449');
    expect(call[1]).toEqual(expect.objectContaining({ headerImage: 'https://app/uploads/a.png', bodyText: 'corpo', buttons: botoes }));
    expect(db.query.mock.calls[3][1][2]).toBe('[imagem recebido: /uploads/a.png | Arte Pedido #12]');
  });

  test('imagem+botões falha 2x → fallback texto+botões, registra o corpo, via=texto_botoes', async () => {
    whatsapp.sendInteractiveButtons
      .mockRejectedValueOnce(new Error('400')).mockRejectedValueOnce(new Error('400')) // imagem: 2 tentativas
      .mockResolvedValueOnce();                                                          // texto+botões: ok
    whatsapp.sendMessage.mockClear();
    mockRegistroOK();
    const r = await conversas.enviarClienteImagem('21988596449', 'https://app/uploads/a.png', 'corpo',
      { mediaRef: '/uploads/a.png', legenda: 'Arte', fallbackTexto: 'Segue: https://app/uploads/a.png', buttons: botoes, delayMs: 0 });
    expect(r).toEqual(expect.objectContaining({ ok: true, via: 'texto_botoes' }));
    // 2ª chamada de sendInteractiveButtons foi só-texto (sem headerImage)
    const ultimaCall = whatsapp.sendInteractiveButtons.mock.calls[2][1];
    expect(ultimaCall.headerImage).toBeUndefined();
    expect(ultimaCall.bodyText).toBe('Segue: https://app/uploads/a.png');
    expect(db.query.mock.calls[3][1][2]).toBe('Segue: https://app/uploads/a.png');
  });

  test('imagem+botões e texto+botões falham → texto puro, via=texto', async () => {
    whatsapp.sendInteractiveButtons.mockRejectedValue(new Error('400')); // todas falham
    whatsapp.sendMessage.mockResolvedValueOnce();
    mockRegistroOK();
    const r = await conversas.enviarClienteImagem('21988596449', 'https://app/uploads/a.png', 'corpo',
      { mediaRef: '/uploads/a.png', legenda: 'Arte', fallbackTexto: 'Segue link', buttons: botoes, delayMs: 0 });
    expect(r).toEqual(expect.objectContaining({ ok: true, via: 'texto' }));
    expect(whatsapp.sendMessage).toHaveBeenCalledWith('21988596449', 'Segue link');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest tests/conversas.test.js --runInBand`
Expected: FAIL (os testes de botões falham — caminho não existe).

- [ ] **Step 3: Refatorar retry + implementar caminho de botões**

In `src/services/conversas.js`, add a generic retry helper (before `enviarImagemComRetry`, after `sanitizarLegenda`):

```javascript
// Executa fn; se falhar, espera delayMs e tenta 1x mais. Loga o corpo real do erro. Retorna true/false.
async function _enviarComRetry(fn, delayMs = 2000) {
  try {
    await fn();
    return true;
  } catch (e) {
    console.warn('[ARTE-WA]', e.response && e.response.data ? JSON.stringify(e.response.data) : e.message);
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      await fn();
      return true;
    } catch (e2) {
      console.warn('[ARTE-WA] retry falhou:', e2.response && e2.response.data ? JSON.stringify(e2.response.data) : e2.message);
      return false;
    }
  }
}
```

Replace the existing `enviarImagemComRetry` body to delegate to the helper (behavior idêntico — 2 tentativas):

```javascript
async function enviarImagemComRetry(celular, urlEnvio, caption, delayMs = 2000) {
  return _enviarComRetry(() => whatsapp.sendImage(celular, urlEnvio, caption), delayMs);
}
```

Replace the whole `enviarClienteImagem` function with:

```javascript
// Envio robusto de imagem ao cliente. Com opts.buttons envia interativo (imagem+botões → texto+botões → texto puro).
// Sem opts.buttons mantém o comportamento anterior (imagem → texto). Registra no histórico em qualquer sucesso.
// opts: { mediaRef, legenda, fallbackTexto, buttons, delayMs, sentBy }
async function enviarClienteImagem(celular, urlEnvio, caption, opts = {}) {
  const temBotoes = Array.isArray(opts.buttons) && opts.buttons.length > 0;
  const ref = opts.mediaRef || urlEnvio;
  const conteudoMidia = `[imagem recebido: ${ref} | ${sanitizarLegenda(opts.legenda)}]`;
  const textoFallback = opts.fallbackTexto || `Segue o arquivo: ${urlEnvio}`;

  if (temBotoes) {
    // 1) imagem + botões
    const okImg = await _enviarComRetry(
      () => whatsapp.sendInteractiveButtons(celular, { headerImage: urlEnvio, bodyText: caption, buttons: opts.buttons }),
      opts.delayMs
    );
    if (okImg) {
      await registrarMensagemCliente(celular, conteudoMidia, opts);
      return { ok: true, via: 'imagem' };
    }
    // 2) texto + botões (link no corpo — mantém os botões)
    const okTxt = await _enviarComRetry(
      () => whatsapp.sendInteractiveButtons(celular, { bodyText: textoFallback, buttons: opts.buttons }),
      opts.delayMs
    );
    if (okTxt) {
      await registrarMensagemCliente(celular, textoFallback, opts);
      return { ok: true, via: 'texto_botoes' };
    }
    // 3) texto puro (sem botões)
    try {
      await whatsapp.sendMessage(celular, textoFallback);
    } catch (e) {
      console.warn('[ARTE-WA] fallback texto falhou:', e.message);
      return { ok: false, via: null };
    }
    await registrarMensagemCliente(celular, textoFallback, opts);
    return { ok: true, via: 'texto' };
  }

  // Sem botões — comportamento anterior
  const ok = await enviarImagemComRetry(celular, urlEnvio, caption, opts.delayMs);
  if (ok) {
    await registrarMensagemCliente(celular, conteudoMidia, opts);
    return { ok: true, via: 'imagem' };
  }
  try {
    await whatsapp.sendMessage(celular, textoFallback);
  } catch (e) {
    console.warn('[ARTE-WA] fallback texto falhou:', e.message);
    return { ok: false, via: null };
  }
  await registrarMensagemCliente(celular, textoFallback, opts);
  return { ok: true, via: 'texto' };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx jest tests/conversas.test.js --runInBand`
Expected: PASS (todos — os 11 antigos + os 3 novos de botões).

- [ ] **Step 5: Commit**

```bash
git add src/services/conversas.js tests/conversas.test.js
git commit -m "feat(conversas): enviarClienteImagem com botões interativos + fallback em cascata"
```

---

## Task 3: `responderArteBotao` + refatoração compartilhada

**Files:**
- Modify: `src/modules/orcamentos/service.js` (funções `responderArteItem` ~906-937, `enviarArteItem` ~872-888, export ~954)
- Test: `tests/modules/arte-envio.test.js`

- [ ] **Step 1: Adicionar testes que falham**

Append to `tests/modules/arte-envio.test.js`:

```javascript
describe('responderArteBotao', () => {
  const PEND = { id: 9, orcamento_id: 1, produto: 'BANNER', tipo_producao: 'OFFSET', vendedor_id: 3, pedido_numero: 31 };

  test('arte_aprovar → status aprovada + resposta de confirmação', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [PEND] }) // _acharArtePendente
      .mockResolvedValueOnce({ rows: [] });    // UPDATE aprovada
    const r = await service.responderArteBotao('21988596449', 'arte_aprovar');
    expect(r).toEqual(expect.objectContaining({ aprovado: true, item_id: 9 }));
    expect(r.resposta).toMatch(/aprovada/i);
    expect(db.query.mock.calls[1][0]).toMatch(/arte_status='aprovada'/);
  });

  test('arte_reprovar → NÃO muda status, pede descrição do ajuste', async () => {
    db.query.mockResolvedValueOnce({ rows: [PEND] }); // só o SELECT
    const r = await service.responderArteBotao('21988596449', 'arte_reprovar');
    expect(r).toEqual(expect.objectContaining({ pediu_ajuste: true, item_id: 9 }));
    expect(r.resposta).toMatch(/descrever o ajuste/i);
    expect(db.query).toHaveBeenCalledTimes(1); // nenhum UPDATE
  });

  test('sem arte pendente → null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await service.responderArteBotao('21988596449', 'arte_aprovar');
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest tests/modules/arte-envio.test.js --runInBand`
Expected: FAIL (`responderArteBotao is not a function`).

- [ ] **Step 3: Extrair helpers compartilhados**

In `src/modules/orcamentos/service.js`, add BEFORE `responderArteItem` (line 906) two helpers:

```javascript
// Acha a arte pendente (status 'enviada') do cliente pelo telefone (sufixo de 9 dígitos).
async function _acharArtePendente(phone) {
  const celular = String(phone || '').replace(/\D/g, '');
  if (!celular) return null;
  const pend = await db.query(
    `SELECT oi.id, oi.orcamento_id, oi.produto, oi.tipo_producao, o.vendedor_id,
            (SELECT numero_os FROM orders WHERE orcamento_id = oi.orcamento_id ORDER BY created_at LIMIT 1) AS pedido_numero
     FROM orcamento_itens oi
     JOIN orcamentos o ON o.id = oi.orcamento_id
     JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE oi.arte_status='enviada' AND (c.celular LIKE $1 OR c.celular LIKE $2)
     ORDER BY oi.arte_enviada_em DESC LIMIT 1`,
    [`%${celular.slice(-9)}`, `%${celular}`]
  );
  return pend.rows[0] || null;
}

// Aprova a arte de um item: marca 'aprovada', dispara OS de CV se for o caso. Retorna a mensagem ao cliente.
async function _aprovarArteItem(item) {
  const refPed = item.pedido_numero || '';
  await db.query(`UPDATE orcamento_itens SET arte_status='aprovada', arte_aprovada_em=NOW() WHERE id=$1`, [item.id]);
  if (item.tipo_producao === 'COMUNICAÇÃO VISUAL') {
    osService.criarOSComunicacaoVisual(item.orcamento_id).catch(e => console.warn('[OS-CV-ARTE]', e.message));
  }
  return `Arte aprovada! ✅ Seu *Pedido #${refPed}* seguirá para produção. Obrigado! 🖨️`;
}
```

- [ ] **Step 4: Refatorar `responderArteItem` para usar os helpers**

Replace the current `responderArteItem` (lines 906-937) with:

```javascript
async function responderArteItem(phone, mensagem) {
  const item = await _acharArtePendente(phone);
  if (!item) return null;
  const texto = String(mensagem || '').trim().toLowerCase();
  const negado = /\bn[aã]o\b/.test(texto);
  const aprovado = !negado && (APROVACAO_ARTE_INC.some(kw => texto.includes(kw)) || APROVACAO_ARTE_EXATO.includes(texto));
  const refPed = item.pedido_numero || '';
  if (aprovado) {
    const resposta = await _aprovarArteItem(item);
    return { aprovado: true, item_id: item.id, resposta };
  }
  await db.query(`UPDATE orcamento_itens SET arte_status='reprovada', arte_comentario=$1 WHERE id=$2`, [String(mensagem || '').trim(), item.id]);
  if (item.vendedor_id) {
    fcm.sendToUser(item.vendedor_id, { title: `Arte com ajustes — Pedido #${refPed}`, body: `${item.produto || 'Item'}: cliente pediu alterações`, data: { orcamento_id: item.orcamento_id } }).catch(() => {});
  }
  return { aprovado: false, item_id: item.id, resposta: `Anotado! ✏️ Vamos ajustar a arte e te enviar uma nova versão em breve.` };
}
```

- [ ] **Step 5: Adicionar `responderArteBotao`**

Add immediately AFTER `responderArteItem`:

```javascript
// Resposta via clique de botão interativo (roteia pelo id, não pelo texto).
async function responderArteBotao(phone, buttonId) {
  const item = await _acharArtePendente(phone);
  if (!item) return null;
  if (buttonId === 'arte_aprovar') {
    const resposta = await _aprovarArteItem(item);
    return { aprovado: true, item_id: item.id, resposta };
  }
  // arte_reprovar → mantém 'enviada'; pede a descrição do ajuste (Opção A).
  // A próxima mensagem de texto do cliente cai no responderArteItem (texto ≠ aprovação → reprovada + comentário).
  return { pediu_ajuste: true, item_id: item.id, resposta: `Certo! ✏️ Pode nos descrever o ajuste que deseja? Assim já mandamos a nova versão certinha.` };
}
```

- [ ] **Step 6: Passar `buttons` no `enviarArteItem`**

In `enviarArteItem`, replace the `conversas.enviarClienteImagem(...)` call (lines ~884-888) with:

```javascript
  const envio = await conversas.enviarClienteImagem(item.cliente_celular, publicUrl, caption, {
    mediaRef: arquivo_url,
    legenda: `Arte Pedido #${refPed}`,
    fallbackTexto,
    buttons: [
      { id: 'arte_aprovar', title: '✅ Aprovar' },
      { id: 'arte_reprovar', title: '✏️ Reprovar' },
    ],
  });
```

- [ ] **Step 7: Exportar `responderArteBotao`**

Update the `module.exports` line (954) to add `responderArteBotao`:

```javascript
module.exports = { listar, buscarPorId, criar, precificar, mudarStatus, concluir, reenviar, aprovar, reprovar, processarRespostaToken, processarRespostaWA, cobrar, confirmarPagamento, cancelarBoleto, cancelarBoletoDireto, cancelarPix, cancelarLinkMp, _rebuildOrderItems, enviarArteItem, responderArteItem, responderArteBotao, listarArtesPendentes };
```

- [ ] **Step 8: Rodar e ver passar**

Run: `npx jest tests/modules/arte-envio.test.js --runInBand`
Expected: PASS (os 4 antigos de `enviarArteItem` + os 3 novos de `responderArteBotao`).

- [ ] **Step 9: Commit**

```bash
git add src/modules/orcamentos/service.js tests/modules/arte-envio.test.js
git commit -m "feat(arte): responderArteBotao (roteia pelo id) + botões no envio; refatora busca/aprovação"
```

---

## Task 4: Webhook trata clique de botão

**Files:**
- Modify: `src/webhook/handler.js` (import linha 4; assinatura de `handleInboundMessage` linha 60; interceptação ~87)
- Modify: `src/webhook/routes.js` (parsing ~50-52)

- [ ] **Step 1: Importar `responderArteBotao` no handler**

In `src/webhook/handler.js`, change line 4:

```javascript
const { responderArteItem } = require('../modules/orcamentos/service');
```

to:

```javascript
const { responderArteItem, responderArteBotao } = require('../modules/orcamentos/service');
```

- [ ] **Step 2: Adicionar o parâmetro `buttonId` e a interceptação**

In `src/webhook/handler.js`, change the signature (line 60):

```javascript
async function handleInboundMessage(phone, profileName, messageText, waMessageId) {
```

to:

```javascript
async function handleInboundMessage(phone, profileName, messageText, waMessageId, buttonId = null) {
```

Then, immediately AFTER the inbound `saveMessage(...)` and the `reengajado_em` UPDATE (after line 79, before the `log('message_received', ...)` call), insert:

```javascript
  // Clique de botão interativo da arte — roteia pelo id (não pelo texto)
  if (buttonId === 'arte_aprovar' || buttonId === 'arte_reprovar') {
    const respBotao = await responderArteBotao(phone, buttonId);
    if (respBotao) {
      await sendMessage(phone, respBotao.resposta);
      await saveMessage(conversation.id, contact.id, respBotao.resposta, 'outbound', null, 'system');
      if (respBotao.aprovado && global.io) global.io.emit('arte_aprovada', { item_id: respBotao.item_id });
      return;
    }
    // sem arte pendente → segue o fluxo normal com o título do botão como texto
  }
```

- [ ] **Step 3: Tratar `interactive` no routes.js**

In `src/webhook/routes.js`, after the MEDIA_TYPES block (after line 50, before `if (msg.type !== 'text') continue;` at line 52), insert:

```javascript
          if (msg.type === 'interactive') {
            const reply = msg.interactive?.button_reply || msg.interactive?.list_reply;
            if (reply) {
              await handleInboundMessage(phone, profileName, reply.title || '(resposta)', msg.id, reply.id || null);
            }
            continue;
          }
```

- [ ] **Step 4: Verificar que os módulos carregam (sem teste unitário do webhook)**

Run: `node -e "require('./src/webhook/handler'); require('./src/webhook/routes'); console.log('require OK')"`
Expected: `require OK` (sem erro de sintaxe/require).

- [ ] **Step 5: Rodar a suíte tocada para garantir que nada quebrou**

Run: `npx jest tests/conversas.test.js tests/modules/arte-envio.test.js tests/whatsapp-interactive.test.js --runInBand`
Expected: PASS em todas.

- [ ] **Step 6: Commit**

```bash
git add src/webhook/handler.js src/webhook/routes.js
git commit -m "feat(webhook): trata clique de botão interativo (aprovar/reprovar arte) pelo id"
```

---

## Task 5: Deploy no VPS + smoke + memória

**Files:** nenhum código novo — deploy e verificação.

- [ ] **Step 1: Backup dos arquivos tocados no VPS**

Run:
```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && T=\$(date +%s) && cp src/modules/orcamentos/service.js /tmp/service.js.bak-\$T && cp src/services/whatsapp.js /tmp/whatsapp.js.bak-\$T && cp src/webhook/handler.js /tmp/handler.js.bak-\$T && cp src/webhook/routes.js /tmp/routes.js.bak-\$T && echo BACKUP_OK"
```
Expected: `BACKUP_OK`.

- [ ] **Step 2: Confirmar deploy com o usuário**

Pergunte ao usuário (AskUserQuestion) se pode fazer o deploy em produção agora. Só prosseguir com "sim".

- [ ] **Step 3: Rsync dos arquivos**

Run:
```bash
rsync -az /Users/klebercamara/LKL/src/services/whatsapp.js root@2.25.147.243:/var/www/lkl-chatbot/src/services/whatsapp.js
rsync -az /Users/klebercamara/LKL/src/services/conversas.js root@2.25.147.243:/var/www/lkl-chatbot/src/services/conversas.js
rsync -az /Users/klebercamara/LKL/src/modules/orcamentos/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/service.js
rsync -az /Users/klebercamara/LKL/src/webhook/handler.js root@2.25.147.243:/var/www/lkl-chatbot/src/webhook/handler.js
rsync -az /Users/klebercamara/LKL/src/webhook/routes.js root@2.25.147.243:/var/www/lkl-chatbot/src/webhook/routes.js
```
Expected: transferência sem erro.

- [ ] **Step 4: Restart do serviço**

Run:
```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && sleep 2 && pm2 logs lkl-chatbot --lines 12 --nostream 2>&1 | tail -14"
```
Expected: processo `online`, `PostgreSQL conectado`, sem stack trace de require.

- [ ] **Step 5: Smoke real com o usuário**

Peça ao usuário para reenviar a arte de um pedido de teste pelo `arte_final.html` e conferir no WhatsApp:
- a arte chega como imagem **com os dois botões** ✅ Aprovar / ✏️ Reprovar;
- clicar **Aprovar** → item vira `aprovada` (segue produção) e a resposta aparece no histórico;
- clicar **Reprovar** → bot pede a descrição do ajuste e a arte continua pendente; ao digitar o ajuste, vira `reprovada` + vendedor notificado.

Conferir status no VPS:
```bash
ssh root@2.25.147.243 "psql -U postgres -d lkl_chatbot -c \"SELECT id, arte_status, left(arte_comentario,40) FROM orcamento_itens WHERE arte_arquivo_url IS NOT NULL ORDER BY arte_enviada_em DESC NULLS LAST LIMIT 5;\""
```

- [ ] **Step 6: Atualizar a memória**

Append ao `project_sprint_status.md` uma entrada ARTE-BOTOES resumindo: botões interativos ✅ Aprovar / ✏️ Reprovar no envio da arte (`whatsapp.sendInteractiveButtons` + `conversas.enviarClienteImagem` com `opts.buttons` e fallback imagem+botões → texto+botões → texto puro); clique roteado pelo `id` (`arte_aprovar`/`arte_reprovar`) via webhook `interactive` → `handleInboundMessage(..., buttonId)` → `responderArteBotao`; Reprovar (Opção A) mantém a arte pendente e pede a descrição, que cai no `responderArteItem` existente; refatoração `_acharArtePendente`/`_aprovarArteItem` compartilhada; sem migration.

---

## Self-Review

**Spec coverage:**
- Envio interativo imagem+botões → Tasks 1 (`sendInteractiveButtons`) + 2 (`opts.buttons`) + 3 (passa `buttons`). ✅
- Fallback imagem+botões → texto+botões → texto puro → Task 2. ✅
- Recebimento do clique via `interactive` + roteamento pelo `id` → Task 4. ✅
- Aprovar aprova/dispara OS; Reprovar (Opção A) mantém pendente e pede descrição → Task 3 (`responderArteBotao`). ✅
- Compartilhar a busca do item pendente com `responderArteItem` → Task 3 (`_acharArtePendente`, `_aprovarArteItem`). ✅
- Evitar o bug do `includes('aprovado')` → roteia pelo `id`, não pelo título → Task 3/4. ✅
- Testes Jest + smoke → Tasks 1-4 (Jest) + 5 (smoke). ✅
- Sem migration → confirmado. ✅

**Placeholder scan:** nenhum TBD/TODO; todo passo com código tem o código completo. ✅

**Type consistency:** `sendInteractiveButtons(to, { headerImage, headerText, bodyText, buttons })` idêntico entre Task 1 (def), Task 2 (uso) e testes. `buttons` sempre `[{ id, title }]`. `enviarClienteImagem(..., opts)` com `opts.buttons` consistente entre Task 2 (def/testes) e Task 3 (uso em `enviarArteItem`). `responderArteBotao(phone, buttonId)` retorna `{ aprovado }` ou `{ pediu_ajuste }` — usado no handler (Task 4) checando `respBotao.aprovado`. `handleInboundMessage(phone, profileName, messageText, waMessageId, buttonId)` — 5º parâmetro batido entre Task 4 (def) e a chamada em routes.js. ✅
