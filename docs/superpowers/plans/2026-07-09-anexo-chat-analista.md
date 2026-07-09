# Anexo de Imagens e Documentos no Chat do Analista Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o analista anexe uma imagem ou documento (PDF/Word) ao responder uma conversa de WhatsApp pelo painel, com legenda opcional, reaproveitando a convenção de mídia já existente no sistema.

**Architecture:** Novo endpoint multipart `POST /api/conversations/:id/reply-media` (multer, mesmo padrão de upload já usado no projeto) envia o arquivo pro WhatsApp via `sendImage()` (já existe) ou a nova `sendDocument()`, grava a mensagem no formato `[tipo recebido: url | legenda]` já entendido pelo renderizador do painel, e reaproveita a lógica de bookkeeping (limpar alerta, log, socket) já usada na resposta de texto. Frontend ganha um botão de anexo ao lado da caixa de resposta existente.

**Tech Stack:** Node.js/Express, `multer`, PostgreSQL, Jest, vanilla JS em `public/dashboard.html`.

---

### Task 1: Backend — `sendDocument()` + endpoint `reply-media`

**Files:**
- Modify: `src/services/whatsapp.js` (adicionar `sendDocument`)
- Modify: `src/dashboard/api.js` (multer + rota `reply-media`)
- Test: `tests/whatsapp-send-document.test.js` (novo)

- [ ] **Step 1: Escrever o teste de `sendDocument` que falha primeiro**

Crie `tests/whatsapp-send-document.test.js`:

```js
jest.mock('axios');
const axios = require('axios');
const { sendDocument } = require('../src/services/whatsapp');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok';
  axios.post.mockResolvedValue({});
});

test('monta o payload type=document com link, filename e caption', async () => {
  await sendDocument('5521999', 'https://x/arquivo.pdf', 'Proposta.pdf', 'Segue a proposta');

  const [url, payload, config] = axios.post.mock.calls[0];
  expect(url).toMatch(/123\/messages/);
  expect(payload.messaging_product).toBe('whatsapp');
  expect(payload.to).toBe('5521999');
  expect(payload.type).toBe('document');
  expect(payload.document).toEqual({ link: 'https://x/arquivo.pdf', filename: 'Proposta.pdf', caption: 'Segue a proposta' });
  expect(config.headers.Authorization).toBe('Bearer tok');
});

test('sem caption → envia string vazia; sem filename → omite o campo', async () => {
  await sendDocument('5521999', 'https://x/arquivo.pdf');

  const payload = axios.post.mock.calls[0][1];
  expect(payload.document.caption).toBe('');
  expect(payload.document.filename).toBeUndefined();
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx jest tests/whatsapp-send-document.test.js --verbose`
Expected: FAIL — `sendDocument` não existe em `src/services/whatsapp.js` ainda (`TypeError: sendDocument is not a function` ou `undefined`).

- [ ] **Step 3: Implementar `sendDocument` em `src/services/whatsapp.js`**

Adicione logo após a função `sendImage` (por volta da linha 107, antes de `sendInteractiveButtons`):

```js
async function sendDocument(to, documentUrl, filename, caption) {
  const url = `${BASE_URL}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  await axios.post(url, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'document',
    document: { link: documentUrl, filename: filename || undefined, caption: caption || '' },
  }, {
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}
```

Atualize o `module.exports` no fim do arquivo para incluir `sendDocument`:

```js
module.exports = { sendMessage, sendImage, sendDocument, sendInteractiveButtons, sendTemplate, markAsRead, getMediaUrl, downloadMedia };
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx jest tests/whatsapp-send-document.test.js --verbose`
Expected: PASS (2 testes).

- [ ] **Step 5: Adicionar multer + rota `reply-media` em `src/dashboard/api.js`**

No topo do arquivo, ajuste os requires (linha 1-8 hoje) adicionando `multer`, `path` e as novas funções de `whatsapp`:

```js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const db = require('../db');
const { requireAuthApi, requireAdmin } = require('../middleware/auth');
const { sendMessage, sendImage, sendDocument, getMediaUrl } = require('../services/whatsapp');
const { log } = require('../services/logger');

const uploadResposta = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../../public/uploads/respostas'),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const permitido = file.mimetype.startsWith('image/')
      || file.mimetype === 'application/pdf'
      || file.mimetype === 'application/msword'
      || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (permitido) cb(null, true);
    else cb(new Error('Tipo de arquivo não suportado (use imagem, PDF ou Word)'));
  },
});
```

Logo após a rota `POST /conversations/:id/reply` já existente (procure por `router.post('/conversations/:id/reply'` — hoje termina com `res.json({ ok: true }); });`), adicione:

```js
// Analista responde ao cliente com anexo (imagem ou documento)
router.post('/conversations/:id/reply-media', requireAuthApi, uploadResposta.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  const conv = await db.query(
    `SELECT c.*, ct.phone FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
    [req.params.id]
  );
  if (!conv.rows[0]) return res.status(404).json({ error: 'Conversa não encontrada' });

  const { phone, id: convId, contact_id } = conv.rows[0];
  const legenda = (req.body.legenda || '').trim();
  const publicUrl = `${process.env.BASE_URL}/uploads/respostas/${req.file.filename}`;
  const isImagem = req.file.mimetype.startsWith('image/');
  const tipo = isImagem ? 'imagem' : 'documento';

  if (isImagem) {
    await sendImage(phone, publicUrl, legenda);
  } else {
    await sendDocument(phone, publicUrl, req.file.originalname, legenda);
  }

  const content = `[${tipo} recebido: ${publicUrl} | ${legenda || req.file.originalname}]`;
  await db.query(
    `INSERT INTO messages (conversation_id, contact_id, content, direction, sent_by, sent_by_name) VALUES ($1, $2, $3, 'outbound', 'human', $4)`,
    [convId, contact_id, content, req.user.name]
  );
  await db.query('UPDATE conversations SET alerta_humano_em = NULL WHERE id = $1 AND alerta_humano_em IS NOT NULL', [convId]);
  await log('human_reply', `${req.user.name} enviou um ${tipo} em ${convId}`, {
    conversationId: convId, userId: req.user.id,
    metadata: { tipo, filename: req.file.originalname },
  });

  if (global.io) global.io.emit('human_reply', { conversationId: convId, message: content, sent_by_name: req.user.name });
  res.json({ ok: true });
});
```

- [ ] **Step 6: Checar sintaxe**

Run: `node --check src/dashboard/api.js && node --check src/services/whatsapp.js`
Expected: sem saída (sintaxe válida).

- [ ] **Step 7: Rodar a suíte pra checar regressão**

Run: `npx jest tests/whatsapp-send-document.test.js tests/whatsapp-interactive.test.js --verbose`
Expected: PASS (nenhuma quebra no arquivo `whatsapp.js` compartilhado).

- [ ] **Step 8: Commit**

```bash
git add src/services/whatsapp.js src/dashboard/api.js tests/whatsapp-send-document.test.js
git commit -m "feat(chat): endpoint reply-media - analista envia imagem/documento anexado"
```

---

### Task 2: Frontend — botão de anexo na caixa de resposta

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Adicionar o botão de anexo no HTML da caixa de resposta**

Localize o bloco `.chat-input` (por volta da linha 4004-4007):

```html
    <div class="chat-input">
      <textarea id="replyText" rows="2" placeholder="Digite sua resposta como analista..." onkeydown="if(event.ctrlKey&&event.key==='Enter')sendReply('${c.id}','${c.phone}')"></textarea>
      <button class="btn btn-primary" onclick="sendReply('${c.id}','${c.phone}')">Enviar</button>
    </div>` : '<div style="padding:12px;text-align:center;color:var(--muted);font-size:13px">Conversa resolvida</div>'}
```

Substitua por:

```html
    <div class="chat-input">
      <textarea id="replyText" rows="2" placeholder="Digite sua resposta como analista..." onkeydown="if(event.ctrlKey&&event.key==='Enter')sendReply('${c.id}','${c.phone}')"></textarea>
      <label class="btn btn-outline" style="cursor:pointer;display:flex;align-items:center;justify-content:center" title="Anexar imagem ou documento">
        📎<input type="file" accept="image/*,.pdf,.doc,.docx" style="display:none" onchange="enviarAnexo(this,'${c.id}')">
      </label>
      <button class="btn btn-primary" onclick="sendReply('${c.id}','${c.phone}')">Enviar</button>
    </div>` : '<div style="padding:12px;text-align:center;color:var(--muted);font-size:13px">Conversa resolvida</div>'}
```

- [ ] **Step 2: Adicionar a função `enviarAnexo`**

Logo após a função `sendReply` (por volta da linha 4014-4024, que termina com `await loadMessages(convId); }`), adicione:

```js
async function enviarAnexo(input, convId) {
  const file = input.files[0];
  if (!file) return;
  const ta = document.getElementById('replyText');
  const legenda = ta.value.trim();
  const fd = new FormData();
  fd.append('arquivo', file);
  if (legenda) fd.append('legenda', legenda);
  input.value = '';
  ta.value = '';
  const r = await fetch(`/api/conversations/${convId}/reply-media`, { method: 'POST', credentials: 'include', body: fd });
  if (!r.ok) { showToast('❌ Erro ao enviar anexo'); return; }
  await loadMessages(convId);
}
```

- [ ] **Step 3: Checar sintaxe**

Run: `node -e "new Function(require('fs').readFileSync('public/dashboard.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"`
Expected: sem erro. Se houver múltiplas tags `<script>`, confirme com `grep -n '<script'` qual contém `sendReply`/`enviarAnexo` e valide essa.

- [ ] **Step 4: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(chat): botao de anexo (imagem/documento) na caixa de resposta do analista"
```

---

### Task 3: Deploy no VPS

**Files:** nenhum (só deploy)

- [ ] **Step 1: Rodar a suíte local**

Run: `npx jest tests/whatsapp-send-document.test.js tests/whatsapp-interactive.test.js --verbose`
Expected: PASS.

Run: `npx jest 2>&1 | tail -10`
Expected: mesma baseline de falhas pré-existentes (suítes de integração dependentes de Postgres real).

- [ ] **Step 2: Pedir confirmação do usuário antes de deployar**

Esse deploy toca produção — confirmar com o usuário (AskUserQuestion) antes do rsync/pm2 restart.

- [ ] **Step 3: Criar a pasta de uploads no VPS**

```bash
ssh root@2.25.147.243 "mkdir -p /var/www/lkl-chatbot/public/uploads/respostas"
```

- [ ] **Step 4: Deploy**

```bash
rsync -R -av src/services/whatsapp.js src/dashboard/api.js public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```

- [ ] **Step 5: Smoke test em produção**

```bash
ssh root@2.25.147.243 "pm2 logs lkl-chatbot --lines 30 --nostream"
```
Expected: processo online, sem erro no restart.

Depois, testar manualmente no painel (`https://app.graficalkl.com.br/dashboard` → aba de conversas): abrir uma conversa ativa, anexar uma imagem com legenda, confirmar que chega no WhatsApp de teste e que a mensagem aparece corretamente na tela do painel (miniatura clicável). Repetir com um PDF (deve aparecer como chip de download, não miniatura).

---

## Fora de escopo (reafirmado do spec)

- Múltiplos arquivos por envio.
- Áudio/vídeo enviado pelo analista.
- Upload por link externo.
- Mudanças em `enviarClienteImagem()`/fluxo de envio de arte (já funciona, não precisa mudar).
