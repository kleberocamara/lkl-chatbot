# Gate de Arte por item do orçamento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mover a aprovação de arte para o nível do item do orçamento (antes da OS); offset só gera OS com arte aprovada; CV deixa de auto-gerar na aprovação do orçamento e gera quando a arte do item é aprovada.

**Architecture:** Migration adiciona colunas de arte em `orcamento_itens`. `orcamentos/service.js` ganha `enviarArteItem`/`responderArteItem`/`listarArtesPendentes`. O inbound do WhatsApp (`webhook/handler.js`) passa a chamar `responderArteItem`. `os/service.js` gateia `itensOffsetDisponiveis`/`criarOSOffset`/`criarOSComunicacaoVisual` por `arte_status='aprovada'`, e o auto-CV sai da aprovação do orçamento. Painel ganha página "Artes" (fila de upload/aprovação por item).

**Tech Stack:** Node/Express, PostgreSQL, multer (upload), vanilla-JS, Jest.

**Decisões (2026-06-25):** arte por item; "Gerar OS" offset manual (gate arte aprovada); CV auto-gera na aprovação da arte.

**Fatos verificados:**
- Migrations em `sql/migrations/` (última `040_insights.sql` → próxima `041`). Aplicadas manualmente via psql no VPS; `orcamento_itens` é owned por `postgres` → ALTER via `sudo -u postgres psql -d lkl_chatbot`.
- Inbound arte: `src/webhook/handler.js:87` chama `processarRespostaArte(phone, messageText)` e usa `{resposta, aprovado, os_id}`.
- Auto-CV: `orcamentos/service.js:239` e `:459` chamam `osService.criarOSComunicacaoVisual(id)` na aprovação do orçamento.
- `os/service.js`: `criarOSComunicacaoVisual(orcamentoId)` (SELECT itens CV NOT EXISTS os_itens, ~linha 324); `itensOffsetDisponiveis` (SELECT ~342, filtro `orc.status='aprovado' AND oi.tipo_producao='OFFSET' AND NOT EXISTS os_itens`); `criarOSOffset` valida itens (~361). `enviarArte`/`processarRespostaArte` (OS-level) ~10–88. `APROVACAO_KEYWORDS` no topo do arquivo.
- Upload multer: `os/router.js` (`destination .../public/uploads/artes`, `/uploads/artes/<file>`).
- Cliente: `clientes_lkl.celular`; matching de telefone em `processarRespostaArte` usa `c.celular LIKE $1/$2` com `%celular.slice(-9)` e `%celular`.
- `orcamentos/service.js buscarPorId` já traz `pedido_numero` (Sub-projeto anterior).
- Deploy backend: rsync + `pm2 restart lkl-chatbot --update-env`. Migration: `scp` + `ssh ... "sudo -u postgres psql -d lkl_chatbot -f /tmp/041....sql"`. Smoke: `ssh ... node -r dotenv/config -e`.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:**
- Create: `sql/migrations/041_arte_por_item.sql`.
- Modify: `src/modules/orcamentos/service.js` (arte por item + remover auto-CV).
- Modify: `src/modules/os/service.js` (gate arte em itensOffsetDisponiveis/criarOSOffset/criarOSComunicacaoVisual).
- Modify: `src/modules/orcamentos/router.js` (upload de arte + listar pendentes).
- Modify: `src/webhook/handler.js` (reapontar inbound).
- Modify: `public/dashboard.html` (página "Artes").

---

### Task 1: Migration 041 — colunas de arte em orcamento_itens

**Files:**
- Create: `sql/migrations/041_arte_por_item.sql`

- [ ] **Step 1: Escrever a migration**

Criar `sql/migrations/041_arte_por_item.sql`:
```sql
-- 041: arte por item do orçamento (gate antes da OS)
ALTER TABLE orcamento_itens
  ADD COLUMN IF NOT EXISTS arte_status      TEXT NOT NULL DEFAULT 'pendente',
  ADD COLUMN IF NOT EXISTS arte_arquivo_url TEXT,
  ADD COLUMN IF NOT EXISTS arte_enviada_em  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arte_aprovada_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arte_comentario  TEXT;

CREATE INDEX IF NOT EXISTS idx_orcamento_itens_arte_status ON orcamento_itens(arte_status);
```

- [ ] **Step 2: Aplicar no VPS**

```bash
scp sql/migrations/041_arte_por_item.sql root@2.25.147.243:/tmp/041_arte_por_item.sql
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -f /tmp/041_arte_por_item.sql"
```
Expected: `ALTER TABLE` + `CREATE INDEX` sem erro.

- [ ] **Step 3: Conferir colunas**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"SELECT column_name FROM information_schema.columns WHERE table_name='orcamento_itens' AND column_name LIKE 'arte%' ORDER BY column_name;\""
```
Expected: arte_aprovada_em, arte_arquivo_url, arte_comentario, arte_enviada_em, arte_status.

- [ ] **Step 4: Commit**

```bash
git add sql/migrations/041_arte_por_item.sql
git commit -m "feat(db): migration 041 — colunas de arte por item do orçamento

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Serviço de arte por item (orcamentos/service.js)

**Files:**
- Modify: `src/modules/orcamentos/service.js`

- [ ] **Step 1: Adicionar `enviarArteItem`, `responderArteItem`, `listarArtesPendentes`**

Perto das outras funções do serviço (antes do `module.exports`), adicionar. (Confirmar no topo do arquivo: `whatsapp` e `fcm` já são `require`d — reutilizar; se não, requerer `const whatsapp = require('../../services/whatsapp');` e `const fcm = require('../../services/fcm');` seguindo o padrão de `os/service.js`.)
```js
const APROVACAO_ARTE = ['aprovado', 'aprovada', 'aprovo', 'ok', 'pode', 'sim', 'confirmo', 'autorizo'];

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
  await db.query(
    `UPDATE orcamento_itens SET arte_status='enviada', arte_arquivo_url=$1, arte_enviada_em=NOW() WHERE id=$2`,
    [arquivo_url, itemId]
  );
  if (item.cliente_celular) {
    const publicUrl = `${process.env.BASE_URL}${arquivo_url}`;
    const msg = `Olá! Segue a arte do *Pedido #${item.pedido_numero || ''}* (${item.produto || item.descricao || 'item'}) para sua aprovação.\n\nResponda *APROVADO* para confirmar ou envie os ajustes desejados.`;
    whatsapp.sendImage(item.cliente_celular, publicUrl, msg).catch(e => console.warn('[ARTE-WA]', e.message));
  }
  return { ok: true, item_id: itemId, status: 'enviada' };
}

async function responderArteItem(phone, mensagem) {
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
  const item = pend.rows[0];
  if (!item) return null;
  const texto = String(mensagem || '').trim().toLowerCase();
  const aprovado = APROVACAO_ARTE.some(kw => texto.includes(kw));
  const refPed = item.pedido_numero || '';
  if (aprovado) {
    await db.query(`UPDATE orcamento_itens SET arte_status='aprovada', arte_aprovada_em=NOW() WHERE id=$1`, [item.id]);
    // CV: gera OS (gateada por arte aprovada) quando a arte é aprovada
    if (item.tipo_producao === 'COMUNICAÇÃO VISUAL') {
      osService.criarOSComunicacaoVisual(item.orcamento_id).catch(e => console.warn('[OS-CV-ARTE]', e.message));
    }
    return { aprovado: true, item_id: item.id, resposta: `Arte aprovada! ✅ Seu *Pedido #${refPed}* seguirá para produção. Obrigado! 🖨️` };
  }
  await db.query(`UPDATE orcamento_itens SET arte_status='reprovada', arte_comentario=$1 WHERE id=$2`, [String(mensagem || '').trim(), item.id]);
  if (item.vendedor_id) {
    fcm.sendToUser(item.vendedor_id, { title: `Arte com ajustes — Pedido #${refPed}`, body: `${item.produto || 'Item'}: cliente pediu alterações`, data: { orcamento_id: item.orcamento_id } }).catch(() => {});
  }
  return { aprovado: false, item_id: item.id, resposta: `Anotado! ✏️ Vamos ajustar a arte e te enviar uma nova versão em breve.` };
}

async function listarArtesPendentes() {
  const r = await db.query(
    `SELECT oi.id, oi.produto, oi.descricao, oi.tipo_producao, oi.arte_status, oi.arte_arquivo_url, oi.arte_comentario,
            o.id AS orcamento_id, o.numero AS numero_orcamento,
            c.nome AS cliente_nome,
            (SELECT numero_os FROM orders WHERE orcamento_id = o.id ORDER BY created_at LIMIT 1) AS pedido_numero
     FROM orcamento_itens oi
     JOIN orcamentos o ON o.id = oi.orcamento_id
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE o.status='aprovado' AND oi.arte_status <> 'aprovada'
     ORDER BY o.numero DESC, oi.codigo`
  );
  return r.rows;
}
```
(Se `osService` ainda não estiver importado neste arquivo, adicionar `const osService = require('../os/service');` no topo — confirmar para não duplicar.)

- [ ] **Step 2: Remover o auto-CV da aprovação do orçamento**

Localizar as DUAS chamadas (linhas ~239 e ~459):
```js
    osService.criarOSComunicacaoVisual(id).catch(e => console.warn('[OS-CV]', e.message));
```
Remover ambas (a geração de OS CV passa a ocorrer em `responderArteItem`). Conferir que não sobrou referência órfã.

- [ ] **Step 3: Exportar as novas funções**

No `module.exports` do arquivo, acrescentar `enviarArteItem, responderArteItem, listarArtesPendentes`.

- [ ] **Step 4: Sintaxe**

Run: `node --check src/modules/orcamentos/service.js`
Expected: sem saída. (Se acusar `osService`/`whatsapp`/`fcm` indefinidos em runtime, garantir os requires no topo.)

- [ ] **Step 5: Commit**

```bash
git add src/modules/orcamentos/service.js
git commit -m "feat(arte): enviarArteItem/responderArteItem/listarArtesPendentes + remover auto-CV da aprovação

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Gate de OS por arte aprovada (os/service.js)

**Files:**
- Modify: `src/modules/os/service.js`

- [ ] **Step 1: Gatear `criarOSComunicacaoVisual`**

No SELECT de itens CV (dentro de `criarOSComunicacaoVisual`, ~linha 324), trocar:
```js
       AND oi.tipo_producao = 'COMUNICAÇÃO VISUAL'
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)`,
```
Por:
```js
       AND oi.tipo_producao = 'COMUNICAÇÃO VISUAL'
       AND oi.arte_status = 'aprovada'
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)`,
```

- [ ] **Step 2: Gatear `itensOffsetDisponiveis`**

No SELECT (~linha 349), trocar:
```js
     WHERE orc.status = 'aprovado'
       AND oi.tipo_producao = 'OFFSET'
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)
```
Por:
```js
     WHERE orc.status = 'aprovado'
       AND oi.tipo_producao = 'OFFSET'
       AND oi.arte_status = 'aprovada'
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)
```

- [ ] **Step 3: Gatear a validação em `criarOSOffset`**

No SELECT de validação (~linha 363), trocar:
```js
     WHERE oi.id = ANY($1) AND orc.status='aprovado' AND oi.tipo_producao='OFFSET'
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)`,
```
Por:
```js
     WHERE oi.id = ANY($1) AND orc.status='aprovado' AND oi.tipo_producao='OFFSET' AND oi.arte_status='aprovada'
       AND NOT EXISTS (SELECT 1 FROM os_itens oit WHERE oit.orcamento_item_id = oi.id)`,
```

- [ ] **Step 4: Sintaxe + commit**

```bash
node --check src/modules/os/service.js
git add src/modules/os/service.js
git commit -m "feat(os): gerar OS (offset/CV) apenas com arte do item aprovada

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected: `node --check` sem saída.

---

### Task 4: Endpoints — upload de arte + listar pendentes (orcamentos/router.js)

**Files:**
- Modify: `src/modules/orcamentos/router.js`

- [ ] **Step 1: Configurar multer (reaproveitar pasta de artes)**

No topo de `src/modules/orcamentos/router.js`, se ainda não houver multer, adicionar (espelhando `os/router.js`):
```js
const multer = require('multer');
const path = require('path');
const _arteStorage = multer.diskStorage({
  destination: path.join(__dirname, '../../../public/uploads/artes'),
  filename: (req, file, cb) => cb(null, `arte_orc_${Date.now()}_${Math.round(Math.random()*1e6)}${path.extname(file.originalname)}`),
});
const _uploadArte = multer({ storage: _arteStorage, limits: { fileSize: 15 * 1024 * 1024 } });
```

- [ ] **Step 2: Rota GET pendentes**

Adicionar:
```js
router.get('/artes/pendentes', requireRole('admin','gestor','atendente','analista'), async (req, res) => {
  try { res.json({ data: await service.listarArtesPendentes() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
```

- [ ] **Step 3: Rota POST upload de arte do item**

Adicionar:
```js
router.post('/:id/itens/:itemId/arte', requireRole('admin','gestor','atendente','analista'), _uploadArte.single('arte'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo de arte é obrigatório (campo "arte")' });
    const arquivo_url = `/uploads/artes/${req.file.filename}`;
    const result = await service.enviarArteItem(req.params.itemId, arquivo_url);
    if (result?.erro) return res.status(404).json({ errors: result.erro });
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```
(Conferir que `requireRole` e `service` já estão importados no arquivo — estão, pelos handlers existentes.)

- [ ] **Step 4: Sintaxe + commit**

```bash
node --check src/modules/orcamentos/router.js
git add src/modules/orcamentos/router.js
git commit -m "feat(arte): endpoints upload de arte por item + listar pendentes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected: `node --check` sem saída. Garantir que a rota `/artes/pendentes` é registrada ANTES de qualquer `/:id` que pudesse capturá-la (no Express, rotas mais específicas/estáticas primeiro; `/artes/pendentes` não conflita com `/:id/itens/...`, mas se houver um `GET /:id`, declarar `/artes/pendentes` antes dele).

---

### Task 5: Reapontar o inbound do WhatsApp (webhook/handler.js)

**Files:**
- Modify: `src/webhook/handler.js`

- [ ] **Step 1: Trocar o import**

Localizar:
```js
const { processarRespostaArte } = require('../modules/os/service');
```
Trocar por:
```js
const { responderArteItem } = require('../modules/orcamentos/service');
```

- [ ] **Step 2: Trocar a interceptação**

Localizar (~linha 86-95):
```js
  // Intercepta resposta de aprovação de arte (antes de qualquer outro fluxo)
  const respostaArte = await processarRespostaArte(phone, messageText);
  if (respostaArte) {
    await sendMessage(phone, respostaArte.resposta);
    await saveMessage(conversation.id, contact.id, respostaArte.resposta, 'outbound', null, 'system');
    if (global.io) global.io.emit('arte_' + (respostaArte.aprovado ? 'aprovada' : 'reprovada'), { os_id: respostaArte.os_id });
    return;
  }
```
Trocar por:
```js
  // Intercepta resposta de aprovação de arte do item do orçamento (antes de qualquer outro fluxo)
  const respostaArte = await responderArteItem(phone, messageText);
  if (respostaArte) {
    await sendMessage(phone, respostaArte.resposta);
    await saveMessage(conversation.id, contact.id, respostaArte.resposta, 'outbound', null, 'system');
    if (global.io) global.io.emit('arte_' + (respostaArte.aprovado ? 'aprovada' : 'reprovada'), { item_id: respostaArte.item_id });
    return;
  }
```

- [ ] **Step 3: Sintaxe + commit**

```bash
node --check src/webhook/handler.js
git add src/webhook/handler.js
git commit -m "feat(arte): inbound do WhatsApp responde arte por item do orçamento

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected: `node --check` sem saída.

---

### Task 6: Painel — página "Artes" (dashboard.html)

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Adicionar a página + loader**

Seguir o padrão das páginas existentes (um `<div class="page" id="page-artes">` com host) e registrar no `loaders` e no `NAV` (seção Produção/Fiscal mais próxima — usar a mesma seção onde a equipe acompanha pedidos). Inserir a página:
```html
<div class="page" id="page-artes">
  <div class="page-header"><h1>🎨 Artes</h1><span style="font-size:13px;color:#888">Envie a arte de cada item e acompanhe a aprovação do cliente</span></div>
  <div id="artes-list" style="margin-top:12px">Carregando...</div>
</div>
```
No `const loaders = { ... }`, acrescentar `artes: loadArtes,`. No `NAV`, acrescentar um item `{ id:'artes', label:'Artes', icon:'🎨', roles:['admin','gestor','atendente','analista'] }` na seção apropriada.

- [ ] **Step 2: Implementar `loadArtes` + render + upload**

Adicionar as funções:
```js
async function loadArtes() {
  const box = document.getElementById('artes-list');
  if (!box) return;
  const r = await api('/api/v2/orcamentos/artes/pendentes');
  const itens = r?.data || [];
  if (!itens.length) { box.innerHTML = '<p style="color:#999;padding:24px;text-align:center">Nenhuma arte pendente. 🎉</p>'; return; }
  const badge = (s) => {
    const m = { pendente:['#9ca3af','Pendente'], enviada:['#f59e0b','Enviada — aguardando cliente'], reprovada:['#ef4444','Ajustes pedidos'] }[s] || ['#64748b', s];
    return `<span style="background:${m[0]};color:#fff;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">${m[1]}</span>`;
  };
  box.innerHTML = itens.map(it => `
    <div class="card" style="padding:12px 16px;margin-bottom:8px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:160px">
        <div style="font-weight:600">Pedido #${it.pedido_numero||'—'} · ${escHtml(it.produto||it.descricao||'item')}</div>
        <div style="font-size:12px;color:#888">${escHtml(it.cliente_nome||'—')} · Orç #${it.numero_orcamento} ${it.arte_comentario ? '· 💬 '+escHtml(it.arte_comentario) : ''}</div>
      </div>
      ${badge(it.arte_status)}
      <label class="btn btn-primary" style="font-size:12px;padding:6px 12px;cursor:pointer;margin:0">
        ${it.arte_status==='enviada' ? '↻ Reenviar arte' : '⬆ Enviar arte'}
        <input type="file" accept="image/*" style="display:none" onchange="enviarArteItem('${it.orcamento_id}','${it.id}', this)">
      </label>
    </div>`).join('');
}

async function enviarArteItem(orcId, itemId, input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('arte', file);
  const res = await fetch(`/api/v2/orcamentos/${orcId}/itens/${itemId}/arte`, { method:'POST', credentials:'include', body: fd });
  const j = await res.json().catch(()=>({}));
  if (res.ok && !j.error) { showToast('🎨 Arte enviada ao cliente'); loadArtes(); }
  else { showToast('❌ ' + (j.error || (j.errors||[]).join(', ') || 'Falha ao enviar arte')); }
}
```
(Usa `fetch` direto por ser multipart — o helper `api()` envia JSON. Mantém `credentials:'include'`.)

- [ ] **Step 3: Sanidade + commit**

```bash
cd /Users/klebercamara/LKL
grep -c "function loadArtes\|async function enviarArteItem\|id=\"page-artes\"\|artes: loadArtes" public/dashboard.html
git add public/dashboard.html
git commit -m "feat(ui): página Artes — upload por item + acompanhamento de aprovação

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected: grep ≥ 4.

---

### Task 7: Deploy + smoke E2E + memória

**Files:**
- Deploy: `src/modules/orcamentos/service.js`, `src/modules/os/service.js`, `src/modules/orcamentos/router.js`, `src/webhook/handler.js`, `public/dashboard.html`
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Deploy**

```bash
cd /Users/klebercamara/LKL
for f in src/modules/orcamentos/service.js src/modules/os/service.js src/modules/orcamentos/router.js src/webhook/handler.js public/dashboard.html; do
  rsync -az "$f" "root@2.25.147.243:/var/www/lkl-chatbot/$f"
done
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && sleep 2 && pm2 jlist | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const a=JSON.parse(d);const p=a.find(x=>x.name===\"lkl-chatbot\");console.log(\"status:\",p?.pm2_env?.status)})'"
```
Expected: `status: online`.

- [ ] **Step 2: Smoke do fluxo de arte**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e '
const db = require(\"./src/db/index\");
const orc = require(\"./src/modules/orcamentos/service\");
const os  = require(\"./src/modules/os/service\");
(async () => {
  // pega um item OFFSET de orçamento aprovado
  const it = (await db.query(\"SELECT oi.id, oi.tipo_producao FROM orcamento_itens oi JOIN orcamentos o ON o.id=oi.orcamento_id WHERE o.status=\$1 AND oi.tipo_producao=\$2 LIMIT 1\", [\"aprovado\",\"OFFSET\"])).rows[0];
  if (!it) { console.log(\"sem item offset aprovado p/ testar\"); process.exit(0); }
  await db.query(\"UPDATE orcamento_itens SET arte_status=DEFAULT, arte_arquivo_url=NULL, arte_aprovada_em=NULL WHERE id=\$1\", [it.id]);
  const antes = await os.itensOffsetDisponiveis();
  const inAntes = antes.some(x=>x.id===it.id);
  await db.query(\"UPDATE orcamento_itens SET arte_status=\$1, arte_aprovada_em=NOW() WHERE id=\$2\", [\"aprovada\", it.id]);
  const depois = await os.itensOffsetDisponiveis();
  const inDepois = depois.some(x=>x.id===it.id);
  console.log(\"item\", it.id, \"em itensOffsetDisponiveis antes(arte pendente)=\", inAntes, \"depois(arte aprovada)=\", inDepois);
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
'"
```
Expected: `antes=false depois=true` (o gate só libera com arte aprovada). Restaura/limpa conforme necessário.

- [ ] **Step 3: Conferência visual + reapontamento**

No painel: abrir **Artes** → ver itens de orçamentos aprovados com status; enviar uma arte (upload) → status vira "Enviada". Conferir nos logs do VPS que o WhatsApp tentou enviar. (Resposta real do cliente — teste manual pelo WhatsApp: responder APROVADO e ver o item virar aprovada + offset aparecer em "Gerar OS"; CV gera OS.) Reportar.

- [ ] **Step 4: Atualizar memória**

Em `project_sprint_status.md`, registrar:
"Gate de Arte por item (Sub-projeto 1 do processo de produção) — CONCLUÍDO 2026-06-25. Migration 041: orcamento_itens ganha arte_status(pendente/enviada/aprovada/reprovada)/arte_arquivo_url/arte_enviada_em/arte_aprovada_em/arte_comentario. orcamentos/service.js: enviarArteItem (upload+WA imagem ref Pedido #N), responderArteItem (inbound casa item por celular; aprovado→aprovada + se CV dispara criarOSComunicacaoVisual; reprovado→reprovada+coment+FCM vendedor), listarArtesPendentes; removido auto-CV das linhas 239/459. os/service.js: itensOffsetDisponiveis/criarOSOffset/criarOSComunicacaoVisual gateados por arte_status='aprovada'. orcamentos/router.js: POST /:id/itens/:itemId/arte (multer) + GET /artes/pendentes. webhook/handler.js: inbound usa responderArteItem. dashboard.html: página Artes (upload por item + status). Smoke: gate libera offset só com arte aprovada. PRÓXIMO: Sub-projeto 2 — board de produção 4 fases (CORTE/IMPRESSÃO/ACABAMENTO/ENTREGA por tipo) + histórico + aposentar status de arte da OS."

- [ ] **Step 5: Sem commit de memória** (fora do git).

---

## Notas de verificação final

- A geração de OS CV agora ocorre em `responderArteItem` (não na aprovação do orçamento). Como `criarOSComunicacaoVisual` é idempotente (NOT EXISTS os_itens) e gateada por arte aprovada, aprovar artes CV em momentos diferentes pode gerar OSs CV separadas — comportamento aceitável (cada item ficou pronto em momento distinto).
- `responderArteItem` intercepta ANTES dos outros fluxos do inbound; mantém o comportamento de "retorna null se não houver item enviada" para não engolir mensagens normais.
- Manter `enviarArte`/`processarRespostaArte` (OS-level) no `os/service.js` por ora (não referenciados pelo inbound) — limpeza no Sub-projeto 2.
- Migration é idempotente (`IF NOT EXISTS`). ALTER em `orcamento_itens` exige `sudo -u postgres`.
- Reverter: `git revert` dos commits; a coluna pode permanecer (inócua) ou ser dropada manualmente.
