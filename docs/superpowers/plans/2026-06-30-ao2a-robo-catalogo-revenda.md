# AO-2a — Robô + Catálogo de Revenda (Graficonauta) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Espelhar para o banco da LKL um catálogo padronizado de produtos de revenda (Graficonauta) com matriz de preço (tiragem × prazo) e acabamentos, mantido por um robô que reusa um cookie de sessão (sem login automatizado).

**Architecture:** Parser puro (cheerio, testável contra fixtures) + scraper Playwright que **injeta o cookie salvo** (nunca loga, então o reCAPTCHA v3 fica fora do caminho) + job de sync (cron diário + spawn sob demanda) + service/router + UI. Catálogo em tabelas novas (migration 044).

**Tech Stack:** Node.js + Express, PostgreSQL (`pg`), Playwright/Chromium (scraping com cookie), cheerio (parsing), node-cron (já no projeto), Jest (parser puro), frontend vanilla em `public/dashboard.html`.

**Spec:** `docs/superpowers/specs/2026-06-30-ao2a-robo-catalogo-revenda-design.md`

---

## Decisão de planejamento que ajusta o spec

O spec previa `login()` via Playwright executando o reCAPTCHA v3. Na investigação ao vivo isso foi **provado inviável** (headless + stealth → `grecaptcha-error`). Decisão (aprovada): **reuso de cookie** — um cookie de sessão/`remember_web` válido é guardado no `.env` do VPS (`REVENDA_GRAFICONAUTA_COOKIE`); o robô **injeta** esse cookie no contexto Playwright e navega autenticado. **Sem login, sem reCAPTCHA.** Quando o cookie expira, o admin gera um novo manualmente (uma vez). Tudo o mais do spec vale.

## File Structure

- **Create** `sql/migrations/044_revenda_catalogo.sql` — `revenda_categorias`, `revenda_produtos`, `revenda_precos`, `revenda_acabamentos`, `revenda_sync_log`, `revenda_config`.
- **Create** `src/modules/revenda/parser.js` — funções puras `parseListaProdutos(html)` e `parseTabelaPreco(html)` (cheerio).
- **Create** `tests/revenda-parser.test.js` + `tests/fixtures/revenda/{lista.html,tabela.html}` — fixtures reais capturados na Task 2.
- **Create** `src/modules/revenda/scraper.js` — Playwright com cookie injetado: `comCookie(fn)`, `fetchHtml(url)`, `abrirTabelaPreco(page, url)`.
- **Create** `src/jobs/revenda-sync.js` — orquestra a sync (carrega categorias, raspa, parseia, upsert, log). Roda como `main` (spawnável) e exporta `runSync()`.
- **Create** `src/modules/revenda/service.js` — CRUD categorias, leitura do catálogo, status de sync, config, disparo (spawn).
- **Create** `src/modules/revenda/router.js` — rotas `/api/v2/revenda/*`.
- **Modify** `src/modules/index.js` — registrar `/revenda`.
- **Modify** `src/app.js` — registrar o cron diário (spawn do job).
- **Modify** `public/dashboard.html` — aba "Revenda".
- **Modify** `.env` (somente no VPS) — `REVENDA_GRAFICONAUTA_COOKIE`.

> **Convenções do projeto:** sem Postgres local (suítes de integração falham com `AggregateError` — pré-existente). Só as suítes puras rodam local e DEVEM passar. Validação real = smoke no VPS. Migrations numeradas aplicadas manualmente (tabelas novas como `lkl_user`). Deploy = `rsync` + `pm2 restart lkl-chatbot --update-env`. Próxima migration livre: **044**.

---

## Task 1: Migration 044 — tabelas do catálogo

**Files:**
- Create: `sql/migrations/044_revenda_catalogo.sql`

- [ ] **Step 1: Escrever a migration** com este conteúdo exato:

```sql
-- 044_revenda_catalogo.sql — AO-2a catálogo de revenda (Graficonauta)
CREATE TABLE IF NOT EXISTS revenda_categorias (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          VARCHAR(150) NOT NULL,
  url           TEXT NOT NULL,
  ativo         BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS revenda_produtos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref             VARCHAR(40) UNIQUE NOT NULL,
  nome            VARCHAR(200) NOT NULL,
  categoria_id    UUID REFERENCES revenda_categorias(id) ON DELETE SET NULL,
  url             TEXT,
  tamanho         VARCHAR(60),
  cores           VARCHAR(20),
  gramatura       VARCHAR(40),
  ativo           BOOLEAN DEFAULT TRUE,
  sincronizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_revenda_produtos_categoria ON revenda_produtos(categoria_id);

CREATE TABLE IF NOT EXISTS revenda_precos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id    UUID NOT NULL REFERENCES revenda_produtos(id) ON DELETE CASCADE,
  quantidade    INTEGER NOT NULL,
  prazo_horas   INTEGER NOT NULL,
  preco_total   NUMERIC(12,2) NOT NULL,
  UNIQUE (produto_id, quantidade, prazo_horas)
);
CREATE INDEX IF NOT EXISTS idx_revenda_precos_produto ON revenda_precos(produto_id);

CREATE TABLE IF NOT EXISTS revenda_acabamentos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id       UUID NOT NULL REFERENCES revenda_produtos(id) ON DELETE CASCADE,
  nome             VARCHAR(150) NOT NULL,
  preco            NUMERIC(12,2) NOT NULL,
  tipo             VARCHAR(20) NOT NULL CHECK (tipo IN ('acabamento','servico')),
  prazo_extra_dias INTEGER DEFAULT 0,
  UNIQUE (produto_id, nome)
);

CREATE TABLE IF NOT EXISTS revenda_sync_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  iniciado_em   TIMESTAMPTZ DEFAULT NOW(),
  finalizado_em TIMESTAMPTZ,
  status        VARCHAR(20) DEFAULT 'rodando' CHECK (status IN ('rodando','ok','erro')),
  produtos_atualizados INTEGER DEFAULT 0,
  erro          TEXT
);

CREATE TABLE IF NOT EXISTS revenda_config (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  markup_percent NUMERIC(6,2) DEFAULT 0,
  prazo_padrao_horas INTEGER DEFAULT 24,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO revenda_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
```

- [ ] **Step 2: Sanidade (sem DB local)**

Run: `node -e "const s=require('fs').readFileSync('sql/migrations/044_revenda_catalogo.sql','utf8'); ['revenda_categorias','revenda_produtos','revenda_precos','revenda_acabamentos','revenda_sync_log','revenda_config'].forEach(t=>{if(!new RegExp('CREATE TABLE IF NOT EXISTS '+t).test(s))throw new Error('falta '+t)}); console.log('OK: 6 tabelas presentes');"`
Expected: `OK: 6 tabelas presentes`

- [ ] **Step 3: Commit**

```bash
git add sql/migrations/044_revenda_catalogo.sql
git commit -m "feat(ao2a): migration 044 catalogo de revenda (categorias/produtos/precos/acabamentos/sync_log/config)"
```

---

## Task 2: Configurar cookie + capturar fixtures reais

> Esta task obtém o HTML real para os testes do parser. Sem ela, os seletores seriam chute. O cookie é fornecido pelo admin (DevTools → cabeçalho `Cookie` de uma sessão logada).

**Files:**
- Create: `scripts/revenda-capturar.js` (script de captura, fica no repo para recaptura futura)
- Create: `tests/fixtures/revenda/lista.html`, `tests/fixtures/revenda/tabela.html` (gerados pela captura)

- [ ] **Step 1: Instalar dependências de scraping (local)**

Run: `npm i playwright cheerio && npx playwright install chromium`
Expected: instala sem erro (Chromium baixado).

- [ ] **Step 2: Escrever o script de captura** `scripts/revenda-capturar.js`:

```javascript
// Captura HTML real do Graficonauta usando um cookie de sessão (sem login).
// Uso: REVENDA_GRAFICONAUTA_COOKIE="XSRF-TOKEN=...; laravel_session=...; remember_web_...=..." \
//      CATEGORIA_URL="https://sistema.graficonauta.com.br/<categoria>" \
//      PRODUTO_URL="https://sistema.graficonauta.com.br/p/<id>/0/<slug>" \
//      node scripts/revenda-capturar.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://sistema.graficonauta.com.br';
const COOKIE = process.env.REVENDA_GRAFICONAUTA_COOKIE;
const CATEGORIA_URL = process.env.CATEGORIA_URL;
const PRODUTO_URL = process.env.PRODUTO_URL;
const OUT = path.join(__dirname, '..', 'tests', 'fixtures', 'revenda');

function cookiesFromHeader(header) {
  return header.split(';').map(p => p.trim()).filter(Boolean).map(p => {
    const i = p.indexOf('=');
    return { name: p.slice(0, i), value: p.slice(i + 1), domain: 'sistema.graficonauta.com.br', path: '/' };
  });
}

(async () => {
  if (!COOKIE || !CATEGORIA_URL || !PRODUTO_URL) { console.error('Faltam env: REVENDA_GRAFICONAUTA_COOKIE, CATEGORIA_URL, PRODUTO_URL'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ locale: 'pt-BR' });
  await ctx.addCookies(cookiesFromHeader(COOKIE));
  const page = await ctx.newPage();

  await page.goto(CATEGORIA_URL, { waitUntil: 'networkidle', timeout: 45000 });
  if (/\/login/.test(page.url())) { console.error('Cookie inválido/expirado — caiu no /login'); process.exit(2); }
  fs.writeFileSync(path.join(OUT, 'lista.html'), await page.content());

  await page.goto(PRODUTO_URL, { waitUntil: 'networkidle', timeout: 45000 });
  const tab = await page.$('button:has-text("Tabela de preços"), a:has-text("Tabela de preços")');
  if (tab) { await tab.click(); await page.waitForTimeout(2500); }
  fs.writeFileSync(path.join(OUT, 'tabela.html'), await page.content());

  await browser.close();
  console.log('OK: lista.html e tabela.html salvos em', OUT);
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
```

- [ ] **Step 3: Rodar a captura** (admin fornece o cookie + URLs da categoria piloto e de 1 produto)

Run (exemplo com a categoria de folhetos e o produto Ref flte057):
```bash
REVENDA_GRAFICONAUTA_COOKIE="<cookie da sessão logada>" \
CATEGORIA_URL="<URL da categoria Folheto Couchê 115g>" \
PRODUTO_URL="<URL do produto Folheto 115g 10x14 4/0>" \
node scripts/revenda-capturar.js
```
Expected: `OK: lista.html e tabela.html salvos ...`. Se aparecer "Cookie inválido", obter um cookie novo (sessão logada) e repetir.

- [ ] **Step 4: Conferir que os fixtures têm os dados esperados**

Run: `node -e "const h=require('fs').readFileSync('tests/fixtures/revenda/tabela.html','utf8'); console.log('20,00?', /20[.,]00/.test(h), '| 580?', /580[.,]00/.test(h), '| Corte Extra?', /Corte Extra/i.test(h), '| flte057 na lista?', /flte057/i.test(require('fs').readFileSync('tests/fixtures/revenda/lista.html','utf8')));"`
Expected: todos `true` (confirma que a matriz de preço e os acabamentos vieram).

- [ ] **Step 5: Commit** (fixtures + script; o cookie NUNCA entra no git)

```bash
git add scripts/revenda-capturar.js tests/fixtures/revenda/lista.html tests/fixtures/revenda/tabela.html
git commit -m "chore(ao2a): script de captura + fixtures reais do Graficonauta para os testes do parser"
```

---

## Task 3: Parser — `parseTabelaPreco` (TDD contra fixture)

**Files:**
- Create: `src/modules/revenda/parser.js`
- Test: `tests/revenda-parser.test.js`

Os valores esperados vêm da tabela real (produto Folheto 115g 10x14 4/0): a matriz tiragem × {12h,24h,48h} e os acabamentos/serviços. `parseTabelaPreco(html)` devolve `{ linhas: [{quantidade, precos:{12,24,48}}], acabamentos: [{nome, preco, tipo, prazo_extra_dias}] }`.

- [ ] **Step 1: Escrever o teste** `tests/revenda-parser.test.js`:

```javascript
const fs = require('fs');
const path = require('path');
const { parseTabelaPreco } = require('../src/modules/revenda/parser');

const tabelaHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'revenda', 'tabela.html'), 'utf8');

describe('parseTabelaPreco', () => {
  const r = parseTabelaPreco(tabelaHtml);

  test('extrai todas as faixas de quantidade', () => {
    const qts = r.linhas.map(l => l.quantidade);
    expect(qts).toEqual([50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000]);
  });

  test('preços da faixa 50 (12h/24h/48h)', () => {
    const l = r.linhas.find(x => x.quantidade === 50);
    expect(l.precos[12]).toBeCloseTo(20.62, 2);
    expect(l.precos[24]).toBeCloseTo(20.00, 2);
    expect(l.precos[48]).toBeCloseTo(19.40, 2);
  });

  test('preços da faixa 20000 (24h)', () => {
    const l = r.linhas.find(x => x.quantidade === 20000);
    expect(l.precos[24]).toBeCloseTo(580.00, 2);
  });

  test('acabamentos e serviços com preço e tipo', () => {
    const corte = r.acabamentos.find(a => /corte extra/i.test(a.nome));
    expect(corte.preco).toBeCloseTo(1.00, 2);
    expect(corte.tipo).toBe('acabamento');
    const dobra = r.acabamentos.find(a => /dobra/i.test(a.nome));
    expect(dobra.preco).toBeCloseTo(10.00, 2);
    const checagem = r.acabamentos.find(a => /checagem/i.test(a.nome));
    expect(checagem.preco).toBeCloseTo(9.00, 2);
    expect(checagem.tipo).toBe('servico');
  });
});
```

- [ ] **Step 2: Rodar o teste — deve falhar**

Run: `npx jest tests/revenda-parser.test.js --no-coverage`
Expected: FAIL — `Cannot find module '../src/modules/revenda/parser'`.

- [ ] **Step 3: Implementar `parseTabelaPreco`** em `src/modules/revenda/parser.js`.

Inspecionar `tests/fixtures/revenda/tabela.html` (capturado na Task 2) e escrever os seletores cheerio que produzem a saída esperada. Estrutura conhecida da tela: uma tabela com a coluna "Quantidade" (linhas 50…20000) e colunas "Produção em: 12 horas / 24 horas / 48 horas"; e blocos "ACABAMENTOS" e "SERVIÇOS" com nome + preço. Esqueleto a completar com os seletores reais do fixture:

```javascript
const cheerio = require('cheerio');

// "R$ 1.234,56" | "20,00" → 1234.56 / 20.00
function moeda(txt) {
  const m = String(txt).replace(/[^0-9,.]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(m);
  return Number.isFinite(n) ? n : null;
}
// "1.000 un" | "50 un" → 1000 / 50
function inteiro(txt) {
  const n = parseInt(String(txt).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
// "Produção em: 24 horas" → 24
function horas(txt) {
  const m = String(txt).match(/(\d+)\s*hora/i);
  return m ? parseInt(m[1], 10) : null;
}

function parseTabelaPreco(html) {
  const $ = cheerio.load(html);
  const linhas = [];
  const acabamentos = [];

  // === MATRIZ ===
  // 1) Descobrir a ordem das colunas de prazo a partir do cabeçalho ("12 horas", "24 horas", "48 horas").
  // 2) Para cada linha de quantidade, ler a célula de cada coluna → precos[horas] = moeda(célula).
  // (Seletores exatos a partir do fixture tabela.html — confirmar as classes/estrutura reais.)
  // Exemplo de forma final:
  //   linhas.push({ quantidade: 50, precos: { 12: 20.62, 24: 20.00, 48: 19.40 } });

  // === ACABAMENTOS / SERVIÇOS ===
  // Bloco "ACABAMENTOS" → tipo 'acabamento'; bloco "SERVIÇOS" → tipo 'servico'.
  // Para cada item: nome (texto), preco (moeda), prazo_extra_dias (de "+N dia(s) útil", senão 0).
  //   acabamentos.push({ nome: '1 Corte Extra', preco: 1.00, tipo: 'acabamento', prazo_extra_dias: 0 });

  return { linhas, acabamentos };
}

module.exports = { parseTabelaPreco, moeda, inteiro, horas };
```

> Os helpers `moeda/inteiro/horas` são completos e testáveis; a montagem de `linhas`/`acabamentos` é escrita lendo o fixture real (as classes/estrutura exatas estão lá). O alvo é fazer os 4 testes do Step 1 passarem com os números reais.

- [ ] **Step 4: Rodar o teste — deve passar**

Run: `npx jest tests/revenda-parser.test.js --no-coverage`
Expected: PASS — 4 testes verdes (faixas, preços 50, preço 20000, acabamentos).

- [ ] **Step 5: Commit**

```bash
git add src/modules/revenda/parser.js tests/revenda-parser.test.js
git commit -m "feat(ao2a): parseTabelaPreco (matriz tiragem x prazo + acabamentos) com testes contra fixture real"
```

---

## Task 4: Parser — `parseListaProdutos` (TDD contra fixture)

**Files:**
- Modify: `src/modules/revenda/parser.js`
- Modify: `tests/revenda-parser.test.js`

`parseListaProdutos(html)` devolve `[{ ref, nome, url }]` a partir da página de categoria (cards com "Ref.: flte057" e nome "Folheto 115g | 10x14cm | 4/0").

- [ ] **Step 1: Acrescentar o teste** ao `tests/revenda-parser.test.js`:

```javascript
const { parseListaProdutos } = require('../src/modules/revenda/parser');
const listaHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'revenda', 'lista.html'), 'utf8');

describe('parseListaProdutos', () => {
  const prods = parseListaProdutos(listaHtml);
  test('encontra produtos com ref e nome', () => {
    expect(prods.length).toBeGreaterThan(0);
    const p = prods.find(x => /flte057/i.test(x.ref));
    expect(p).toBeTruthy();
    expect(p.nome).toMatch(/Folheto 115g/i);
    expect(p.url).toMatch(/^https?:\/\//);
  });
  test('refs são únicos e não vazios', () => {
    const refs = prods.map(p => p.ref);
    expect(refs.every(Boolean)).toBe(true);
    expect(new Set(refs).size).toBe(refs.length);
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

Run: `npx jest tests/revenda-parser.test.js --no-coverage -t parseListaProdutos`
Expected: FAIL — `parseListaProdutos is not a function`.

- [ ] **Step 3: Implementar `parseListaProdutos`** em `src/modules/revenda/parser.js` (ler o fixture `lista.html` para os seletores reais dos cards) e exportá-la:

```javascript
function parseListaProdutos(html) {
  const $ = cheerio.load(html);
  const out = [];
  // Cada card de produto na página de categoria tem: nome, "Ref.: <ref>", e um link para a página do produto.
  // Selecionar os cards a partir do fixture lista.html; para cada um:
  //   const nome = ...; const ref = (texto "Ref.: X" → X); const url = (href absoluto do card);
  //   if (ref && nome) out.push({ ref: ref.toLowerCase(), nome, url });
  return out;
}
module.exports = { parseTabelaPreco, parseListaProdutos, moeda, inteiro, horas };
```

> Substituir o `module.exports` anterior por este (inclui `parseListaProdutos`). Seletores exatos vêm do fixture.

- [ ] **Step 4: Rodar — deve passar**

Run: `npx jest tests/revenda-parser.test.js --no-coverage`
Expected: PASS — todos os blocos verdes (parseTabelaPreco + parseListaProdutos).

- [ ] **Step 5: Commit**

```bash
git add src/modules/revenda/parser.js tests/revenda-parser.test.js
git commit -m "feat(ao2a): parseListaProdutos (ref/nome/url dos cards de categoria) com testes"
```

---

## Task 5: Scraper Playwright com cookie injetado

**Files:**
- Create: `src/modules/revenda/scraper.js`

Helpers que abrem o Chromium com o cookie do `.env`, navegam e devolvem HTML. Sem login (cookie já autentica).

- [ ] **Step 1: Implementar** `src/modules/revenda/scraper.js`:

```javascript
const { chromium } = require('playwright');

const BASE = 'https://sistema.graficonauta.com.br';

function cookiesFromHeader(header) {
  return String(header || '').split(';').map(p => p.trim()).filter(Boolean).map(p => {
    const i = p.indexOf('=');
    return { name: p.slice(0, i), value: p.slice(i + 1), domain: 'sistema.graficonauta.com.br', path: '/' };
  });
}

// Abre um contexto autenticado pelo cookie e executa fn(page). Garante fechamento do browser.
async function comCookie(fn) {
  const header = process.env.REVENDA_GRAFICONAUTA_COOKIE;
  if (!header) throw new Error('REVENDA_GRAFICONAUTA_COOKIE ausente no .env');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ locale: 'pt-BR' });
    await ctx.addCookies(cookiesFromHeader(header));
    const page = await ctx.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// HTML de uma URL; lança se o cookie caiu (redirecionou para /login).
async function fetchHtml(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  if (/\/login(\?|$)/.test(page.url())) throw new Error('Cookie de revenda inválido/expirado (redirecionou para /login)');
  return page.content();
}

// HTML da página do produto com a "Tabela de preços" aberta.
async function fetchTabelaPreco(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  if (/\/login(\?|$)/.test(page.url())) throw new Error('Cookie de revenda inválido/expirado');
  const tab = await page.$('button:has-text("Tabela de preços"), a:has-text("Tabela de preços")');
  if (tab) { await tab.click().catch(() => {}); await page.waitForTimeout(2000); }
  return page.content();
}

module.exports = { comCookie, fetchHtml, fetchTabelaPreco, BASE };
```

- [ ] **Step 2: Sanidade — módulo carrega**

Run: `node -e "const s=require('./src/modules/revenda/scraper'); console.log(Object.keys(s).sort().join(','))"`
Expected: `BASE,comCookie,fetchHtml,fetchTabelaPreco`

- [ ] **Step 3: Commit**

```bash
git add src/modules/revenda/scraper.js
git commit -m "feat(ao2a): scraper Playwright com cookie injetado (sem login)"
```

---

## Task 6: Job de sincronização + cron

**Files:**
- Create: `src/jobs/revenda-sync.js`
- Modify: `src/app.js`

`runSync()`: cria `revenda_sync_log` (rodando), para cada categoria ativa raspa a lista, para cada produto raspa a tabela, parseia e faz upsert; ao fim marca log ok/erro. Rodável como `main` (spawn) e por cron.

- [ ] **Step 1: Implementar** `src/jobs/revenda-sync.js`:

```javascript
require('dotenv').config();
const db = require('../db');
const parser = require('../modules/revenda/parser');
const scraper = require('../modules/revenda/scraper');

function log(m) { console.log(`[REVENDA-SYNC] ${new Date().toISOString()} ${m}`); }

async function upsertProduto(catId, p, tabela) {
  // produto (upsert por ref)
  const r = await db.query(
    `INSERT INTO revenda_produtos (ref, nome, categoria_id, url, ativo, sincronizado_em)
     VALUES ($1,$2,$3,$4,TRUE,NOW())
     ON CONFLICT (ref) DO UPDATE SET nome=EXCLUDED.nome, categoria_id=EXCLUDED.categoria_id,
       url=EXCLUDED.url, ativo=TRUE, sincronizado_em=NOW()
     RETURNING id`,
    [p.ref, p.nome, catId, p.url]
  );
  const pid = r.rows[0].id;
  // substitui matriz e acabamentos
  await db.query('DELETE FROM revenda_precos WHERE produto_id=$1', [pid]);
  for (const linha of tabela.linhas) {
    for (const h of [12, 24, 48]) {
      if (linha.precos[h] != null) {
        await db.query(
          'INSERT INTO revenda_precos (produto_id, quantidade, prazo_horas, preco_total) VALUES ($1,$2,$3,$4)',
          [pid, linha.quantidade, h, linha.precos[h]]
        );
      }
    }
  }
  await db.query('DELETE FROM revenda_acabamentos WHERE produto_id=$1', [pid]);
  for (const a of tabela.acabamentos) {
    await db.query(
      `INSERT INTO revenda_acabamentos (produto_id, nome, preco, tipo, prazo_extra_dias)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (produto_id, nome) DO UPDATE SET preco=EXCLUDED.preco`,
      [pid, a.nome, a.preco, a.tipo, a.prazo_extra_dias || 0]
    );
  }
  return p.ref;
}

async function runSync() {
  const logR = await db.query("INSERT INTO revenda_sync_log (status) VALUES ('rodando') RETURNING id");
  const logId = logR.rows[0].id;
  let count = 0;
  try {
    const cats = (await db.query('SELECT id, url FROM revenda_categorias WHERE ativo=TRUE')).rows;
    await scraper.comCookie(async (page) => {
      for (const cat of cats) {
        const listaHtml = await scraper.fetchHtml(page, cat.url);
        const produtos = parser.parseListaProdutos(listaHtml);
        const refsVistos = [];
        for (const p of produtos) {
          try {
            const tabHtml = await scraper.fetchTabelaPreco(page, p.url);
            const tabela = parser.parseTabelaPreco(tabHtml);
            await upsertProduto(cat.id, p, tabela);
            refsVistos.push(p.ref);
            count++;
            await page.waitForTimeout(800); // gentileza com o site
          } catch (e) { log(`produto ${p.ref} falhou: ${e.message}`); }
        }
        // produtos da categoria não vistos → inativos
        if (refsVistos.length) {
          await db.query(
            `UPDATE revenda_produtos SET ativo=FALSE
             WHERE categoria_id=$1 AND ref <> ALL($2::varchar[])`,
            [cat.id, refsVistos]
          );
        }
      }
    });
    await db.query("UPDATE revenda_sync_log SET status='ok', finalizado_em=NOW(), produtos_atualizados=$2 WHERE id=$1", [logId, count]);
    log(`OK: ${count} produtos`);
  } catch (e) {
    await db.query("UPDATE revenda_sync_log SET status='erro', finalizado_em=NOW(), erro=$2 WHERE id=$1", [logId, e.message]);
    log(`ERRO: ${e.message}`);
    throw e;
  }
}

module.exports = { runSync };

if (require.main === module) {
  runSync().then(() => process.exit(0)).catch(() => process.exit(1));
}
```

- [ ] **Step 2: Registrar o cron** em `src/app.js` (perto do `require('./jobs/contas-pagar');`, linha ~20). Adicionar:

```javascript
require('./jobs/contas-pagar');
// Revenda: sync diária às 04:00 (spawn do job em processo filho — Chromium fora do web)
const cron = require('node-cron');
const { spawn } = require('child_process');
cron.schedule('0 4 * * *', () => {
  const p = spawn('node', [require('path').join(__dirname, 'jobs', 'revenda-sync.js')], { stdio: 'inherit' });
  p.on('exit', (code) => console.log(`[REVENDA-SYNC] cron finalizou code=${code}`));
}, { timezone: 'America/Sao_Paulo' });
```

- [ ] **Step 3: Sanidade — carrega sem erro**

Run: `node -e "require('./src/jobs/revenda-sync'); console.log('job OK')"`
Expected: `job OK` (carrega o módulo; não dispara sync porque não é `main`).

- [ ] **Step 4: Commit**

```bash
git add src/jobs/revenda-sync.js src/app.js
git commit -m "feat(ao2a): job de sync (upsert catalogo) + cron diario 04h via spawn"
```

---

## Task 7: Service + Router + registro

**Files:**
- Create: `src/modules/revenda/service.js`
- Create: `src/modules/revenda/router.js`
- Modify: `src/modules/index.js`

- [ ] **Step 1: Implementar** `src/modules/revenda/service.js`:

```javascript
const db = require('../../db');
const path = require('path');
const { spawn } = require('child_process');

// Categorias
async function listarCategorias() {
  return (await db.query('SELECT * FROM revenda_categorias ORDER BY nome')).rows;
}
async function criarCategoria(d) {
  if (!d.nome || !d.url) return { erro: ['nome e url são obrigatórios'] };
  const r = await db.query('INSERT INTO revenda_categorias (nome, url) VALUES ($1,$2) RETURNING *', [d.nome, d.url]);
  return { item: r.rows[0] };
}
async function atualizarCategoria(id, d) {
  const r = await db.query(
    'UPDATE revenda_categorias SET nome=COALESCE($1,nome), url=COALESCE($2,url), ativo=COALESCE($3,ativo) WHERE id=$4 RETURNING *',
    [d.nome ?? null, d.url ?? null, d.ativo, id]
  );
  if (!r.rows[0]) return { erro: ['Categoria não encontrada'] };
  return { item: r.rows[0] };
}

// Catálogo (produto + matriz + acabamentos)
async function listarProdutos({ busca } = {}) {
  const params = [];
  let where = 'WHERE ativo=TRUE';
  if (busca) { params.push(`%${busca}%`); where += ` AND (nome ILIKE $1 OR ref ILIKE $1)`; }
  const prods = (await db.query(`SELECT * FROM revenda_produtos ${where} ORDER BY nome LIMIT 500`, params)).rows;
  return prods;
}
async function detalheProduto(id) {
  const prod = (await db.query('SELECT * FROM revenda_produtos WHERE id=$1', [id])).rows[0];
  if (!prod) return null;
  prod.precos = (await db.query('SELECT quantidade, prazo_horas, preco_total FROM revenda_precos WHERE produto_id=$1 ORDER BY quantidade, prazo_horas', [id])).rows;
  prod.acabamentos = (await db.query('SELECT nome, preco, tipo, prazo_extra_dias FROM revenda_acabamentos WHERE produto_id=$1 ORDER BY tipo, nome', [id])).rows;
  return prod;
}

// Sync
async function statusSync() {
  return (await db.query('SELECT * FROM revenda_sync_log ORDER BY iniciado_em DESC LIMIT 1')).rows[0] || null;
}
async function dispararSync() {
  const atual = await statusSync();
  if (atual && atual.status === 'rodando') return { erro: ['Já há uma sincronização em andamento'] };
  const job = path.join(__dirname, '..', '..', 'jobs', 'revenda-sync.js');
  const p = spawn('node', [job], { detached: true, stdio: 'ignore', env: process.env });
  p.unref();
  return { ok: true };
}

// Config
async function getConfig() {
  return (await db.query('SELECT markup_percent, prazo_padrao_horas FROM revenda_config WHERE id=1')).rows[0];
}
async function setConfig(d) {
  const r = await db.query(
    'UPDATE revenda_config SET markup_percent=COALESCE($1,markup_percent), prazo_padrao_horas=COALESCE($2,prazo_padrao_horas), updated_at=NOW() WHERE id=1 RETURNING markup_percent, prazo_padrao_horas',
    [d.markup_percent ?? null, d.prazo_padrao_horas ?? null]
  );
  return { item: r.rows[0] };
}

module.exports = {
  listarCategorias, criarCategoria, atualizarCategoria,
  listarProdutos, detalheProduto,
  statusSync, dispararSync,
  getConfig, setConfig,
};
```

- [ ] **Step 2: Implementar** `src/modules/revenda/router.js`:

```javascript
const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');
const router = express.Router();
const adminGestor = requireRole('admin', 'gestor');
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); } };

router.get('/categorias', adminGestor, wrap(async (req, res) => res.json(await service.listarCategorias())));
router.post('/categorias', adminGestor, wrap(async (req, res) => {
  const r = await service.criarCategoria(req.body); if (r.erro) return res.status(400).json({ errors: r.erro }); res.status(201).json(r.item);
}));
router.put('/categorias/:id', adminGestor, wrap(async (req, res) => {
  const r = await service.atualizarCategoria(req.params.id, req.body); if (r.erro) return res.status(400).json({ errors: r.erro }); res.json(r.item);
}));

router.get('/produtos', wrap(async (req, res) => res.json(await service.listarProdutos({ busca: req.query.busca }))));
router.get('/produtos/:id', wrap(async (req, res) => {
  const p = await service.detalheProduto(req.params.id); if (!p) return res.status(404).json({ error: 'Produto não encontrado' }); res.json(p);
}));

router.post('/sincronizar', adminGestor, wrap(async (req, res) => {
  const r = await service.dispararSync(); if (r.erro) return res.status(409).json({ errors: r.erro }); res.json({ ok: true });
}));
router.get('/sync/status', wrap(async (req, res) => res.json(await service.statusSync())));

router.get('/config', wrap(async (req, res) => res.json(await service.getConfig())));
router.put('/config', adminGestor, wrap(async (req, res) => res.json((await service.setConfig(req.body)).item)));

module.exports = router;
```

- [ ] **Step 3: Registrar** em `src/modules/index.js` — após a linha do `precificacao` (criada no AO-1):

```javascript
router.use('/precificacao', requireAuthApi, require('./precificacao/router'));
router.use('/revenda', requireAuthApi, require('./revenda/router'));
```

- [ ] **Step 4: Sanidade — aggregate carrega**

Run: `node -e "const r=require('./src/modules'); console.log('modules OK:', typeof r)"`
Expected: `modules OK: function`

- [ ] **Step 5: Commit**

```bash
git add src/modules/revenda/service.js src/modules/revenda/router.js src/modules/index.js
git commit -m "feat(ao2a): service+router /api/v2/revenda (categorias, catalogo, sync, config) + registro"
```

---

## Task 8: UI — aba "Revenda" no painel

**Files:**
- Modify: `public/dashboard.html`

A aba mostra: categorias (cadastro/ativar), botão sincronizar + status, busca no catálogo (produto → matriz + acabamentos), e config (markup + prazo). Usa `api(path,{...})` (caminho completo `/api/v2/...`), `showModal`, `closeModal`, `showToast`, `escHtml`.

- [ ] **Step 1: Localizar âncoras**

Run: `grep -n "id=\"page-prices\"|NAV = \[|{ id: 'prices'|function showPage|loaders = {" public/dashboard.html | head`
Expected: imprime o array de NAV, o mapa de loaders e a página de Preços (modelo para adicionar a nova aba/página). Anote os números de linha.

- [ ] **Step 2: Adicionar item de NAV + página** `#page-revenda`

No array `NAV` (perto do item `{ id: 'prices', ... }`), adicionar:
```javascript
{ id: 'revenda',   label: 'Revenda',       icon: '🛰️', roles: ['admin','gestor'] },
```
No mapa de loaders (onde está `prices: loadPrices,`), adicionar:
```javascript
    revenda:      loadRevenda,
```
E adicionar a página (logo após o bloco `<div class="page" id="page-prices"> ... </div>`):
```html
  <!-- REVENDA -->
  <div class="page" id="page-revenda">
    <div class="page-header"><div><h1>🛰️ Revenda (Graficonauta)</h1><p>Catálogo sincronizado e configuração de margem</p></div></div>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
      <button class="btn btn-primary" onclick="sincronizarRevenda()">🔄 Sincronizar agora</button>
      <span id="revenda-sync-status" style="font-size:13px;color:#666"></span>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <div style="flex:1;min-width:280px"><h3 style="margin:0 0 8px">Categorias a sincronizar</h3>
        <div id="revenda-categorias">Carregando…</div>
        <button class="btn btn-outline" style="margin-top:8px" onclick="abrirNovaCategoriaRevenda()">➕ Nova categoria</button></div>
      <div style="flex:1;min-width:280px"><h3 style="margin:0 0 8px">Configuração</h3>
        <label style="font-size:13px">Margem global (%)<br><input id="rev-markup" type="number" step="0.01" style="width:120px;padding:6px;border:1px solid #ddd;border-radius:6px"></label>
        <label style="font-size:13px;margin-left:12px">Prazo padrão<br>
          <select id="rev-prazo" style="padding:6px;border:1px solid #ddd;border-radius:6px"><option value="12">12h</option><option value="24">24h</option><option value="48">48h</option></select></label>
        <div><button class="btn btn-outline" style="margin-top:8px" onclick="salvarConfigRevenda()">Salvar config</button></div></div>
    </div>
    <h3 style="margin:0 0 8px">Catálogo</h3>
    <input id="rev-busca" placeholder="Buscar por nome ou Ref…" oninput="loadCatalogoRevenda()" style="width:100%;max-width:360px;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:10px">
    <div id="revenda-catalogo">Carregando…</div>
  </div>
```

- [ ] **Step 3: Funções JS** (adicionar no `<script>`, perto de `loadPrices`):

```javascript
async function loadRevenda() {
  loadCategoriasRevenda(); loadCatalogoRevenda(); loadConfigRevenda(); atualizarStatusRevenda();
}
async function loadCategoriasRevenda() {
  const host = document.getElementById('revenda-categorias'); if (!host) return;
  const cats = await api('/api/v2/revenda/categorias');
  host.innerHTML = (Array.isArray(cats) && cats.length)
    ? cats.map(c => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f0f0f0">
         <span>${escHtml(c.nome)} ${c.ativo ? '' : '<span style="color:#c00">(inativa)</span>'}</span>
         <button class="btn btn-outline" style="font-size:11px;padding:3px 8px" onclick="toggleCategoriaRevenda('${c.id}', ${!c.ativo})">${c.ativo ? 'desativar' : 'ativar'}</button>
       </div>`).join('')
    : '<p style="color:#888;font-size:13px">Nenhuma categoria cadastrada.</p>';
}
function abrirNovaCategoriaRevenda() {
  showModal('Nova categoria de revenda', `
    <label style="font-size:13px">Apelido<br><input id="rc-nome" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px"></label>
    <label style="font-size:13px">URL da categoria (Graficonauta)<br><input id="rc-url" placeholder="https://sistema.graficonauta.com.br/..." style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px"></label>
    <button class="btn btn-primary" style="width:100%;margin-top:10px" onclick="salvarCategoriaRevenda()">Salvar</button>`);
}
async function salvarCategoriaRevenda() {
  const body = { nome: document.getElementById('rc-nome').value, url: document.getElementById('rc-url').value };
  const r = await api('/api/v2/revenda/categorias', { method: 'POST', body: JSON.stringify(body) });
  if (r && !r.errors) { closeModal(); showToast('✅ Categoria salva'); loadCategoriasRevenda(); }
  else showToast('❌ ' + (r?.errors?.[0] || 'Erro'));
}
async function toggleCategoriaRevenda(id, ativo) {
  await api('/api/v2/revenda/categorias/' + id, { method: 'PUT', body: JSON.stringify({ ativo }) });
  loadCategoriasRevenda();
}
async function loadCatalogoRevenda() {
  const host = document.getElementById('revenda-catalogo'); if (!host) return;
  const busca = document.getElementById('rev-busca')?.value || '';
  const prods = await api('/api/v2/revenda/produtos?busca=' + encodeURIComponent(busca));
  host.innerHTML = (Array.isArray(prods) && prods.length)
    ? '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#f5f7ff;text-align:left"><th style="padding:8px">Ref</th><th style="padding:8px">Produto</th><th style="padding:8px"></th></tr></thead><tbody>'
      + prods.map(p => `<tr style="border-bottom:1px solid #f0f0f0"><td style="padding:8px">${escHtml(p.ref)}</td><td style="padding:8px">${escHtml(p.nome)}</td>
          <td style="padding:8px"><button class="btn btn-outline" style="font-size:11px;padding:3px 8px" onclick="verProdutoRevenda('${p.id}')">ver preços</button></td></tr>`).join('')
      + '</tbody></table>'
    : '<p style="color:#888;font-size:13px">Catálogo vazio — cadastre uma categoria e sincronize.</p>';
}
async function verProdutoRevenda(id) {
  const p = await api('/api/v2/revenda/produtos/' + id);
  if (!p) return;
  const prazos = [12, 24, 48];
  const qts = [...new Set(p.precos.map(x => x.quantidade))].sort((a, b) => a - b);
  const cell = (q, h) => { const r = p.precos.find(x => x.quantidade === q && x.prazo_horas === h); return r ? 'R$ ' + Number(r.preco_total).toFixed(2) : '—'; };
  const matriz = '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th style="padding:6px;text-align:left">Qtd</th>'
    + prazos.map(h => `<th style="padding:6px">${h}h</th>`).join('') + '</tr></thead><tbody>'
    + qts.map(q => `<tr><td style="padding:6px">${q}</td>${prazos.map(h => `<td style="padding:6px;text-align:center">${cell(q, h)}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
  const acab = p.acabamentos.length ? '<h4>Acabamentos / Serviços</h4>' + p.acabamentos.map(a => `<div>${escHtml(a.nome)} — R$ ${Number(a.preco).toFixed(2)} <span style="color:#888">(${a.tipo})</span></div>`).join('') : '';
  showModal(p.nome, matriz + acab);
}
async function loadConfigRevenda() {
  const c = await api('/api/v2/revenda/config'); if (!c) return;
  document.getElementById('rev-markup').value = c.markup_percent;
  document.getElementById('rev-prazo').value = c.prazo_padrao_horas;
}
async function salvarConfigRevenda() {
  const body = { markup_percent: document.getElementById('rev-markup').value, prazo_padrao_horas: document.getElementById('rev-prazo').value };
  await api('/api/v2/revenda/config', { method: 'PUT', body: JSON.stringify(body) });
  showToast('✅ Config salva');
}
async function sincronizarRevenda() {
  const r = await api('/api/v2/revenda/sincronizar', { method: 'POST', body: '{}' });
  if (r && r.errors) { showToast('❌ ' + r.errors[0]); return; }
  showToast('🔄 Sincronização iniciada'); atualizarStatusRevenda();
}
async function atualizarStatusRevenda() {
  const el = document.getElementById('revenda-sync-status'); if (!el) return;
  const s = await api('/api/v2/revenda/sync/status');
  if (!s) { el.textContent = 'Nunca sincronizado.'; return; }
  el.textContent = `Última: ${new Date(s.iniciado_em).toLocaleString('pt-BR')} — ${s.status}${s.produtos_atualizados ? ' (' + s.produtos_atualizados + ' produtos)' : ''}${s.erro ? ' · ' + s.erro : ''}`;
  if (s.status === 'rodando') setTimeout(atualizarStatusRevenda, 5000);
}
```

- [ ] **Step 4: Verificar sintaxe dos blocos `<script>`**

Run: `node -e "const h=require('fs').readFileSync('public/dashboard.html','utf8');const re=/<script[^>]*>([\s\S]*?)<\/script>/g;const cp=require('child_process');let m,i=0,f=0;while((m=re.exec(h))){i++;const c=m[1];if(!c.trim())continue;const t='/tmp/d'+i+'.js';require('fs').writeFileSync(t,c);try{cp.execSync('node --check '+t,{stdio:'pipe'})}catch(e){f++;console.log('script#'+i+' ERRO')}}console.log(f?'FAIL '+f:'ALL SCRIPTS OK')"`
Expected: `ALL SCRIPTS OK`

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(ao2a): aba Revenda no painel (categorias, sync+status, catalogo, config)"
```

---

## Task 9: Deploy VPS + Playwright + cookie + smoke

**Files:**
- Modify: `~/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Deploy do código**

```bash
rsync -az --exclude node_modules --exclude .git --exclude backups /Users/klebercamara/LKL/ root@2.25.147.243:/var/www/lkl-chatbot/
```

- [ ] **Step 2: Instalar Playwright + Chromium no VPS**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && npm i playwright cheerio && npx playwright install --with-deps chromium"
```
Expected: instala Chromium + libs do sistema sem erro. (Se `--with-deps` falhar por permissão, rodar `npx playwright install-deps chromium` como root e depois `npx playwright install chromium`.)

- [ ] **Step 3: Aplicar a migration 044 (como lkl_user)**

```bash
ssh root@2.25.147.243 'set -a; . /var/www/lkl-chatbot/.env; set +a; PGPASSWORD="$DB_PASSWORD" psql -h "${DB_HOST:-localhost}" -U "$DB_USER" -d "$DB_NAME" -f /var/www/lkl-chatbot/sql/migrations/044_revenda_catalogo.sql'
```
Expected: `CREATE TABLE`/`INSERT 0 1` sem erro.

- [ ] **Step 4: Configurar o cookie no `.env` do VPS** (NUNCA commitar)

```bash
ssh root@2.25.147.243 "grep -q REVENDA_GRAFICONAUTA_COOKIE /var/www/lkl-chatbot/.env || echo 'REVENDA_GRAFICONAUTA_COOKIE=' >> /var/www/lkl-chatbot/.env"
# editar manualmente o valor (cookie de uma sessão logada, com remember_web):
ssh root@2.25.147.243 "nano /var/www/lkl-chatbot/.env"   # ou sed para setar a linha
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```

- [ ] **Step 5: Cadastrar a categoria piloto + smoke da sync**

```bash
# Inserir a categoria piloto direto no banco (ou pela UI):
ssh root@2.25.147.243 'set -a; . /var/www/lkl-chatbot/.env; set +a; PGPASSWORD="$DB_PASSWORD" psql -h localhost -U "$DB_USER" -d "$DB_NAME" -c "INSERT INTO revenda_categorias (nome,url) VALUES ('"'"'Folheto Couchê 115g'"'"','"'"'<URL_DA_CATEGORIA>'"'"')"'
# Rodar o job manualmente (usa o cookie do .env):
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node src/jobs/revenda-sync.js"
# Conferir que populou:
ssh root@2.25.147.243 'set -a; . /var/www/lkl-chatbot/.env; set +a; PGPASSWORD="$DB_PASSWORD" psql -h localhost -U "$DB_USER" -d "$DB_NAME" -c "SELECT (SELECT count(*) FROM revenda_produtos) AS produtos, (SELECT count(*) FROM revenda_precos) AS precos, (SELECT count(*) FROM revenda_acabamentos) AS acab, (SELECT status FROM revenda_sync_log ORDER BY iniciado_em DESC LIMIT 1) AS ultimo;"'
```
Expected: `produtos > 0`, `precos > 0`, `ultimo = ok`. Se `erro`, ler `revenda_sync_log.erro` (cookie expirado → renovar; seletor → ajustar parser contra novo fixture).

- [ ] **Step 6: Atualizar a memória do projeto**

Acrescentar ao `project_sprint_status.md` um parágrafo no estilo dos demais: AO-2a concluído (migration 044, parser puro com fixtures, scraper Playwright cookie-inject, job+cron 04h, service/router /api/v2/revenda, aba Revenda, deploy + Chromium no VPS, smoke da categoria piloto). Registrar: login por **cookie-reuse** (reCAPTCHA v3 inviabilizou login automatizado); `REVENDA_GRAFICONAUTA_COOKIE` no `.env`; **substitui** o placeholder `precos_revenda` do AO-1; PRÓXIMO = **AO-2b** (consumo no orçamento: seletor de revenda + faixa+prazo+markup+acabamentos). Próxima migration livre: 045.

- [ ] **Step 7: Commit final**

```bash
git add -A
git commit -m "chore(ao2a): smoke VPS da sync piloto + registro do AO-2a na memoria"
```

---

## Self-Review (preenchido pelo autor do plano)

**Cobertura do spec:**
- Tabelas do catálogo (categorias/produtos/precos/acabamentos/sync_log/config) → Task 1. ✓
- Captura de fixtures reais → Task 2. ✓
- Parser puro (tabela + lista) com testes → Tasks 3-4. ✓
- Scraper com cookie injetado (sem login, sem reCAPTCHA) → Task 5. ✓
- Job de sync (upsert idempotente, inativar não-vistos) + cron diário + spawn → Task 6. ✓
- Service/Router (categorias, catálogo, sync sob demanda, status, config) → Task 7. ✓
- UI aba Revenda → Task 8. ✓
- Deploy + Chromium + cookie + smoke + memória → Task 9. ✓

**Ajuste consciente do spec:** o spec falava em `login()` Playwright executando o reCAPTCHA v3; foi **substituído por cookie-reuse** (login automatizado provado inviável). Documentado no topo e na memória.

**Consistência de nomes:** `parseTabelaPreco`/`parseListaProdutos` (parser) usados igual em testes, scraper-job. `comCookie/fetchHtml/fetchTabelaPreco` (scraper) idem no job. Colunas (`revenda_precos.prazo_horas`, `preco_total`; `revenda_acabamentos.tipo`) idênticas na migration, no job e na UI.

**Limite honesto conhecido:** os **seletores cheerio** exatos do parser (Task 3-4, Step 3) são escritos lendo o fixture real capturado na Task 2 — não dá para fixá-los antes da captura. Os **valores esperados** nos testes são reais (dos prints), então o TDD é concreto: o implementador escreve seletores até a saída bater com os números conhecidos. Depende do **cookie** (admin fornece) para a Task 2 e o smoke da Task 9.
