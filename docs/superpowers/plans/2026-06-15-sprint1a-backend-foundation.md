# Sprint 1-A — Backend Foundation + M0 APIs + M1 Motor de Orçamento

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar a fundação do novo sistema: setup de qualidade (ESLint/Prettier/Jest), migration do banco Sprint 1, corrigir bugs do chatbot, implementar middleware de roles, e entregar as APIs REST completas de M0 (clientes, fornecedores, materiais, funcionários, price_table) e M1 (motor de orçamento + criação de OS).

**Architecture:** Extensão direta do projeto existente. Novas rotas montadas em `/api/v2` via sub-router Express. Cada módulo tem `router.js` (rotas + validação) e `service.js` (queries SQL). O chatbot em `/api` e `/webhook` permanece inalterado exceto pelos bugs corrigidos.

**Tech Stack:** Node.js 20, Express 4, PostgreSQL 15 (pool `pg`), Jest + Supertest (testes), ESLint + Prettier (qualidade), `ulid` (IDs únicos de OS), `axios` (ViaCEP)

---

## Arquivos criados / modificados

```
Criar:
  .eslintrc.js
  .prettierrc
  jest.config.js
  sql/migrations/001_sprint1_foundation.sql
  src/modules/index.js
  src/modules/utils/router.js
  src/modules/clientes/router.js
  src/modules/clientes/service.js
  src/modules/fornecedores/router.js
  src/modules/fornecedores/service.js
  src/modules/materiais/router.js
  src/modules/materiais/service.js
  src/modules/funcionarios/router.js
  src/modules/funcionarios/service.js
  src/modules/price-table/router.js
  src/modules/price-table/service.js
  src/modules/orders/router.js
  src/modules/orders/service.js
  src/utils/validators.js
  tests/setup.js
  tests/utils/validators.test.js
  tests/modules/clientes.test.js
  tests/modules/funcionarios.test.js
  tests/modules/orders.test.js

Modificar:
  package.json            — adicionar Jest, ESLint, Prettier, ulid, multer, cookie-parser
  src/index.js            — montar /api/v2 router + rate limit
  src/middleware/auth.js  — adicionar requireRole()
  src/webhook/handler.js  — corrigir bug resolved + bug total_conversations
```

---

## Task 1: Setup de Qualidade (ESLint + Prettier + Jest)

**Files:**
- Modify: `package.json`
- Create: `.eslintrc.js`, `.prettierrc`, `jest.config.js`, `tests/setup.js`

- [ ] **Instalar dependências de desenvolvimento**

```bash
cd /Users/klebercamara/LKL
npm install --save-dev jest supertest eslint prettier eslint-config-prettier eslint-plugin-node
npm install ulid
```

Saída esperada: `added N packages` sem erros.

- [ ] **Criar `.eslintrc.js`**

```js
module.exports = {
  env: { node: true, es2022: true, jest: true },
  extends: ['eslint:recommended', 'prettier'],
  parserOptions: { ecmaVersion: 2022 },
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': ['warn', { allow: ['error', 'warn'] }],
  },
};
```

- [ ] **Criar `.prettierrc`**

```json
{
  "singleQuote": true,
  "trailingComma": "es5",
  "printWidth": 100,
  "semi": true
}
```

- [ ] **Criar `jest.config.js`**

```js
module.exports = {
  testEnvironment: 'node',
  setupFilesAfterFramework: ['./tests/setup.js'],
  testPathPattern: 'tests/',
  verbose: true,
};
```

- [ ] **Criar `tests/setup.js`**

```js
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-lkl-2026';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/lkl_chatbot_test';
```

- [ ] **Atualizar `package.json` — adicionar scripts**

Nos `scripts` do `package.json`, adicionar:
```json
"test": "jest --runInBand",
"test:watch": "jest --watch",
"lint": "eslint src/ tests/",
"format": "prettier --write src/ tests/"
```

- [ ] **Verificar que ESLint roda sem erros fatais**

```bash
npm run lint
```

Saída esperada: warnings de `no-console` nos arquivos existentes, sem errors que parem a execução.

- [ ] **Commit**

```bash
git add package.json package-lock.json .eslintrc.js .prettierrc jest.config.js tests/setup.js
git commit -m "chore: adicionar ESLint, Prettier e Jest ao projeto"
```

---

## Task 2: Migration do Banco — Sprint 1

**Files:**
- Create: `sql/migrations/001_sprint1_foundation.sql`

- [ ] **Criar `sql/migrations/001_sprint1_foundation.sql`**

```sql
-- Migration Sprint 1: M0 Cadastros + M1 Orders
-- Executar: psql -U postgres -d lkl_chatbot -f sql/migrations/001_sprint1_foundation.sql

BEGIN;

-- ── CLIENTES ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clientes_lkl (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,
  tipo_pessoa       VARCHAR(2) NOT NULL CHECK (tipo_pessoa IN ('PF', 'PJ')),
  cpf_cnpj          VARCHAR(18),
  nome              VARCHAR(150) NOT NULL,
  fantasia          VARCHAR(150),
  email             VARCHAR(150),
  celular           VARCHAR(20),
  telefone          VARCHAR(20),
  cep               VARCHAR(9),
  logradouro        VARCHAR(200),
  numero            VARCHAR(20),
  bairro            VARCHAR(100),
  cidade            VARCHAR(100),
  uf                VARCHAR(2),
  segmento          VARCHAR(100),
  canal_origem      VARCHAR(50) DEFAULT 'sisgraph',
  condicao_pagamento VARCHAR(50),
  limite_credito    NUMERIC(10,2) DEFAULT 0,
  contribuinte_icms VARCHAR(10) DEFAULT 'nao' CHECK (contribuinte_icms IN ('sim', 'nao', 'isento')),
  status            VARCHAR(20) DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo', 'bloqueado')),
  score_completude  INTEGER DEFAULT 0 CHECK (score_completude BETWEEN 0 AND 100),
  codigo_sisgraph   INTEGER,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_cpf_cnpj ON clientes_lkl(cpf_cnpj) WHERE cpf_cnpj IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clientes_celular ON clientes_lkl(celular);
CREATE INDEX IF NOT EXISTS idx_clientes_email ON clientes_lkl(email);
CREATE INDEX IF NOT EXISTS idx_clientes_status ON clientes_lkl(status);

-- ── FORNECEDORES ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fornecedores (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo_sisgraph  VARCHAR(20),
  nome             VARCHAR(150) NOT NULL,
  cnpj             VARCHAR(18),
  contato          VARCHAR(150),
  ddd              VARCHAR(3),
  telefone         VARCHAR(20),
  email            VARCHAR(150),
  logradouro       VARCHAR(200),
  cidade           VARCHAR(100),
  uf               VARCHAR(2),
  categoria        VARCHAR(100),
  status           VARCHAR(20) DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo')),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fornecedores_cnpj ON fornecedores(cnpj) WHERE cnpj IS NOT NULL;

-- ── MATERIAIS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS materiais (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo           VARCHAR(50) UNIQUE,
  nome             VARCHAR(150) NOT NULL,
  unidade          VARCHAR(20) NOT NULL DEFAULT 'un',
  estoque_atual    NUMERIC(10,3) DEFAULT 0,
  estoque_minimo   NUMERIC(10,3) DEFAULT 0,
  custo_medio      NUMERIC(10,4) DEFAULT 0,
  fornecedor_id    UUID REFERENCES fornecedores(id) ON DELETE SET NULL,
  status           VARCHAR(20) DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo')),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── FUNCIONÁRIOS ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS funcionarios (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  nome             VARCHAR(150) NOT NULL,
  cpf              VARCHAR(14) UNIQUE NOT NULL,
  rg               VARCHAR(20),
  data_nascimento  DATE,
  cargo            VARCHAR(100) NOT NULL,
  salario          NUMERIC(10,2),
  data_admissao    DATE NOT NULL,
  telefone         VARCHAR(20),
  celular          VARCHAR(20),
  email            VARCHAR(150),
  status           VARCHAR(20) DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo', 'afastado')),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── TABELA DE PREÇOS ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_table (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto          VARCHAR(150) NOT NULL,
  acabamento       VARCHAR(100),
  quantidade_min   INTEGER NOT NULL DEFAULT 1,
  quantidade_max   INTEGER,
  preco_unitario   NUMERIC(10,4) NOT NULL,
  unidade          VARCHAR(20) DEFAULT 'un',
  ativo            BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_table_produto ON price_table(produto);
CREATE INDEX IF NOT EXISTS idx_price_table_ativo ON price_table(ativo);

-- ── ORDERS (OS) ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_os               SERIAL UNIQUE,
  origin_channel          VARCHAR(20) NOT NULL CHECK (origin_channel IN ('whatsapp','balcao','telefone','site','vendedor')),
  orcamento_id            UUID,
  cliente_id              UUID REFERENCES clientes_lkl(id) ON DELETE SET NULL,
  vendedor_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  status                  VARCHAR(50) NOT NULL DEFAULT 'criada'
                          CHECK (status IN (
                            'criada','gerando_arquivo_impressao','arte_enviada_cliente',
                            'arte_aprovada_cliente','arte_reprovada_cliente',
                            'em_producao','concluido','entregue','cancelado'
                          )),
  status_arte             VARCHAR(50) DEFAULT 'pendente'
                          CHECK (status_arte IN ('pendente','em_criacao','aguardando_aprovacao_cliente','aprovada','reprovada')),
  produto                 VARCHAR(150),
  quantidade              INTEGER,
  material                VARCHAR(150),
  acabamento              VARCHAR(100),
  tem_arte                BOOLEAN DEFAULT FALSE,
  arquivo_arte            VARCHAR(500),
  prazo                   DATE,
  valor_orcamento         NUMERIC(10,2),
  valor_final             NUMERIC(10,2),
  external_reference_id   VARCHAR(26) UNIQUE,
  nps_score               INTEGER CHECK (nps_score BETWEEN 1 AND 5),
  observacoes             TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_cliente ON orders(cliente_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

-- ── ORDER ITEMS ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  produto         VARCHAR(150) NOT NULL,
  quantidade      INTEGER NOT NULL,
  acabamento      VARCHAR(100),
  valor_unitario  NUMERIC(10,4) NOT NULL,
  valor_total     NUMERIC(10,2) NOT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── EXPANDIR ROLES EM USERS ───────────────────────────────────────────────────
-- Adiciona novos valores ao check constraint de role
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','analyst','gestor','vendedor','atendente','operador','financeiro'));

COMMIT;
```

- [ ] **Criar banco de teste (executar uma vez na máquina local)**

```bash
psql -U postgres -c "CREATE DATABASE lkl_chatbot_test;"
psql -U postgres -d lkl_chatbot_test -f sql/schema.sql
psql -U postgres -d lkl_chatbot_test -f sql/followup_migration.sql
psql -U postgres -d lkl_chatbot_test -f sql/migrations/001_sprint1_foundation.sql
```

Saída esperada: `CREATE DATABASE` e `COMMIT` sem erros.

- [ ] **Aplicar migration no banco de produção local (para desenvolvimento)**

```bash
psql -U postgres -d lkl_chatbot -f sql/migrations/001_sprint1_foundation.sql
```

Saída esperada: `COMMIT`

- [ ] **Commit**

```bash
git add sql/migrations/
git commit -m "feat(db): migration sprint 1 — tabelas M0 e M1 (clientes, fornecedores, materiais, funcionarios, price_table, orders)"
```

---

## Task 3: Corrigir Bugs do Chatbot

**Files:**
- Modify: `src/webhook/handler.js`

Dois bugs a corrigir:
1. `total_conversations` incrementa com `+ 0` — nunca incrementa
2. Conversa setada como `resolved` prematuramente (antes do orçamento ser enviado)

- [ ] **Corrigir bug do `total_conversations` em `handler.js`**

Localizar (linha ~53):
```js
'UPDATE contacts SET total_conversations = total_conversations + 0, last_contact = NOW() WHERE id = $1',
```

Substituir por:
```js
'UPDATE contacts SET total_conversations = total_conversations + 1, last_contact = NOW() WHERE id = $1',
```

- [ ] **Verificar e corrigir qualquer `status = 'resolved'` setado antes do envio do orçamento**

```bash
grep -n "resolved" src/webhook/handler.js src/dashboard/api.js src/ai/agent.js
```

Qualquer linha que sete `status = 'resolved'` a partir de uma ação automática da IA (não de endpoint manual) deve ser removida ou alterada para `'aguardando_humano'`. O status `resolved` só deve ser setado pelo endpoint manual `POST /api/conversations/:id/resolve`.

- [ ] **Commit**

```bash
git add src/webhook/handler.js
git commit -m "fix(chatbot): corrigir total_conversations + 0 e status resolved prematuro"
```

---

## Task 4: Middleware `requireRole`

**Files:**
- Modify: `src/middleware/auth.js`

- [ ] **Adicionar `requireRole` ao `src/middleware/auth.js`**

Adicionar após a função `requireAuthApi` existente:

```js
function requireRole(...roles) {
  return (req, res, next) => {
    const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    try {
      req.user = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Acesso negado para este perfil' });
      }
      next();
    } catch {
      res.status(401).json({ error: 'Token inválido' });
    }
  };
}
```

Adicionar `requireRole` ao `module.exports`:
```js
module.exports = { requireAuth, requireAdmin, requireAuthApi, requireRole };
```

- [ ] **Escrever teste para `requireRole`**

Criar `tests/middleware/auth.test.js`:

```js
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret-lkl-2026';
const { requireRole } = require('../../src/middleware/auth');

function makeReq(role) {
  const token = jwt.sign({ id: '1', role }, process.env.JWT_SECRET);
  return { cookies: { token }, headers: {} };
}

function makeRes() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return res;
}

test('requireRole permite role correto', () => {
  const req = makeReq('admin');
  const res = makeRes();
  const next = jest.fn();
  requireRole('admin', 'gestor')(req, res, next);
  expect(next).toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
});

test('requireRole bloqueia role incorreto', () => {
  const req = makeReq('operador');
  const res = makeRes();
  const next = jest.fn();
  requireRole('admin', 'gestor')(req, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});

test('requireRole retorna 401 sem token', () => {
  const req = { cookies: {}, headers: {} };
  const res = makeRes();
  const next = jest.fn();
  requireRole('admin')(req, res, next);
  expect(res.status).toHaveBeenCalledWith(401);
});
```

- [ ] **Rodar teste**

```bash
npx jest tests/middleware/auth.test.js --verbose
```

Saída esperada: 3 testes PASS.

- [ ] **Commit**

```bash
git add src/middleware/auth.js tests/middleware/auth.test.js
git commit -m "feat(auth): adicionar middleware requireRole para controle de acesso por perfil"
```

---

## Task 5: Utilitários de Validação

**Files:**
- Create: `src/utils/validators.js`, `tests/utils/validators.test.js`

- [ ] **Criar `src/utils/validators.js`**

```js
function validarCPF(cpf) {
  const c = cpf.replace(/\D/g, '');
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(c[i]) * (10 - i);
  let d1 = (sum * 10) % 11;
  if (d1 === 10 || d1 === 11) d1 = 0;
  if (d1 !== parseInt(c[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(c[i]) * (11 - i);
  let d2 = (sum * 10) % 11;
  if (d2 === 10 || d2 === 11) d2 = 0;
  return d2 === parseInt(c[10]);
}

function validarCNPJ(cnpj) {
  const c = cnpj.replace(/\D/g, '');
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (c, n) => {
    let sum = 0, pos = n - 7;
    for (let i = n; i >= 1; i--) {
      sum += parseInt(c[n - i]) * pos--;
      if (pos < 2) pos = 9;
    }
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(c, 12) === parseInt(c[12]) && calc(c, 13) === parseInt(c[13]);
}

function validarCelular(cel) {
  const c = cel.replace(/\D/g, '');
  if (c.length !== 11) return false;
  const ddd = parseInt(c.substring(0, 2));
  return ddd >= 11 && ddd <= 99 && c[2] === '9';
}

function calcularScoreCompletude(cliente) {
  let score = 0;
  if (cliente.nome) score += 20;
  if (cliente.cpf_cnpj) score += 20;
  if (cliente.celular) score += 20;
  if (cliente.email) score += 15;
  if (cliente.cep) score += 10;
  if (cliente.logradouro) score += 10;
  if (cliente.bairro) score += 5;
  return score;
}

module.exports = { validarCPF, validarCNPJ, validarCelular, calcularScoreCompletude };
```

- [ ] **Criar `tests/utils/validators.test.js`**

```js
const { validarCPF, validarCNPJ, validarCelular, calcularScoreCompletude } = require('../../src/utils/validators');

describe('validarCPF', () => {
  test('CPF válido', () => expect(validarCPF('529.982.247-25')).toBe(true));
  test('CPF inválido — dígito errado', () => expect(validarCPF('529.982.247-26')).toBe(false));
  test('CPF com todos dígitos iguais', () => expect(validarCPF('111.111.111-11')).toBe(false));
});

describe('validarCNPJ', () => {
  test('CNPJ válido', () => expect(validarCNPJ('11.222.333/0001-81')).toBe(true));
  test('CNPJ inválido', () => expect(validarCNPJ('11.222.333/0001-82')).toBe(false));
  test('CNPJ com todos dígitos iguais', () => expect(validarCNPJ('00.000.000/0000-00')).toBe(false));
});

describe('validarCelular', () => {
  test('celular válido SP', () => expect(validarCelular('(11) 99999-9999')).toBe(true));
  test('celular válido RJ', () => expect(validarCelular('21987654321')).toBe(true));
  test('celular sem 9 no início', () => expect(validarCelular('2187654321')).toBe(false));
  test('celular curto demais', () => expect(validarCelular('2199999')).toBe(false));
});

describe('calcularScoreCompletude', () => {
  test('cliente completo = 100', () => {
    const c = { nome: 'X', cpf_cnpj: '1', celular: '1', email: 'x@y', cep: '1', logradouro: '1', bairro: '1' };
    expect(calcularScoreCompletude(c)).toBe(100);
  });
  test('cliente só com nome = 20', () => {
    expect(calcularScoreCompletude({ nome: 'X' })).toBe(20);
  });
});
```

- [ ] **Rodar testes**

```bash
npx jest tests/utils/validators.test.js --verbose
```

Saída esperada: todos PASS.

- [ ] **Commit**

```bash
git add src/utils/validators.js tests/utils/validators.test.js
git commit -m "feat(utils): validadores CPF, CNPJ, celular e score de completude"
```

---

## Task 6: Router Principal `/api/v2` + Utils CEP

**Files:**
- Create: `src/modules/utils/router.js`, `src/modules/index.js`
- Modify: `src/index.js`

- [ ] **Criar `src/modules/utils/router.js`**

```js
const express = require('express');
const axios = require('axios');
const { requireAuthApi } = require('../../middleware/auth');

const router = express.Router();

router.get('/cep/:cep', requireAuthApi, async (req, res) => {
  const cep = req.params.cep.replace(/\D/g, '');
  if (cep.length !== 8) return res.status(400).json({ error: 'CEP inválido — deve ter 8 dígitos' });
  try {
    const { data } = await axios.get(`https://viacep.com.br/ws/${cep}/json/`, { timeout: 5000 });
    if (data.erro) return res.status(404).json({ error: 'CEP não encontrado' });
    res.json({
      cep: data.cep,
      logradouro: data.logradouro,
      bairro: data.bairro,
      cidade: data.localidade,
      uf: data.uf,
    });
  } catch {
    res.status(502).json({ error: 'Falha ao consultar ViaCEP — tente novamente' });
  }
});

module.exports = router;
```

- [ ] **Criar `src/modules/index.js`**

```js
const express = require('express');
const { requireAuthApi } = require('../middleware/auth');

const utilsRouter = require('./utils/router');
const clientesRouter = require('./clientes/router');
const fornecedoresRouter = require('./fornecedores/router');
const materiaisRouter = require('./materiais/router');
const funcionariosRouter = require('./funcionarios/router');
const priceTableRouter = require('./price-table/router');
const ordersRouter = require('./orders/router');

const router = express.Router();

router.use('/utils', utilsRouter);
router.use('/clientes', requireAuthApi, clientesRouter);
router.use('/fornecedores', requireAuthApi, fornecedoresRouter);
router.use('/materiais', requireAuthApi, materiaisRouter);
router.use('/funcionarios', requireAuthApi, funcionariosRouter);
router.use('/price-table', requireAuthApi, priceTableRouter);
router.use('/orders', requireAuthApi, ordersRouter);

module.exports = router;
```

- [ ] **Montar `/api/v2` no `src/index.js`**

Após a linha `const { startScheduler } = require('./services/followup');`, adicionar:
```js
const modulesRouter = require('./modules/index');
```

Após a linha `app.use('/api', apiRoutes);`, adicionar:
```js
app.use('/api/v2', rateLimit({ windowMs: 60000, max: 200 }));
app.use('/api/v2', modulesRouter);
```

- [ ] **Testar CEP manualmente**

```bash
npm run dev
# Em outro terminal:
curl -s "http://localhost:3000/api/v2/utils/cep/25020140" -H "Cookie: token=<JWT_VALIDO>"
```

Saída esperada: `{"cep":"25020-140","logradouro":"Rua José de Alvarenga","bairro":"Centro","cidade":"Duque de Caxias","uf":"RJ"}`

- [ ] **Commit**

```bash
git add src/modules/ src/index.js
git commit -m "feat(api): montar router /api/v2 com utilitário de CEP via ViaCEP"
```

---

## Task 7: M0 — API de Clientes

**Files:**
- Create: `src/modules/clientes/service.js`, `src/modules/clientes/router.js`
- Create: `tests/modules/clientes.test.js`

- [ ] **Criar `src/modules/clientes/service.js`**

```js
const db = require('../../db');
const { validarCPF, validarCNPJ, validarCelular, calcularScoreCompletude } = require('../../utils/validators');

async function listar({ page = 1, limit = 20, busca, status }) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  if (busca) {
    params.push(`%${busca}%`);
    where += ` AND (nome ILIKE $${params.length} OR celular ILIKE $${params.length} OR cpf_cnpj ILIKE $${params.length})`;
  }
  const [rows, count] = await Promise.all([
    db.query(`SELECT * FROM clientes_lkl ${where} ORDER BY nome LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]),
    db.query(`SELECT COUNT(*) FROM clientes_lkl ${where}`, params),
  ]);
  return { clientes: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

async function buscarPorId(id) {
  const r = await db.query('SELECT * FROM clientes_lkl WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function validarDados(dados, idExcluir = null) {
  const erros = [];
  if (!dados.nome || dados.nome.trim().length < 3) erros.push('Nome deve ter pelo menos 3 caracteres');
  if (!dados.tipo_pessoa || !['PF', 'PJ'].includes(dados.tipo_pessoa)) erros.push('tipo_pessoa deve ser PF ou PJ');
  if (dados.cpf_cnpj) {
    const doc = dados.cpf_cnpj.replace(/\D/g, '');
    if (dados.tipo_pessoa === 'PF' && !validarCPF(dados.cpf_cnpj)) erros.push('CPF inválido');
    if (dados.tipo_pessoa === 'PJ' && !validarCNPJ(dados.cpf_cnpj)) erros.push('CNPJ inválido');
    const q = idExcluir
      ? await db.query('SELECT id FROM clientes_lkl WHERE cpf_cnpj = $1 AND id != $2', [dados.cpf_cnpj, idExcluir])
      : await db.query('SELECT id FROM clientes_lkl WHERE cpf_cnpj = $1', [dados.cpf_cnpj]);
    if (q.rows.length > 0) erros.push('CPF/CNPJ já cadastrado');
  }
  if (dados.celular && !validarCelular(dados.celular)) erros.push('Celular inválido — formato: (XX) 9XXXX-XXXX');
  return erros;
}

async function criar(dados) {
  const erros = await validarDados(dados);
  if (erros.length > 0) return { erro: erros };
  const score = calcularScoreCompletude(dados);
  const r = await db.query(
    `INSERT INTO clientes_lkl
     (tipo_pessoa, cpf_cnpj, nome, fantasia, email, celular, telefone, cep, logradouro, numero,
      bairro, cidade, uf, segmento, canal_origem, condicao_pagamento, limite_credito,
      contribuinte_icms, status, score_completude, codigo_sisgraph)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [dados.tipo_pessoa, dados.cpf_cnpj, dados.nome, dados.fantasia, dados.email, dados.celular,
     dados.telefone, dados.cep, dados.logradouro, dados.numero, dados.bairro, dados.cidade, dados.uf,
     dados.segmento, dados.canal_origem || 'balcao', dados.condicao_pagamento, dados.limite_credito || 0,
     dados.contribuinte_icms || 'nao', 'ativo', score, dados.codigo_sisgraph]
  );
  return { cliente: r.rows[0] };
}

async function atualizar(id, dados) {
  const existente = await buscarPorId(id);
  if (!existente) return { erro: ['Cliente não encontrado'] };
  const erros = await validarDados({ ...existente, ...dados }, id);
  if (erros.length > 0) return { erro: erros };
  const merged = { ...existente, ...dados };
  const score = calcularScoreCompletude(merged);
  const r = await db.query(
    `UPDATE clientes_lkl SET tipo_pessoa=$1, cpf_cnpj=$2, nome=$3, fantasia=$4, email=$5,
     celular=$6, telefone=$7, cep=$8, logradouro=$9, numero=$10, bairro=$11, cidade=$12, uf=$13,
     segmento=$14, condicao_pagamento=$15, limite_credito=$16, contribuinte_icms=$17,
     status=$18, score_completude=$19, updated_at=NOW() WHERE id=$20 RETURNING *`,
    [merged.tipo_pessoa, merged.cpf_cnpj, merged.nome, merged.fantasia, merged.email, merged.celular,
     merged.telefone, merged.cep, merged.logradouro, merged.numero, merged.bairro, merged.cidade,
     merged.uf, merged.segmento, merged.condicao_pagamento, merged.limite_credito,
     merged.contribuinte_icms, merged.status, score, id]
  );
  return { cliente: r.rows[0] };
}

module.exports = { listar, buscarPorId, criar, atualizar };
```

- [ ] **Criar `src/modules/clientes/router.js`**

```js
const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  const { page, limit, busca, status } = req.query;
  const result = await service.listar({ page: parseInt(page) || 1, limit: parseInt(limit) || 20, busca, status });
  res.json(result);
});

router.get('/busca', async (req, res) => {
  if (!req.query.q) return res.status(400).json({ error: 'Parâmetro q é obrigatório' });
  const result = await service.listar({ busca: req.query.q, limit: 10 });
  res.json(result.clientes);
});

router.get('/:id', async (req, res) => {
  const cliente = await service.buscarPorId(req.params.id);
  if (!cliente) return res.status(404).json({ error: 'Cliente não encontrado' });
  res.json(cliente);
});

router.post('/', async (req, res) => {
  const result = await service.criar(req.body);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.status(201).json(result.cliente);
});

router.put('/:id', async (req, res) => {
  const result = await service.atualizar(req.params.id, req.body);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.json(result.cliente);
});

router.patch('/:id', async (req, res) => {
  const result = await service.atualizar(req.params.id, req.body);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.json(result.cliente);
});

module.exports = router;
```

- [ ] **Criar `tests/modules/clientes.test.js`**

```js
const db = require('../../src/db');
const service = require('../../src/modules/clientes/service');

beforeAll(async () => {
  await db.query("DELETE FROM clientes_lkl WHERE nome LIKE 'TEST_%'");
});

afterAll(async () => {
  await db.query("DELETE FROM clientes_lkl WHERE nome LIKE 'TEST_%'");
  await db.pool?.end();
});

const dadosValidos = {
  tipo_pessoa: 'PF',
  cpf_cnpj: '529.982.247-25',
  nome: 'TEST_João Silva',
  celular: '21987654321',
  email: 'test@example.com',
};

test('criar cliente com dados válidos', async () => {
  const result = await service.criar(dadosValidos);
  expect(result.erro).toBeUndefined();
  expect(result.cliente.nome).toBe('TEST_João Silva');
  expect(result.cliente.score_completude).toBeGreaterThan(0);
});

test('rejeitar CPF inválido', async () => {
  const result = await service.criar({ ...dadosValidos, cpf_cnpj: '111.111.111-11', nome: 'TEST_Inválido' });
  expect(result.erro).toContain('CPF inválido');
});

test('rejeitar CPF duplicado', async () => {
  const result = await service.criar({ ...dadosValidos, nome: 'TEST_Duplicado' });
  expect(result.erro).toContain('CPF/CNPJ já cadastrado');
});

test('listar clientes com busca', async () => {
  const result = await service.listar({ busca: 'TEST_João' });
  expect(result.clientes.length).toBeGreaterThan(0);
});
```

- [ ] **Rodar testes (requer banco de teste configurado)**

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/lkl_chatbot_test npx jest tests/modules/clientes.test.js --verbose
```

Saída esperada: 4 testes PASS.

- [ ] **Commit**

```bash
git add src/modules/clientes/ tests/modules/clientes.test.js
git commit -m "feat(M0): API REST de clientes com validação CPF/CNPJ e score de completude"
```

---

## Task 8: M0 — APIs de Fornecedores e Materiais

**Files:**
- Create: `src/modules/fornecedores/service.js`, `src/modules/fornecedores/router.js`
- Create: `src/modules/materiais/service.js`, `src/modules/materiais/router.js`

- [ ] **Criar `src/modules/fornecedores/service.js`**

```js
const db = require('../../db');

async function listar({ page = 1, limit = 20, busca, status }) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  if (busca) {
    params.push(`%${busca}%`);
    where += ` AND (nome ILIKE $${params.length} OR cnpj ILIKE $${params.length})`;
  }
  const [rows, count] = await Promise.all([
    db.query(`SELECT * FROM fornecedores ${where} ORDER BY nome LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]),
    db.query(`SELECT COUNT(*) FROM fornecedores ${where}`, params),
  ]);
  return { fornecedores: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

async function buscarPorId(id) {
  const r = await db.query('SELECT * FROM fornecedores WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function criar(dados) {
  if (!dados.nome || dados.nome.trim().length < 2) return { erro: ['Nome é obrigatório'] };
  const r = await db.query(
    `INSERT INTO fornecedores (codigo_sisgraph, nome, cnpj, contato, ddd, telefone, email, logradouro, cidade, uf, categoria, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ativo') RETURNING *`,
    [dados.codigo_sisgraph, dados.nome, dados.cnpj, dados.contato, dados.ddd, dados.telefone,
     dados.email, dados.logradouro, dados.cidade, dados.uf, dados.categoria]
  );
  return { fornecedor: r.rows[0] };
}

async function atualizar(id, dados) {
  const r = await db.query(
    `UPDATE fornecedores SET nome=COALESCE($1,nome), cnpj=COALESCE($2,cnpj), contato=COALESCE($3,contato),
     telefone=COALESCE($4,telefone), email=COALESCE($5,email), logradouro=COALESCE($6,logradouro),
     cidade=COALESCE($7,cidade), uf=COALESCE($8,uf), categoria=COALESCE($9,categoria),
     status=COALESCE($10,status), updated_at=NOW() WHERE id=$11 RETURNING *`,
    [dados.nome, dados.cnpj, dados.contato, dados.telefone, dados.email, dados.logradouro,
     dados.cidade, dados.uf, dados.categoria, dados.status, id]
  );
  if (!r.rows[0]) return { erro: ['Fornecedor não encontrado'] };
  return { fornecedor: r.rows[0] };
}

module.exports = { listar, buscarPorId, criar, atualizar };
```

- [ ] **Criar `src/modules/fornecedores/router.js`**

```js
const express = require('express');
const service = require('./service');

const router = express.Router();

router.get('/', async (req, res) => {
  const { page, limit, busca, status } = req.query;
  res.json(await service.listar({ page: parseInt(page)||1, limit: parseInt(limit)||20, busca, status }));
});

router.get('/:id', async (req, res) => {
  const f = await service.buscarPorId(req.params.id);
  if (!f) return res.status(404).json({ error: 'Fornecedor não encontrado' });
  res.json(f);
});

router.post('/', async (req, res) => {
  const result = await service.criar(req.body);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.status(201).json(result.fornecedor);
});

router.put('/:id', async (req, res) => {
  const result = await service.atualizar(req.params.id, req.body);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.json(result.fornecedor);
});

module.exports = router;
```

- [ ] **Criar `src/modules/materiais/service.js`**

```js
const db = require('../../db');

async function listar({ busca, status } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  if (busca) { params.push(`%${busca}%`); where += ` AND nome ILIKE $${params.length}`; }
  const r = await db.query(`SELECT m.*, f.nome as fornecedor_nome FROM materiais m
    LEFT JOIN fornecedores f ON f.id = m.fornecedor_id ${where} ORDER BY m.nome`, params);
  return r.rows;
}

async function buscarPorId(id) {
  const r = await db.query('SELECT * FROM materiais WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function criar(dados) {
  if (!dados.nome) return { erro: ['Nome é obrigatório'] };
  if (!dados.unidade) return { erro: ['Unidade é obrigatória'] };
  const r = await db.query(
    `INSERT INTO materiais (codigo, nome, unidade, estoque_atual, estoque_minimo, custo_medio, fornecedor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [dados.codigo, dados.nome, dados.unidade, dados.estoque_atual||0, dados.estoque_minimo||0,
     dados.custo_medio||0, dados.fornecedor_id||null]
  );
  return { material: r.rows[0] };
}

async function atualizarEstoque(id, quantidade, tipo) {
  const op = tipo === 'entrada' ? '+' : '-';
  const r = await db.query(
    `UPDATE materiais SET estoque_atual = estoque_atual ${op} $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [Math.abs(quantidade), id]
  );
  if (!r.rows[0]) return { erro: ['Material não encontrado'] };
  return { material: r.rows[0] };
}

module.exports = { listar, buscarPorId, criar, atualizarEstoque };
```

- [ ] **Criar `src/modules/materiais/router.js`**

```js
const express = require('express');
const service = require('./service');

const router = express.Router();

router.get('/', async (req, res) => res.json(await service.listar(req.query)));

router.get('/:id', async (req, res) => {
  const m = await service.buscarPorId(req.params.id);
  if (!m) return res.status(404).json({ error: 'Material não encontrado' });
  res.json(m);
});

router.post('/', async (req, res) => {
  const result = await service.criar(req.body);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.status(201).json(result.material);
});

router.patch('/:id/estoque', async (req, res) => {
  const { quantidade, tipo } = req.body;
  if (!quantidade || !['entrada', 'saida'].includes(tipo))
    return res.status(400).json({ error: 'quantidade e tipo (entrada|saida) são obrigatórios' });
  const result = await service.atualizarEstoque(req.params.id, quantidade, tipo);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.json(result.material);
});

module.exports = router;
```

- [ ] **Commit**

```bash
git add src/modules/fornecedores/ src/modules/materiais/
git commit -m "feat(M0): APIs REST de fornecedores e materiais"
```

---

## Task 9: M0 — API de Funcionários

**Files:**
- Create: `src/modules/funcionarios/service.js`, `src/modules/funcionarios/router.js`
- Create: `tests/modules/funcionarios.test.js`

- [ ] **Criar `src/modules/funcionarios/service.js`**

```js
const db = require('../../db');
const { validarCPF } = require('../../utils/validators');

async function listar({ status } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND f.status = $${params.length}`; }
  const r = await db.query(
    `SELECT f.*, u.name as user_nome, u.role as user_role FROM funcionarios f
     LEFT JOIN users u ON u.id = f.user_id ${where} ORDER BY f.nome`, params
  );
  return r.rows;
}

async function buscarPorId(id) {
  const r = await db.query(
    `SELECT f.*, u.name as user_nome FROM funcionarios f LEFT JOIN users u ON u.id = f.user_id WHERE f.id = $1`, [id]
  );
  return r.rows[0] || null;
}

async function criar(dados) {
  const erros = [];
  if (!dados.nome || dados.nome.trim().length < 2) erros.push('Nome é obrigatório');
  if (!dados.cpf) erros.push('CPF é obrigatório');
  else if (!validarCPF(dados.cpf)) erros.push('CPF inválido');
  if (!dados.cargo) erros.push('Cargo é obrigatório');
  if (!dados.data_admissao) erros.push('Data de admissão é obrigatória');
  if (erros.length > 0) return { erro: erros };

  const dup = await db.query('SELECT id FROM funcionarios WHERE cpf = $1', [dados.cpf]);
  if (dup.rows.length > 0) return { erro: ['CPF já cadastrado'] };

  const r = await db.query(
    `INSERT INTO funcionarios (user_id, nome, cpf, rg, data_nascimento, cargo, salario,
     data_admissao, telefone, celular, email, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ativo') RETURNING *`,
    [dados.user_id||null, dados.nome, dados.cpf.replace(/\D/g,''), dados.rg, dados.data_nascimento,
     dados.cargo, dados.salario||null, dados.data_admissao, dados.telefone, dados.celular, dados.email]
  );
  return { funcionario: r.rows[0] };
}

async function atualizar(id, dados) {
  const existente = await buscarPorId(id);
  if (!existente) return { erro: ['Funcionário não encontrado'] };
  if (dados.cpf && !validarCPF(dados.cpf)) return { erro: ['CPF inválido'] };
  const r = await db.query(
    `UPDATE funcionarios SET nome=COALESCE($1,nome), rg=COALESCE($2,rg),
     data_nascimento=COALESCE($3,data_nascimento), cargo=COALESCE($4,cargo),
     salario=COALESCE($5,salario), telefone=COALESCE($6,telefone), celular=COALESCE($7,celular),
     email=COALESCE($8,email), status=COALESCE($9,status), user_id=COALESCE($10,user_id),
     updated_at=NOW() WHERE id=$11 RETURNING *`,
    [dados.nome, dados.rg, dados.data_nascimento, dados.cargo, dados.salario,
     dados.telefone, dados.celular, dados.email, dados.status, dados.user_id, id]
  );
  return { funcionario: r.rows[0] };
}

module.exports = { listar, buscarPorId, criar, atualizar };
```

- [ ] **Criar `src/modules/funcionarios/router.js`**

```js
const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => res.json(await service.listar(req.query)));

router.get('/:id', async (req, res) => {
  const f = await service.buscarPorId(req.params.id);
  if (!f) return res.status(404).json({ error: 'Funcionário não encontrado' });
  res.json(f);
});

router.post('/', requireRole('admin', 'gestor'), async (req, res) => {
  const result = await service.criar(req.body);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.status(201).json(result.funcionario);
});

router.patch('/:id', requireRole('admin', 'gestor'), async (req, res) => {
  const result = await service.atualizar(req.params.id, req.body);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.json(result.funcionario);
});

module.exports = router;
```

- [ ] **Criar `tests/modules/funcionarios.test.js`**

```js
const db = require('../../src/db');
const service = require('../../src/modules/funcionarios/service');

beforeAll(async () => {
  await db.query("DELETE FROM funcionarios WHERE nome LIKE 'TEST_%'");
});

afterAll(async () => {
  await db.query("DELETE FROM funcionarios WHERE nome LIKE 'TEST_%'");
});

test('criar funcionário com dados válidos', async () => {
  const result = await service.criar({
    nome: 'TEST_Maria Souza',
    cpf: '529.982.247-25',
    cargo: 'Operadora de Impressão',
    data_admissao: '2024-01-15',
  });
  expect(result.erro).toBeUndefined();
  expect(result.funcionario.nome).toBe('TEST_Maria Souza');
  expect(result.funcionario.status).toBe('ativo');
});

test('rejeitar CPF inválido', async () => {
  const result = await service.criar({
    nome: 'TEST_Inválido',
    cpf: '111.111.111-11',
    cargo: 'Teste',
    data_admissao: '2024-01-15',
  });
  expect(result.erro).toContain('CPF inválido');
});

test('rejeitar CPF duplicado', async () => {
  const result = await service.criar({
    nome: 'TEST_Duplicado',
    cpf: '529.982.247-25',
    cargo: 'Teste',
    data_admissao: '2024-01-15',
  });
  expect(result.erro).toContain('CPF já cadastrado');
});
```

- [ ] **Rodar testes**

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/lkl_chatbot_test npx jest tests/modules/funcionarios.test.js --verbose
```

Saída esperada: 3 testes PASS.

- [ ] **Commit**

```bash
git add src/modules/funcionarios/ tests/modules/funcionarios.test.js
git commit -m "feat(M0): API REST de funcionários com validação de CPF e vínculo com perfil de sistema"
```

---

## Task 10: M1 — Price Table API

**Files:**
- Create: `src/modules/price-table/service.js`, `src/modules/price-table/router.js`

- [ ] **Criar `src/modules/price-table/service.js`**

```js
const db = require('../../db');

async function listarCatalogo() {
  const r = await db.query(
    `SELECT produto, acabamento, MIN(quantidade_min) as qtd_min, MAX(quantidade_max) as qtd_max,
     MIN(preco_unitario) as preco_min, MAX(preco_unitario) as preco_max
     FROM price_table WHERE ativo = true GROUP BY produto, acabamento ORDER BY produto, acabamento`
  );
  return r.rows;
}

async function listarTodos() {
  const r = await db.query('SELECT * FROM price_table ORDER BY produto, acabamento, quantidade_min');
  return r.rows;
}

async function calcularPreco(produto, acabamento, quantidade) {
  const r = await db.query(
    `SELECT preco_unitario FROM price_table
     WHERE produto = $1 AND (acabamento = $2 OR acabamento IS NULL)
     AND quantidade_min <= $3 AND (quantidade_max >= $3 OR quantidade_max IS NULL)
     AND ativo = true
     ORDER BY quantidade_min DESC LIMIT 1`,
    [produto, acabamento, quantidade]
  );
  if (!r.rows[0]) return null;
  const unitario = parseFloat(r.rows[0].preco_unitario);
  return { preco_unitario: unitario, valor_total: unitario * quantidade };
}

async function criar(dados) {
  if (!dados.produto || !dados.quantidade_min || !dados.preco_unitario)
    return { erro: ['produto, quantidade_min e preco_unitario são obrigatórios'] };
  const r = await db.query(
    `INSERT INTO price_table (produto, acabamento, quantidade_min, quantidade_max, preco_unitario, unidade, ativo)
     VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *`,
    [dados.produto, dados.acabamento||null, dados.quantidade_min, dados.quantidade_max||null,
     dados.preco_unitario, dados.unidade||'un']
  );
  return { item: r.rows[0] };
}

async function atualizar(id, dados) {
  const r = await db.query(
    `UPDATE price_table SET produto=COALESCE($1,produto), acabamento=COALESCE($2,acabamento),
     quantidade_min=COALESCE($3,quantidade_min), quantidade_max=COALESCE($4,quantidade_max),
     preco_unitario=COALESCE($5,preco_unitario), ativo=COALESCE($6,ativo), updated_at=NOW()
     WHERE id=$7 RETURNING *`,
    [dados.produto, dados.acabamento, dados.quantidade_min, dados.quantidade_max,
     dados.preco_unitario, dados.ativo, id]
  );
  if (!r.rows[0]) return { erro: ['Item não encontrado'] };
  return { item: r.rows[0] };
}

module.exports = { listarCatalogo, listarTodos, calcularPreco, criar, atualizar };
```

- [ ] **Criar `src/modules/price-table/router.js`**

```js
const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();

// Catálogo público (para o PWA mostrar produtos e preços)
router.get('/catalogo', async (req, res) => res.json(await service.listarCatalogo()));

// Cálculo de preço para um produto/quantidade específico
router.get('/calcular', async (req, res) => {
  const { produto, acabamento, quantidade } = req.query;
  if (!produto || !quantidade) return res.status(400).json({ error: 'produto e quantidade são obrigatórios' });
  const preco = await service.calcularPreco(produto, acabamento, parseInt(quantidade));
  if (!preco) return res.status(404).json({ error: 'Nenhuma faixa de preço encontrada para esses parâmetros' });
  res.json(preco);
});

// Administração da tabela (só admin/gestor)
router.get('/', requireRole('admin', 'gestor'), async (req, res) => res.json(await service.listarTodos()));

router.post('/', requireRole('admin', 'gestor'), async (req, res) => {
  const result = await service.criar(req.body);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.status(201).json(result.item);
});

router.put('/:id', requireRole('admin', 'gestor'), async (req, res) => {
  const result = await service.atualizar(req.params.id, req.body);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.json(result.item);
});

module.exports = router;
```

- [ ] **Commit**

```bash
git add src/modules/price-table/
git commit -m "feat(M1): API de tabela de preços com motor de cálculo por produto/quantidade/acabamento"
```

---

## Task 11: M1/M2 — Motor de Orçamento + Orders API

**Files:**
- Create: `src/modules/orders/service.js`, `src/modules/orders/router.js`
- Create: `tests/modules/orders.test.js`

- [ ] **Criar `src/modules/orders/service.js`**

```js
const db = require('../../db');
const priceService = require('../price-table/service');

const CANAIS_VALIDOS = ['whatsapp', 'balcao', 'telefone', 'site', 'vendedor'];

async function criarOrder(dados, userId) {
  const erros = [];
  if (!dados.origin_channel || !CANAIS_VALIDOS.includes(dados.origin_channel))
    erros.push(`origin_channel deve ser: ${CANAIS_VALIDOS.join(', ')}`);
  if (!dados.produto) erros.push('produto é obrigatório');
  if (!dados.quantidade || dados.quantidade < 1) erros.push('quantidade deve ser maior que zero');
  if (!dados.cliente_id) erros.push('cliente_id é obrigatório');
  if (erros.length > 0) return { erro: erros };

  // Calcular valor do orçamento automaticamente
  let valor_orcamento = dados.valor_orcamento || null;
  if (!valor_orcamento && dados.produto && dados.quantidade) {
    const preco = await priceService.calcularPreco(dados.produto, dados.acabamento, dados.quantidade);
    if (preco) valor_orcamento = preco.valor_total;
  }

  const r = await db.query(
    `INSERT INTO orders
     (origin_channel, cliente_id, vendedor_id, status, produto, quantidade, material, acabamento,
      tem_arte, prazo, valor_orcamento, observacoes)
     VALUES ($1,$2,$3,'criada',$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [dados.origin_channel, dados.cliente_id, dados.vendedor_id||userId||null,
     dados.produto, dados.quantidade, dados.material||null, dados.acabamento||null,
     dados.tem_arte||false, dados.prazo||null, valor_orcamento, dados.observacoes||null]
  );

  // Inserir itens se fornecidos
  if (dados.itens && dados.itens.length > 0) {
    for (const item of dados.itens) {
      await db.query(
        `INSERT INTO order_items (order_id, produto, quantidade, acabamento, valor_unitario, valor_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [r.rows[0].id, item.produto, item.quantidade, item.acabamento||null,
         item.valor_unitario, item.valor_total]
      );
    }
  }

  if (global.io) global.io.emit('new_order', { orderId: r.rows[0].id, numeroOs: r.rows[0].numero_os });
  return { order: r.rows[0] };
}

async function buscarPorId(id) {
  const [order, items] = await Promise.all([
    db.query(`SELECT o.*, c.nome as cliente_nome, c.celular as cliente_celular, u.name as vendedor_nome
              FROM orders o
              LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
              LEFT JOIN users u ON u.id = o.vendedor_id
              WHERE o.id = $1`, [id]),
    db.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at', [id]),
  ]);
  if (!order.rows[0]) return null;
  return { ...order.rows[0], itens: items.rows };
}

async function atualizarStatus(id, novoStatus, userId) {
  const STATUS_VALIDOS = [
    'criada','gerando_arquivo_impressao','arte_enviada_cliente',
    'arte_aprovada_cliente','arte_reprovada_cliente',
    'em_producao','concluido','entregue','cancelado',
  ];
  if (!STATUS_VALIDOS.includes(novoStatus))
    return { erro: [`Status inválido. Válidos: ${STATUS_VALIDOS.join(', ')}`] };

  const r = await db.query(
    `UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
    [novoStatus, id]
  );
  if (!r.rows[0]) return { erro: ['OS não encontrada'] };
  if (global.io) global.io.emit('order_status_update', { orderId: id, status: novoStatus });
  return { order: r.rows[0] };
}

async function listar({ page = 1, limit = 20, status, cliente_id, origin_channel } = {}) {
  const offset = (page - 1) * limit;
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND o.status = $${params.length}`; }
  if (cliente_id) { params.push(cliente_id); where += ` AND o.cliente_id = $${params.length}`; }
  if (origin_channel) { params.push(origin_channel); where += ` AND o.origin_channel = $${params.length}`; }
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT o.*, c.nome as cliente_nome FROM orders o
       LEFT JOIN clientes_lkl c ON c.id = o.cliente_id
       ${where} ORDER BY o.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) FROM orders o ${where}`, params),
  ]);
  return { orders: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

module.exports = { criarOrder, buscarPorId, atualizarStatus, listar };
```

- [ ] **Criar `src/modules/orders/router.js`**

```js
const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  const { page, limit, status, cliente_id, origin_channel } = req.query;
  res.json(await service.listar({ page: parseInt(page)||1, limit: parseInt(limit)||20, status, cliente_id, origin_channel }));
});

router.get('/:id', async (req, res) => {
  const order = await service.buscarPorId(req.params.id);
  if (!order) return res.status(404).json({ error: 'OS não encontrada' });
  res.json(order);
});

router.post('/', async (req, res) => {
  const result = await service.criarOrder(req.body, req.user.id);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.status(201).json(result.order);
});

router.patch('/:id/status', requireRole('admin', 'gestor', 'atendente', 'operador', 'analyst'), async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status é obrigatório' });
  const result = await service.atualizarStatus(req.params.id, status, req.user.id);
  if (result.erro) return res.status(400).json({ errors: result.erro });
  res.json(result.order);
});

module.exports = router;
```

- [ ] **Criar `tests/modules/orders.test.js`**

```js
const db = require('../../src/db');
const service = require('../../src/modules/orders/service');

let clienteId;

beforeAll(async () => {
  // Criar cliente de teste
  const r = await db.query(
    `INSERT INTO clientes_lkl (tipo_pessoa, nome, status) VALUES ('PF', 'TEST_Cliente Order', 'ativo') RETURNING id`
  );
  clienteId = r.rows[0].id;
});

afterAll(async () => {
  await db.query('DELETE FROM orders WHERE observacoes = $1', ['TEST_order']);
  await db.query("DELETE FROM clientes_lkl WHERE nome = 'TEST_Cliente Order'");
});

test('criar OS com canal válido', async () => {
  const result = await service.criarOrder({
    origin_channel: 'balcao',
    cliente_id: clienteId,
    produto: 'Cartão de Visita',
    quantidade: 1000,
    observacoes: 'TEST_order',
  }, null);
  expect(result.erro).toBeUndefined();
  expect(result.order.numero_os).toBeDefined();
  expect(result.order.status).toBe('criada');
});

test('rejeitar canal inválido', async () => {
  const result = await service.criarOrder({
    origin_channel: 'invalido',
    cliente_id: clienteId,
    produto: 'Folder',
    quantidade: 500,
  }, null);
  expect(result.erro).toBeDefined();
  expect(result.erro[0]).toMatch(/origin_channel/);
});

test('atualizar status para em_producao', async () => {
  const criada = await service.criarOrder({
    origin_channel: 'site',
    cliente_id: clienteId,
    produto: 'Banner',
    quantidade: 1,
    observacoes: 'TEST_order',
  }, null);
  const result = await service.atualizarStatus(criada.order.id, 'em_producao', null);
  expect(result.erro).toBeUndefined();
  expect(result.order.status).toBe('em_producao');
});
```

- [ ] **Rodar testes**

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/lkl_chatbot_test npx jest tests/modules/orders.test.js --verbose
```

Saída esperada: 3 testes PASS.

- [ ] **Commit final Sprint 1-A**

```bash
git add src/modules/orders/ tests/modules/orders.test.js
git commit -m "feat(M1/M2): motor de orçamento automático e API de Ordens de Serviço com Socket.IO"
```

---

## Verificação Final Sprint 1-A

- [ ] **Rodar todos os testes**

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/lkl_chatbot_test npm test
```

Saída esperada: todos os testes PASS, zero falhas.

- [ ] **Verificar que o chatbot ainda funciona**

```bash
npm run dev
curl -s http://localhost:3000/webhook -X GET \
  "?hub.mode=subscribe&hub.verify_token=${WHATSAPP_WEBHOOK_VERIFY_TOKEN}&hub.challenge=test"
```

Saída esperada: `test` (challenge retornado — webhook ativo).

- [ ] **Verificar rotas `/api/v2` estão montadas**

```bash
curl -s http://localhost:3000/api/v2/price-table/catalogo
```

Saída esperada: `[]` (tabela vazia, mas rota responde sem erro).
