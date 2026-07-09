# Anexo de imagens e documentos na resposta do analista

## Contexto

O analista responde conversas do WhatsApp pelo painel (`public/dashboard.html`, caixa de texto em `.chat-input`, função `sendReply()` → `POST /api/conversations/:id/reply`). Hoje só dá pra mandar texto. O cliente pediu que o analista consiga anexar imagens e documentos nas respostas.

Já existe um fluxo muito parecido no sistema: `enviarClienteImagem()` (`src/services/conversas.js`) envia uma imagem pro cliente e grava a mensagem usando a convenção `[imagem recebido: {url} | {legenda}]` — o frontend já sabe renderizar isso (regex em `dashboard.html:3971`), inclusive pra mensagens **outbound** (o "recebido" no texto é só o nome da convenção, não indica direção). Isso significa que dá pra implementar o recurso sem tocar no renderizador de mensagens.

`sendImage()` já existe em `src/services/whatsapp.js` (envia por link público, não pelo método de upload em duas etapas da API do WhatsApp). `sendDocument()` não existe — precisa ser criado, no mesmo formato.

Arquivos que precisam ser alcançáveis pelo WhatsApp (Meta busca a URL sem autenticação) ficam sob `public/uploads/...` servido por `express.static`, nunca sob `/api/file/...` (que exige cookie de sessão — inacessível pra Meta).

## Escopo

- Novo endpoint `POST /api/conversations/:id/reply-media`: recebe `multipart/form-data` com campo `arquivo` (obrigatório) e `legenda` (texto opcional).
- Aceita imagens (`image/*`) e documentos (PDF, Word `.doc`/`.docx`).
- Um arquivo por envio (não múltiplo).
- Novo botão de anexo (clipe 📎) ao lado da caixa de resposta existente no painel.
- **Fora de escopo**: múltiplos arquivos por envio, áudio/vídeo enviado pelo analista, upload por URL/link externo, mudança no fluxo `enviarClienteImagem()`/orçamentos (que já funciona e não precisa mudar).

## Design técnico

### 1. `src/services/whatsapp.js` — nova função `sendDocument`

Espelha `sendImage()` (linha 93-107), trocando o tipo:

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

Exportada junto com as demais em `module.exports`.

### 2. `src/dashboard/api.js` — multer + rota `reply-media`

Novo multer, mesmo padrão de `uploadArtes` (`src/modules/os/router.js:23-36`), mas com `fileFilter` aceitando imagem OU PDF/Word e destino `public/uploads/respostas/`:

```js
const multer = require('multer');
const path = require('path');
const { sendMessage, sendImage, sendDocument, getMediaUrl } = require('../services/whatsapp');

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

Rota, logo após `POST /conversations/:id/reply` já existente:

```js
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

`public/uploads/respostas/` precisa existir no VPS antes do deploy (criar via `mkdir -p` no passo de deploy, igual às outras pastas de upload).

### 3. `public/dashboard.html` — botão de anexo

Ao lado do textarea/botão "Enviar" (linha 4004-4007), adiciona um label-botão com input de arquivo escondido (mesmo padrão de `enviarArteItemUI`, linha 2341-2356):

```html
<div class="chat-input">
  <textarea id="replyText" rows="2" placeholder="Digite sua resposta como analista..." onkeydown="if(event.ctrlKey&&event.key==='Enter')sendReply('${c.id}','${c.phone}')"></textarea>
  <label class="btn btn-outline" style="cursor:pointer" title="Anexar imagem ou documento">
    📎<input type="file" accept="image/*,.pdf,.doc,.docx" style="display:none" onchange="enviarAnexo(this,'${c.id}')">
  </label>
  <button class="btn btn-primary" onclick="sendReply('${c.id}','${c.phone}')">Enviar</button>
</div>
```

Nova função `enviarAnexo(input, convId)`:

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

## Testes

- `sendDocument()`: teste unitário mockando `axios.post`, confirmando payload `type:'document'` e `document.link`/`document.filename`/`document.caption` corretos (mesmo padrão de qualquer teste existente de `whatsapp.js`, se houver — senão, verificação por leitura + smoke manual, já que o resto do arquivo não tem suíte).
- Rota `reply-media`: sem teste automatizado (mesmo padrão das outras rotas de upload deste projeto, que não têm testes — `enviar-arte`, `entregar` — verificação por leitura + smoke manual pós-deploy, testando envio real de uma imagem e de um PDF).
- Frontend: sem teste automatizado (mesmo padrão do resto da UI) — parse check (`new Function`) + smoke manual.

## Fora de escopo

- Múltiplos arquivos por envio.
- Áudio/vídeo enviado pelo analista.
- Upload por link externo.
- Mudanças em `enviarClienteImagem()`/orçamentos (fluxo de envio de arte ao cliente, já funciona, não precisa mudar).
