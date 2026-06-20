# Mercado Pago — Link de Pagamento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar Mercado Pago como gateway alternativo de pagamento via link de checkout, permitindo que o admin gere um link que o cliente abre e paga por PIX, cartão ou boleto dentro da plataforma MP.

**Architecture:** Novo serviço `src/services/mercadopago.js` encapsula a API MP REST. A função `cobrar()` existente ganha branch `link_mp`. Um webhook handler em `src/webhook/mercadopago.js` recebe notificações de pagamento e reutiliza `confirmarPagamento()`. Admin PWA recebe botão + bloco de exibição do link.

**Tech Stack:** Node.js 20 + axios, Mercado Pago REST API v1, PostgreSQL 15, HTML/JS vanilla (PWA).

---

## File Structure

**Criar:**
- `src/services/mercadopago.js` — `criarPreference()` e `consultarPagamento()`
- `src/webhook/mercadopago.js` — handler IPN
- `sql/migrations/011_mercadopago.sql` — 2 colunas + constraint atualizada

**Modificar:**
- `src/modules/orcamentos/service.js` — branch `link_mp` em `cobrar()` + função `cancelarLinkMp()`; branch `link_mp` em `confirmarPagamento()`
- `src/modules/orcamentos/router.js` — `POST /:id/link_mp/cancelar`; validar `link_mp` em `/cobrar`
- `src/webhook/routes.js` — rota `POST /mercadopago`
- `public/pwa/admin.html` — botão "💳 Link MP", bloco de exibição, função JS `cancelarLinkMp()`

---

## Task 1: Migration — colunas MP + constraint

**Files:**
- Create: `sql/migrations/011_mercadopago.sql`

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- sql/migrations/011_mercadopago.sql
BEGIN;

ALTER TABLE orcamentos
  ADD COLUMN IF NOT EXISTS mp_preference_id TEXT,
  ADD COLUMN IF NOT EXISTS mp_checkout_url  TEXT;

-- Recria o CHECK para aceitar 'link_mp'
ALTER TABLE orcamentos DROP CONSTRAINT IF EXISTS orcamentos_tipo_cobranca_check;
ALTER TABLE orcamentos ADD CONSTRAINT orcamentos_tipo_cobranca_check
  CHECK (tipo_cobranca IN ('boleto','pix','link_mp'));

CREATE INDEX IF NOT EXISTS idx_orcamentos_mp_preference ON orcamentos(mp_preference_id);

COMMIT;
```

- [ ] **Step 2: Copiar e aplicar no VPS**

```bash
scp sql/migrations/011_mercadopago.sql root@2.25.147.243:/var/www/lkl-chatbot/sql/migrations/
ssh root@2.25.147.243 'DB=$(grep DATABASE_URL /var/www/lkl-chatbot/.env | cut -d= -f2-) && sudo -u postgres psql "$DB" -f /var/www/lkl-chatbot/sql/migrations/011_mercadopago.sql'
```

Expected:
```
ALTER TABLE
ALTER TABLE
ALTER TABLE
CREATE INDEX
```

- [ ] **Step 3: Commit**

```bash
git add sql/migrations/011_mercadopago.sql
git commit -m "feat: migration — mp_preference_id, mp_checkout_url, constraint link_mp"
```

---

## Task 2: src/services/mercadopago.js

**Files:**
- Create: `src/services/mercadopago.js`

- [ ] **Step 1: Criar o serviço**

```javascript
// src/services/mercadopago.js
const axios = require('axios');

const MP_BASE = 'https://api.mercadopago.com';

function mpHeaders() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) throw new Error('MP_ACCESS_TOKEN não configurado');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Idempotency-Key': `${Date.now()}-${Math.random()}`,
  };
}

/**
 * Cria uma Preference (link de checkout) no Mercado Pago.
 * @param {Object} p
 * @param {string} p.titulo
 * @param {number} p.valor
 * @param {string|number} p.orcamentoNumero  — external_reference para rastrear no webhook
 * @param {string} p.clienteNome
 * @param {string} [p.clienteEmail]
 * @returns {{ preferenceId: string, checkoutUrl: string }}
 */
async function criarPreference({ titulo, valor, orcamentoNumero, clienteNome, clienteEmail }) {
  const appUrl = process.env.APP_URL || 'https://chatbot.klebercamaraconsultoria.cloud';
  const body = {
    items: [{
      title: titulo,
      quantity: 1,
      unit_price: parseFloat(valor.toFixed(2)),
      currency_id: 'BRL',
    }],
    payer: {
      name: (clienteNome || 'Cliente').slice(0, 256),
      email: clienteEmail || 'cliente@lklgrafica.com.br',
    },
    external_reference: String(orcamentoNumero),
    notification_url: `${appUrl}/webhook/mercadopago`,
    statement_descriptor: 'FACTOR GRAFICA',
  };

  try {
    const res = await axios.post(`${MP_BASE}/checkout/preferences`, body, {
      headers: mpHeaders(),
      timeout: 15000,
    });
    const d = res.data;
    // init_point = produção, sandbox_init_point = teste
    const checkoutUrl = d.sandbox_init_point || d.init_point;
    return { preferenceId: d.id, checkoutUrl };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`Mercado Pago: ${msg}`);
  }
}

/**
 * Consulta um pagamento pelo ID.
 * @returns {{ status: string, externalReference: string, valor: number }}
 */
async function consultarPagamento(paymentId) {
  try {
    const res = await axios.get(`${MP_BASE}/v1/payments/${paymentId}`, {
      headers: mpHeaders(),
      timeout: 10000,
    });
    const d = res.data;
    return {
      status: d.status,
      externalReference: d.external_reference,
      valor: d.transaction_amount,
    };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`Mercado Pago: ${msg}`);
  }
}

module.exports = { criarPreference, consultarPagamento };
```

- [ ] **Step 2: Commit**

```bash
git add src/services/mercadopago.js
git commit -m "feat: serviço Mercado Pago — criarPreference, consultarPagamento"
```

---

## Task 3: Webhook handler Mercado Pago

**Files:**
- Create: `src/webhook/mercadopago.js`
- Modify: `src/webhook/routes.js`

- [ ] **Step 1: Criar `src/webhook/mercadopago.js`**

```javascript
// src/webhook/mercadopago.js
const crypto = require('crypto');
const { consultarPagamento } = require('../services/mercadopago');
const db = require('../db');
const { pool } = require('../db');

/**
 * MP envia duas formas de notificação (ambas tratadas aqui):
 * 1. Query params: GET/POST ?type=payment&data.id=<id>
 * 2. Body JSON: { action: "payment.updated", data: { id: "<id>" } }
 */
async function handleMercadoPagoWebhook(req, res) {
  // Responde 200 imediatamente para o MP não fazer retry
  res.sendStatus(200);

  try {
    // Validação de assinatura (opcional — só se MP_WEBHOOK_SECRET estiver configurado)
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (secret) {
      const xSignature = req.headers['x-signature'] || '';
      const xRequestId = req.headers['x-request-id'] || '';
      const dataId = req.query['data.id'] || req.body?.data?.id || '';
      const signedTemplate = `id:${dataId};request-id:${xRequestId};ts:${_extractTs(xSignature)};`;
      const expected = crypto.createHmac('sha256', secret).update(signedTemplate).digest('hex');
      const received = _extractV1(xSignature);
      if (received && received !== expected) {
        console.warn('[MP-WEBHOOK] Assinatura inválida — ignorando');
        return;
      }
    }

    // Extrai o payment ID (query param ou body)
    const paymentId = req.query['data.id'] || req.body?.data?.id;
    const type = req.query['type'] || req.body?.action?.split('.')?.[0];

    if (!paymentId || type !== 'payment') return;

    const pagamento = await consultarPagamento(paymentId);
    if (pagamento.status !== 'approved') return;

    // external_reference = número do orçamento
    const numeroOrc = pagamento.externalReference;
    if (!numeroOrc) return;

    const r = await db.query(
      `SELECT id FROM orcamentos WHERE numero = $1 AND tipo_cobranca = 'link_mp'
       AND status_pagamento = 'aguardando_pagamento'`,
      [parseInt(numeroOrc)]
    );
    if (!r.rows[0]) return;

    const orcId = r.rows[0].id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE orcamentos SET status_pagamento='pago', pago_em=COALESCE(pago_em, NOW()),
         updated_at=NOW() WHERE id=$1 AND status_pagamento != 'pago'`,
        [orcId]
      );
      await client.query(
        `UPDATE ordens_servico SET pago=true, updated_at=NOW() WHERE orcamento_id=$1`,
        [orcId]
      );
      await client.query('COMMIT');
      console.log(`[MP-WEBHOOK] Orçamento ${numeroOrc} marcado como pago (payment ${paymentId})`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[MP-WEBHOOK] Erro:', err.message);
  }
}

function _extractTs(xSignature) {
  const m = xSignature.match(/ts=([^,]+)/);
  return m ? m[1] : '';
}

function _extractV1(xSignature) {
  const m = xSignature.match(/v1=([^,]+)/);
  return m ? m[1] : '';
}

module.exports = { handleMercadoPagoWebhook };
```

- [ ] **Step 2: Adicionar rota em `src/webhook/routes.js`**

Adicionar após a linha `router.post('/c6bank', ...)`:

```javascript
const { handleMercadoPagoWebhook } = require('./mercadopago');
// ...
router.post('/mercadopago', express.json(), handleMercadoPagoWebhook);
```

O arquivo final de `src/webhook/routes.js` ficará assim (substitua o conteúdo completo):

```javascript
const express = require('express');
const router = express.Router();
const { handleInboundMessage } = require('./handler');
const { markAsRead } = require('../services/whatsapp');
const { handleC6Webhook } = require('./c6bank');
const { handleMercadoPagoWebhook } = require('./mercadopago');

// Verificação do webhook (Meta exige isso na configuração)
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado com sucesso pela Meta');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Recebimento de mensagens
router.post('/', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const messages = change.value?.messages || [];
        const contacts = change.value?.contacts || [];

        for (const msg of messages) {
          if (msg.type !== 'text') continue;

          const phone = msg.from;
          const profileName = contacts.find(c => c.wa_id === phone)?.profile?.name || '';
          const text = msg.text?.body || '';

          await markAsRead(msg.id);
          await handleInboundMessage(phone, profileName, text, msg.id);
        }
      }
    }
  } catch (err) {
    console.error('Erro no processamento do webhook:', err);
  }
});

router.post('/c6bank', express.json(), handleC6Webhook);
router.post('/mercadopago', express.json(), handleMercadoPagoWebhook);

module.exports = router;
```

- [ ] **Step 3: Commit**

```bash
git add src/webhook/mercadopago.js src/webhook/routes.js
git commit -m "feat: webhook Mercado Pago — confirmação de pagamento via IPN"
```

---

## Task 4: service.js — cobrar() branch link_mp + cancelarLinkMp()

**Files:**
- Modify: `src/modules/orcamentos/service.js`

- [ ] **Step 1: Adicionar require do mercadopago no topo do arquivo**

Localizar as primeiras linhas do arquivo onde estão os requires:
```javascript
const db = require('../../db');
const { pool } = require('../../db');
const c6bank = require('../../services/c6bank');
```

Adicionar após a linha do c6bank:
```javascript
const mercadopago = require('../../services/mercadopago');
```

- [ ] **Step 2: Atualizar validação de tipo em cobrar()**

Localizar:
```javascript
if (!['boleto', 'pix'].includes(tipo)) {
  return { erro: ['tipo deve ser boleto ou pix'] };
}
```

Substituir por:
```javascript
if (!['boleto', 'pix', 'link_mp'].includes(tipo)) {
  return { erro: ['tipo deve ser boleto, pix ou link_mp'] };
}
```

- [ ] **Step 3: Adicionar branch link_mp no bloco try dentro de cobrar()**

Localizar o final do bloco `else` (que trata PIX), antes do `} catch (e)`:

```javascript
      return { tipo: 'pix', txid: pix.txid, pixCopiaECola: pix.pixCopiaECola, valor };
    }
  } catch (e) {
    console.error('[C6-COBRAR]', e.message);
```

Substituir por:
```javascript
      return { tipo: 'pix', txid: pix.txid, pixCopiaECola: pix.pixCopiaECola, valor };
    } else {
      // link_mp — Mercado Pago checkout
      const pref = await mercadopago.criarPreference({
        titulo: `Orçamento #${orc.numero} — LKL Gráfica`,
        valor,
        orcamentoNumero: orc.numero,
        clienteNome: nomeSacado,
        clienteEmail: orc.cliente_email,
      });
      await db.query(
        `UPDATE orcamentos SET tipo_cobranca='link_mp', status_pagamento='aguardando_pagamento',
         mp_preference_id=$1, mp_checkout_url=$2, updated_at=NOW() WHERE id=$3`,
        [pref.preferenceId, pref.checkoutUrl, id]
      );
      return { tipo: 'link_mp', preferenceId: pref.preferenceId, checkoutUrl: pref.checkoutUrl, valor };
    }
  } catch (e) {
    console.error('[COBRAR]', e.message);
```

- [ ] **Step 4: Adicionar função cancelarLinkMp antes de cancelarBoleto**

Localizar a linha:
```javascript
async function cancelarBoleto(orcamentoId, boletoRowId) {
```

Adicionar antes dela:
```javascript
async function cancelarLinkMp(orcamentoId) {
  const r = await db.query(
    `SELECT id, mp_preference_id, status_pagamento FROM orcamentos WHERE id=$1`, [orcamentoId]
  );
  const orc = r.rows[0];
  if (!orc) return { erro: ['Orçamento não encontrado'] };
  if (!orc.mp_preference_id) return { erro: ['Nenhum link MP registrado neste orçamento'] };
  if (orc.status_pagamento === 'pago') return { erro: ['Pagamento já confirmado, não é possível cancelar'] };
  if (orc.status_pagamento === 'cancelado') return { erro: ['Link MP já foi cancelado'] };

  // Preferências MP expiram automaticamente — apenas limpar localmente
  await db.query(
    `UPDATE orcamentos SET status_pagamento='cancelado',
     mp_preference_id=NULL, mp_checkout_url=NULL, updated_at=NOW() WHERE id=$1`,
    [orcamentoId]
  );
  return { cancelado: true };
}

```

- [ ] **Step 5: Atualizar module.exports**

Localizar:
```javascript
module.exports = { listar, buscarPorId, criar, precificar, mudarStatus, aprovar, cobrar, confirmarPagamento, cancelarBoleto, cancelarBoletoDireto, cancelarPix };
```

Substituir por:
```javascript
module.exports = { listar, buscarPorId, criar, precificar, mudarStatus, aprovar, cobrar, confirmarPagamento, cancelarBoleto, cancelarBoletoDireto, cancelarPix, cancelarLinkMp };
```

- [ ] **Step 6: Commit**

```bash
git add src/modules/orcamentos/service.js
git commit -m "feat: cobrar() aceita link_mp + cancelarLinkMp() via Mercado Pago"
```

---

## Task 5: router.js — rota POST /:id/link_mp/cancelar

**Files:**
- Modify: `src/modules/orcamentos/router.js`

- [ ] **Step 1: Adicionar cancelarLinkMp ao destructure do service**

Localizar no topo do router:
```javascript
const service = require('./service');
```

(O service é importado como objeto — as funções são acessadas via `service.cancelarLinkMp(...)` — nenhuma alteração necessária no import.)

- [ ] **Step 2: Adicionar rota após `POST /:id/pix/cancelar`**

Localizar:
```javascript
// GET /:id/pdf — generate PDF quote
```

Adicionar antes dessa linha:
```javascript
// POST /:id/link_mp/cancelar — cancela link MP (admin)
router.post('/:id/link_mp/cancelar', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.cancelarLinkMp(req.params.id);
    if (result.erro) return res.status(400).json({ erro: result.erro });
    res.json(result);
  } catch (err) {
    console.error('[CANCELAR-LINK-MP]', err);
    res.status(500).json({ error: 'Erro interno ao cancelar link MP' });
  }
});

```

- [ ] **Step 3: Commit**

```bash
git add src/modules/orcamentos/router.js
git commit -m "feat: rota POST /:id/link_mp/cancelar"
```

---

## Task 6: admin.html — botão + bloco + JS

**Files:**
- Modify: `public/pwa/admin.html`

- [ ] **Step 1: Adicionar botão "💳 Link MP" junto aos botões Boleto e PIX**

Localizar o bloco de botões de cobrança (linha ~234):
```javascript
${o.status === 'aprovado' && o.status_pagamento !== 'pago' ? `
  <button onclick="gerarCobranca('${o.id}', 'boleto')" style="font-size:11px;padding:4px 10px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-top:4px">🧾 Boleto</button>
  <button onclick="gerarCobranca('${o.id}', 'pix')" style="font-size:11px;padding:4px 10px;background:#00695c;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-top:4px">⚡ PIX</button>
```

Substituir por:
```javascript
${o.status === 'aprovado' && o.status_pagamento !== 'pago' ? `
  <button onclick="gerarCobranca('${o.id}', 'boleto')" style="font-size:11px;padding:4px 10px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-top:4px">🧾 Boleto</button>
  <button onclick="gerarCobranca('${o.id}', 'pix')" style="font-size:11px;padding:4px 10px;background:#00695c;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-top:4px">⚡ PIX</button>
  <button onclick="gerarCobranca('${o.id}', 'link_mp')" style="font-size:11px;padding:4px 10px;background:#009ee3;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-top:4px">💳 Link MP</button>
```

- [ ] **Step 2: Adicionar bloco de exibição do link MP**

Localizar o final da cadeia de blocos de cobrança (onde termina o bloco PIX):
```javascript
      ` : o.tipo_cobranca === 'pix' && o.pix_copia_cola ? `
        <div style="margin-top:8px;padding:8px;background:#e8f5e9;border-radius:6px;border-left:3px solid #00695c">
          ...
        </div>
      ` : ''}
```

Substituir o `` ` : ''} `` final por:
```javascript
      ` : o.tipo_cobranca === 'link_mp' && o.mp_checkout_url ? `
        <div style="margin-top:8px;padding:8px;background:#e3f2fd;border-radius:6px;border-left:3px solid #009ee3">
          <div style="font-size:10px;color:#0277bd;font-weight:bold;margin-bottom:4px">💳 LINK MP GERADO</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button onclick="navigator.clipboard.writeText('${o.mp_checkout_url}').then(()=>showToast('Link copiado!'))"
                    style="font-size:11px;padding:3px 8px;background:#009ee3;color:#fff;border:none;border-radius:4px;cursor:pointer">📋 Copiar Link</button>
            <a href="${o.mp_checkout_url}" target="_blank"
               style="font-size:11px;padding:3px 8px;background:#0277bd;color:#fff;border-radius:4px;text-decoration:none">🔗 Abrir</a>
            <button onclick="cancelarLinkMp('${o.id}')"
                    style="font-size:11px;padding:3px 8px;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer">🗑 Cancelar</button>
          </div>
        </div>
      ` : ''}
```

- [ ] **Step 3: Atualizar gerarCobranca() para tratar link_mp**

Localizar em `gerarCobranca()`:
```javascript
async function gerarCobranca(orcId, tipo) {
  const label = tipo === 'boleto' ? 'Boleto' : 'PIX';
```

Substituir por:
```javascript
async function gerarCobranca(orcId, tipo) {
  const label = tipo === 'boleto' ? 'Boleto' : tipo === 'pix' ? 'PIX' : 'Link MP';
```

E localizar o bloco `else` do PIX (que tem o `confirm`):
```javascript
  } else {
    if (!confirm(`Gerar ${label} para este orçamento e enviar ao cliente via WhatsApp?`)) return;
  }
```

Manter como está — o `confirm` serve para `pix` e `link_mp` igualmente.

Localizar o toast de sucesso:
```javascript
    const n = res.parcelas > 1 ? ` (${res.parcelas}x)` : '';
    showToast(`✅ ${label}${n} gerado e enviado ao cliente via WhatsApp!`);
```

Substituir por:
```javascript
    const n = res.parcelas > 1 ? ` (${res.parcelas}x)` : '';
    const extra = tipo === 'link_mp' ? ' Copie o link e envie ao cliente.' : ' enviado ao cliente via WhatsApp!';
    showToast(`✅ ${label}${n} gerado.${extra}`);
```

- [ ] **Step 4: Adicionar função JS cancelarLinkMp() após cancelarPix()**

Localizar:
```javascript
// ---------- ORDENS DE SERVIÇO ----------
```

Adicionar antes dessa linha:
```javascript
async function cancelarLinkMp(orcId) {
  if (!confirm('Confirma o cancelamento deste link de pagamento MP? Esta ação não pode ser desfeita.')) return;
  const res = await api('POST', `/api/v2/orcamentos/${orcId}/link_mp/cancelar`);
  if (res && res.cancelado) {
    showToast('✅ Link MP cancelado.');
    loadOrcamentos();
  } else {
    const msg = res?.erro || [res?.error || 'Erro desconhecido'];
    showToast(`❌ ${Array.isArray(msg) ? msg[0] : msg}`);
  }
}

```

- [ ] **Step 5: Commit**

```bash
git add public/pwa/admin.html
git commit -m "feat: admin PWA — botão Link MP, bloco de exibição, cancelarLinkMp"
```

---

## Task 7: Variáveis de ambiente + Deploy VPS

**Files:**
- `.env` no VPS (editar via ssh)
- Todos os arquivos novos/modificados das tasks 1-6

- [ ] **Step 1: Adicionar variáveis no .env do VPS**

```bash
ssh root@2.25.147.243
cat >> /var/www/lkl-chatbot/.env << 'EOF'
MP_ACCESS_TOKEN=APP_USR-6895784811357982-061909-aea682f21510e75ae1f95dd14365757d-3485467060
MP_PUBLIC_KEY=APP_USR-ef704b3c-4f1c-4c20-b146-dce7eb268690
MP_WEBHOOK_SECRET=
APP_URL=https://chatbot.klebercamaraconsultoria.cloud
EOF
```

> ⚠️ `MP_WEBHOOK_SECRET` deixar vazio por agora — configurar depois no painel MP após primeiro teste.
> ⚠️ `APP_URL` pode já existir — verificar com `grep APP_URL /var/www/lkl-chatbot/.env` antes de adicionar.

- [ ] **Step 2: Sincronizar arquivos para o VPS**

```bash
rsync -av \
  src/services/mercadopago.js \
  root@2.25.147.243:/var/www/lkl-chatbot/src/services/

rsync -av \
  src/webhook/mercadopago.js \
  src/webhook/routes.js \
  root@2.25.147.243:/var/www/lkl-chatbot/src/webhook/

rsync -av \
  src/modules/orcamentos/service.js \
  src/modules/orcamentos/router.js \
  root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/

rsync -av \
  public/pwa/admin.html \
  root@2.25.147.243:/var/www/lkl-chatbot/public/pwa/
```

- [ ] **Step 3: Reiniciar Node.js**

```bash
ssh root@2.25.147.243 'pm2 restart lkl-chatbot && sleep 3 && pm2 status lkl-chatbot'
```

Expected: status `online`.

- [ ] **Step 4: Teste de geração de link via curl**

```bash
ssh root@2.25.147.243 '
TOKEN=$(curl -s -X POST http://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@lklgrafica.com.br\",\"password\":\"Admin@2024\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)[\"token\"])" 2>/dev/null)

# Substituir ORC_ID pelo ID de um orçamento aprovado com status_pagamento != pago
ORC_ID=5

curl -s -X POST http://localhost/api/v2/orcamentos/$ORC_ID/cobrar \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"tipo\":\"link_mp\"}" | python3 -m json.tool
'
```

Expected:
```json
{
  "tipo": "link_mp",
  "preferenceId": "...",
  "checkoutUrl": "https://sandbox.mercadopago.com.br/checkout/...",
  "valor": 123.45
}
```

- [ ] **Step 5: Testar cancelamento do link**

```bash
ssh root@2.25.147.243 '
TOKEN=$(curl -s -X POST http://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"admin@lklgrafica.com.br\",\"password\":\"Admin@2024\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)[\"token\"])" 2>/dev/null)

ORC_ID=5

curl -s -X POST http://localhost/api/v2/orcamentos/$ORC_ID/link_mp/cancelar \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
'
```

Expected: `{"cancelado": true}`

- [ ] **Step 6: Simular webhook do MP (teste local)**

```bash
ssh root@2.25.147.243 '
# Primeiro gerar um novo link para o orçamento (refazer step 4)
# Depois simular o webhook:
curl -s -X POST http://localhost/webhook/mercadopago \
  -H "Content-Type: application/json" \
  -d "{\"action\":\"payment.updated\",\"data\":{\"id\":\"TEST_PAYMENT_ID\"}}"
echo "Status: $?"
'
```

> O webhook vai tentar consultar `TEST_PAYMENT_ID` na API MP e falhar (esperado). O importante é que retorne 200 e o log mostre `[MP-WEBHOOK] Erro: Mercado Pago: ...` sem crash do servidor.

- [ ] **Step 7: Commit final**

```bash
git add -A
git commit -m "feat: deploy Mercado Pago link de pagamento — Sprint 3-B"
```
