# Sprint 3 — Pagamentos C6 Bank (Boleto + PIX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrar a API C6 Bank para emitir boletos e cobranças PIX a partir de orçamentos aprovados, com confirmação automática de pagamento via webhook que marca o orçamento e suas OSs como pagos.

**Architecture:** O serviço `c6bank.js` encapsula toda comunicação com a API (mTLS + OAuth2 token cache). A função `cobrar()` no service de orçamentos emite a cobrança e salva os dados no banco. Um webhook endpoint separado recebe confirmações do C6 Bank e atualiza os status. O admin dispara a cobrança manualmente pelo PWA; o cliente recebe os dados de pagamento via WhatsApp.

**Tech Stack:** Node.js 20, Express 4, PostgreSQL 15, CommonJS (require/module.exports), axios com `https.Agent` para mTLS, C6 Bank API (sandbox: https://baas-api-sandbox.c6bank.info), variáveis de ambiente já configuradas no VPS.

**Credenciais no VPS (.env):**
- `C6_BASE_URL=https://baas-api-sandbox.c6bank.info`
- `C6_CLIENT_ID=70440e9a-1021-4eae-a550-8d7138de346c`
- `C6_CLIENT_SECRET=L03oyfQyrn8f3B5ZOojSrFAkfWlSnlro`
- `C6_PIX_KEY=0b3a4612-a29d-48cb-be5c-9e0d580969a2`
- `C6_CERT_PATH=/var/www/lkl-chatbot/certs/c6bank/client.crt`
- `C6_KEY_PATH=/var/www/lkl-chatbot/certs/c6bank/client.key`

**Padrões do projeto:**
- Rotas modulares em `src/modules/*/router.js` montadas em `src/modules/index.js` sob `/api/v2`
- Auth: `requireAuthApi` (401 sem token) + `requireRole(...roles)` (403 role errada) de `src/middleware/auth.js`
- DB: `const db = require('../../db')` — `db.query(sql, params)` retorna `{ rows }`
- Transações: `const client = await pool.connect()` + BEGIN/COMMIT/ROLLBACK
- Fire-and-forget: `.catch(() => {})` nunca bloqueia resposta HTTP
- WhatsApp: `require('../../services/whatsapp').sendMessage(phone, text)` e `.sendImage(phone, url, caption)`
- Webhook externo (não autenticado): montado em `src/webhook/routes.js` sob `/webhook`
- Deploy: rsync para root@2.25.147.243:/var/www/lkl-chatbot/ + `pm2 restart lkl-chatbot`

---

## Arquivo: Mapa de Arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `sql/migrations/007_sprint3_pagamentos.sql` | Criar | Campos de pagamento em orcamentos + pago em ordens_servico |
| `src/services/c6bank.js` | Criar | mTLS agent, token OAuth2 (cache 55min), emitirBoleto(), criarPixCobranca() |
| `src/modules/orcamentos/service.js` | Modificar | Adicionar cobrar() e confirmarPagamento() |
| `src/modules/orcamentos/router.js` | Modificar | POST /:id/cobrar + disparar WhatsApp |
| `src/webhook/c6bank.js` | Criar | Handler de confirmação PIX e boleto do C6 Bank |
| `src/webhook/routes.js` | Modificar | Registrar POST /c6bank |
| `src/app.js` | Verificar | Confirmar que /webhook já está montado (não deve precisar de alteração) |
| `public/pwa/admin.html` | Modificar | Botão "Gerar Cobrança" + badge status_pagamento nos cards |
| `tests/modules/pagamentos.test.js` | Criar | Testes de cobrar() e confirmarPagamento() com mocks |

---

## Task 1: Migration — campos de pagamento

**Files:**
- Create: `sql/migrations/007_sprint3_pagamentos.sql`

- [ ] **Step 1: Criar arquivo de migration**

```sql
-- sql/migrations/007_sprint3_pagamentos.sql
BEGIN;

ALTER TABLE orcamentos
  ADD COLUMN IF NOT EXISTS status_pagamento VARCHAR(20) DEFAULT 'pendente'
    CHECK (status_pagamento IN ('pendente','aguardando_pagamento','pago','cancelado')),
  ADD COLUMN IF NOT EXISTS tipo_cobranca VARCHAR(10)
    CHECK (tipo_cobranca IN ('boleto','pix')),
  ADD COLUMN IF NOT EXISTS boleto_id TEXT,
  ADD COLUMN IF NOT EXISTS boleto_linha_digitavel TEXT,
  ADD COLUMN IF NOT EXISTS boleto_pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS boleto_vencimento DATE,
  ADD COLUMN IF NOT EXISTS pix_txid TEXT,
  ADD COLUMN IF NOT EXISTS pix_copia_cola TEXT,
  ADD COLUMN IF NOT EXISTS pago_em TIMESTAMPTZ;

ALTER TABLE ordens_servico
  ADD COLUMN IF NOT EXISTS pago BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_orcamentos_status_pgto ON orcamentos(status_pagamento);
CREATE INDEX IF NOT EXISTS idx_orcamentos_pix_txid ON orcamentos(pix_txid);
CREATE INDEX IF NOT EXISTS idx_orcamentos_boleto_id ON orcamentos(boleto_id);

COMMIT;
```

- [ ] **Step 2: Aplicar no VPS**

```bash
scp sql/migrations/007_sprint3_pagamentos.sql root@2.25.147.243:/tmp/
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -f /tmp/007_sprint3_pagamentos.sql"
```

Saída esperada:
```
BEGIN
ALTER TABLE
ALTER TABLE
CREATE INDEX
CREATE INDEX
CREATE INDEX
COMMIT
```

- [ ] **Step 3: Verificar colunas**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c '\d orcamentos' | grep -E 'status_pagamento|boleto|pix|pago_em'"
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c '\d ordens_servico' | grep pago"
```

- [ ] **Step 4: Commit**

```bash
git add sql/migrations/007_sprint3_pagamentos.sql
git commit -m "feat: migration Sprint 3 — campos pagamento em orcamentos e ordens_servico"
```

---

## Task 2: Serviço C6 Bank (mTLS + OAuth2 + Boleto + PIX)

**Files:**
- Create: `src/services/c6bank.js`

**Contexto C6 Bank API:**
- Autenticação: OAuth2 client_credentials + mTLS obrigatório em todas as chamadas
- Token endpoint: `POST /v1/token` com `Content-Type: application/x-www-form-urlencoded`
- Boleto: `POST /v1/boleto` com Bearer token + mTLS
- PIX cobrança imediata: `POST /v2/cob` (padrão BACEN) com Bearer + mTLS
- PIX webhook: `PUT /v2/webhook/{chave}` para registrar URL de notificação

- [ ] **Step 1: Criar src/services/c6bank.js**

```javascript
// src/services/c6bank.js
const axios = require('axios');
const https = require('https');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.C6_BASE_URL || 'https://baas-api-sandbox.c6bank.info';
const CLIENT_ID = process.env.C6_CLIENT_ID;
const CLIENT_SECRET = process.env.C6_CLIENT_SECRET;
const PIX_KEY = process.env.C6_PIX_KEY;

// mTLS agent — lido uma vez no boot
let _agent = null;
function getAgent() {
  if (!_agent) {
    const certPath = process.env.C6_CERT_PATH;
    const keyPath = process.env.C6_KEY_PATH;
    if (!certPath || !keyPath) throw new Error('C6_CERT_PATH e C6_KEY_PATH não configurados');
    _agent = new https.Agent({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      rejectUnauthorized: true,
    });
  }
  return _agent;
}

// Token cache — válido 55 minutos (C6 expira em 60)
let _tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.token;
  }
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const res = await axios.post(`${BASE_URL}/v1/token`, params.toString(), {
    httpsAgent: getAgent(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const { access_token, expires_in } = res.data;
  _tokenCache = {
    token: access_token,
    expiresAt: Date.now() + (expires_in - 300) * 1000, // 5min de margem
  };
  return access_token;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Formata data como YYYY-MM-DD
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

// Vencimento padrão: 3 dias úteis (simplificado: 5 dias corridos)
function vencimentoPadrao() {
  const d = new Date();
  d.setDate(d.getDate() + 5);
  return formatDate(d);
}

/**
 * Emite boleto de cobrança
 * @param {Object} params
 * @param {string} params.seuNumero - referência interna (ex: "ORC-1")
 * @param {string} params.nomeSacado
 * @param {string} params.cpfCnpjSacado - somente dígitos
 * @param {number} params.valor - em reais (ex: 150.00)
 * @param {string} [params.dataVencimento] - YYYY-MM-DD, padrão 5 dias
 * @returns {Object} { boletoId, linhaDigitavel, pdfUrl, dataVencimento }
 */
async function emitirBoleto({ seuNumero, nomeSacado, cpfCnpjSacado, valor, dataVencimento }) {
  const token = await getAccessToken();
  const vencimento = dataVencimento || vencimentoPadrao();
  const res = await axios.post(`${BASE_URL}/v1/boleto`, {
    seuNumero,
    nomeSacado,
    cpfCnpjSacado: cpfCnpjSacado.replace(/\D/g, ''),
    valor,
    dataVencimento: vencimento,
    jurosDiarios: 0.033,   // 1% ao mês
    multa: 2.0,             // 2% de multa
  }, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  });
  const d = res.data;
  return {
    boletoId: d.boletoId || d.id,
    linhaDigitavel: d.linhaDigitavel || d.codigoDeBarras,
    pdfUrl: d.urlBoleto || d.pdfUrl || null,
    dataVencimento: vencimento,
  };
}

/**
 * Cria cobrança PIX imediata (padrão BACEN / DICT)
 * @param {Object} params
 * @param {string} params.txid - identificador único (32 chars alphanum)
 * @param {number} params.valor - em reais
 * @param {string} params.nomeDevedor
 * @param {string} params.cpfCnpjDevedor - somente dígitos
 * @param {string} params.solicitacao - descrição (ex: "ORC #1 - LKL Gráfica")
 * @returns {Object} { txid, pixCopiaECola, qrCodeBase64 }
 */
async function criarPixCobranca({ txid, valor, nomeDevedor, cpfCnpjDevedor, solicitacao }) {
  const token = await getAccessToken();
  const cpfCnpj = cpfCnpjDevedor.replace(/\D/g, '');
  const devedor = cpfCnpj.length === 11
    ? { cpf: cpfCnpj, nome: nomeDevedor }
    : { cnpj: cpfCnpj, nome: nomeDevedor };

  const res = await axios.put(`${BASE_URL}/v2/cob/${txid}`, {
    calendario: { expiracao: 86400 }, // 24h
    devedor,
    valor: { original: valor.toFixed(2) },
    chave: PIX_KEY,
    solicitacaoPagador: solicitacao,
  }, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  });
  const d = res.data;
  return {
    txid: d.txid,
    pixCopiaECola: d.pixCopiaECola || d.pix_copia_cola,
    qrCodeBase64: d.imagemQrcode || null,
  };
}

/**
 * Registra webhook para notificações PIX
 * @param {string} webhookUrl - URL pública do endpoint
 */
async function registrarWebhookPix(webhookUrl) {
  const token = await getAccessToken();
  await axios.put(`${BASE_URL}/v2/webhook/${PIX_KEY}`, { webhookUrl }, {
    httpsAgent: getAgent(),
    headers: authHeaders(token),
  });
}

module.exports = { getAccessToken, emitirBoleto, criarPixCobranca, registrarWebhookPix };
```

- [ ] **Step 2: Testar carregamento do módulo localmente**

```bash
node -e "const c6 = require('./src/services/c6bank'); console.log('OK', Object.keys(c6))"
```

Saída esperada:
```
OK [ 'getAccessToken', 'emitirBoleto', 'criarPixCobranca', 'registrarWebhookPix' ]
```

- [ ] **Step 3: Commit**

```bash
git add src/services/c6bank.js
git commit -m "feat: serviço C6 Bank — mTLS client, token cache, boleto e PIX"
```

---

## Task 3: Serviço de orçamentos — cobrar() e confirmarPagamento()

**Files:**
- Modify: `src/modules/orcamentos/service.js`

A função `cobrar()` chama c6bank.js e salva os dados no banco.  
A função `confirmarPagamento()` é chamada pelo webhook handler.

- [ ] **Step 1: Escrever teste que falha**

```javascript
// tests/modules/pagamentos.test.js
const service = require('../../src/modules/orcamentos/service');

jest.mock('../../src/services/c6bank', () => ({
  emitirBoleto: jest.fn().mockResolvedValue({
    boletoId: 'BOLETO-001',
    linhaDigitavel: '12345.67890 12345.678901 12345.678901 1 12340000010000',
    pdfUrl: 'https://example.com/boleto.pdf',
    dataVencimento: '2026-07-01',
  }),
  criarPixCobranca: jest.fn().mockResolvedValue({
    txid: 'TXID001',
    pixCopiaECola: '00020126330014br.gov.bcb.pix01110b3a4612',
    qrCodeBase64: null,
  }),
}));

jest.mock('../../src/db', () => ({
  query: jest.fn(),
}));

const db = require('../../src/db');

describe('cobrar()', () => {
  beforeEach(() => jest.clearAllMocks());

  it('retorna erro se orçamento não encontrado', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await service.cobrar('uuid-inexistente', 'boleto');
    expect(res.erro).toBeDefined();
    expect(res.erro[0]).toMatch(/não encontrado/);
  });

  it('retorna erro se orçamento não está aprovado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid', status: 'rascunho', status_pagamento: 'pendente' }] });
    const res = await service.cobrar('uuid', 'boleto');
    expect(res.erro[0]).toMatch(/aprovado/);
  });

  it('retorna erro se tipo inválido', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid', status: 'aprovado', status_pagamento: 'pendente', numero: 1, cliente_nome: 'Test', cliente_cpf_cnpj: '12345678000195', valor_total: 100 }] });
    const res = await service.cobrar('uuid', 'cartao');
    expect(res.erro[0]).toMatch(/boleto.*pix/i);
  });
});

describe('confirmarPagamento()', () => {
  it('retorna erro se orçamento não encontrado por txid', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await service.confirmarPagamento({ tipo: 'pix', txid: 'NAO_EXISTE' });
    expect(res.erro).toBeDefined();
  });
});
```

- [ ] **Step 2: Rodar teste e verificar falha**

```bash
npx jest tests/modules/pagamentos.test.js --no-coverage 2>&1 | tail -20
```

Esperado: falha com `TypeError: service.cobrar is not a function`

- [ ] **Step 3: Implementar cobrar() e confirmarPagamento() em service.js**

Adicione ao final de `src/modules/orcamentos/service.js`, antes do `module.exports`:

```javascript
const c6bank = require('../../services/c6bank');
const { ulid } = require('ulid');

async function cobrar(id, tipo) {
  if (!['boleto', 'pix'].includes(tipo)) {
    return { erro: ['tipo deve ser boleto ou pix'] };
  }

  // Busca orçamento com dados do cliente
  const r = await db.query(
    `SELECT o.id, o.numero, o.status, o.status_pagamento,
            o.valor_total_calculado,
            c.nome AS cliente_nome, c.cpf_cnpj AS cliente_cpf_cnpj, c.celular AS cliente_celular
     FROM orcamentos o
     LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
     WHERE o.id = $1`,
    [id]
  );
  if (!r.rows[0]) return { erro: ['Orçamento não encontrado'] };
  const orc = r.rows[0];

  if (orc.status !== 'aprovado') return { erro: ['Orçamento precisa estar aprovado para gerar cobrança'] };
  if (orc.status_pagamento === 'pago') return { erro: ['Orçamento já está pago'] };

  // Valor: soma dos itens se valor_total_calculado não disponível
  let valor = parseFloat(orc.valor_total_calculado) || 0;
  if (!valor) {
    const itensR = await db.query(
      'SELECT COALESCE(SUM(valor_total), 0) AS total FROM orcamento_itens WHERE orcamento_id = $1',
      [id]
    );
    valor = parseFloat(itensR.rows[0].total) || 0;
  }
  if (!valor || valor <= 0) return { erro: ['Orçamento sem valor definido — precifique antes de cobrar'] };

  const seuNumero = `ORC-${orc.numero}`;
  const nomeSacado = orc.cliente_nome || 'Cliente';
  const cpfCnpj = (orc.cliente_cpf_cnpj || '').replace(/\D/g, '') || '00000000000';

  try {
    if (tipo === 'boleto') {
      const boleto = await c6bank.emitirBoleto({ seuNumero, nomeSacado, cpfCnpjSacado: cpfCnpj, valor });
      await db.query(
        `UPDATE orcamentos SET tipo_cobranca='boleto', status_pagamento='aguardando_pagamento',
         boleto_id=$1, boleto_linha_digitavel=$2, boleto_pdf_url=$3, boleto_vencimento=$4,
         updated_at=NOW() WHERE id=$5`,
        [boleto.boletoId, boleto.linhaDigitavel, boleto.pdfUrl, boleto.dataVencimento, id]
      );
      return { tipo: 'boleto', linhaDigitavel: boleto.linhaDigitavel, pdfUrl: boleto.pdfUrl, dataVencimento: boleto.dataVencimento, valor };
    } else {
      const txid = ulid().replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
      const pix = await c6bank.criarPixCobranca({
        txid,
        valor,
        nomeDevedor: nomeSacado,
        cpfCnpjDevedor: cpfCnpj,
        solicitacao: `${seuNumero} - LKL Gráfica`,
      });
      await db.query(
        `UPDATE orcamentos SET tipo_cobranca='pix', status_pagamento='aguardando_pagamento',
         pix_txid=$1, pix_copia_cola=$2, updated_at=NOW() WHERE id=$3`,
        [pix.txid, pix.pixCopiaECola, id]
      );
      return { tipo: 'pix', txid: pix.txid, pixCopiaECola: pix.pixCopiaECola, valor };
    }
  } catch (e) {
    console.error('[C6-COBRAR]', e.response?.data || e.message);
    return { erro: [`Erro na API C6 Bank: ${e.response?.data?.message || e.message}`] };
  }
}

async function confirmarPagamento({ tipo, txid, boletoId }) {
  // Localiza o orçamento pelo identificador
  let findResult;
  if (tipo === 'pix' && txid) {
    findResult = await db.query('SELECT id, orcamentos.* FROM orcamentos WHERE pix_txid = $1', [txid]);
  } else if (tipo === 'boleto' && boletoId) {
    findResult = await db.query('SELECT id FROM orcamentos WHERE boleto_id = $1', [boletoId]);
  } else {
    return { erro: ['txid ou boletoId obrigatório'] };
  }

  if (!findResult.rows[0]) return { erro: ['Orçamento não encontrado para este pagamento'] };
  const orcId = findResult.rows[0].id;

  // Atualiza orçamento e todas as OSs vinculadas
  await db.query(
    `UPDATE orcamentos SET status_pagamento='pago', pago_em=NOW(), updated_at=NOW() WHERE id=$1`,
    [orcId]
  );
  await db.query(
    `UPDATE ordens_servico SET pago=true, updated_at=NOW() WHERE orcamento_id=$1`,
    [orcId]
  );

  return { confirmado: true, orcamento_id: orcId };
}
```

- [ ] **Step 4: Atualizar module.exports**

No final do arquivo, altere a linha de exports:

```javascript
module.exports = { listar, buscarPorId, criar, precificar, mudarStatus, aprovar, cobrar, confirmarPagamento };
```

- [ ] **Step 5: Rodar testes**

```bash
npx jest tests/modules/pagamentos.test.js --no-coverage 2>&1 | tail -20
```

Esperado: todos os 4 testes passando.

- [ ] **Step 6: Commit**

```bash
git add src/modules/orcamentos/service.js tests/modules/pagamentos.test.js
git commit -m "feat: orcamentos service — cobrar() boleto/PIX + confirmarPagamento()"
```

---

## Task 4: Endpoint POST /api/v2/orcamentos/:id/cobrar

**Files:**
- Modify: `src/modules/orcamentos/router.js`

- [ ] **Step 1: Adicionar rota em router.js**

Logo antes do último `module.exports = router;`, adicione:

```javascript
// POST /:id/cobrar — admin gera cobrança (boleto ou pix)
router.post('/:id/cobrar', requireRole('admin'), async (req, res) => {
  try {
    const { tipo } = req.body || {};
    if (!tipo) return res.status(400).json({ errors: ['tipo é obrigatório (boleto ou pix)'] });
    const result = await service.cobrar(req.params.id, tipo);
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrado'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }

    // Envia dados de pagamento ao cliente via WhatsApp (fire-and-forget)
    service.buscarPorId(req.params.id).then(orc => {
      if (!orc?.cliente_celular) return;
      let msg;
      if (result.tipo === 'boleto') {
        msg = `Olá! Segue o boleto referente ao *ORC #${orc.numero}* — LKL Gráfica.\n\n` +
              `💰 *Valor:* R$ ${result.valor.toFixed(2).replace('.', ',')}\n` +
              `📅 *Vencimento:* ${new Date(result.dataVencimento + 'T12:00:00').toLocaleDateString('pt-BR')}\n\n` +
              `*Linha digitável:*\n${result.linhaDigitavel}\n\n` +
              (result.pdfUrl ? `PDF: ${result.pdfUrl}\n\n` : '') +
              `Em caso de dúvidas, entre em contato conosco. Obrigado! 😊`;
      } else {
        msg = `Olá! Segue a cobrança PIX referente ao *ORC #${orc.numero}* — LKL Gráfica.\n\n` +
              `💰 *Valor:* R$ ${result.valor.toFixed(2).replace('.', ',')}\n\n` +
              `*PIX Copia e Cola:*\n${result.pixCopiaECola}\n\n` +
              `Cole o código no app do seu banco para pagar. Obrigado! 😊`;
      }
      whatsapp.sendMessage(orc.cliente_celular, msg).catch(e =>
        console.warn('[WA-COBRAR] Falha:', e.message)
      );
    }).catch(() => {});

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});
```

- [ ] **Step 2: Verificar que `whatsapp` já está importado no topo do arquivo**

O arquivo já deve ter `const whatsapp = require('../../services/whatsapp');`. Confirme com:

```bash
head -10 src/modules/orcamentos/router.js | grep whatsapp
```

Se não estiver, adicione após os outros requires:
```javascript
const whatsapp = require('../../services/whatsapp');
```

- [ ] **Step 3: Testar carregamento**

```bash
node -e "require('./src/modules/orcamentos/router')" && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add src/modules/orcamentos/router.js
git commit -m "feat: POST /api/v2/orcamentos/:id/cobrar — gera cobrança e envia ao cliente via WhatsApp"
```

---

## Task 5: Webhook handler do C6 Bank

**Files:**
- Create: `src/webhook/c6bank.js`
- Modify: `src/webhook/routes.js`

O C6 Bank envia um POST para a URL cadastrada quando um pagamento é confirmado. O payload PIX segue o padrão BACEN (RFC da API PIX). O payload do boleto é específico do C6.

- [ ] **Step 1: Criar src/webhook/c6bank.js**

```javascript
// src/webhook/c6bank.js
const { confirmarPagamento } = require('../modules/orcamentos/service');

/**
 * Handler de webhook de confirmação de pagamento do C6 Bank.
 * PIX (padrão BACEN): body.pix[].txid
 * Boleto: body.boletoId ou body.nossoNumero
 */
async function handleC6Webhook(req, res) {
  // Responde imediatamente — C6 pode retentar se demorar
  res.sendStatus(200);

  try {
    const body = req.body;
    console.log('[C6-WEBHOOK]', JSON.stringify(body).slice(0, 300));

    // Formato PIX (padrão BACEN): { pix: [{ txid, valor, horario, ... }] }
    if (body.pix && Array.isArray(body.pix)) {
      for (const pagamento of body.pix) {
        if (!pagamento.txid) continue;
        const result = await confirmarPagamento({ tipo: 'pix', txid: pagamento.txid });
        if (result.confirmado) {
          console.log(`[C6-PIX] Pagamento confirmado — ORC ID: ${result.orcamento_id}`);
        } else {
          console.warn('[C6-PIX] Não encontrado para txid:', pagamento.txid);
        }
      }
      return;
    }

    // Formato Boleto C6: { boletoId, status, ... }
    if (body.boletoId && body.status === 'LIQUIDADO') {
      const result = await confirmarPagamento({ tipo: 'boleto', boletoId: body.boletoId });
      if (result.confirmado) {
        console.log(`[C6-BOLETO] Pagamento confirmado — ORC ID: ${result.orcamento_id}`);
      } else {
        console.warn('[C6-BOLETO] Não encontrado para boletoId:', body.boletoId);
      }
      return;
    }

    console.warn('[C6-WEBHOOK] Payload não reconhecido:', JSON.stringify(body).slice(0, 200));
  } catch (err) {
    console.error('[C6-WEBHOOK] Erro ao processar:', err.message);
  }
}

module.exports = { handleC6Webhook };
```

- [ ] **Step 2: Registrar rota em src/webhook/routes.js**

Adicione no topo do arquivo:
```javascript
const { handleC6Webhook } = require('./c6bank');
```

Adicione a rota antes do `module.exports = router;`:
```javascript
// Webhook C6 Bank — confirmação de pagamento (PIX e Boleto)
router.post('/c6bank', express.json(), handleC6Webhook);
```

> **Nota:** `express.json()` inline porque o middleware global já existe, mas é bom ser explícito para garantir parsing correto no contexto do webhook.

- [ ] **Step 3: Verificar carregamento**

```bash
node -e "require('./src/webhook/routes')" && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add src/webhook/c6bank.js src/webhook/routes.js
git commit -m "feat: webhook C6 Bank — confirma pagamento PIX e boleto"
```

---

## Task 6: PWA admin.html — Gerar Cobrança + badge status pagamento

**Files:**
- Modify: `public/pwa/admin.html`

- [ ] **Step 1: Adicionar badge de status_pagamento nos cards de orçamento**

Localize a função que renderiza cards de orçamento em `admin.html`. Encontre onde o status do orçamento é exibido e adicione o badge de pagamento ao lado:

```javascript
// Adicionar no mapa de badges de pagamento (inserir próximo às outras constantes de status):
const PGTO_BADGE = {
  pendente:             { label: 'Não cobrado',         bg: '#f5f5f5', color: '#666' },
  aguardando_pagamento: { label: '⏳ Aguardando pgto',  bg: '#fff8e1', color: '#f57f17' },
  pago:                 { label: '✅ Pago',             bg: '#e8f5e9', color: '#2e7d32' },
  cancelado:            { label: '❌ Cancelado',        bg: '#fce4ec', color: '#c62828' },
};

function pgtoBadgeHTML(statusPgto) {
  const s = PGTO_BADGE[statusPgto] || PGTO_BADGE.pendente;
  return `<span style="background:${s.bg};color:${s.color};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">${s.label}</span>`;
}
```

- [ ] **Step 2: Adicionar botão "Gerar Cobrança" nos orçamentos aprovados**

Na função que renderiza o card/linha de cada orçamento aprovado, adicione os botões. Localize onde os botões de ação do orçamento são renderizados (próximo a "Enviar", "Aprovar") e adicione:

```javascript
// Dentro do HTML do card, após os botões existentes:
const podeGerar = orc.status === 'aprovado' && orc.status_pagamento !== 'pago';
const botoesCobranca = podeGerar ? `
  <button class="btn btn-outline" style="font-size:11px;padding:4px 10px;background:#1565c0;color:#fff;border:none"
    onclick="gerarCobranca('${orc.id}', 'boleto')">🧾 Boleto</button>
  <button class="btn btn-outline" style="font-size:11px;padding:4px 10px;background:#00695c;color:#fff;border:none"
    onclick="gerarCobranca('${orc.id}', 'pix')">⚡ PIX</button>
` : '';

// Exibir dados de pagamento se já gerado:
const dadosPgto = orc.tipo_cobranca === 'boleto' && orc.boleto_linha_digitavel
  ? `<div style="font-size:11px;color:#555;margin-top:6px;word-break:break-all">📋 ${orc.boleto_linha_digitavel}</div>`
  : orc.tipo_cobranca === 'pix' && orc.pix_copia_cola
  ? `<div style="font-size:11px;color:#555;margin-top:6px;word-break:break-all">⚡ PIX: ${orc.pix_copia_cola.slice(0, 40)}...</div>`
  : '';
```

- [ ] **Step 3: Implementar função gerarCobranca()**

Adicione na seção de scripts de `admin.html`:

```javascript
async function gerarCobranca(orcId, tipo) {
  const label = tipo === 'boleto' ? 'Boleto' : 'PIX';
  if (!confirm(`Gerar ${label} para este orçamento e enviar ao cliente via WhatsApp?`)) return;
  const res = await api(`/api/v2/orcamentos/${orcId}/cobrar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo }),
  });
  if (res && !res.errors && !res.error) {
    showToast(`✅ ${label} gerado e enviado ao cliente via WhatsApp!`);
    loadOrcamentos(); // recarrega a lista para mostrar o badge atualizado
  } else {
    showToast(`❌ Erro: ${(res?.errors || [res?.error])[0] || 'Erro desconhecido'}`);
  }
}
```

- [ ] **Step 4: Garantir que o GET /orcamentos inclui os novos campos**

O endpoint `GET /api/v2/orcamentos` já retorna todas as colunas do `SELECT o.*`. Os novos campos (`status_pagamento`, `tipo_cobranca`, `boleto_linha_digitavel`, `pix_copia_cola`) estarão disponíveis automaticamente após a migration.

- [ ] **Step 5: Commit**

```bash
git add public/pwa/admin.html
git commit -m "feat: admin.html — botões Gerar Boleto/PIX + badge status pagamento"
```

---

## Task 7: Deploy e registro do webhook no C6 Bank

**Files:**
- Nenhum arquivo novo — apenas deploy + chamada de API

- [ ] **Step 1: Rsync arquivos modificados para VPS**

```bash
rsync -az \
  src/services/c6bank.js \
  src/modules/orcamentos/service.js \
  src/modules/orcamentos/router.js \
  src/webhook/c6bank.js \
  src/webhook/routes.js \
  root@2.25.147.243:/var/www/lkl-chatbot/src/services/

rsync -az src/modules/orcamentos/ root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/
rsync -az src/webhook/ root@2.25.147.243:/var/www/lkl-chatbot/src/webhook/
rsync -az public/pwa/admin.html root@2.25.147.243:/var/www/lkl-chatbot/public/pwa/admin.html
```

- [ ] **Step 2: Reiniciar PM2 e verificar logs**

```bash
ssh root@2.25.147.243 "pm2 restart lkl-chatbot --update-env && sleep 3 && pm2 logs lkl-chatbot --lines 10 --nostream"
```

Esperado: `✅ PostgreSQL conectado`, `🚀 LKL Chatbot rodando na porta 3000`, sem erros.

- [ ] **Step 3: Testar obtenção do token C6 Bank no VPS**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -e \"
const c6 = require('./src/services/c6bank');
c6.getAccessToken().then(t => console.log('TOKEN OK, len:', t.length)).catch(e => console.error('ERRO:', e.message));
\""
```

Esperado: `TOKEN OK, len: <número>` — se falhar, verificar se o sandbox está disponível (Mon-Sex 7h-23h).

- [ ] **Step 4: Registrar webhook PIX no C6 Bank**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -e \"
const c6 = require('./src/services/c6bank');
c6.registrarWebhookPix('https://chatbot.klebercamaraconsultoria.cloud/webhook/c6bank')
  .then(() => console.log('Webhook PIX registrado!'))
  .catch(e => console.error('ERRO:', e.response?.data || e.message));
\""
```

- [ ] **Step 5: Testar endpoint de webhook localmente**

```bash
ssh root@2.25.147.243 "curl -s -X POST http://localhost:3000/webhook/c6bank \
  -H 'Content-Type: application/json' \
  -d '{\"pix\":[{\"txid\":\"TESTE123\",\"valor\":\"100.00\"}]}' \
  -w '\nHTTP: %{http_code}'"
```

Esperado: `HTTP: 200` (e log `[C6-PIX] Não encontrado para txid: TESTE123` — correto, txid não existe).

- [ ] **Step 6: Testar endpoint de cobrança via API (sandbox)**

Primeiro garanta que existe um orçamento aprovado com valor definido no banco:

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"
SELECT o.id, o.numero, o.status, c.nome, c.cpf_cnpj, c.celular
FROM orcamentos o LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
WHERE o.status = 'aprovado' LIMIT 1;
\""
```

Copie o `id` e teste (substitua TOKEN pelo JWT de um admin — obtenha via login no PWA):

```bash
curl -s -X POST https://chatbot.klebercamaraconsultoria.cloud/api/v2/orcamentos/<UUID>/cobrar \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"tipo":"pix"}' | jq .
```

Esperado: `{"tipo":"pix","txid":"...","pixCopiaECola":"00020126...","valor":...}`

- [ ] **Step 7: Commit final**

```bash
git add -A
git commit -m "feat: Sprint 3 deploy — C6 Bank Boleto + PIX integrado e webhook registrado"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ Boleto: `emitirBoleto()` + rota `/cobrar` + WhatsApp notification
- ✅ PIX: `criarPixCobranca()` + rota `/cobrar` + WhatsApp notification
- ✅ Webhook PIX: `handleC6Webhook` → `confirmarPagamento()`
- ✅ Webhook Boleto: mesmo handler, payload diferente
- ✅ Status orcamento → `pago` + todas OSs `pago = true`
- ✅ Sem FCM push ao vendedor (conforme solicitado)
- ✅ Admin PWA: botões Boleto/PIX + badge status

**2. Placeholder scan:** Nenhum TBD ou TODO no plano.

**3. Type consistency:**
- `cobrar(id, tipo)` definido em Task 3, chamado em Task 4 ✅
- `confirmarPagamento({ tipo, txid, boletoId })` definido em Task 3, chamado em Task 5 ✅
- `c6bank.emitirBoleto()` / `c6bank.criarPixCobranca()` definidos em Task 2, usados em Task 3 ✅
- `service.cobrar()` exportado em Task 3, importado em Task 4 ✅

**Atenção operacional:**
- Sandbox disponível apenas Seg-Sex 7h-23h (horário de Brasília)
- O `cliente_cpf_cnpj` precisa estar preenchido em `clientes_lkl` para emitir boleto/PIX — orçamentos criados pelo chatbot podem não ter esse campo. Nesse caso, o sistema usa `'00000000000'` como fallback (ajustar na interface do vendedor futuramente)
- Após homologação, trocar `C6_BASE_URL` para a URL de produção e atualizar os certificados
