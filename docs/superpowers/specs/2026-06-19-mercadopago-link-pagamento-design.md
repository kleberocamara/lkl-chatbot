# Mercado Pago — Link de Pagamento (Sprint 3-B)

## Goal
Integrar o Mercado Pago como gateway alternativo de pagamento via link de checkout, permitindo que clientes paguem por PIX, cartão de crédito ou boleto dentro da plataforma MP — sem alterar o fluxo C6 Bank existente.

## Architecture
Novo serviço `src/services/mercadopago.js` encapsula a API MP. A função `cobrar()` existente em `src/modules/orcamentos/service.js` ganha uma nova branch para `tipo = 'link_mp'`. Um webhook handler recebe notificações de pagamento do MP e reutiliza a função `confirmarPagamento()` já existente. O admin escolhe o gateway no momento de cobrar.

## Tech Stack
- Mercado Pago REST API v1 (`https://api.mercadopago.com`)
- Bearer token (sem mTLS — mais simples que C6 Bank)
- Node.js axios para chamadas HTTP
- PostgreSQL: 2 novas colunas em `orcamentos`

---

## File Structure

**Criar:**
- `src/services/mercadopago.js` — wrapper da API MP
- `src/webhook/mercadopago.js` — handler de IPN
- `sql/migrations/011_mercadopago.sql` — colunas + constraint

**Modificar:**
- `src/modules/orcamentos/service.js` — branch `link_mp` em `cobrar()` + `cancelarLinkMp()`
- `src/modules/orcamentos/router.js` — botão cobrar aceita `link_mp`, rota `POST /:id/link_mp/cancelar`
- `src/webhook/routes.js` — rota `POST /webhook/mercadopago`
- `public/pwa/admin.html` — botão "💳 Link MP" + exibição do link gerado

---

## Componentes

### src/services/mercadopago.js

```javascript
const MP_BASE = 'https://api.mercadopago.com';
const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

async function criarPreference({ titulo, valor, orcamentoNumero, clienteNome, clienteEmail }) {
  // POST /checkout/preferences
  // body: { items, payer, back_urls, notification_url, external_reference }
  // Retorna: { preferenceId, checkoutUrl }
}

async function consultarPagamento(paymentId) {
  // GET /v1/payments/:paymentId
  // Retorna: { status, external_reference, transaction_amount }
}

module.exports = { criarPreference, consultarPagamento };
```

**Campos da Preference:**
- `items[0]`: `{ title: titulo, quantity: 1, unit_price: valor }`
- `payer`: `{ name: clienteNome, email: clienteEmail || 'cliente@lklgrafica.com.br' }`
- `external_reference`: número do orçamento (para rastrear no webhook)
- `notification_url`: `${process.env.APP_URL}/webhook/mercadopago`
- `back_urls`: não obrigatório para o caso de uso (admin envia link direto)
- `statement_descriptor`: `'FACTOR GRAFICA'`
- `auto_return`: não usar (cliente não volta para o site)

**Autenticação:** `Authorization: Bearer ${MP_ACCESS_TOKEN}` em todas as chamadas.

**Ambientes:** MP usa tokens diferentes por ambiente — o `APP_USR-...` de produção ou teste é determinado pelo próprio token (não há flag separada).

### sql/migrations/011_mercadopago.sql

```sql
BEGIN;

ALTER TABLE orcamentos
  ADD COLUMN IF NOT EXISTS mp_preference_id TEXT,
  ADD COLUMN IF NOT EXISTS mp_checkout_url  TEXT;

-- Expande o CHECK de tipo_cobranca para aceitar 'link_mp'
ALTER TABLE orcamentos DROP CONSTRAINT IF EXISTS orcamentos_tipo_cobranca_check;
ALTER TABLE orcamentos ADD CONSTRAINT orcamentos_tipo_cobranca_check
  CHECK (tipo_cobranca IN ('boleto','pix','link_mp'));

CREATE INDEX IF NOT EXISTS idx_orcamentos_mp_preference ON orcamentos(mp_preference_id);

COMMIT;
```

### service.js — cobrar() branch link_mp

```javascript
// Dentro de cobrar(id, tipo, ...)
if (tipo === 'link_mp') {
  const { criarPreference } = require('../../services/mercadopago');
  const pref = await criarPreference({
    titulo: `Orçamento #${orc.numero} — LKL Gráfica`,
    valor: orc.valor_final,
    orcamentoNumero: orc.numero,
    clienteNome: orc.cliente_nome,
    clienteEmail: orc.cliente_email,
  });
  await db.query(
    `UPDATE orcamentos SET tipo_cobranca='link_mp', status_pagamento='aguardando_pagamento',
     mp_preference_id=$1, mp_checkout_url=$2, updated_at=NOW() WHERE id=$3`,
    [pref.preferenceId, pref.checkoutUrl, id]
  );
  return { tipo: 'link_mp', preferenceId: pref.preferenceId, checkoutUrl: pref.checkoutUrl, valor };
}
```

### cancelarLinkMp(orcamentoId)

Preferências MP expiram automaticamente (não há endpoint de cancelamento). Basta limpar localmente:

```javascript
async function cancelarLinkMp(orcamentoId) {
  // Valida existência, status não-pago
  await db.query(
    `UPDATE orcamentos SET status_pagamento='cancelado',
     mp_preference_id=NULL, mp_checkout_url=NULL, updated_at=NOW() WHERE id=$1`,
    [orcamentoId]
  );
  return { cancelado: true };
}
```

### src/webhook/mercadopago.js

```javascript
// POST /webhook/mercadopago
// MP envia: { type: 'payment', data: { id: paymentId } }
async function handleMercadoPagoWebhook(req, res) {
  res.sendStatus(200); // Responder imediatamente (MP faz retry se não receber 2xx)
  
  if (req.body?.type !== 'payment') return;
  const paymentId = req.body?.data?.id;
  if (!paymentId) return;

  const pagamento = await consultarPagamento(paymentId);
  if (pagamento.status !== 'approved') return;

  const externalRef = pagamento.external_reference; // número do orçamento
  // Busca orçamento pelo numero e confirma pagamento
  const r = await db.query('SELECT id FROM orcamentos WHERE numero=$1', [externalRef]);
  if (!r.rows[0]) return;
  await confirmarPagamento({ tipo: 'link_mp', orcamentoId: r.rows[0].id });
}
```

**Segurança:** MP envia um header `x-signature` com HMAC-SHA256. Validar usando `MP_WEBHOOK_SECRET` (configurável no painel MP). Se não configurado, logar aviso mas não bloquear (para facilitar testes).

### confirmarPagamento() — extensão

Adicionar branch `link_mp` na função existente:

```javascript
if (tipo === 'link_mp' && orcamentoId) {
  r = await db.query('SELECT id FROM orcamentos WHERE id=$1', [orcamentoId]);
}
```

### router.js — novas rotas

```javascript
// POST /:id/link_mp/cancelar
router.post('/:id/link_mp/cancelar', requireRole('admin'), async (req, res) => { ... });
```

O endpoint `POST /:id/cobrar` já aceita qualquer `tipo` via body — apenas valida que é um dos valores permitidos. Basta adicionar `'link_mp'` à lista de tipos válidos.

### admin.html — UI

**Botão de cobrar** (na área de orçamento aprovado):
```html
<button onclick="gerarCobranca('${o.id}', 'link_mp')">💳 Link MP</button>
```

**Exibição quando link_mp gerado** (similar ao bloco PIX):
```html
${o.tipo_cobranca === 'link_mp' && o.mp_checkout_url ? `
  <div style="...fundo azul MP...">
    <div>💳 LINK MP GERADO</div>
    <div style="display:flex;gap:6px">
      <button onclick="navigator.clipboard.writeText('${o.mp_checkout_url}')">📋 Copiar Link</button>
      <a href="${o.mp_checkout_url}" target="_blank">🔗 Abrir</a>
      <button onclick="cancelarLinkMp('${o.id}')">🗑 Cancelar</button>
    </div>
  </div>
` : ''}
```

---

## Variáveis de Ambiente (.env)

```
MP_ACCESS_TOKEN=APP_USR-...    # Token de acesso (teste ou produção)
MP_PUBLIC_KEY=APP_USR-ef704b3c-...  # Para referência — não usado no backend
MP_WEBHOOK_SECRET=              # Configurar no painel MP após deploy
APP_URL=https://chatbot.klebercamaraconsultoria.cloud  # Base URL para notification_url
```

---

## Fluxo Completo

1. Admin clica **💳 Link MP** no orçamento aprovado
2. Sistema cria Preference via API MP → recebe `checkoutUrl`
3. Admin copia o link e envia ao cliente (WhatsApp ou e-mail)
4. Cliente abre o link → escolhe PIX, cartão ou boleto → paga dentro do MP
5. MP chama `POST /webhook/mercadopago` com `{ type: 'payment', data: { id } }`
6. Handler consulta o pagamento via API → confirma se `status === 'approved'`
7. `confirmarPagamento()` marca orçamento como `pago` e OSs como pagas

---

## Decisões de Design

- **Sem parcelas via MP**: a Preference suporta parcelas de cartão automaticamente (MP cuida disso na UI de checkout). Não precisamos controlar do nosso lado.
- **email fallback**: se o cliente não tem e-mail cadastrado, usar `cliente@lklgrafica.com.br` para não bloquear a criação da Preference.
- **Webhook antes de 200**: o handler responde 200 imediatamente antes de processar (padrão MP para evitar timeouts e retries desnecessários).
- **Cancelamento local**: não há endpoint de cancelamento de Preference no MP. O cancelamento apenas limpa os campos localmente. A Preference expira em 30 dias por padrão.
- **WhatsApp**: o fluxo de envio de WhatsApp existente já manda o link na mensagem de cobrança — apenas incluir o checkoutUrl quando tipo = 'link_mp'.
