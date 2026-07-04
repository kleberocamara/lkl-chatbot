# Rastreio de mensagens ao cliente + Arte robusta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Toda mensagem enviada ao cliente (valor do orçamento e arte) é registrada no histórico da conversa do chatbot, e o envio da arte passa a ser confiável (await + retry + fallback texto-com-link + status honesto).

**Architecture:** Um módulo novo `src/services/conversas.js` centraliza a resolução da conversa do cliente (por telefone) e o registro de mensagens outbound em `messages`, além de wrappers de envio (`enviarClienteTexto`, `enviarClienteImagem`) que enviam pelo WhatsApp **e** registram no histórico. `enviarArteItem` e o envio do valor do orçamento passam a usar esses wrappers. Sem migration.

**Tech Stack:** Node.js, PostgreSQL (`pg`), WhatsApp Cloud API (axios), socket.io, Jest.

---

## Desvios em relação ao spec (decisões de planejamento)

1. **Sem refatorar `handler.js`.** O spec sugeria mover `getOrCreateContact`/`getActiveConversation`/`createConversation` do handler para o módulo novo. Ao planejar, ficou claro que o caminho **inbound** (webhook) casa o contato por telefone **exato** (o `from` do WhatsApp é canônico), enquanto o caminho **outbound** (orçamento/arte) precisa casar por **sufixo de 9 dígitos** — o `cliente_celular` do ERP pode estar formatado ou com/sem DDI `55`, diferente do `phone` do contato. Semânticas de matching diferentes → `conversas.js` é **autossuficiente** (resolve contato por sufixo) e o `handler.js` fica **intocado** (zero risco de regressão no webhook). A duplicação é de ~3 linhas triviais (get-or-create de conversa), aceitável.

2. Por consequência, a correção de `COALESCE` no `getOrCreateContact` do handler não é necessária (o webhook sempre passa `profileName`). O resolver de `conversas.js` já trata nome nulo com `COALESCE`.

---

## File Structure

- **Create** `src/services/conversas.js` — resolução de contato/conversa do cliente por telefone e registro de mensagens outbound; wrappers `enviarClienteTexto`, `enviarClienteImagem`, `enviarImagemComRetry`. Depende de `src/db`, `src/services/whatsapp`.
- **Create** `tests/conversas.test.js` — testes unitários de `conversas.js` (mock de `db` e `whatsapp`).
- **Modify** `src/modules/orcamentos/service.js` — `enviarArteItem` (envio robusto + status honesto) e `_dispararNotificacoesEnvio` (valor do orçamento via `enviarClienteTexto`).
- **Create** `tests/modules/arte-envio.test.js` — testes de `enviarArteItem` (mock de `db` e `conversas`).

Sem migration. Sem mudança de UI (o painel já renderiza o formato de mídia `[imagem recebido: <path> | <legenda>]`).

---

## Task 1: `conversas.js` — resolver contato/conversa + `registrarMensagemCliente`

**Files:**
- Create: `src/services/conversas.js`
- Test: `tests/conversas.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Create `tests/conversas.test.js`:

```javascript
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn(), sendImage: jest.fn() }));

const db = require('../src/db');
const conversas = require('../src/services/conversas');

beforeEach(() => { jest.clearAllMocks(); delete global.io; });

describe('registrarMensagemCliente', () => {
  test('telefone vazio → retorna null, não toca no banco', async () => {
    const r = await conversas.registrarMensagemCliente('', 'oi');
    expect(r).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('contato+conversa existentes → insere outbound system na conversa achada', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'KLEBER', profile_name: 'K' }] }) // acharContato
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })                                     // update contato
      .mockResolvedValueOnce({ rows: [{ id: 30, contact_id: 7, status: 'active' }] })   // conversa ativa
      .mockResolvedValueOnce({ rows: [] });                                             // insert message
    const r = await conversas.registrarMensagemCliente('5521988596449', 'valor R$ 10', { sentBy: 'system' });
    expect(r).toEqual({ conversationId: 30, contactId: 7 });
    const insert = db.query.mock.calls[3];
    expect(insert[0]).toMatch(/INSERT INTO messages/i);
    expect(insert[1]).toEqual([30, 7, 'valor R$ 10', 'outbound', null, 'system']);
  });

  test('sem conversa ativa → cria conversa e insere', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'KLEBER' }] }) // acharContato
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })                 // update contato
      .mockResolvedValueOnce({ rows: [] })                          // sem conversa ativa
      .mockResolvedValueOnce({ rows: [{ id: 55, contact_id: 7, status: 'active' }] }) // cria conversa
      .mockResolvedValueOnce({ rows: [] });                        // insert message
    const r = await conversas.registrarMensagemCliente('21988596449', 'oi');
    expect(r.conversationId).toBe(55);
    expect(db.query.mock.calls[3][0]).toMatch(/INSERT INTO conversations/i);
  });

  test('sem contato → cria contato pelos dígitos', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })                          // acharContato: nada
      .mockResolvedValueOnce({ rows: [{ id: 99, name: null }] })    // cria contato
      .mockResolvedValueOnce({ rows: [{ id: 60, contact_id: 99 }] })// cria conversa
      .mockResolvedValueOnce({ rows: [] });                        // insert message
    const r = await conversas.registrarMensagemCliente('(21) 98859-6449', 'oi');
    expect(r.contactId).toBe(99);
    const insContato = db.query.mock.calls[1];
    expect(insContato[0]).toMatch(/INSERT INTO contacts/i);
    expect(insContato[1][0]).toBe('988596449'); // só dígitos, últimos 9
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest tests/conversas.test.js --runInBand`
Expected: FAIL (`Cannot find module '../src/services/conversas'`).

- [ ] **Step 3: Implementar `conversas.js` (parte 1)**

Create `src/services/conversas.js`:

```javascript
const db = require('../db');

function soDigitos(cel) {
  return String(cel || '').replace(/\D/g, '');
}

// Acha o contato do WhatsApp pelo telefone (casa por sufixo de 9 dígitos p/ tolerar DDI/formatação).
async function acharContatoPorTelefone(celular) {
  const dig = soDigitos(celular);
  if (!dig) return null;
  const suf = dig.slice(-9);
  const r = await db.query(
    `SELECT * FROM contacts WHERE phone LIKE $1 OR phone = $2
     ORDER BY last_contact DESC NULLS LAST LIMIT 1`,
    [`%${suf}`, dig]
  );
  return r.rows[0] || null;
}

async function getOrCreateContatoPorTelefone(celular, nome) {
  const dig = soDigitos(celular);
  if (!dig) return null;
  const existing = await acharContatoPorTelefone(dig);
  if (existing) {
    await db.query(
      `UPDATE contacts SET name = COALESCE(name, $1), last_contact = NOW() WHERE id = $2`,
      [nome || null, existing.id]
    );
    return existing;
  }
  const ins = await db.query(
    `INSERT INTO contacts (phone, profile_name, name, last_contact)
     VALUES ($1, $2, $2, NOW()) RETURNING *`,
    [dig.slice(-9), nome || null]
  );
  return ins.rows[0];
}

async function getOrCreateConversaAtiva(contactId) {
  const r = await db.query(
    `SELECT * FROM conversations WHERE contact_id = $1
     AND status IN ('active', 'aguardando_humano', 'orcamento_enviado')
     ORDER BY started_at DESC LIMIT 1`,
    [contactId]
  );
  if (r.rows[0]) return r.rows[0];
  const ins = await db.query(
    `INSERT INTO conversations (contact_id, status) VALUES ($1, 'active') RETURNING *`,
    [contactId]
  );
  return ins.rows[0];
}

// Registra uma mensagem enviada AO cliente no histórico da conversa dele.
async function registrarMensagemCliente(celular, conteudo, opts = {}) {
  const dig = soDigitos(celular);
  if (!dig) return null;
  const sentBy = opts.sentBy || 'system';
  const waId = opts.whatsappMessageId || null;

  const contato = await getOrCreateContatoPorTelefone(dig, opts.nome);
  if (!contato) return null;
  const conversa = await getOrCreateConversaAtiva(contato.id);

  await db.query(
    `INSERT INTO messages (conversation_id, contact_id, content, direction, whatsapp_message_id, sent_by)
     VALUES ($1, $2, $3, 'outbound', $4, $5)`,
    [conversa.id, contato.id, conteudo, waId, sentBy]
  );

  if (global.io) {
    global.io.emit('new_message', {
      conversationId: conversa.id,
      contactPhone: dig,
      contactName: contato.name || contato.profile_name || '',
      message: conteudo,
      timestamp: new Date().toISOString(),
      sent_by: sentBy,
    });
  }

  return { conversationId: conversa.id, contactId: contato.id };
}

module.exports = {
  soDigitos,
  acharContatoPorTelefone,
  registrarMensagemCliente,
};
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx jest tests/conversas.test.js --runInBand`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add src/services/conversas.js tests/conversas.test.js
git commit -m "feat(conversas): registrarMensagemCliente (resolve conversa por telefone + loga outbound)"
```

---

## Task 2: `conversas.js` — wrappers de envio (`enviarClienteTexto`, `enviarImagemComRetry`, `enviarClienteImagem`)

**Files:**
- Modify: `src/services/conversas.js`
- Test: `tests/conversas.test.js`

- [ ] **Step 1: Adicionar testes que falham**

Append to `tests/conversas.test.js`:

```javascript
const whatsapp = require('../src/services/whatsapp');

function mockRegistroOK() {
  // acharContato → update → conversa ativa → insert message
  db.query
    .mockResolvedValueOnce({ rows: [{ id: 7, name: 'K' }] })
    .mockResolvedValueOnce({ rows: [{ id: 7 }] })
    .mockResolvedValueOnce({ rows: [{ id: 30 }] })
    .mockResolvedValueOnce({ rows: [] });
}

describe('enviarClienteTexto', () => {
  test('envia por WhatsApp e registra o texto', async () => {
    whatsapp.sendMessage.mockResolvedValueOnce();
    mockRegistroOK();
    const r = await conversas.enviarClienteTexto('21988596449', 'valor R$ 10');
    expect(whatsapp.sendMessage).toHaveBeenCalledWith('21988596449', 'valor R$ 10');
    expect(db.query.mock.calls[3][1][2]).toBe('valor R$ 10'); // conteúdo registrado
    expect(r.conversationId).toBe(30);
  });
});

describe('enviarImagemComRetry', () => {
  test('sucesso na 1ª tentativa → true, 1 chamada', async () => {
    whatsapp.sendImage.mockResolvedValueOnce();
    const ok = await conversas.enviarImagemComRetry('21988596449', 'http://x/a.png', 'cap', 0);
    expect(ok).toBe(true);
    expect(whatsapp.sendImage).toHaveBeenCalledTimes(1);
  });
  test('falha 1x, sucesso no retry → true, 2 chamadas', async () => {
    whatsapp.sendImage.mockRejectedValueOnce(new Error('400')).mockResolvedValueOnce();
    const ok = await conversas.enviarImagemComRetry('21988596449', 'http://x/a.png', 'cap', 0);
    expect(ok).toBe(true);
    expect(whatsapp.sendImage).toHaveBeenCalledTimes(2);
  });
  test('falha nas 2 → false', async () => {
    whatsapp.sendImage.mockRejectedValue(new Error('400'));
    const ok = await conversas.enviarImagemComRetry('21988596449', 'http://x/a.png', 'cap', 0);
    expect(ok).toBe(false);
    expect(whatsapp.sendImage).toHaveBeenCalledTimes(2);
  });
});

describe('enviarClienteImagem', () => {
  test('imagem OK → registra formato de mídia com mediaRef relativo', async () => {
    whatsapp.sendImage.mockResolvedValueOnce();
    mockRegistroOK();
    const r = await conversas.enviarClienteImagem('21988596449', 'https://app/uploads/a.png', 'legenda WA',
      { mediaRef: '/uploads/a.png', legenda: 'Arte Pedido #12', delayMs: 0 });
    expect(r).toEqual(expect.objectContaining({ ok: true, via: 'imagem' }));
    expect(db.query.mock.calls[3][1][2]).toBe('[imagem recebido: /uploads/a.png | Arte Pedido #12]');
  });
  test('imagem falha 2x → fallback texto, registra o texto, via=texto', async () => {
    whatsapp.sendImage.mockRejectedValue(new Error('400'));
    whatsapp.sendMessage.mockResolvedValueOnce();
    mockRegistroOK();
    const r = await conversas.enviarClienteImagem('21988596449', 'https://app/uploads/a.png', 'cap',
      { mediaRef: '/uploads/a.png', legenda: 'Arte', fallbackTexto: 'Segue: https://app/uploads/a.png', delayMs: 0 });
    expect(r).toEqual(expect.objectContaining({ ok: true, via: 'texto' }));
    expect(whatsapp.sendMessage).toHaveBeenCalledWith('21988596449', 'Segue: https://app/uploads/a.png');
    expect(db.query.mock.calls[3][1][2]).toBe('Segue: https://app/uploads/a.png');
  });
  test('imagem e texto falham → ok=false, não registra', async () => {
    whatsapp.sendImage.mockRejectedValue(new Error('400'));
    whatsapp.sendMessage.mockRejectedValue(new Error('500'));
    const r = await conversas.enviarClienteImagem('21988596449', 'https://app/uploads/a.png', 'cap',
      { mediaRef: '/uploads/a.png', legenda: 'Arte', fallbackTexto: 'Segue', delayMs: 0 });
    expect(r.ok).toBe(false);
    expect(db.query).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO messages/i), expect.anything());
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest tests/conversas.test.js --runInBand`
Expected: FAIL (`enviarClienteTexto is not a function`, etc).

- [ ] **Step 3: Implementar os wrappers**

In `src/services/conversas.js`, add `const whatsapp = require('./whatsapp');` at the top (após `const db = ...`). Add these functions before `module.exports`:

```javascript
function sanitizarLegenda(txt) {
  return String(txt || 'imagem').replace(/\|/g, '/').replace(/[\[\]]/g, '');
}

async function enviarClienteTexto(celular, texto, opts = {}) {
  await whatsapp.sendMessage(celular, texto);
  return registrarMensagemCliente(celular, texto, opts);
}

// Envia a imagem; se falhar, espera delayMs e tenta 1x mais. Retorna true/false.
async function enviarImagemComRetry(celular, urlEnvio, caption, delayMs = 2000) {
  try {
    await whatsapp.sendImage(celular, urlEnvio, caption);
    return true;
  } catch (e) {
    console.warn('[ARTE-WA]', e.response && e.response.data ? JSON.stringify(e.response.data) : e.message);
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      await whatsapp.sendImage(celular, urlEnvio, caption);
      return true;
    } catch (e2) {
      console.warn('[ARTE-WA] retry falhou:', e2.response && e2.response.data ? JSON.stringify(e2.response.data) : e2.message);
      return false;
    }
  }
}

// Envio robusto de imagem ao cliente: tenta imagem (com retry); se falhar, fallback texto-com-link.
// Registra no histórico em ambos os sucessos. opts: { mediaRef, legenda, fallbackTexto, delayMs, sentBy }
async function enviarClienteImagem(celular, urlEnvio, caption, opts = {}) {
  const ok = await enviarImagemComRetry(celular, urlEnvio, caption, opts.delayMs);
  if (ok) {
    const ref = opts.mediaRef || urlEnvio;
    const content = `[imagem recebido: ${ref} | ${sanitizarLegenda(opts.legenda)}]`;
    await registrarMensagemCliente(celular, content, opts);
    return { ok: true, via: 'imagem' };
  }
  const texto = opts.fallbackTexto || `Segue o arquivo: ${urlEnvio}`;
  try {
    await whatsapp.sendMessage(celular, texto);
  } catch (e) {
    console.warn('[ARTE-WA] fallback texto falhou:', e.message);
    return { ok: false, via: null };
  }
  await registrarMensagemCliente(celular, texto, opts);
  return { ok: true, via: 'texto' };
}
```

Update `module.exports`:

```javascript
module.exports = {
  soDigitos,
  acharContatoPorTelefone,
  registrarMensagemCliente,
  enviarClienteTexto,
  enviarImagemComRetry,
  enviarClienteImagem,
};
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx jest tests/conversas.test.js --runInBand`
Expected: PASS (todos os testes de conversas).

- [ ] **Step 5: Commit**

```bash
git add src/services/conversas.js tests/conversas.test.js
git commit -m "feat(conversas): wrappers enviarClienteTexto/enviarClienteImagem (envio + rastreio + retry/fallback)"
```

---

## Task 3: `enviarArteItem` — envio robusto + status honesto

**Files:**
- Modify: `src/modules/orcamentos/service.js:854-876`
- Test: `tests/modules/arte-envio.test.js`

- [ ] **Step 1: Escrever os testes que falham**

Create `tests/modules/arte-envio.test.js`:

```javascript
jest.mock('../../src/db', () => ({ query: jest.fn() }));
jest.mock('../../src/services/conversas', () => ({ enviarClienteImagem: jest.fn(), enviarClienteTexto: jest.fn() }));

const db = require('../../src/db');
const conversas = require('../../src/services/conversas');
const service = require('../../src/modules/orcamentos/service');

const ITEM = {
  id: 5, produto: 'FOLDER', descricao: null, orcamento_id: 1,
  cliente_celular: '21988596449', cliente_nome: 'KLEBER', pedido_numero: 42,
};

beforeEach(() => { jest.clearAllMocks(); process.env.BASE_URL = 'https://app.graficalkl.com.br'; });

test('envio OK → arte_status=enviada e usa enviarClienteImagem com mediaRef relativo', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [ITEM] }) // SELECT item
    .mockResolvedValueOnce({ rows: [] });    // UPDATE status
  conversas.enviarClienteImagem.mockResolvedValueOnce({ ok: true, via: 'imagem' });

  const r = await service.enviarArteItem(5, '/uploads/artes/arte_1.png');

  expect(conversas.enviarClienteImagem).toHaveBeenCalledWith(
    '21988596449',
    'https://app.graficalkl.com.br/uploads/artes/arte_1.png',
    expect.stringMatching(/Pedido #42/),
    expect.objectContaining({ mediaRef: '/uploads/artes/arte_1.png' })
  );
  const upd = db.query.mock.calls[1];
  expect(upd[0]).toMatch(/arte_status='enviada'/);
  expect(r).toEqual({ ok: true, item_id: 5, status: 'enviada' });
});

test('envio falha total → arte_status=erro_envio e retorna erro', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [ITEM] }) // SELECT item
    .mockResolvedValueOnce({ rows: [] });    // UPDATE erro_envio
  conversas.enviarClienteImagem.mockResolvedValueOnce({ ok: false, via: null });

  const r = await service.enviarArteItem(5, '/uploads/artes/arte_1.png');

  expect(db.query.mock.calls[1][0]).toMatch(/arte_status='erro_envio'/);
  expect(r.status).toBe('erro_envio');
  expect(r.erro[0]).toMatch(/Falha ao enviar arte/);
});

test('item não encontrado → erro', async () => {
  db.query.mockResolvedValueOnce({ rows: [] });
  const r = await service.enviarArteItem(999, '/uploads/x.png');
  expect(r.erro[0]).toMatch(/não encontrado/);
});

test('item sem celular → salva status enviada sem tentar enviar', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [{ ...ITEM, cliente_celular: null }] })
    .mockResolvedValueOnce({ rows: [] });
  const r = await service.enviarArteItem(5, '/uploads/x.png');
  expect(conversas.enviarClienteImagem).not.toHaveBeenCalled();
  expect(r.status).toBe('enviada');
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx jest tests/modules/arte-envio.test.js --runInBand`
Expected: FAIL (o envio atual não usa `conversas`, faz UPDATE antes do envio, e nunca retorna `erro_envio`).

- [ ] **Step 3: Adicionar o require de `conversas`**

At the top of `src/modules/orcamentos/service.js`, next to the existing service requires (there is already `const whatsapp = require('../../services/whatsapp');`), add:

```javascript
const conversas = require('../../services/conversas');
```

- [ ] **Step 4: Reescrever `enviarArteItem`**

Replace the current body (`src/modules/orcamentos/service.js:854-876`) with:

```javascript
async function enviarArteItem(itemId, arquivo_url) {
  const r = await db.query(
    `SELECT oi.id, oi.produto, oi.descricao, oi.orcamento_id,
            c.celular AS cliente_celular, c.nome AS cliente_nome,
            (SELECT numero_os FROM orders WHERE orcamento_id = oi.orcamento_id ORDER BY created_at LIMIT 1) AS pedido_numero
     FROM orcamento_itens oi
     LEFT JOIN orcamentos o ON o.id = oi.orcamento_id
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE oi.id = $1`, [itemId]
  );
  const item = r.rows[0];
  if (!item) return { erro: ['Item não encontrado'] };

  const nomeItem = item.produto || item.descricao || 'item';
  const refPed = item.pedido_numero || '';

  // Sem celular: não há como enviar; registra status enviada (comportamento anterior).
  if (!item.cliente_celular) {
    await db.query(
      `UPDATE orcamento_itens SET arte_status='enviada', arte_arquivo_url=$1, arte_enviada_em=NOW() WHERE id=$2`,
      [arquivo_url, itemId]
    );
    return { ok: true, item_id: itemId, status: 'enviada' };
  }

  const publicUrl = `${process.env.BASE_URL || 'https://app.graficalkl.com.br'}${arquivo_url}`;
  const caption = `Olá! Segue a arte do *Pedido #${refPed}* (${nomeItem}) para sua aprovação.\n\nResponda *APROVADO* para confirmar ou envie os ajustes desejados.`;
  const fallbackTexto = `Olá! Segue a arte do seu *Pedido #${refPed}* (${nomeItem}): ${publicUrl}\n\nResponda *APROVADO* para confirmar ou envie os ajustes desejados.`;

  const envio = await conversas.enviarClienteImagem(item.cliente_celular, publicUrl, caption, {
    mediaRef: arquivo_url,
    legenda: `Arte Pedido #${refPed}`,
    fallbackTexto,
  });

  if (envio.ok) {
    await db.query(
      `UPDATE orcamento_itens SET arte_status='enviada', arte_arquivo_url=$1, arte_enviada_em=NOW() WHERE id=$2`,
      [arquivo_url, itemId]
    );
    return { ok: true, item_id: itemId, status: 'enviada' };
  }

  await db.query(
    `UPDATE orcamento_itens SET arte_status='erro_envio', arte_arquivo_url=$1, arte_enviada_em=NULL WHERE id=$2`,
    [arquivo_url, itemId]
  );
  console.warn('[ARTE] Falha total ao enviar arte do item', itemId);
  return { erro: ['Falha ao enviar arte ao cliente'], item_id: itemId, status: 'erro_envio' };
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx jest tests/modules/arte-envio.test.js --runInBand`
Expected: PASS (4 testes).

- [ ] **Step 6: Rodar a suíte tocada para garantir que nada quebrou**

Run: `npx jest tests/conversas.test.js tests/modules/arte-envio.test.js --runInBand`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/orcamentos/service.js tests/modules/arte-envio.test.js
git commit -m "fix(arte): envio robusto (retry+fallback), rastreio no histórico e status honesto (erro_envio)"
```

---

## Task 4: Valor do orçamento vai para o histórico

**Files:**
- Modify: `src/modules/orcamentos/service.js:327` (dentro de `_dispararNotificacoesEnvio`)

- [ ] **Step 1: Trocar o envio direto pelo wrapper rastreável**

In `_dispararNotificacoesEnvio`, replace the line:

```javascript
    await whatsapp.sendMessage(orc.cliente_celular, msg);
```

with:

```javascript
    await conversas.enviarClienteTexto(orc.cliente_celular, msg, { nome: orc.cliente_nome });
```

(O `require` de `conversas` já foi adicionado na Task 3. As linhas seguintes — INSERT em `orcamento_confirmacao_wa` — ficam inalteradas.)

- [ ] **Step 2: Garantir que a suíte de orçamentos existente não quebrou**

Run: `npx jest --runInBand 2>&1 | tail -25`
Expected: todos os testes que rodam sem DB passam; nenhum novo erro relacionado a `orcamentos/service`. (Testes que dependem de Postgres podem falhar por falta de banco local — isso é esperado neste ambiente e não é regressão desta mudança.)

- [ ] **Step 3: Commit**

```bash
git add src/modules/orcamentos/service.js
git commit -m "feat(orcamentos): valor do orçamento enviado ao cliente entra no histórico da conversa"
```

---

## Task 5: Deploy no VPS + smoke + memória

**Files:** nenhum código novo — deploy e verificação.

- [ ] **Step 1: Backup do arquivo tocado no VPS**

Run:
```bash
ssh root@2.25.147.243 "cp /var/www/lkl-chatbot/src/modules/orcamentos/service.js /tmp/service.js.bak-$(date +%s)"
```
Expected: sem saída (sucesso).

- [ ] **Step 2: Confirmar deploy com o usuário**

Pergunte ao usuário (AskUserQuestion) se pode fazer o deploy em produção agora. Só prosseguir com "sim".

- [ ] **Step 3: Rsync dos arquivos**

Run:
```bash
rsync -az /Users/klebercamara/LKL/src/services/conversas.js root@2.25.147.243:/var/www/lkl-chatbot/src/services/conversas.js
rsync -az /Users/klebercamara/LKL/src/modules/orcamentos/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/service.js
```
Expected: transferência sem erro.

- [ ] **Step 4: Restart do serviço**

Run:
```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env && sleep 2 && pm2 logs lkl-chatbot --lines 15 --nostream"
```
Expected: processo `online`, sem stack trace de require.

- [ ] **Step 5: Smoke — reenviar valor de um orçamento e conferir histórico**

Escolher um orçamento de teste com `cliente_celular` que já tem conversa no chatbot. Reenviar (pelo painel ou endpoint de envio) e conferir no VPS:
```bash
ssh root@2.25.147.243 "psql -U postgres -d lkl_chatbot -c \"SELECT direction, sent_by, left(content,60) FROM messages WHERE conversation_id = (SELECT id FROM conversations ORDER BY started_at DESC LIMIT 1) ORDER BY created_at DESC LIMIT 5;\""
```
Expected: aparece uma linha `outbound | system | Olá, ...Pedido #...valor...`.

- [ ] **Step 6: Smoke — enviar uma arte e conferir**

Enviar uma arte de item pelo painel `arte_final.html`. Conferir:
```bash
ssh root@2.25.147.243 "psql -U postgres -d lkl_chatbot -c \"SELECT arte_status FROM orcamento_itens WHERE arte_arquivo_url IS NOT NULL ORDER BY arte_enviada_em DESC NULLS LAST LIMIT 3;\""
ssh root@2.25.147.243 "psql -U postgres -d lkl_chatbot -c \"SELECT left(content,80) FROM messages WHERE content LIKE '[imagem recebido:%' ORDER BY created_at DESC LIMIT 3;\""
```
Expected: `arte_status='enviada'` (ou `erro_envio` se a Meta realmente recusar, mas sem sumir silenciosamente); uma mensagem `[imagem recebido: /uploads/artes/...]` no histórico. Conferir no painel que a arte aparece como miniatura e que o cliente recebeu no WhatsApp.

- [ ] **Step 7: Atualizar a memória**

Append ao `project_sprint_status.md` uma entrada RASTREIO-ARTE resumindo: rastreio de mensagens outbound ao cliente (valor do orçamento + arte) no histórico da conversa via `src/services/conversas.js`; arte com retry+fallback texto-com-link e status honesto (`erro_envio`); sem migration.

- [ ] **Step 8: Commit da memória**

```bash
git add /Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md
git commit -m "docs(memory): registra sub-projeto rastreio + arte robusta"
```

---

## Self-Review

**Spec coverage:**
- Parte 1 (módulo `conversas.js` + `registrarMensagemCliente`) → Task 1. ✅
- Wrappers `enviarClienteTexto`/`enviarClienteImagem` + formato de mídia relativo → Task 2. ✅
- Parte 2 (arte robusta: await, log do corpo da Meta, retry, fallback, status honesto) → Tasks 2 (retry/fallback/log) + 3 (status honesto). ✅
- Parte 3 (valor do orçamento no histórico) → Task 4. ✅
- Miniatura só com caminho relativo → Task 2 (`mediaRef`) + Task 3 (`mediaRef: arquivo_url`). ✅
- Testes Jest puros + smoke VPS → Tasks 1–3 (Jest) + Task 5 (smoke). ✅
- Sem migration → confirmado, nenhuma task cria migration. ✅
- Desvio: `handler.js` não é refatorado (documentado no topo). ✅

**Placeholder scan:** nenhum TBD/TODO; todo passo com código tem o código completo. ✅

**Type consistency:** `registrarMensagemCliente(celular, conteudo, opts)`, `enviarClienteTexto(celular, texto, opts)`, `enviarClienteImagem(celular, urlEnvio, caption, opts)`, `enviarImagemComRetry(celular, urlEnvio, caption, delayMs)` — assinaturas idênticas entre Task 2 (definição), testes e uso em Task 3/4. `opts` usa `mediaRef`, `legenda`, `fallbackTexto`, `nome`, `sentBy`, `delayMs`, `whatsappMessageId` consistentemente. Retorno de `enviarClienteImagem` `{ ok, via }` usado igual em Task 3. ✅
