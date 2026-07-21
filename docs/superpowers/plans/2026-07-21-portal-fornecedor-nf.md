# Portal do Fornecedor — Entrada de NF com Anti-Fraude — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar aos fornecedores um portal próprio pra declarar NF, itens e forma de pagamento antes da mercadoria chegar, com verificação automática (bot) e cruzamento com o DDA — reduzindo digitação manual e criando uma "lista branca declarada" contra boletos fraudulentos.

**Architecture:** Extensão do sistema atual (mesmo Express/PostgreSQL). Autenticação de fornecedor totalmente separada da de funcionário (tabela e claim JWT próprios, nunca aceito em rotas internas e vice-versa). Fluxo de aceite reaproveita a Entrada de Estoque já existente. Router público (`/api/v2/portal-fornecedor`) para o fornecedor; router interno protegido (`/api/v2/fornecedor-submissoes`) para a fila do LKL.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), `bcryptjs`, `jsonwebtoken`, `multer`, OpenAI GPT-4o Vision (OCR, reaproveitando `contas-pagar/ocr.js`), Jest.

**Spec:** `docs/superpowers/specs/2026-07-21-portal-fornecedor-nf-design.md`

---

### Task 1: Migration — tabelas do portal e colunas novas

**Files:**
- Create: `sql/migrations/057_portal_fornecedor.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- sql/migrations/057_portal_fornecedor.sql
BEGIN;

ALTER TABLE fornecedores ADD COLUMN portal_liberado BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE fornecedor_logins (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fornecedor_id     UUID NOT NULL UNIQUE REFERENCES fornecedores(id) ON DELETE CASCADE,
  email             VARCHAR(150) NOT NULL UNIQUE,
  senha_hash        VARCHAR(255),
  convite_token     VARCHAR(64) UNIQUE,
  convite_expira    TIMESTAMPTZ,
  senha_definida_em TIMESTAMPTZ,
  ativo             BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE fornecedor_submissoes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fornecedor_id         UUID NOT NULL REFERENCES fornecedores(id),
  nnf                   VARCHAR(20),
  emitida_em            DATE,
  data_entrega_agendada DATE,
  valor_total           NUMERIC(12,2) NOT NULL,
  arquivo_nf_path       VARCHAR(255),
  tipo_pagamento        VARCHAR(10) NOT NULL CHECK (tipo_pagamento IN ('boleto','pix','ted','link_mp')),
  pix_chave             VARCHAR(140),
  ted_banco_nome        VARCHAR(100),
  ted_banco_codigo      VARCHAR(10),
  ted_tipo_conta        VARCHAR(20),
  ted_titularidade      VARCHAR(2) CHECK (ted_titularidade IN ('PJ','PF')),
  ted_documento         VARCHAR(18),
  ted_agencia           VARCHAR(10),
  ted_conta             VARCHAR(20),
  link_mp_url           VARCHAR(500),
  status                VARCHAR(20) NOT NULL DEFAULT 'pendente'
                        CHECK (status IN ('pendente','alerta_dado_bancario','aguardando_entrega','aceita','rejeitada')),
  bot_verificacao       JSONB,
  entrada_estoque_id    UUID REFERENCES entradas_estoque(id) ON DELETE SET NULL,
  criada_em             TIMESTAMPTZ DEFAULT NOW(),
  revisada_por          UUID REFERENCES users(id) ON DELETE SET NULL,
  revisada_em           TIMESTAMPTZ
);

CREATE TABLE fornecedor_submissao_itens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submissao_id    UUID NOT NULL REFERENCES fornecedor_submissoes(id) ON DELETE CASCADE,
  produto         VARCHAR(200) NOT NULL,
  quantidade      NUMERIC(10,3) NOT NULL,
  valor_unitario  NUMERIC(12,4) NOT NULL,
  valor_total     NUMERIC(12,2) NOT NULL
);

CREATE TABLE fornecedor_submissao_boletos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submissao_id      UUID NOT NULL REFERENCES fornecedor_submissoes(id) ON DELETE CASCADE,
  arquivo_path      VARCHAR(255) NOT NULL,
  linha_digitavel   VARCHAR(60),
  valor             NUMERIC(12,2),
  vencimento        DATE
);

ALTER TABLE entradas_estoque ADD COLUMN fornecedor_submissao_id UUID REFERENCES fornecedor_submissoes(id) ON DELETE SET NULL;

CREATE INDEX idx_fornecedor_submissoes_fornecedor ON fornecedor_submissoes(fornecedor_id);
CREATE INDEX idx_fornecedor_submissoes_status ON fornecedor_submissoes(status);

COMMIT;
```

- [ ] **Step 2: Aplicar no VPS (sem afetar o app rodando)**

Run: `rsync -av sql/migrations/057_portal_fornecedor.sql lkl:/var/www/lkl-chatbot/sql/migrations/057_portal_fornecedor.sql`
Depois: `ssh lkl "cd /var/www/lkl-chatbot && set -a && source .env && set +a && node -e \"const fs=require('fs');const db=require('./src/db');(async()=>{await db.pool.query(fs.readFileSync('sql/migrations/057_portal_fornecedor.sql','utf8'));console.log('OK');process.exit(0);})();\""`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add sql/migrations/057_portal_fornecedor.sql
git commit -m "feat(portal-fornecedor): migration tabelas de login e submissao de NF"
```

---

### Task 2: Middleware de autenticação — separar fornecedor de funcionário

**Files:**
- Modify: `src/middleware/auth.js`
- Test: `tests/middleware-auth-fornecedor.test.js`

- [ ] **Step 1: Escrever o teste (falhando)**

```js
// tests/middleware-auth-fornecedor.test.js
jest.mock('jsonwebtoken');
const jwt = require('jsonwebtoken');
const { requireAuthFornecedor, requireAuthApi, requireRole } = require('../src/middleware/auth');

function mockReqRes(token) {
  const req = { cookies: {}, headers: { authorization: `Bearer ${token}` }, path: '/x' };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), redirect: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
}

describe('requireAuthFornecedor', () => {
  afterEach(() => jest.clearAllMocks());

  test('token com tipo=fornecedor → passa', () => {
    jwt.verify.mockReturnValueOnce({ tipo: 'fornecedor', fornecedorId: 'uuid-1' });
    const { req, res, next } = mockReqRes('tok');
    requireAuthFornecedor(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('token de funcionário (sem tipo=fornecedor) → rejeitado', () => {
    jwt.verify.mockReturnValueOnce({ id: 'user-1', role: 'admin' });
    const { req, res, next } = mockReqRes('tok');
    requireAuthFornecedor(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('requireAuthApi — rejeita token de fornecedor', () => {
  afterEach(() => jest.clearAllMocks());

  test('token com tipo=fornecedor → rejeitado mesmo com JWT válido', () => {
    jwt.verify.mockReturnValueOnce({ tipo: 'fornecedor', fornecedorId: 'uuid-1' });
    const { req, res, next } = mockReqRes('tok');
    requireAuthApi(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('requireRole — rejeita token de fornecedor', () => {
  afterEach(() => jest.clearAllMocks());

  test('token com tipo=fornecedor → rejeitado mesmo se role bater por acaso', () => {
    jwt.verify.mockReturnValueOnce({ tipo: 'fornecedor', fornecedorId: 'uuid-1', role: 'admin' });
    const { req, res, next } = mockReqRes('tok');
    requireRole('admin')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/middleware-auth-fornecedor.test.js --silent`
Expected: FAIL — `requireAuthFornecedor is not a function`

- [ ] **Step 3: Implementar**

Em `src/middleware/auth.js`, adicione a nova função e trave as duas existentes contra token de fornecedor:

```js
function requireAuthFornecedor(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.tipo !== 'fornecedor') return res.status(401).json({ error: 'Token inválido' });
    req.fornecedor = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}
```

Em `requireAuthApi`, logo após `req.user = jwt.verify(...)`:

```js
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    if (req.user.tipo === 'fornecedor') return res.status(401).json({ error: 'Token inválido' });
    if (req.user.mustChangePassword && !ROTAS_LIVRES_TROCA_SENHA.includes(req.path)) {
```

Em `requireRole`, logo após `req.user = require('jsonwebtoken').verify(...)`:

```js
      req.user = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
      if (req.user.tipo === 'fornecedor') return res.status(401).json({ error: 'Token inválido' });
      if (!roles.includes(req.user.role)) {
```

Por fim, no `module.exports`:

```js
module.exports = { requireAuth, requireAdmin, requireAuthApi, requireRole, requireAuthFornecedor };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest tests/middleware-auth-fornecedor.test.js --silent`
Expected: PASS (4 testes)

- [ ] **Step 5: Rodar a suíte completa**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: baseline conhecida (5 suites falhando só por Postgres local ausente), sem regressão nova.

- [ ] **Step 6: Commit**

```bash
git add src/middleware/auth.js tests/middleware-auth-fornecedor.test.js
git commit -m "feat(portal-fornecedor): middleware requireAuthFornecedor e isolamento de escopo JWT"
```

---

### Task 3: Service de autenticação do fornecedor (convite, definir senha, login)

**Files:**
- Create: `src/modules/portal-fornecedor/auth-service.js`
- Test: `tests/portal-fornecedor-auth-service.test.js`

- [ ] **Step 1: Escrever o teste (falhando)**

```js
// tests/portal-fornecedor-auth-service.test.js
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('bcryptjs', () => ({ hash: jest.fn(), compare: jest.fn() }));
jest.mock('jsonwebtoken', () => ({ sign: jest.fn() }));
jest.mock('crypto', () => ({ randomBytes: jest.fn(() => ({ toString: () => 'token-gerado-64chars' })) }));

const db = require('../src/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authService = require('../src/modules/portal-fornecedor/auth-service');

beforeEach(() => jest.clearAllMocks());

describe('criarConvite', () => {
  test('gera token, grava e-mail + expira em 7 dias, marca portal_liberado', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // upsert fornecedor_logins
      .mockResolvedValueOnce({ rows: [] }); // update fornecedores.portal_liberado

    const r = await authService.criarConvite('forn-1', 'contato@vinilline.com.br');

    expect(r.conviteToken).toBe('token-gerado-64chars');
    const insert = db.query.mock.calls[0];
    expect(insert[0]).toMatch(/INSERT INTO fornecedor_logins/);
    expect(insert[1]).toEqual(['forn-1', 'contato@vinilline.com.br', 'token-gerado-64chars']);
  });
});

describe('definirSenha', () => {
  test('token válido e não expirado → grava hash e limpa o convite', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'login-1', convite_expira: new Date(Date.now() + 3600_000).toISOString() }],
    });
    bcrypt.hash.mockResolvedValueOnce('hash-da-senha');

    const r = await authService.definirSenha('token-valido', 'MinhaSenh@123');

    expect(r.ok).toBe(true);
    const update = db.query.mock.calls[1];
    expect(update[0]).toMatch(/UPDATE fornecedor_logins SET senha_hash/);
    expect(update[1]).toEqual(['hash-da-senha', 'login-1']);
  });

  test('token expirado → erro', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'login-1', convite_expira: new Date(Date.now() - 3600_000).toISOString() }],
    });
    const r = await authService.definirSenha('token-expirado', 'MinhaSenh@123');
    expect(r.erro).toEqual(['Convite expirado — peça um novo à Gráfica LKL']);
  });

  test('token inexistente → erro', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await authService.definirSenha('token-invalido', 'MinhaSenh@123');
    expect(r.erro).toEqual(['Convite inválido']);
  });
});

describe('login', () => {
  test('credenciais corretas → retorna token JWT com tipo=fornecedor', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'login-1', fornecedor_id: 'forn-1', senha_hash: 'hash', ativo: true }],
    });
    bcrypt.compare.mockResolvedValueOnce(true);
    jwt.sign.mockReturnValueOnce('jwt-assinado');

    const r = await authService.login('contato@vinilline.com.br', 'MinhaSenh@123');

    expect(r.token).toBe('jwt-assinado');
    expect(jwt.sign.mock.calls[0][0]).toEqual(expect.objectContaining({ tipo: 'fornecedor', fornecedorId: 'forn-1' }));
  });

  test('senha errada → erro', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'login-1', senha_hash: 'hash', ativo: true }] });
    bcrypt.compare.mockResolvedValueOnce(false);
    const r = await authService.login('contato@vinilline.com.br', 'errada');
    expect(r.erro).toEqual(['Credenciais inválidas']);
  });

  test('login sem senha definida ainda (convite pendente) → erro', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'login-1', senha_hash: null, ativo: true }] });
    const r = await authService.login('contato@vinilline.com.br', 'qualquer');
    expect(r.erro).toEqual(['Credenciais inválidas']);
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/portal-fornecedor-auth-service.test.js --silent`
Expected: FAIL — `Cannot find module '../src/modules/portal-fornecedor/auth-service'`

- [ ] **Step 3: Implementar**

```js
// src/modules/portal-fornecedor/auth-service.js
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../../db');

async function criarConvite(fornecedorId, email) {
  const conviteToken = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO fornecedor_logins (fornecedor_id, email, convite_token, convite_expira)
     VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')
     ON CONFLICT (fornecedor_id) DO UPDATE SET
       email = $2, convite_token = $3, convite_expira = NOW() + INTERVAL '7 days', updated_at = NOW()`,
    [fornecedorId, email, conviteToken]
  );
  await db.query('UPDATE fornecedores SET portal_liberado = true WHERE id = $1', [fornecedorId]);
  return { conviteToken };
}

async function definirSenha(conviteToken, novaSenha) {
  const r = await db.query(
    `SELECT id, convite_expira FROM fornecedor_logins WHERE convite_token = $1`,
    [conviteToken]
  );
  if (!r.rows[0]) return { erro: ['Convite inválido'] };
  if (new Date(r.rows[0].convite_expira) < new Date()) {
    return { erro: ['Convite expirado — peça um novo à Gráfica LKL'] };
  }
  const hash = await bcrypt.hash(novaSenha, 10);
  await db.query(
    `UPDATE fornecedor_logins SET senha_hash = $1, senha_definida_em = NOW(), convite_token = NULL, convite_expira = NULL, updated_at = NOW() WHERE id = $2`,
    [hash, r.rows[0].id]
  );
  return { ok: true };
}

async function login(email, senha) {
  const r = await db.query(
    `SELECT id, fornecedor_id, senha_hash, ativo FROM fornecedor_logins WHERE email = $1`,
    [email]
  );
  const login = r.rows[0];
  if (!login || !login.senha_hash || !login.ativo) return { erro: ['Credenciais inválidas'] };
  const ok = await bcrypt.compare(senha, login.senha_hash);
  if (!ok) return { erro: ['Credenciais inválidas'] };
  const token = jwt.sign(
    { tipo: 'fornecedor', fornecedorId: login.fornecedor_id, loginId: login.id },
    process.env.JWT_SECRET,
    { expiresIn: '12h' }
  );
  return { token, fornecedorId: login.fornecedor_id };
}

module.exports = { criarConvite, definirSenha, login };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest tests/portal-fornecedor-auth-service.test.js --silent`
Expected: PASS (7 testes)

- [ ] **Step 5: Commit**

```bash
git add src/modules/portal-fornecedor/auth-service.js tests/portal-fornecedor-auth-service.test.js
git commit -m "feat(portal-fornecedor): service de convite, definicao de senha e login"
```

---

### Task 4: Liberar acesso ao portal no cadastro de fornecedor

**Files:**
- Modify: `src/modules/fornecedores/router.js`
- Test: `tests/fornecedores-portal-liberar.test.js`

- [ ] **Step 1: Ler o router atual pra saber onde encaixar a rota nova**

Run: `grep -n "router\." src/modules/fornecedores/router.js`
(confirme os imports existentes de `requireRole`/`db` antes de editar — se `db` não estiver importado no arquivo, adicione `const db = require('../../db');` no topo)

- [ ] **Step 2: Escrever o teste (falhando)**

```js
// tests/fornecedores-portal-liberar.test.js
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/modules/portal-fornecedor/auth-service', () => ({ criarConvite: jest.fn() }));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret';

const db = require('../src/db');
const authService = require('../src/modules/portal-fornecedor/auth-service');
const fornecedoresRouter = require('../src/modules/fornecedores/router');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 'user-1', role: 'admin' }; next(); });
app.use('/fornecedores', fornecedoresRouter);

describe('POST /fornecedores/:id/portal/liberar', () => {
  afterEach(() => jest.clearAllMocks());

  test('libera o portal e retorna o link de convite', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'forn-1', nome: 'Vinil Line' }] }); // busca fornecedor
    authService.criarConvite.mockResolvedValueOnce({ conviteToken: 'abc123' });

    const res = await request(app)
      .post('/fornecedores/forn-1/portal/liberar')
      .send({ email: 'contato@vinilline.com.br' });

    expect(res.status).toBe(200);
    expect(res.body.conviteUrl).toMatch(/\/portal-fornecedor\/definir-senha\.html\?token=abc123$/);
    expect(authService.criarConvite).toHaveBeenCalledWith('forn-1', 'contato@vinilline.com.br');
  });

  test('sem e-mail informado → erro 400', async () => {
    const res = await request(app).post('/fornecedores/forn-1/portal/liberar').send({});
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Instalar `supertest` se ainda não estiver no projeto**

Run: `grep -q '"supertest"' package.json && echo "já instalado" || npm install --save-dev supertest`

- [ ] **Step 4: Rodar e confirmar que falha**

Run: `npx jest tests/fornecedores-portal-liberar.test.js --silent`
Expected: FAIL — rota retorna 404

- [ ] **Step 5: Implementar a rota**

Abra `src/modules/fornecedores/router.js` e adicione (perto das demais rotas `POST`/`PATCH`, usando os mesmos imports já presentes no arquivo):

```js
const authService = require('../portal-fornecedor/auth-service');

router.post('/:id/portal/liberar', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email é obrigatório' });
    const forn = await db.query('SELECT id, nome FROM fornecedores WHERE id = $1', [req.params.id]);
    if (!forn.rows[0]) return res.status(404).json({ error: 'Fornecedor não encontrado' });
    const { conviteToken } = await authService.criarConvite(req.params.id, email);
    const baseUrl = process.env.BASE_URL || 'https://app.graficalkl.com.br';
    res.json({ ok: true, conviteUrl: `${baseUrl}/portal-fornecedor/definir-senha.html?token=${conviteToken}` });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
```

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `npx jest tests/fornecedores-portal-liberar.test.js --silent`
Expected: PASS (2 testes)

- [ ] **Step 7: Rodar a suíte completa**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: baseline conhecida, sem regressão.

- [ ] **Step 8: Commit**

```bash
git add src/modules/fornecedores/router.js tests/fornecedores-portal-liberar.test.js package.json package-lock.json
git commit -m "feat(portal-fornecedor): endpoint para LKL liberar acesso do fornecedor ao portal"
```

---

### Task 5: Bot de verificação (formato, duplicidade, mudança de dado bancário)

**Files:**
- Create: `src/modules/portal-fornecedor/bot-verificacao.js`
- Test: `tests/portal-fornecedor-bot-verificacao.test.js`

- [ ] **Step 1: Escrever o teste (falhando)**

```js
// tests/portal-fornecedor-bot-verificacao.test.js
jest.mock('../src/db', () => ({ query: jest.fn() }));
const db = require('../src/db');
const { verificarSubmissao } = require('../src/modules/portal-fornecedor/bot-verificacao');

beforeEach(() => jest.clearAllMocks());

describe('verificarSubmissao', () => {
  test('PIX com chave em formato inválido → alerta pix_formato_invalido', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // duplicidade
      .mockResolvedValueOnce({ rows: [] }); // última aprovada (não existe ainda)

    const r = await verificarSubmissao('forn-1', {
      nnf: '4521', tipo_pagamento: 'pix', pix_chave: 'abc', boletos: [],
    });

    expect(r.alertas).toContain('pix_formato_invalido');
  });

  test('mesma NF já submetida pelo fornecedor → alerta duplicidade_nf', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'sub-antiga' }] }) // duplicidade encontrada
      .mockResolvedValueOnce({ rows: [] });

    const r = await verificarSubmissao('forn-1', {
      nnf: '4521', tipo_pagamento: 'pix', pix_chave: 'contato@vinilline.com.br', boletos: [],
    });

    expect(r.alertas).toContain('duplicidade_nf');
  });

  test('TED com dado bancário diferente da última aprovada → alerta dado_bancario_mudou', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // duplicidade
      .mockResolvedValueOnce({ rows: [{ ted_banco_codigo: '001', ted_agencia: '1234', ted_conta: '55667-8', ted_documento: '12345678000199', pix_chave: null }] });

    const r = await verificarSubmissao('forn-1', {
      nnf: '4522', tipo_pagamento: 'ted', ted_banco_codigo: '341', ted_agencia: '1234', ted_conta: '55667-8', ted_documento: '12345678000199', boletos: [],
    });

    expect(r.alertas).toContain('dado_bancario_mudou');
  });

  test('TED com dado bancário igual à última aprovada → sem alerta de mudança', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ted_banco_codigo: '341', ted_agencia: '1234', ted_conta: '55667-8', ted_documento: '12345678000199', pix_chave: null }] });

    const r = await verificarSubmissao('forn-1', {
      nnf: '4522', tipo_pagamento: 'ted', ted_banco_codigo: '341', ted_agencia: '1234', ted_conta: '55667-8', ted_documento: '12345678000199', boletos: [],
    });

    expect(r.alertas).not.toContain('dado_bancario_mudou');
  });

  test('primeira submissão do fornecedor (sem histórico aprovado) → sem alerta de mudança', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // nenhuma aprovada ainda

    const r = await verificarSubmissao('forn-1', {
      nnf: '4523', tipo_pagamento: 'pix', pix_chave: 'contato@vinilline.com.br', boletos: [],
    });

    expect(r.alertas).not.toContain('dado_bancario_mudou');
  });

  test('boleto com linha digitável em formato inválido → alerta boleto_linha_invalida', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const r = await verificarSubmissao('forn-1', {
      nnf: '4524', tipo_pagamento: 'boleto', boletos: [{ linha_digitavel: '123' }],
    });

    expect(r.alertas).toContain('boleto_linha_invalida');
  });

  test('boleto não precisa consultar dado bancário (só pix/ted checam mudança)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // só a checagem de duplicidade

    await verificarSubmissao('forn-1', {
      nnf: '4525', tipo_pagamento: 'boleto',
      boletos: [{ linha_digitavel: '34191790010104351004791020150008291070026000' }],
    });

    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/portal-fornecedor-bot-verificacao.test.js --silent`
Expected: FAIL — `Cannot find module '../src/modules/portal-fornecedor/bot-verificacao'`

- [ ] **Step 3: Implementar**

```js
// src/modules/portal-fornecedor/bot-verificacao.js
const db = require('../../db');

function validarChavePix(chave) {
  if (!chave) return false;
  const soDigitos = chave.replace(/\D/g, '');
  const ehCpfCnpj = soDigitos.length === 11 || soDigitos.length === 14;
  const ehEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(chave);
  const ehTelefone = /^\+55\d{10,11}$/.test(chave);
  const ehAleatoria = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chave);
  return ehCpfCnpj || ehEmail || ehTelefone || ehAleatoria;
}

function validarLinhaDigitavel(linha) {
  if (!linha) return false;
  return linha.replace(/\D/g, '').length >= 44;
}

function dadosBancariosMudaram(anterior, atual) {
  if (atual.tipo_pagamento === 'pix') {
    return anterior.pix_chave !== null && anterior.pix_chave !== atual.pix_chave;
  }
  if (atual.tipo_pagamento === 'ted') {
    const camposIguais = anterior.ted_banco_codigo === atual.ted_banco_codigo
      && anterior.ted_agencia === atual.ted_agencia
      && anterior.ted_conta === atual.ted_conta
      && anterior.ted_documento === atual.ted_documento;
    const anteriorTinhaTed = anterior.ted_banco_codigo !== null;
    return anteriorTinhaTed && !camposIguais;
  }
  return false;
}

async function verificarSubmissao(fornecedorId, dados) {
  const alertas = [];

  if (dados.tipo_pagamento === 'pix' && !validarChavePix(dados.pix_chave)) {
    alertas.push('pix_formato_invalido');
  }
  if (dados.tipo_pagamento === 'boleto') {
    for (const b of dados.boletos || []) {
      if (!validarLinhaDigitavel(b.linha_digitavel)) alertas.push('boleto_linha_invalida');
    }
  }

  const dup = await db.query(
    `SELECT id FROM fornecedor_submissoes WHERE fornecedor_id = $1 AND nnf = $2 AND status != 'rejeitada'`,
    [fornecedorId, dados.nnf]
  );
  if (dup.rows.length) alertas.push('duplicidade_nf');

  if (['pix', 'ted'].includes(dados.tipo_pagamento)) {
    const ultima = await db.query(
      `SELECT pix_chave, ted_banco_codigo, ted_agencia, ted_conta, ted_documento
       FROM fornecedor_submissoes
       WHERE fornecedor_id = $1 AND tipo_pagamento = $2 AND status = 'aceita'
       ORDER BY criada_em DESC LIMIT 1`,
      [fornecedorId, dados.tipo_pagamento]
    );
    if (ultima.rows.length && dadosBancariosMudaram(ultima.rows[0], dados)) {
      alertas.push('dado_bancario_mudou');
    }
  }

  return { alertas };
}

module.exports = { verificarSubmissao, validarChavePix, validarLinhaDigitavel, dadosBancariosMudaram };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest tests/portal-fornecedor-bot-verificacao.test.js --silent`
Expected: PASS (7 testes)

- [ ] **Step 5: Commit**

```bash
git add src/modules/portal-fornecedor/bot-verificacao.js tests/portal-fornecedor-bot-verificacao.test.js
git commit -m "feat(portal-fornecedor): bot de verificacao (formato, duplicidade, mudanca de dado bancario)"
```

---

### Task 6: Extensão do OCR — extrair dados da NF e da linha digitável do boleto

**Files:**
- Modify: `src/modules/contas-pagar/ocr.js`
- Test: `tests/contas-pagar-ocr.test.js` (arquivo já existe — adicionar novos casos)

- [ ] **Step 1: Ler o arquivo atual pra entender o padrão de prompt/parsing já usado**

Run: `sed -n '1,60p' src/modules/contas-pagar/ocr.js`

- [ ] **Step 2: Escrever os testes novos (falhando) — anexar ao arquivo existente**

Adicione ao final de `tests/contas-pagar-ocr.test.js` (o arquivo já mocka `openai` no topo — reaproveite o mesmo mock):

```js
describe('extrairDadosNFCompra', () => {
  test('extrai número, emissão e itens da NF a partir da imagem', async () => {
    const openai = require('openai');
    const instancia = openai.mock.results[0].value;
    instancia.chat.completions.create.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        nnf: '4521', emitida_em: '2026-07-21', valor_total: 425.00,
        itens: [{ produto: 'Vinil Fosco 1,20m', quantidade: 50, valor_unitario: 8.50, valor_total: 425.00 }],
      }) } }],
    });

    const { extrairDadosNFCompra } = require('../src/modules/contas-pagar/ocr');
    const r = await extrairDadosNFCompra('/tmp/nf.pdf');

    expect(r.nnf).toBe('4521');
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0].produto).toBe('Vinil Fosco 1,20m');
  });

  test('resposta sem JSON válido → retorna null', async () => {
    const openai = require('openai');
    const instancia = openai.mock.results[0].value;
    instancia.chat.completions.create.mockResolvedValueOnce({ choices: [{ message: { content: 'não consegui ler' } }] });

    const { extrairDadosNFCompra } = require('../src/modules/contas-pagar/ocr');
    const r = await extrairDadosNFCompra('/tmp/nf.pdf');
    expect(r).toBeNull();
  });
});

describe('extrairLinhaDigitavel', () => {
  test('extrai a linha digitável de uma imagem de boleto', async () => {
    const openai = require('openai');
    const instancia = openai.mock.results[0].value;
    instancia.chat.completions.create.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        linha_digitavel: '34191790010104351004791020150008291070026000', valor: 425.00, vencimento: '2026-08-10',
      }) } }],
    });

    const { extrairLinhaDigitavel } = require('../src/modules/contas-pagar/ocr');
    const r = await extrairLinhaDigitavel('/tmp/boleto.jpg');

    expect(r.linha_digitavel).toBe('34191790010104351004791020150008291070026000');
    expect(r.valor).toBe(425.00);
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npx jest tests/contas-pagar-ocr.test.js --silent`
Expected: FAIL — `extrairDadosNFCompra is not a function`

- [ ] **Step 4: Implementar, reaproveitando `_dataUri` e o cliente `openai` já existentes no arquivo**

No final de `src/modules/contas-pagar/ocr.js`, antes do `module.exports`, adicione:

```js
function _promptNFCompra() {
  return `Você recebe a imagem/PDF de uma Nota Fiscal de compra de mercadoria. Extraia em JSON:
{
  "nnf": "número da NF (string)",
  "emitida_em": "data de emissão no formato YYYY-MM-DD",
  "valor_total": número (valor total da nota),
  "itens": [{ "produto": "descrição do produto", "quantidade": número, "valor_unitario": número, "valor_total": número }]
}
Responda APENAS o JSON, sem texto adicional. Se não conseguir identificar um campo, use null.`;
}

async function extrairDadosNFCompra(absPath) {
  const dataUri = _dataUri(absPath);
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [
      { role: 'system', content: _promptNFCompra() },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] },
    ],
    temperature: 0,
    max_tokens: 800,
  });
  const texto = response.choices[0]?.message?.content || '';
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function _promptLinhaDigitavel() {
  return `Você recebe a imagem de um boleto bancário. Extraia em JSON:
{ "linha_digitavel": "os dígitos da linha digitável, sem espaços", "valor": número, "vencimento": "YYYY-MM-DD" }
Responda APENAS o JSON. Se não conseguir ler algum campo, use null.`;
}

async function extrairLinhaDigitavel(absPath) {
  const dataUri = _dataUri(absPath);
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [
      { role: 'system', content: _promptLinhaDigitavel() },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] },
    ],
    temperature: 0,
    max_tokens: 300,
  });
  const texto = response.choices[0]?.message?.content || '';
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
```

Atualize o `module.exports` no final do arquivo pra incluir as duas novas funções:

```js
module.exports = { extrairDadosComprovante, _validarDadosExtraidos, _cnpjsProprios, extrairDadosNFCompra, extrairLinhaDigitavel };
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx jest tests/contas-pagar-ocr.test.js --silent`
Expected: PASS (todos os testes do arquivo, incluindo os novos)

- [ ] **Step 6: Rodar a suíte completa**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: baseline conhecida, sem regressão.

- [ ] **Step 7: Commit**

```bash
git add src/modules/contas-pagar/ocr.js tests/contas-pagar-ocr.test.js
git commit -m "feat(portal-fornecedor): extrai dados de NF de compra e linha digitavel de boleto via OCR"
```

---

### Task 7: Extensão de `criarOuReconciliarContaPagar` para agrupar múltiplos boletos como parcelas

**Files:**
- Modify: `src/modules/contas-pagar/service.js`
- Test: `tests/contas-pagar-service.test.js`

- [ ] **Step 1: Escrever o teste (falhando)**

Adicione ao `describe('criarOuReconciliarContaPagar', ...)` já existente em `tests/contas-pagar-service.test.js`:

```js
  test('com parcelaGrupoId, zero correspondências → INSERT inclui colunas de parcela', async () => {
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        expect(sql).toContain('parcela_grupo_id');
        expect(sql).toContain('parcela_numero');
        expect(sql).toContain('parcela_total');
        expect(params).toContain('grupo-uuid-1');
        expect(params).toContain(1);
        expect(params).toContain(2);
        return Promise.resolve({ rows: [{ id: 90 }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-9', fornecedorNome: 'Vinil Line', descricao: 'NF 4521 — boleto 1/2',
      valor: 212.50, vencimento: '2026-08-10', tipoDespesaId: 4, tipoEntrada: 'entrada_estoque',
      linhaDigitavel: '341...', parcelaGrupoId: 'grupo-uuid-1', parcelaNumero: 1, parcelaTotal: 2,
    });

    expect(r.id).toBe(90);
  });
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/contas-pagar-service.test.js -t "parcelaGrupoId" --silent`
Expected: FAIL — `sql toContain('parcela_grupo_id')` falha (colunas ausentes do INSERT)

- [ ] **Step 3: Implementar**

Em `src/modules/contas-pagar/service.js`, na assinatura de `criarOuReconciliarContaPagar` (por volta da linha 540), adicione os 3 novos parâmetros e inclua-os condicionalmente no INSERT, seguindo o mesmo padrão já usado pra `competencia`:

```js
async function criarOuReconciliarContaPagar({ fornecedorId, fornecedorNome, valor, vencimento, descricao, tipoDespesaId, tipoEntrada, linhaDigitavel, tipo, competencia, parcelaGrupoId, parcelaNumero, parcelaTotal }) {
```

E no branch de criação (`else` do `if (match)`, dentro do mesmo `try`), logo após a linha que adiciona `competencia`:

```js
      if (competencia) { colunas.push('competencia'); valores.push(competencia); }
      if (parcelaGrupoId) {
        colunas.push('parcela_grupo_id', 'parcela_numero', 'parcela_total');
        valores.push(parcelaGrupoId, parcelaNumero, parcelaTotal);
      }
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest tests/contas-pagar-service.test.js --silent`
Expected: PASS (todos os testes do arquivo, incluindo o novo)

- [ ] **Step 5: Commit**

```bash
git add src/modules/contas-pagar/service.js tests/contas-pagar-service.test.js
git commit -m "feat(portal-fornecedor): criarOuReconciliarContaPagar aceita agrupamento de parcelas"
```

---

### Task 8: Service e router — submissão de NF pelo fornecedor

**Files:**
- Create: `src/modules/portal-fornecedor/submissao-service.js`
- Create: `src/modules/portal-fornecedor/router.js`
- Test: `tests/portal-fornecedor-submissao-service.test.js`

- [ ] **Step 1: Escrever o teste (falhando)**

```js
// tests/portal-fornecedor-submissao-service.test.js
jest.mock('../src/db', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock('../src/modules/portal-fornecedor/bot-verificacao', () => ({ verificarSubmissao: jest.fn() }));

function mockClient(queryImpl) {
  return { query: jest.fn(queryImpl), release: jest.fn() };
}

const db = require('../src/db');
const botVerificacao = require('../src/modules/portal-fornecedor/bot-verificacao');
const submissaoService = require('../src/modules/portal-fornecedor/submissao-service');

beforeEach(() => jest.clearAllMocks());

describe('criarSubmissao', () => {
  test('sem alertas → status aguardando_entrega', async () => {
    botVerificacao.verificarSubmissao.mockResolvedValueOnce({ alertas: [] });
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO fornecedor_submissoes')) return Promise.resolve({ rows: [{ id: 'sub-1' }] });
      if (sql.startsWith('INSERT INTO fornecedor_submissao_itens')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await submissaoService.criarSubmissao('forn-1', {
      nnf: '4521', valor_total: 425, tipo_pagamento: 'pix', pix_chave: 'contato@vinilline.com.br',
      itens: [{ produto: 'Vinil', quantidade: 50, valor_unitario: 8.5, valor_total: 425 }], boletos: [],
    });

    expect(r.submissao.id).toBe('sub-1');
    const insertSubmissao = client.query.mock.calls.find(c => c[0].startsWith('INSERT INTO fornecedor_submissoes'));
    expect(insertSubmissao[0]).toContain("'aguardando_entrega'");
  });

  test('com alerta dado_bancario_mudou → status alerta_dado_bancario', async () => {
    botVerificacao.verificarSubmissao.mockResolvedValueOnce({ alertas: ['dado_bancario_mudou'] });
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO fornecedor_submissoes')) return Promise.resolve({ rows: [{ id: 'sub-2' }] });
      if (sql.startsWith('INSERT INTO fornecedor_submissao_itens')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await submissaoService.criarSubmissao('forn-1', {
      nnf: '4522', valor_total: 100, tipo_pagamento: 'ted', ted_banco_codigo: '341',
      itens: [], boletos: [],
    });

    const insertSubmissao = client.query.mock.calls.find(c => c[0].startsWith('INSERT INTO fornecedor_submissoes'));
    expect(insertSubmissao[0]).toContain("'alerta_dado_bancario'");
  });

  test('com alerta de formato/duplicidade (não bancário) → status pendente', async () => {
    botVerificacao.verificarSubmissao.mockResolvedValueOnce({ alertas: ['duplicidade_nf'] });
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO fornecedor_submissoes')) return Promise.resolve({ rows: [{ id: 'sub-3' }] });
      if (sql.startsWith('INSERT INTO fornecedor_submissao_itens')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await submissaoService.criarSubmissao('forn-1', {
      nnf: '4521', valor_total: 425, tipo_pagamento: 'pix', pix_chave: 'x', itens: [], boletos: [],
    });

    const insertSubmissao = client.query.mock.calls.find(c => c[0].startsWith('INSERT INTO fornecedor_submissoes'));
    expect(insertSubmissao[0]).toContain("'pendente'");
  });
});

describe('listarFila', () => {
  test('sem filtro → lista todas ordenadas por criada_em desc', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'sub-1' }, { id: 'sub-2' }] });
    const r = await submissaoService.listarFila({});
    expect(r).toHaveLength(2);
    expect(db.query.mock.calls[0][0]).toMatch(/ORDER BY s.criada_em DESC/);
  });

  test('com filtro de status → adiciona WHERE', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await submissaoService.listarFila({ status: 'alerta_dado_bancario' });
    expect(db.query.mock.calls[0][0]).toMatch(/WHERE s.status = \$1/);
    expect(db.query.mock.calls[0][1]).toEqual(['alerta_dado_bancario']);
  });
});

describe('aprovarDadoBancario', () => {
  test('muda status de alerta_dado_bancario para aguardando_entrega', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'sub-1' }] });
    const r = await submissaoService.aprovarDadoBancario('sub-1', 'user-1');
    expect(r.ok).toBe(true);
    expect(db.query.mock.calls[0][0]).toMatch(/UPDATE fornecedor_submissoes SET status = 'aguardando_entrega'/);
  });

  test('submissão não encontrada ou não está em alerta → erro', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await submissaoService.aprovarDadoBancario('sub-999', 'user-1');
    expect(r.erro).toEqual(['Submissão não encontrada ou não está aguardando aprovação de dado bancário']);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/portal-fornecedor-submissao-service.test.js --silent`
Expected: FAIL — `Cannot find module '../src/modules/portal-fornecedor/submissao-service'`

- [ ] **Step 3: Implementar o service**

```js
// src/modules/portal-fornecedor/submissao-service.js
const db = require('../../db');
const { pool } = require('../../db');
const { verificarSubmissao } = require('./bot-verificacao');

function _statusInicial(alertas) {
  if (alertas.includes('dado_bancario_mudou')) return 'alerta_dado_bancario';
  if (alertas.length) return 'pendente';
  return 'aguardando_entrega';
}

async function criarSubmissao(fornecedorId, dados) {
  const { alertas } = await verificarSubmissao(fornecedorId, dados);
  const status = _statusInicial(alertas);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sub = await client.query(
      `INSERT INTO fornecedor_submissoes
         (fornecedor_id, nnf, emitida_em, data_entrega_agendada, valor_total, arquivo_nf_path,
          tipo_pagamento, pix_chave, ted_banco_nome, ted_banco_codigo, ted_tipo_conta, ted_titularidade,
          ted_documento, ted_agencia, ted_conta, link_mp_url, status, bot_verificacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'${status}',$17)
       RETURNING *`,
      [fornecedorId, dados.nnf || null, dados.emitida_em || null, dados.data_entrega_agendada || null,
       dados.valor_total, dados.arquivo_nf_path || null, dados.tipo_pagamento,
       dados.pix_chave || null, dados.ted_banco_nome || null, dados.ted_banco_codigo || null,
       dados.ted_tipo_conta || null, dados.ted_titularidade || null, dados.ted_documento || null,
       dados.ted_agencia || null, dados.ted_conta || null, dados.link_mp_url || null,
       JSON.stringify({ alertas })]
    );
    const submissao = sub.rows[0];

    for (const it of dados.itens || []) {
      await client.query(
        `INSERT INTO fornecedor_submissao_itens (submissao_id, produto, quantidade, valor_unitario, valor_total)
         VALUES ($1,$2,$3,$4,$5)`,
        [submissao.id, it.produto, it.quantidade, it.valor_unitario, it.valor_total]
      );
    }
    for (const b of dados.boletos || []) {
      await client.query(
        `INSERT INTO fornecedor_submissao_boletos (submissao_id, arquivo_path, linha_digitavel, valor, vencimento)
         VALUES ($1,$2,$3,$4,$5)`,
        [submissao.id, b.arquivo_path, b.linha_digitavel || null, b.valor || null, b.vencimento || null]
      );
    }
    await client.query('COMMIT');
    return { submissao, alertas };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function listarMinhasSubmissoes(fornecedorId) {
  const r = await db.query(
    `SELECT * FROM fornecedor_submissoes WHERE fornecedor_id = $1 ORDER BY criada_em DESC`,
    [fornecedorId]
  );
  return r.rows;
}

async function listarFila({ status } = {}) {
  const params = [];
  let where = '';
  if (status) { params.push(status); where = 'WHERE s.status = $1'; }
  const r = await db.query(
    `SELECT s.*, f.nome AS fornecedor_nome
     FROM fornecedor_submissoes s
     JOIN fornecedores f ON f.id = s.fornecedor_id
     ${where}
     ORDER BY s.criada_em DESC`,
    params
  );
  return r.rows;
}

async function buscarSubmissaoDetalhe(id) {
  const sub = await db.query(
    `SELECT s.*, f.nome AS fornecedor_nome FROM fornecedor_submissoes s
     JOIN fornecedores f ON f.id = s.fornecedor_id WHERE s.id = $1`,
    [id]
  );
  if (!sub.rows[0]) return null;
  const itens = await db.query('SELECT * FROM fornecedor_submissao_itens WHERE submissao_id = $1', [id]);
  const boletos = await db.query('SELECT * FROM fornecedor_submissao_boletos WHERE submissao_id = $1', [id]);
  return { ...sub.rows[0], itens: itens.rows, boletos: boletos.rows };
}

async function aprovarDadoBancario(submissaoId, userId) {
  const r = await db.query(
    `UPDATE fornecedor_submissoes SET status = 'aguardando_entrega', revisada_por = $2, revisada_em = NOW()
     WHERE id = $1 AND status = 'alerta_dado_bancario' RETURNING id`,
    [submissaoId, userId]
  );
  if (!r.rows.length) return { erro: ['Submissão não encontrada ou não está aguardando aprovação de dado bancário'] };
  return { ok: true };
}

module.exports = { criarSubmissao, listarMinhasSubmissoes, listarFila, buscarSubmissaoDetalhe, aprovarDadoBancario };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest tests/portal-fornecedor-submissao-service.test.js --silent`
Expected: PASS (7 testes)

- [ ] **Step 5: Criar o router do fornecedor (login público + submissões protegidas)**

```js
// src/modules/portal-fornecedor/router.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const { requireAuthFornecedor } = require('../../middleware/auth');
const authService = require('./auth-service');
const submissaoService = require('./submissao-service');
const ocr = require('../contas-pagar/ocr');

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, '../../../public/uploads/fornecedor-submissoes'),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '';
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ── Rotas públicas ──────────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: 'email e senha são obrigatórios' });
  const r = await authService.login(email, senha);
  if (r.erro) return res.status(401).json({ error: r.erro[0] });
  res.json({ token: r.token });
});

router.post('/definir-senha', async (req, res) => {
  const { token, senha } = req.body;
  if (!token || !senha) return res.status(400).json({ error: 'token e senha são obrigatórios' });
  const r = await authService.definirSenha(token, senha);
  if (r.erro) return res.status(400).json({ error: r.erro[0] });
  res.json({ ok: true });
});

// ── Rotas do fornecedor autenticado ─────────────────────────────────────────

router.use(requireAuthFornecedor);

router.post('/nf/extrair', upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const dados = await ocr.extrairDadosNFCompra(req.file.path);
  if (!dados) return res.status(422).json({ error: 'Não consegui ler os dados da NF — preencha manualmente' });
  res.json({ ...dados, arquivo_nf_path: `/uploads/fornecedor-submissoes/${req.file.filename}` });
});

router.post('/boleto/extrair', upload.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  const dados = await ocr.extrairLinhaDigitavel(req.file.path);
  if (!dados) return res.status(422).json({ error: 'Não consegui ler a linha digitável — preencha manualmente' });
  res.json({ ...dados, arquivo_path: `/uploads/fornecedor-submissoes/${req.file.filename}` });
});

router.post('/submissoes', async (req, res) => {
  try {
    const { submissao, alertas } = await submissaoService.criarSubmissao(req.fornecedor.fornecedorId, req.body);
    res.status(201).json({ submissao, alertas });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/submissoes', async (req, res) => {
  const r = await submissaoService.listarMinhasSubmissoes(req.fornecedor.fornecedorId);
  res.json(r);
});

module.exports = router;
```

- [ ] **Step 6: Registrar o router (sem `requireAuthApi` blanket — a auth é interna ao próprio router)**

Em `src/modules/index.js`, adicione, junto às demais linhas `router.use`:

```js
router.use('/portal-fornecedor', require('./portal-fornecedor/router'));
```

- [ ] **Step 7: Criar o diretório de upload no servidor**

Run: `mkdir -p public/uploads/fornecedor-submissoes`

- [ ] **Step 8: Rodar a suíte completa**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: baseline conhecida, sem regressão.

- [ ] **Step 9: Commit**

```bash
git add src/modules/portal-fornecedor/submissao-service.js src/modules/portal-fornecedor/router.js src/modules/index.js tests/portal-fornecedor-submissao-service.test.js public/uploads/fornecedor-submissoes/.gitkeep
git commit -m "feat(portal-fornecedor): service e router de submissao de NF (fornecedor)"
```

(Se `public/uploads/fornecedor-submissoes` ficar vazio, crie um arquivo `.gitkeep` nele antes do commit, senão o Git não versiona a pasta: `touch public/uploads/fornecedor-submissoes/.gitkeep`)

---

### Task 9: Router interno — fila de submissões (LKL)

**Files:**
- Create: `src/modules/fornecedor-submissoes/router.js`
- Test: `tests/fornecedor-submissoes-router.test.js`

- [ ] **Step 1: Escrever o teste (falhando)**

```js
// tests/fornecedor-submissoes-router.test.js
jest.mock('../src/modules/portal-fornecedor/submissao-service', () => ({
  listarFila: jest.fn(), buscarSubmissaoDetalhe: jest.fn(), aprovarDadoBancario: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const submissaoService = require('../src/modules/portal-fornecedor/submissao-service');
const fornecedorSubmissoesRouter = require('../src/modules/fornecedor-submissoes/router');

function appComRole(role) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'user-1', role }; next(); });
  app.use('/fornecedor-submissoes', fornecedorSubmissoesRouter);
  return app;
}

describe('GET /fornecedor-submissoes', () => {
  afterEach(() => jest.clearAllMocks());

  test('lista a fila', async () => {
    submissaoService.listarFila.mockResolvedValueOnce([{ id: 'sub-1' }]);
    const res = await request(appComRole('atendente')).get('/fornecedor-submissoes');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('filtra por status via query param', async () => {
    submissaoService.listarFila.mockResolvedValueOnce([]);
    await request(appComRole('atendente')).get('/fornecedor-submissoes?status=alerta_dado_bancario');
    expect(submissaoService.listarFila).toHaveBeenCalledWith({ status: 'alerta_dado_bancario' });
  });
});

describe('POST /fornecedor-submissoes/:id/aprovar-dado-bancario', () => {
  afterEach(() => jest.clearAllMocks());

  test('admin consegue aprovar', async () => {
    submissaoService.aprovarDadoBancario.mockResolvedValueOnce({ ok: true });
    const res = await request(appComRole('admin')).post('/fornecedor-submissoes/sub-1/aprovar-dado-bancario');
    expect(res.status).toBe(200);
  });

  test('atendente NÃO consegue aprovar (403)', async () => {
    const res = await request(appComRole('atendente')).post('/fornecedor-submissoes/sub-1/aprovar-dado-bancario');
    expect(res.status).toBe(403);
    expect(submissaoService.aprovarDadoBancario).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/fornecedor-submissoes-router.test.js --silent`
Expected: FAIL — `Cannot find module '../src/modules/fornecedor-submissoes/router'`

- [ ] **Step 3: Implementar**

```js
// src/modules/fornecedor-submissoes/router.js
const express = require('express');
const router = express.Router();
const { requireRole } = require('../../middleware/auth');
const submissaoService = require('../portal-fornecedor/submissao-service');

router.get('/', async (req, res) => {
  try {
    const r = await submissaoService.listarFila({ status: req.query.status });
    res.json(r);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await submissaoService.buscarSubmissaoDetalhe(req.params.id);
    if (!r) return res.status(404).json({ error: 'Submissão não encontrada' });
    res.json(r);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/:id/aprovar-dado-bancario', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const r = await submissaoService.aprovarDadoBancario(req.params.id, req.user.id);
    if (r.erro) return res.status(400).json({ erro: r.erro });
    res.json(r);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
```

- [ ] **Step 4: Registrar o router (com `requireAuthApi`, como os demais módulos internos)**

Em `src/modules/index.js`:

```js
router.use('/fornecedor-submissoes', requireAuthApi, require('./fornecedor-submissoes/router'));
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx jest tests/fornecedor-submissoes-router.test.js --silent`
Expected: PASS (4 testes)

- [ ] **Step 6: Rodar a suíte completa**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: baseline conhecida, sem regressão.

- [ ] **Step 7: Commit**

```bash
git add src/modules/fornecedor-submissoes/router.js src/modules/index.js tests/fornecedor-submissoes-router.test.js
git commit -m "feat(portal-fornecedor): router interno da fila de submissoes (LKL)"
```

---

### Task 10: Integração com Entrada de Estoque — pré-preenchimento e aceite

**Files:**
- Modify: `src/modules/entradas/service.js`
- Modify: `src/modules/entradas/router.js`
- Test: `tests/entradas-fornecedor-submissao.test.js`

- [ ] **Step 1: Ler o `confirmar()` e o router atuais**

Run: `sed -n '79,145p' src/modules/entradas/service.js` e `grep -n "router\." src/modules/entradas/router.js`

- [ ] **Step 2: Escrever o teste (falhando)**

```js
// tests/entradas-fornecedor-submissao.test.js
jest.mock('../src/db', () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock('../src/modules/contas-pagar/service', () => ({ criarOuReconciliarContaPagar: jest.fn() }));

function mockClient(queryImpl) {
  return { query: jest.fn(queryImpl), release: jest.fn() };
}

const db = require('../src/db');
const contasPagarService = require('../src/modules/contas-pagar/service');
const service = require('../src/modules/entradas/service');

beforeEach(() => jest.clearAllMocks());

describe('confirmar — com fornecedor_submissao_id e múltiplos boletos', () => {
  test('grava fornecedor_submissao_id na entrada, atualiza status da submissão pra aceita, e cria uma conta a pagar por boleto com o mesmo parcela_grupo_id', async () => {
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO entradas_estoque')) return Promise.resolve({ rows: [{ id: 'entrada-1' }] });
      if (sql.startsWith('INSERT INTO entradas_estoque_itens')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);
    db.query
      .mockResolvedValueOnce({ rows: [{ nome: 'Vinil Line' }] }) // busca nome do fornecedor
      .mockResolvedValueOnce({ rows: [] }) // UPDATE entradas_estoque SET fornecedor_submissao_id
      .mockResolvedValueOnce({ rows: [] }); // UPDATE fornecedor_submissoes SET status='aceita'
    contasPagarService.criarOuReconciliarContaPagar
      .mockResolvedValueOnce({ id: 201 })
      .mockResolvedValueOnce({ id: 202 });

    const r = await service.confirmar({
      fornecedor_id: 'forn-1', nnf: '4521', emitida_em: '2026-07-21', valor_total: 425, itens: [],
      fornecedor_submissao_id: 'sub-1',
      boletos: [
        { linha_digitavel: '341...001', valor: 212.50, vencimento: '2026-08-10' },
        { linha_digitavel: '341...002', valor: 212.50, vencimento: '2026-09-10' },
      ],
    });

    expect(r.entrada.id).toBe('entrada-1');
    expect(contasPagarService.criarOuReconciliarContaPagar).toHaveBeenCalledTimes(2);
    const chamada1 = contasPagarService.criarOuReconciliarContaPagar.mock.calls[0][0];
    const chamada2 = contasPagarService.criarOuReconciliarContaPagar.mock.calls[1][0];
    expect(chamada1.parcelaGrupoId).toBe(chamada2.parcelaGrupoId);
    expect(chamada1.parcelaNumero).toBe(1);
    expect(chamada2.parcelaNumero).toBe(2);
    expect(chamada1.parcelaTotal).toBe(2);
    expect(chamada1.linhaDigitavel).toBe('341...001');

    const updateEntrada = db.query.mock.calls.find(c => c[0].startsWith('UPDATE entradas_estoque SET fornecedor_submissao_id'));
    expect(updateEntrada[1]).toEqual(['sub-1', 'entrada-1']);
    const updateSubmissao = db.query.mock.calls.find(c => c[0].startsWith('UPDATE fornecedor_submissoes'));
    expect(updateSubmissao[0]).toMatch(/status = 'aceita'/);
    expect(updateSubmissao[1]).toEqual(['entrada-1', 'sub-1']);
  });

  test('sem fornecedor_submissao_id → comportamento antigo inalterado (1 conta a pagar, sem parcela)', async () => {
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('INSERT INTO entradas_estoque')) return Promise.resolve({ rows: [{ id: 'entrada-2' }] });
      if (sql.startsWith('INSERT INTO entradas_estoque_itens')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);
    db.query
      .mockResolvedValueOnce({ rows: [{ nome: 'Fornecedor X' }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE conta_pagar_id (comportamento já existente)
    contasPagarService.criarOuReconciliarContaPagar.mockResolvedValueOnce({ id: 300 });

    await service.confirmar({ fornecedor_id: 'forn-2', nnf: '999', valor_total: 100, itens: [] });

    expect(contasPagarService.criarOuReconciliarContaPagar).toHaveBeenCalledTimes(1);
    expect(contasPagarService.criarOuReconciliarContaPagar.mock.calls[0][0].parcelaGrupoId).toBeUndefined();
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npx jest tests/entradas-fornecedor-submissao.test.js --silent`
Expected: FAIL — comportamento novo não implementado (chamadas a `criarOuReconciliarContaPagar` não batem)

- [ ] **Step 4: Implementar**

Em `src/modules/entradas/service.js`, adicione `const crypto = require('crypto');` no topo (junto aos outros `require`), atualize a assinatura de `confirmar` e o bloco de geração de conta a pagar:

```js
async function confirmar({ chave, nnf, emitida_em, valor_total, fornecedor_id, itens, fornecedor_submissao_id, boletos }) {
```

Substitua o bloco `if (fornecedor_id && valor_total) { ... }` (linhas ~117-134) por:

```js
    if (fornecedor_id && valor_total) {
      try {
        const fornecedorR = await db.query('SELECT nome FROM fornecedores WHERE id=$1', [fornecedor_id]);
        const vencimentoProvisorio = emitida_em
          ? format(addDays(new Date(`${emitida_em}T00:00:00`), 30), 'yyyy-MM-dd')
          : format(addDays(new Date(), 30), 'yyyy-MM-dd');

        if (Array.isArray(boletos) && boletos.length > 1) {
          const parcelaGrupoId = crypto.randomUUID();
          for (let i = 0; i < boletos.length; i++) {
            await contasPagarService.criarOuReconciliarContaPagar({
              fornecedorId: fornecedor_id,
              fornecedorNome: fornecedorR.rows[0]?.nome || null,
              descricao: `NF ${nnf || 's/nº'} — boleto ${i + 1}/${boletos.length}`,
              valor: boletos[i].valor,
              vencimento: boletos[i].vencimento || vencimentoProvisorio,
              linhaDigitavel: boletos[i].linha_digitavel,
              tipoEntrada: 'entrada_estoque',
              parcelaGrupoId, parcelaNumero: i + 1, parcelaTotal: boletos.length,
            });
          }
        } else {
          const conta = await contasPagarService.criarOuReconciliarContaPagar({
            fornecedorId: fornecedor_id,
            fornecedorNome: fornecedorR.rows[0]?.nome || null,
            descricao: `NF ${nnf || 's/nº'} — entrada de estoque`,
            valor: (Array.isArray(boletos) && boletos.length === 1) ? boletos[0].valor : valor_total,
            vencimento: (Array.isArray(boletos) && boletos.length === 1) ? (boletos[0].vencimento || vencimentoProvisorio) : vencimentoProvisorio,
            linhaDigitavel: (Array.isArray(boletos) && boletos.length === 1) ? boletos[0].linha_digitavel : undefined,
            tipoEntrada: 'entrada_estoque',
          });
          if (!fornecedor_submissao_id) {
            await db.query('UPDATE entradas_estoque SET conta_pagar_id=$1 WHERE id=$2', [conta.id, entrada.id]);
          }
        }

        if (fornecedor_submissao_id) {
          await db.query('UPDATE entradas_estoque SET fornecedor_submissao_id=$1 WHERE id=$2', [fornecedor_submissao_id, entrada.id]);
          await db.query(
            `UPDATE fornecedor_submissoes SET status='aceita', entrada_estoque_id=$1, revisada_em=NOW() WHERE id=$2`,
            [entrada.id, fornecedor_submissao_id]
          );
        }
      } catch (e) {
        console.error('[ENTRADAS] Erro ao gerar conta a pagar da NF:', e.message);
      }
    }
```

*(A checagem `if (!fornecedor_submissao_id)` antes do `UPDATE ... conta_pagar_id` preserva o comportamento antigo exatamente como estava pra entradas sem submissão de portal — evita gravar `conta_pagar_id` de forma ambígua quando existem múltiplas parcelas.)*

Atualize também o `module.exports` do arquivo se necessário (já exporta `confirmar`, nenhuma mudança aí).

- [ ] **Step 5: Adicionar endpoint pra pré-preencher a partir de uma submissão**

Em `src/modules/entradas/router.js`, adicione (usando os imports já presentes no arquivo):

Formate a resposta EXATAMENTE como o formato que `abrirPreviewNfe(data)` já espera em
`dashboard.html` (mesma forma que o preview de XML de NF-e gera: `data.fornecedor.nome`,
`data.itens[].xprod/qcom/ucom`), acrescentando só os dois campos novos que o fluxo do
portal precisa (`fornecedor_submissao_id`, `boletos`) — assim a Task 13 reaproveita o
modal existente sem nenhuma tela nova:

```js
const submissaoService = require('../portal-fornecedor/submissao-service');
const db = require('../../db');

router.get('/pre-preenchido/:submissaoId', async (req, res) => {
  try {
    const sub = await submissaoService.buscarSubmissaoDetalhe(req.params.submissaoId);
    if (!sub) return res.status(404).json({ error: 'Submissão não encontrada' });
    const forn = await db.query('SELECT id, nome FROM fornecedores WHERE id = $1', [sub.fornecedor_id]);
    res.json({
      chave: null,
      nnf: sub.nnf,
      emitida_em: sub.emitida_em,
      valor_total: sub.valor_total,
      fornecedor: forn.rows[0] || null,
      itens: sub.itens.map(it => ({
        xprod: it.produto, cprod: null, cean: null, ucom: 'UN',
        qcom: Number(it.quantidade), vun: Number(it.valor_unitario), material_id: null,
      })),
      fornecedor_submissao_id: sub.id,
      boletos: sub.boletos.map(b => ({ linha_digitavel: b.linha_digitavel, valor: Number(b.valor), vencimento: b.vencimento })),
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
```

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `npx jest tests/entradas-fornecedor-submissao.test.js --silent`
Expected: PASS (2 testes)

- [ ] **Step 7: Rodar a suíte completa, incluindo os testes já existentes de `entradas`**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: baseline conhecida (5 suites por Postgres local ausente), sem regressão nova — preste atenção especial a qualquer teste existente de `entradas/service.js` que possa quebrar por causa da mudança no bloco de geração de conta a pagar.

- [ ] **Step 8: Commit**

```bash
git add src/modules/entradas/service.js src/modules/entradas/router.js tests/entradas-fornecedor-submissao.test.js
git commit -m "feat(portal-fornecedor): entrada de estoque aceita submissao do fornecedor e gera parcelas por boleto"
```

---

### Task 11: PWA do fornecedor — login e definição de senha

**Files:**
- Create: `public/portal-fornecedor/login.html`
- Create: `public/portal-fornecedor/definir-senha.html`

- [ ] **Step 1: Criar a página de login**

```html
<!-- public/portal-fornecedor/login.html -->
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Portal do Fornecedor — Gráfica LKL</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f5f5f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border-radius: 16px; padding: 32px; width: 100%; max-width: 360px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 4px; color: #1a237e; }
  p.sub { color: #888; font-size: 13px; margin: 0 0 24px; }
  input { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 12px; font-size: 14px; box-sizing: border-box; }
  button { width: 100%; padding: 12px; background: #1a237e; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .erro { color: #c62828; font-size: 13px; margin-top: 8px; display: none; }
</style>
</head>
<body>
  <div class="card">
    <h1>🏭 Gráfica LKL</h1>
    <p class="sub">Portal do Fornecedor</p>
    <input type="email" id="email" placeholder="E-mail">
    <input type="password" id="senha" placeholder="Senha">
    <button onclick="entrar()">Entrar</button>
    <p class="erro" id="erro"></p>
  </div>
  <script>
    async function entrar() {
      const email = document.getElementById('email').value.trim();
      const senha = document.getElementById('senha').value;
      const erroEl = document.getElementById('erro');
      erroEl.style.display = 'none';
      const r = await fetch('/api/v2/portal-fornecedor/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, senha }),
      });
      const data = await r.json();
      if (!r.ok) { erroEl.textContent = data.error || 'Erro ao entrar'; erroEl.style.display = 'block'; return; }
      localStorage.setItem('lkl_fornecedor_token', data.token);
      window.location.href = '/portal-fornecedor/nova-nf.html';
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: Criar a página de definição de senha (link do convite)**

```html
<!-- public/portal-fornecedor/definir-senha.html -->
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Definir senha — Portal do Fornecedor</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f5f5f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border-radius: 16px; padding: 32px; width: 100%; max-width: 360px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 4px; color: #1a237e; }
  p.sub { color: #888; font-size: 13px; margin: 0 0 24px; }
  input { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 12px; font-size: 14px; box-sizing: border-box; }
  button { width: 100%; padding: 12px; background: #1a237e; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .msg { font-size: 13px; margin-top: 8px; display: none; }
  .erro { color: #c62828; } .sucesso { color: #2e7d32; }
</style>
</head>
<body>
  <div class="card">
    <h1>🏭 Gráfica LKL</h1>
    <p class="sub">Defina sua senha de acesso ao portal</p>
    <input type="password" id="senha" placeholder="Nova senha (mín. 8 caracteres)">
    <input type="password" id="senha2" placeholder="Confirme a senha">
    <button onclick="definir()">Definir senha</button>
    <p class="msg" id="msg"></p>
  </div>
  <script>
    async function definir() {
      const token = new URLSearchParams(window.location.search).get('token');
      const senha = document.getElementById('senha').value;
      const senha2 = document.getElementById('senha2').value;
      const msgEl = document.getElementById('msg');
      msgEl.style.display = 'none'; msgEl.className = 'msg';
      if (senha.length < 8) { msgEl.textContent = 'A senha precisa ter pelo menos 8 caracteres'; msgEl.classList.add('erro'); msgEl.style.display = 'block'; return; }
      if (senha !== senha2) { msgEl.textContent = 'As senhas não coincidem'; msgEl.classList.add('erro'); msgEl.style.display = 'block'; return; }
      const r = await fetch('/api/v2/portal-fornecedor/definir-senha', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, senha }),
      });
      const data = await r.json();
      if (!r.ok) { msgEl.textContent = data.error || 'Erro ao definir senha'; msgEl.classList.add('erro'); msgEl.style.display = 'block'; return; }
      msgEl.textContent = 'Senha definida! Redirecionando pro login...'; msgEl.classList.add('sucesso'); msgEl.style.display = 'block';
      setTimeout(() => { window.location.href = '/portal-fornecedor/login.html'; }, 1500);
    }
  </script>
</body>
</html>
```

- [ ] **Step 3: Testar manualmente**

Suba o servidor local (ou no VPS após o deploy) e acesse `/portal-fornecedor/login.html` — confirme que a página carrega e que o botão "Entrar" chama a API (mesmo sem login válido ainda, deve mostrar "Credenciais inválidas" ao tentar).

- [ ] **Step 4: Commit**

```bash
git add public/portal-fornecedor/login.html public/portal-fornecedor/definir-senha.html
git commit -m "feat(portal-fornecedor): paginas de login e definicao de senha"
```

---

### Task 12: PWA do fornecedor — Nova NF (upload, itens, pagamento expansível)

**Files:**
- Create: `public/portal-fornecedor/nova-nf.html`

- [ ] **Step 1: Criar a página, reaproveitando o layout já validado nos mockups**

```html
<!-- public/portal-fornecedor/nova-nf.html -->
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nova NF — Portal do Fornecedor</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f5f5f7; margin: 0; color: #222; }
  .topo { background: #1a237e; color: #fff; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; }
  .topo a { color: #90caf9; text-decoration: none; font-size: 13px; }
  main { max-width: 640px; margin: 24px auto; padding: 0 16px 40px; }
  .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,.06); }
  label.lbl { font-size: 12px; font-weight: 600; text-transform: uppercase; color: #666; display: block; margin-bottom: 6px; }
  input, select { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; box-sizing: border-box; margin-bottom: 10px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .grid3 { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 10px; }
  .dropzone { border: 2px dashed #ccc; border-radius: 8px; padding: 20px; text-align: center; background: #fafafa; cursor: pointer; }
  .item-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr auto; gap: 8px; margin-bottom: 8px; align-items: center; }
  .pagamento-opcoes { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
  .pagamento-opcoes .opt { border: 1px solid #ddd; border-radius: 8px; padding: 10px; text-align: center; cursor: pointer; font-size: 12px; }
  .pagamento-opcoes .opt.ativo { border-color: #1a237e; background: #f0f4ff; font-weight: 700; }
  .painel-pagamento { background: #f0f4ff; border-radius: 8px; padding: 14px; display: none; }
  .boleto-chip { display: inline-block; background: #e8f5e9; color: #2e7d32; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; margin: 4px 4px 0 0; }
  button.btn { padding: 12px 20px; background: #1a237e; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button.btn-sec { background: #f1f5f9; color: #333; padding: 6px 12px; font-size: 12px; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1a237e; color: #fff; padding: 10px 20px; border-radius: 8px; display: none; }
</style>
</head>
<body>
  <div class="topo">
    <strong>🏭 Gráfica LKL — Portal Fornecedor</strong>
    <a href="#" onclick="sair()">Sair</a>
  </div>

  <main>
    <h2>📄 Declarar Nota Fiscal</h2>

    <div class="card">
      <label class="lbl">1. Anexe a NF (PDF ou foto)</label>
      <div class="dropzone" onclick="document.getElementById('input-nf').click()">
        📎 Clique pra anexar
        <div id="status-nf" style="margin-top:8px;font-size:12px;color:#2e7d32"></div>
      </div>
      <input type="file" id="input-nf" style="display:none" accept="image/*,.pdf" onchange="anexarNF(this)">
    </div>

    <div class="card">
      <label class="lbl">2. Dados da NF</label>
      <div class="grid3">
        <input id="nnf" placeholder="Número da NF">
        <input id="emitida_em" type="date" placeholder="Emissão">
        <input id="data_entrega_agendada" type="date" placeholder="Agendamento de entrega">
      </div>
      <label class="lbl" style="margin-top:10px">Itens</label>
      <div id="itens"></div>
      <button class="btn-sec" onclick="adicionarItem()">+ Adicionar item</button>
    </div>

    <div class="card">
      <label class="lbl">3. Forma de pagamento</label>
      <div class="pagamento-opcoes">
        <div class="opt" data-tipo="boleto" onclick="selecionarPagamento('boleto')">🧾 Boleto</div>
        <div class="opt" data-tipo="pix" onclick="selecionarPagamento('pix')">💠 PIX</div>
        <div class="opt" data-tipo="ted" onclick="selecionarPagamento('ted')">🏦 TED</div>
        <div class="opt" data-tipo="link_mp" onclick="selecionarPagamento('link_mp')">🔗 Link MP</div>
      </div>

      <div id="painel-boleto" class="painel-pagamento">
        <div class="dropzone" onclick="document.getElementById('input-boleto').click()">📎 Anexar boleto</div>
        <input type="file" id="input-boleto" style="display:none" accept="image/*,.pdf" onchange="anexarBoleto(this)">
        <div id="lista-boletos"></div>
      </div>

      <div id="painel-pix" class="painel-pagamento">
        <input id="pix_chave" placeholder="Chave PIX (CNPJ, e-mail, telefone ou aleatória)">
      </div>

      <div id="painel-ted" class="painel-pagamento">
        <div class="grid2">
          <input id="ted_banco_nome" placeholder="Banco (nome)">
          <input id="ted_banco_codigo" placeholder="Código do banco">
        </div>
        <div class="grid3">
          <select id="ted_tipo_conta"><option value="corrente">Corrente</option><option value="poupanca">Poupança</option></select>
          <select id="ted_titularidade"><option value="PJ">PJ</option><option value="PF">PF</option></select>
          <input id="ted_documento" placeholder="CNPJ/CPF titular">
        </div>
        <div class="grid2">
          <input id="ted_agencia" placeholder="Agência">
          <input id="ted_conta" placeholder="Conta (com dígito)">
        </div>
      </div>

      <div id="painel-link_mp" class="painel-pagamento">
        <p style="font-size:12px;color:#666;margin:0 0 8px">Cole o link de pagamento gerado por você no Mercado Pago</p>
        <input id="link_mp_url" placeholder="https://mpago.la/...">
      </div>
    </div>

    <button class="btn" onclick="enviar()">Enviar NF pra Gráfica LKL</button>
  </main>

  <div class="toast" id="toast"></div>

  <script>
    let itens = [];
    let boletos = [];
    let pagamentoAtivo = null;
    let arquivoNfPath = null;

    function token() { return localStorage.getItem('lkl_fornecedor_token'); }
    function sair() { localStorage.removeItem('lkl_fornecedor_token'); window.location.href = '/portal-fornecedor/login.html'; }
    function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.style.display = 'block'; setTimeout(() => t.style.display = 'none', 3500); }

    async function api(path, opts = {}) {
      const r = await fetch('/api/v2/portal-fornecedor' + path, {
        ...opts,
        headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token() },
      });
      if (r.status === 401) { sair(); return null; }
      return r;
    }

    function renderItens() {
      document.getElementById('itens').innerHTML = itens.map((it, i) => `
        <div class="item-row">
          <input value="${it.produto || ''}" oninput="itens[${i}].produto=this.value">
          <input type="number" value="${it.quantidade || ''}" oninput="itens[${i}].quantidade=parseFloat(this.value)||0;recalcularItem(${i})">
          <input type="number" step="0.01" value="${it.valor_unitario || ''}" oninput="itens[${i}].valor_unitario=parseFloat(this.value)||0;recalcularItem(${i})">
          <input type="number" step="0.01" value="${it.valor_total || ''}" readonly>
          <button class="btn-sec" onclick="itens.splice(${i},1);renderItens()">✕</button>
        </div>`).join('');
    }
    function recalcularItem(i) { itens[i].valor_total = Math.round((itens[i].quantidade || 0) * (itens[i].valor_unitario || 0) * 100) / 100; renderItens(); }
    function adicionarItem() { itens.push({ produto: '', quantidade: 0, valor_unitario: 0, valor_total: 0 }); renderItens(); }

    async function anexarNF(input) {
      if (!input.files[0]) return;
      const fd = new FormData(); fd.append('arquivo', input.files[0]);
      document.getElementById('status-nf').textContent = 'Lendo dados da NF...';
      const r = await api('/nf/extrair', { method: 'POST', body: fd });
      const data = await r.json();
      if (!r.ok) { document.getElementById('status-nf').textContent = data.error; return; }
      arquivoNfPath = data.arquivo_nf_path;
      document.getElementById('nnf').value = data.nnf || '';
      document.getElementById('emitida_em').value = data.emitida_em || '';
      itens = (data.itens || []).map(it => ({ produto: it.produto, quantidade: it.quantidade, valor_unitario: it.valor_unitario, valor_total: it.valor_total }));
      renderItens();
      document.getElementById('status-nf').textContent = '✓ Dados extraídos — confira abaixo';
    }

    async function anexarBoleto(input) {
      if (!input.files[0]) return;
      const fd = new FormData(); fd.append('arquivo', input.files[0]);
      const r = await api('/boleto/extrair', { method: 'POST', body: fd });
      const data = await r.json();
      if (!r.ok) { toast(data.error); return; }
      boletos.push({ arquivo_path: data.arquivo_path, linha_digitavel: data.linha_digitavel, valor: data.valor, vencimento: data.vencimento });
      renderBoletos();
      input.value = '';
    }
    function renderBoletos() {
      document.getElementById('lista-boletos').innerHTML = boletos.map(b =>
        `<span class="boleto-chip">✓ ${b.linha_digitavel ? b.linha_digitavel.slice(0, 15) + '...' : 'sem leitura automática'}</span>`
      ).join('');
    }

    function selecionarPagamento(tipo) {
      pagamentoAtivo = tipo;
      document.querySelectorAll('.pagamento-opcoes .opt').forEach(o => o.classList.toggle('ativo', o.dataset.tipo === tipo));
      ['boleto', 'pix', 'ted', 'link_mp'].forEach(t => document.getElementById('painel-' + t).style.display = (t === tipo) ? 'block' : 'none');
    }

    async function enviar() {
      if (!pagamentoAtivo) { toast('Escolha uma forma de pagamento'); return; }
      const valorTotal = itens.reduce((s, it) => s + (it.valor_total || 0), 0);
      const body = {
        nnf: document.getElementById('nnf').value || null,
        emitida_em: document.getElementById('emitida_em').value || null,
        data_entrega_agendada: document.getElementById('data_entrega_agendada').value || null,
        valor_total: valorTotal,
        arquivo_nf_path: arquivoNfPath,
        tipo_pagamento: pagamentoAtivo,
        itens, boletos,
      };
      if (pagamentoAtivo === 'pix') body.pix_chave = document.getElementById('pix_chave').value;
      if (pagamentoAtivo === 'ted') {
        body.ted_banco_nome = document.getElementById('ted_banco_nome').value;
        body.ted_banco_codigo = document.getElementById('ted_banco_codigo').value;
        body.ted_tipo_conta = document.getElementById('ted_tipo_conta').value;
        body.ted_titularidade = document.getElementById('ted_titularidade').value;
        body.ted_documento = document.getElementById('ted_documento').value;
        body.ted_agencia = document.getElementById('ted_agencia').value;
        body.ted_conta = document.getElementById('ted_conta').value;
      }
      if (pagamentoAtivo === 'link_mp') body.link_mp_url = document.getElementById('link_mp_url').value;

      const r = await api('/submissoes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) { toast(data.error || 'Erro ao enviar'); return; }
      toast('✅ NF enviada pra Gráfica LKL!');
      setTimeout(() => window.location.reload(), 1500);
    }

    if (!token()) window.location.href = '/portal-fornecedor/login.html';
    adicionarItem();
  </script>
</body>
</html>
```

- [ ] **Step 2: Testar manualmente no navegador**

Abra `/portal-fornecedor/nova-nf.html` (sem token vai redirecionar pro login — confirme esse comportamento). Depois de logar (Task 13 cria o fluxo de liberação), confirme que os campos de pagamento abrem/fecham corretamente ao clicar nas opções.

- [ ] **Step 3: Commit**

```bash
git add public/portal-fornecedor/nova-nf.html
git commit -m "feat(portal-fornecedor): pagina Nova NF com OCR e pagamento expansivel"
```

---

### Task 13: Painel interno LKL — fila de submissões e integração com Entrada de Estoque

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Adicionar a página no menu de navegação**

Localize o array `NAV` em `public/dashboard.html` (seção "Financeiro", junto com `contas_pagar`/`cobrancas`) e adicione um item novo:

```js
{ id: 'fornecedor_submissoes', label: 'Submissões de Fornecedores', icon: '📥', roles: ['admin','gestor','financeiro','atendente'] },
```

- [ ] **Step 2: Adicionar o botão de "Liberar portal" na tela de edição de fornecedor**

Em `_formFornecedor(f)` (já editado na sessão anterior pra incluir o status `bloqueado`), adicione, logo após o campo de Status:

```js
    ${f.id ? `<div style="margin-top:12px"><button class="btn btn-outline" onclick="liberarPortalFornecedor('${f.id}')">🔓 Liberar acesso ao Portal do Fornecedor</button></div>` : ''}
```

E a função que chama o endpoint (perto de `editarFornecedor`):

```js
async function liberarPortalFornecedor(fornecedorId) {
  const email = prompt('E-mail do fornecedor pra enviar o convite:');
  if (!email) return;
  const r = await api(`/api/v2/fornecedores/${fornecedorId}/portal/liberar`, { method: 'POST', body: JSON.stringify({ email }) });
  if (r?.conviteUrl) {
    showToast('✅ Convite gerado! Envie este link ao fornecedor:');
    prompt('Link de convite (copie e envie ao fornecedor):', r.conviteUrl);
  } else {
    showToast('❌ ' + (r?.error || 'Erro ao liberar portal'));
  }
}
```

- [ ] **Step 3: Adicionar a página `page-fornecedor_submissoes`**

Adicione o HTML da página (perto de outras páginas `page-*` já existentes, ex: `page-contas_pagar`):

```html
<div class="page" id="page-fornecedor_submissoes">
  <div class="page-header"><h1>📥 Submissões de Fornecedores</h1><p>Notas fiscais declaradas pelos fornecedores no portal</p></div>
  <div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap" id="fs-filtros">
    <button class="btn btn-primary" id="fs-filtro-todas" onclick="filtrarSubmissoes(null, this)">Todas</button>
    <button class="btn btn-outline" onclick="filtrarSubmissoes('pendente', this)">Pendentes</button>
    <button class="btn btn-outline" onclick="filtrarSubmissoes('alerta_dado_bancario', this)">Com alerta</button>
    <button class="btn btn-outline" onclick="filtrarSubmissoes('aceita', this)">Aceitas</button>
  </div>
  <div id="fs-lista" style="display:flex;flex-direction:column;gap:10px"></div>
</div>
```

- [ ] **Step 4: Adicionar o JS de carregamento/filtro/detalhe**

```js
let fsFiltroAtivo = null;

async function loadFornecedorSubmissoes() {
  const params = fsFiltroAtivo ? '?status=' + fsFiltroAtivo : '';
  const lista = await api('/api/v2/fornecedor-submissoes' + params);
  if (!lista) return;
  const badgeCor = { pendente: '#f1f5f9|#64748b', alerta_dado_bancario: '#fee2e2|#dc2626', aguardando_entrega: '#fef3c7|#b45309', aceita: '#dbeafe|#1d4ed8', rejeitada: '#f1f5f9|#64748b' };
  const badgeLabel = { pendente: 'Pendente', alerta_dado_bancario: '⚠ Dado bancário mudou', aguardando_entrega: '🕓 Aguardando entrega', aceita: '📦 Aceita', rejeitada: 'Rejeitada' };
  document.getElementById('fs-lista').innerHTML = lista.length ? lista.map(s => {
    const [bg, col] = (badgeCor[s.status] || badgeCor.pendente).split('|');
    return `
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:700;font-size:14px">${s.fornecedor_nome} — NF ${s.nnf || 's/nº'} — R$ ${parseFloat(s.valor_total).toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>
        <div style="font-size:12px;color:#888;margin-top:2px">Entrega agendada: ${s.data_entrega_agendada ? new Date(s.data_entrega_agendada).toLocaleDateString('pt-BR') : '—'}</div>
        <div style="margin-top:6px"><span style="background:${bg};color:${col};padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700">${badgeLabel[s.status] || s.status}</span></div>
      </div>
      <button class="btn btn-outline" onclick="verDetalheSubmissao('${s.id}')">Ver detalhes</button>
    </div>`;
  }).join('') : '<p style="text-align:center;color:#888;padding:40px">Nenhuma submissão encontrada</p>';
}

function filtrarSubmissoes(status, el) {
  fsFiltroAtivo = status;
  document.querySelectorAll('#fs-filtros button').forEach(b => { b.classList.remove('btn-primary'); b.classList.add('btn-outline'); });
  el.classList.remove('btn-outline'); el.classList.add('btn-primary');
  loadFornecedorSubmissoes();
}

async function verDetalheSubmissao(id) {
  const s = await api('/api/v2/fornecedor-submissoes/' + id);
  if (!s) return;
  if (s.status === 'alerta_dado_bancario') {
    if (!confirm(`Fornecedor ${s.fornecedor_nome} mudou o dado bancário nessa submissão.\n\nAprovar essa mudança?`)) return;
    const r = await api('/api/v2/fornecedor-submissoes/' + id + '/aprovar-dado-bancario', { method: 'POST' });
    if (r?.ok) { showToast('✅ Dado bancário aprovado'); loadFornecedorSubmissoes(); }
    return;
  }
  // Reaproveita o MESMO modal de preview que a importação de XML de NF-e já usa
  // (abrirPreviewNfe/_previewNfe/confirmarNfe, definidas mais acima no arquivo) —
  // só troca a origem dos dados (endpoint do portal em vez do parser de XML).
  const data = await api('/api/v2/entradas/pre-preenchido/' + id);
  if (!data) return;
  _previewNfe = data;
  abrirPreviewNfe(data);
}
```

Como o modal de preview (`abrirPreviewNfe`) é o mesmo, `confirmarNfe()` (já existente
em `dashboard.html`, por volta da linha 5856) precisa passar adiante os dois campos
novos que só existem quando a entrada vem do portal. Localize a função e ajuste o
`payload`:

```js
async function confirmarNfe() {
  if (!_previewNfe) return;
  const itens = _previewNfe.itens.map((it, i) => ({
    ...it,
    material_id: document.getElementById('nfe-mat-' + i).value || null,
    fator: parseFloat(document.getElementById('nfe-fator-' + i).value) || 1,
  }));
  const payload = {
    chave:        _previewNfe.chave,
    nnf:          _previewNfe.nnf,
    emitida_em:   _previewNfe.emitida_em,
    valor_total:  _previewNfe.valor_total,
    fornecedor_id: _previewNfe.fornecedor ? _previewNfe.fornecedor.id : null,
    itens,
    fornecedor_submissao_id: _previewNfe.fornecedor_submissao_id || undefined,
    boletos: _previewNfe.boletos && _previewNfe.boletos.length ? _previewNfe.boletos : undefined,
  };
  const res = await api('/api/v2/entradas', { method: 'POST', body: JSON.stringify(payload) });
  if (!res || res.errors || res.error) { showToast('Erro: ' + (res?.errors?.[0] || res?.error || 'Falha ao confirmar')); return; }
  closeModal();
  showToast('✅ Entrada lançada');
  loadEntradasMain();
}
```

*(Só os dois campos novos no fim mudam em relação à função original — o resto é
idêntico ao que já existe hoje, preservado pra não quebrar o fluxo de importação de XML
que continua funcionando exatamente como antes quando `_previewNfe.fornecedor_submissao_id`
está ausente.)*

- [ ] **Step 5: Registrar o carregamento da página ao navegar até ela**

Localize a função `showPage(id)` já existente em `dashboard.html` e adicione, junto aos
`if (id === '...') load...()` já existentes:

```js
if (id === 'fornecedor_submissoes') loadFornecedorSubmissoes();
```

- [ ] **Step 6: Testar manualmente**

Suba o servidor (`preview_start`), logue como admin, abra a página "Submissões de
Fornecedores" no menu, confirme que carrega (mesmo vazia) e que os filtros trocam o
botão ativo corretamente.

- [ ] **Step 7: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(portal-fornecedor): fila de submissoes no painel + liberar portal no cadastro de fornecedor"
```

---

### Task 14: Deploy no VPS

**Files:** nenhum arquivo novo — deploy de tudo que foi criado/alterado nas tasks 1–13.

- [ ] **Step 1: Rodar a suíte completa uma última vez**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: baseline conhecida (5 suites por Postgres local ausente), sem regressão.

- [ ] **Step 2: Sincronizar todos os arquivos novos/alterados**

```bash
ssh lkl "mkdir -p /var/www/lkl-chatbot/src/modules/portal-fornecedor /var/www/lkl-chatbot/src/modules/fornecedor-submissoes /var/www/lkl-chatbot/public/portal-fornecedor /var/www/lkl-chatbot/public/uploads/fornecedor-submissoes"
rsync -av src/middleware/auth.js lkl:/var/www/lkl-chatbot/src/middleware/auth.js
rsync -av src/modules/portal-fornecedor/ lkl:/var/www/lkl-chatbot/src/modules/portal-fornecedor/
rsync -av src/modules/fornecedor-submissoes/ lkl:/var/www/lkl-chatbot/src/modules/fornecedor-submissoes/
rsync -av src/modules/fornecedores/router.js lkl:/var/www/lkl-chatbot/src/modules/fornecedores/router.js
rsync -av src/modules/contas-pagar/ocr.js lkl:/var/www/lkl-chatbot/src/modules/contas-pagar/ocr.js
rsync -av src/modules/contas-pagar/service.js lkl:/var/www/lkl-chatbot/src/modules/contas-pagar/service.js
rsync -av src/modules/entradas/service.js lkl:/var/www/lkl-chatbot/src/modules/entradas/service.js
rsync -av src/modules/entradas/router.js lkl:/var/www/lkl-chatbot/src/modules/entradas/router.js
rsync -av src/modules/index.js lkl:/var/www/lkl-chatbot/src/modules/index.js
rsync -av public/portal-fornecedor/ lkl:/var/www/lkl-chatbot/public/portal-fornecedor/
rsync -av public/dashboard.html lkl:/var/www/lkl-chatbot/public/dashboard.html
```

- [ ] **Step 3: Verificar md5 de cada arquivo (local vs remoto) — repita pra cada par acima**

Run (exemplo pra um arquivo, repita o padrão pros demais):
```bash
md5sum src/middleware/auth.js
ssh lkl "md5sum /var/www/lkl-chatbot/src/middleware/auth.js"
```
Expected: hashes idênticos em cada par.

- [ ] **Step 4: Confirmar dependências (`bcryptjs`, `jsonwebtoken`, `multer`) já instaladas no VPS**

Run: `ssh lkl "cd /var/www/lkl-chatbot && node -e \"require('bcryptjs');require('jsonwebtoken');require('multer');console.log('OK')\""`
Expected: `OK` (essas libs já são usadas em outros módulos do projeto, não devem faltar)

- [ ] **Step 5: Reiniciar o processo**

Run: `ssh lkl "cd /var/www/lkl-chatbot && set -a && source .env && set +a && pm2 restart lkl-chatbot --update-env && pm2 save"`
Expected: `[PM2] [lkl-chatbot](0) ✓`, status `online`

- [ ] **Step 6: Checar logs de startup**

Run: `ssh lkl "pm2 logs lkl-chatbot --lines 20 --nostream --err"`
Expected: `✅ PostgreSQL conectado`, `🚀 LKL Chatbot rodando na porta 3000`, sem erros novos relacionados a `portal-fornecedor` ou `fornecedor-submissoes`.

- [ ] **Step 7: Smoke test manual — fluxo completo com um fornecedor de teste**

1. No painel, editar um fornecedor de teste → "Liberar acesso ao Portal do Fornecedor" → copiar o link de convite.
2. Abrir o link em aba anônima → definir senha → confirma redirecionamento pro login.
3. Logar com o e-mail/senha definidos → confirma redirecionamento pra Nova NF.
4. Preencher uma NF de teste manualmente (sem anexo, pra não gastar chamada de OCR à toa) → escolher PIX → enviar.
5. No painel LKL, abrir "Submissões de Fornecedores" → confirmar que a submissão aparece com status `aguardando_entrega`.
6. Clicar "Ver detalhes" → confirmar que abre a Entrada de Estoque com os dados pré-preenchidos.

---

## Cobertura do spec

- Tabela de login separada + middleware de escopo isolado → Tasks 1, 2.
- Convite/definição de senha/login → Task 3.
- Liberação manual pela LKL → Task 4.
- Bot de verificação (formato, duplicidade, mudança de dado bancário) → Task 5.
- OCR de NF e de linha digitável de boleto → Task 6.
- Múltiplos boletos como parcelas do mesmo grupo → Tasks 7, 10.
- Submissão pelo fornecedor (service + router + PWA) → Tasks 8, 11, 12.
- Fila interna + aprovação de dado bancário → Tasks 9, 13.
- Integração com Entrada de Estoque (pré-preenchimento + aceite → Contas a Pagar) → Task 10.
- Cruzamento com DDA → nenhuma mudança de código necessária (documentado na Task 10 e no spec — o motor de reconciliação já existente passa a ter mais contas "esperando match" geradas por um canal confiável).
- Deploy → Task 14.

Fora de escopo explicitamente confirmado no spec (contas recorrentes, múltiplos
usuários por fornecedor, webhook automático de Link MP) — nenhuma task criada pra isso,
como esperado.
