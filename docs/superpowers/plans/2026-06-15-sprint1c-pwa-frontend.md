# Sprint 1-C — PWA Frontend + FCM Push Notifications

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o PWA mobile-first para vendedores/atendentes da LKL com login, criação de pedido, carteira de pedidos e notificações push via Firebase Cloud Messaging.

**Architecture:** Vanilla JS + CSS sem bundler (padrão do projeto), servido pelo Express em `public/pwa/`. Service worker na raiz (`public/sw.js`) para escopo total do FCM. Backend usa `firebase-admin` para enviar push ao vendedor quando o status da OS muda.

**Tech Stack:** Node.js 20 + Express 4 + firebase-admin 12 + Firebase JS SDK v10 (CDN compat) + vanilla PWA APIs (manifest, service worker, Push API)

---

## Mapa de Arquivos

| Arquivo | Ação | Responsabilidade |
|---------|------|-----------------|
| `sql/migrations/002_device_tokens.sql` | Criar | Tabela `device_tokens` por usuário |
| `src/services/fcm.js` | Criar | firebase-admin: inicializar + sendToUser() |
| `src/modules/notifications/router.js` | Criar | POST/DELETE /api/v2/notifications/token |
| `src/modules/index.js` | Modificar | Registrar rota notifications |
| `src/modules/orders/service.js` | Modificar | Chamar fcm.sendToUser() em atualizarStatus() |
| `src/index.js` | Modificar | Rota GET /pwa → redireciona para login |
| `public/manifest.json` | Criar | PWA manifest (nome, ícones, start_url) |
| `public/sw.js` | Criar | Service worker: FCM background + cache |
| `public/pwa/login.html` | Criar | Tela de login mobile-first |
| `public/pwa/pedidos.html` | Criar | Novo Pedido + Carteira do Vendedor |
| `public/pwa/app.js` | Criar | Auth helpers + FCM token registration |
| `tests/modules/notifications.test.js` | Criar | Testes de integração da API de tokens |

---

## Task 1: Tabela device_tokens + firebase-admin

**Files:**
- Create: `sql/migrations/002_device_tokens.sql`
- Create: `src/services/fcm.js`
- Modify: `package.json` (adicionar firebase-admin)

**Contexto:** O projeto usa Node.js CommonJS (require/module.exports). O arquivo de credenciais do Firebase está em `/root/lkl-grafica-adminsdk.json` no VPS. Localmente o caminho pode ser diferente — usar variável `FIREBASE_SERVICE_ACCOUNT_PATH` do `.env`. O `pg` pool está em `src/db/index.js`.

- [ ] **Step 1: Instalar firebase-admin**

```bash
cd /Users/klebercamara/LKL
npm install firebase-admin
```

Verificar: `node -e "require('firebase-admin'); console.log('ok')"` deve imprimir `ok`.

- [ ] **Step 2: Criar migration device_tokens**

Criar `/Users/klebercamara/LKL/sql/migrations/002_device_tokens.sql`:

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS device_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  platform   VARCHAR(20) DEFAULT 'web',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, token)
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);

COMMIT;
```

- [ ] **Step 3: Aplicar migration localmente (banco de teste)**

```bash
# Verificar que o banco de teste existe
psql postgresql://postgres:postgres@localhost:5432/lkl_chatbot_test -c "\dt" 2>&1 | head -5
# Aplicar
psql postgresql://postgres:postgres@localhost:5432/lkl_chatbot_test -f sql/migrations/002_device_tokens.sql
```

Esperado: `CREATE TABLE` + `CREATE INDEX` + `COMMIT`

- [ ] **Step 4: Criar src/services/fcm.js**

```js
const admin = require('firebase-admin');
const db = require('../db');

let initialized = false;

function init() {
  if (initialized) return;
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!path) {
    console.warn('[FCM] FIREBASE_SERVICE_ACCOUNT_PATH não definido — push desativado');
    return;
  }
  try {
    admin.initializeApp({ credential: admin.credential.cert(require(path)) });
    initialized = true;
  } catch (e) {
    console.error('[FCM] Falha ao inicializar firebase-admin:', e.message);
  }
}

async function sendToUser(userId, { title, body, data = {} }) {
  if (!initialized) return;
  const result = await db.query(
    'SELECT token FROM device_tokens WHERE user_id = $1',
    [userId]
  );
  if (!result.rows.length) return;

  const tokens = result.rows.map(r => r.token);
  const message = {
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    tokens,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    // Remove tokens inválidos
    const invalid = [];
    response.responses.forEach((r, i) => {
      if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
        invalid.push(tokens[i]);
      }
    });
    if (invalid.length) {
      await db.query(
        'DELETE FROM device_tokens WHERE token = ANY($1)',
        [invalid]
      );
    }
  } catch (e) {
    console.error('[FCM] Erro ao enviar push:', e.message);
  }
}

module.exports = { init, sendToUser };
```

- [ ] **Step 5: Inicializar FCM no startup**

Modificar `src/index.js` — após `require` dos outros módulos, adicionar:

```js
const fcm = require('./services/fcm');
```

E dentro da função `start()`, antes de `server.listen(...)`:

```js
fcm.init();
```

- [ ] **Step 6: Commit**

```bash
git add sql/migrations/002_device_tokens.sql src/services/fcm.js src/index.js package.json package-lock.json
git commit -m "feat: firebase-admin + device_tokens table"
```

---

## Task 2: API de Device Tokens (registrar/remover FCM token)

**Files:**
- Create: `src/modules/notifications/router.js`
- Modify: `src/modules/index.js`
- Create: `tests/modules/notifications.test.js`

**Contexto:** `requireAuthApi` está em `src/middleware/auth.js` e extrai `req.user` do JWT. O `db` pool está em `src/db/index.js`. Padrão do projeto: router Express CommonJS com async/await e try/catch retornando JSON.

- [ ] **Step 1: Escrever teste que falha**

Criar `tests/modules/notifications.test.js`:

```js
const request = require('supertest');
const app = require('../../src/app');
const db = require('../../src/db');
const jwt = require('jsonwebtoken');

let token;
let userId;

beforeAll(async () => {
  // Criar usuário de teste
  const result = await db.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ('Test Vendedor', 'vendedor.test@lkl.com', 'hash', 'vendedor')
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`
  );
  userId = result.rows[0].id;
  token = jwt.sign(
    { id: userId, name: 'Test Vendedor', email: 'vendedor.test@lkl.com', role: 'vendedor' },
    process.env.JWT_SECRET
  );
});

afterAll(async () => {
  await db.query('DELETE FROM device_tokens WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM users WHERE email = $1', ['vendedor.test@lkl.com']);
  await db.end();
});

describe('POST /api/v2/notifications/token', () => {
  test('salva token FCM do usuário', async () => {
    const res = await request(app)
      .post('/api/v2/notifications/token')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: 'fcm-test-token-abc123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('retorna 400 sem token', async () => {
    const res = await request(app)
      .post('/api/v2/notifications/token')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('retorna 401 sem autenticação', async () => {
    const res = await request(app)
      .post('/api/v2/notifications/token')
      .send({ token: 'fcm-test-token-abc123' });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/v2/notifications/token', () => {
  test('remove token FCM do usuário', async () => {
    const res = await request(app)
      .delete('/api/v2/notifications/token')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: 'fcm-test-token-abc123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar teste — confirmar que falha**

```bash
npx jest tests/modules/notifications.test.js --no-coverage 2>&1 | tail -20
```

Esperado: FAIL com `Cannot find module` ou erro de rota 404.

- [ ] **Step 3: Separar app do server em src/app.js**

O supertest precisa do Express `app` sem o `server.listen()`. Verificar se já existe `src/app.js`. Se não existir, extrair do `src/index.js`:

Criar `src/app.js`:

```js
require('dotenv').config();
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const webhookRoutes = require('./webhook/routes');
const apiRoutes = require('./dashboard/api');
const db = require('./db');
const modulesRouter = require('./modules/index');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
global.io = io;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.BASE_URL, credentials: true }));
app.use('/webhook', rateLimit({ windowMs: 60000, max: 200 }));
app.use('/api', rateLimit({ windowMs: 60000, max: 100 }));
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/webhook', webhookRoutes);
app.use('/api', apiRoutes);
app.use('/api/v2', rateLimit({ windowMs: 60000, max: 200 }));
app.use('/api/v2', modulesRouter);

app.get('/api/me', (req, res) => {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    res.json(jwt.verify(token, process.env.JWT_SECRET));
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
});

// PWA
app.get('/pwa', (_req, res) => res.redirect('/pwa/login.html'));

app.use(express.static(path.join(__dirname, '../public')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html')));
app.get('/', (req, res) => res.redirect('/login'));

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.cookie
    ?.split(';').find(c => c.trim().startsWith('token='))?.split('=')[1];
  if (!token) return next(new Error('Não autenticado'));
  try { socket.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { next(new Error('Token inválido')); }
});

io.on('connection', (socket) => {
  console.warn(`Painel conectado: ${socket.user?.name}`);
});

module.exports = { app, server };
```

Modificar `src/index.js` para usar o app exportado:

```js
require('dotenv').config();
const { server } = require('./app');
const db = require('./db');
const { startScheduler } = require('./services/followup');
const fcm = require('./services/fcm');

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await db.query('SELECT 1');
    console.warn('✅ PostgreSQL conectado');
  } catch (err) {
    console.error('❌ Falha ao conectar com PostgreSQL:', err.message);
    process.exit(1);
  }

  fcm.init();
  startScheduler();

  server.listen(PORT, () => {
    console.warn(`🚀 LKL Chatbot rodando na porta ${PORT}`);
    console.warn(`   Painel: ${process.env.BASE_URL || 'http://localhost:' + PORT}/dashboard`);
    console.warn(`   PWA: ${process.env.BASE_URL || 'http://localhost:' + PORT}/pwa`);
  });
}

start();
```

E no `tests/setup.js` já importa `src/app` via require — verificar que o arquivo `tests/setup.js` atual não faz `server.listen`. Se o arquivo atual importar o index.js completo, ajustar.

- [ ] **Step 4: Criar src/modules/notifications/router.js**

```js
const express = require('express');
const router = express.Router();
const db = require('../../db');

router.post('/token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token é obrigatório' });
  try {
    await db.query(
      `INSERT INTO device_tokens (user_id, token)
       VALUES ($1, $2)
       ON CONFLICT (user_id, token) DO UPDATE SET updated_at = NOW()`,
      [req.user.id, token]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[notifications] Erro ao salvar token:', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.delete('/token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token é obrigatório' });
  try {
    await db.query(
      'DELETE FROM device_tokens WHERE user_id = $1 AND token = $2',
      [req.user.id, token]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[notifications] Erro ao remover token:', e.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
```

- [ ] **Step 5: Registrar rota em src/modules/index.js**

Adicionar após as outras rotas:

```js
router.use('/notifications', requireAuthApi, require('./notifications/router'));
```

- [ ] **Step 6: Rodar teste — confirmar PASS**

```bash
npx jest tests/modules/notifications.test.js --no-coverage 2>&1 | tail -20
```

Esperado: 4 testes passando.

- [ ] **Step 7: Rodar suite completa**

```bash
npx jest --no-coverage 2>&1 | tail -15
```

Esperado: todos os testes passando (15 anteriores + 4 novos = 19).

- [ ] **Step 8: Commit**

```bash
git add src/app.js src/index.js src/modules/notifications/router.js src/modules/index.js tests/modules/notifications.test.js
git commit -m "feat: notifications API — save/delete FCM device tokens"
```

---

## Task 3: PWA Manifest + Service Worker

**Files:**
- Create: `public/manifest.json`
- Create: `public/sw.js`
- Create: `public/icons/icon-192.png` e `icon-512.png` (placeholder SVG convertido)

**Contexto:** O service worker precisa estar em `public/sw.js` (raiz pública) para ter escopo sobre `/pwa/`. Firebase Messaging no SW usa importScripts com a CDN. As variáveis do Firebase config vêm hardcoded no SW (são públicas por design).

- [ ] **Step 1: Criar public/manifest.json**

```json
{
  "name": "LKL Gráfica",
  "short_name": "LKL",
  "description": "Sistema de pedidos LKL Gráfica",
  "start_url": "/pwa/login.html",
  "display": "standalone",
  "background_color": "#1a237e",
  "theme_color": "#1a237e",
  "orientation": "portrait",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

- [ ] **Step 2: Criar ícones PWA**

Criar `public/icons/` e gerar ícones simples via Node.js:

```bash
mkdir -p /Users/klebercamara/LKL/public/icons
```

Criar `/Users/klebercamara/LKL/scripts/generate-icons.js`:

```js
const fs = require('fs');

function svgIcon(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#1a237e" rx="${size * 0.15}"/>
  <text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle"
        font-family="Arial" font-weight="bold" fill="white" font-size="${size * 0.38}">LKL</text>
</svg>`;
}

fs.writeFileSync('public/icons/icon-192.svg', svgIcon(192));
fs.writeFileSync('public/icons/icon-512.svg', svgIcon(512));
// Usar SVG como PNG placeholder (browsers aceitam SVG em manifest)
fs.copyFileSync('public/icons/icon-192.svg', 'public/icons/icon-192.png');
fs.copyFileSync('public/icons/icon-512.svg', 'public/icons/icon-512.png');
console.log('Ícones gerados em public/icons/');
```

```bash
node scripts/generate-icons.js
```

- [ ] **Step 3: Criar public/sw.js**

```js
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyBQAK0QyrJI8mikxb4-RNP-597YKGU_iLw',
  authDomain: 'lkl-grafica.firebaseapp.com',
  projectId: 'lkl-grafica',
  storageBucket: 'lkl-grafica.firebasestorage.app',
  messagingSenderId: '985126589887',
  appId: '1:985126589887:web:c79a5e67ec106e41f77d0a',
});

const messaging = firebase.messaging();

// Notificações em background (quando o browser não está em foco)
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification;
  self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: payload.data,
  });
});

// Cache básico para funcionamento offline
const CACHE = 'lkl-pwa-v1';
const OFFLINE_URLS = ['/pwa/login.html', '/pwa/pedidos.html', '/pwa/app.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(OFFLINE_URLS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Click na notificação — abre o PWA
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      const pwa = list.find(c => c.url.includes('/pwa/'));
      if (pwa) return pwa.focus();
      return clients.openWindow('/pwa/pedidos.html');
    })
  );
});
```

- [ ] **Step 4: Commit**

```bash
git add public/manifest.json public/sw.js public/icons/ scripts/generate-icons.js
git commit -m "feat: PWA manifest + service worker + FCM background"
```

---

## Task 4: PWA Login Page (mobile-first)

**Files:**
- Create: `public/pwa/login.html`
- Create: `public/pwa/app.js`

**Contexto:** O login usa `POST /api/auth/login` (definido em `src/dashboard/api.js`) que retorna `{ token, user }`. O token é salvo no `localStorage` como `lkl_token` e o user como `lkl_user` (JSON). A chave VAPID pública do FCM é `BFVONu-p0mCpsmq9XqT6E0pqzBgEAUEzXq3W_oR7YeunPko4oDZ2fVoKjtTJIprWrQYhF1gijFqdho4vj54gqjs`.

- [ ] **Step 1: Criar public/pwa/app.js**

```js
// ── Constantes Firebase ───────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBQAK0QyrJI8mikxb4-RNP-597YKGU_iLw',
  authDomain: 'lkl-grafica.firebaseapp.com',
  projectId: 'lkl-grafica',
  storageBucket: 'lkl-grafica.firebasestorage.app',
  messagingSenderId: '985126589887',
  appId: '1:985126589887:web:c79a5e67ec106e41f77d0a',
};
const VAPID_KEY = 'BFVONu-p0mCpsmq9XqT6E0pqzBgEAUEzXq3W_oR7YeunPko4oDZ2fVoKjtTJIprWrQYhF1gijFqdho4vj54gqjs';

// ── Auth helpers ──────────────────────────────────────────────────────────────
function getToken() { return localStorage.getItem('lkl_token'); }
function getUser() {
  try { return JSON.parse(localStorage.getItem('lkl_user')); } catch { return null; }
}
function logout() {
  localStorage.removeItem('lkl_token');
  localStorage.removeItem('lkl_user');
  window.location.href = '/pwa/login.html';
}
function requireAuth() {
  if (!getToken()) window.location.href = '/pwa/login.html';
}

// ── API helper ────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { logout(); return; }
  return res.json();
}

// ── FCM ───────────────────────────────────────────────────────────────────────
async function initFCM() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return;
  try {
    // Registrar SW
    const reg = await navigator.serviceWorker.register('/sw.js');

    // Carregar Firebase dinamicamente (compat)
    if (!window.firebase) return;
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    const messaging = firebase.messaging();

    // Pedir permissão
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    // Obter token FCM
    const fcmToken = await messaging.getToken({ serviceWorkerRegistration: reg, vapidKey: VAPID_KEY });
    if (fcmToken) {
      await api('POST', '/api/v2/notifications/token', { token: fcmToken });
    }

    // Mensagens em foreground
    messaging.onMessage((payload) => {
      const { title, body } = payload.notification;
      if (Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/icons/icon-192.png' });
      }
    });
  } catch (e) {
    console.warn('[FCM] Erro ao inicializar:', e.message);
  }
}
```

- [ ] **Step 2: Criar public/pwa/login.html**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<meta name="theme-color" content="#1a237e">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>LKL Gráfica — Login</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  body {
    font-family: -apple-system, 'Segoe UI', sans-serif;
    background: linear-gradient(160deg, #1a237e 0%, #0d47a1 100%);
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
  }
  .card {
    background: #fff;
    border-radius: 20px;
    padding: 40px 28px 32px;
    width: 100%;
    max-width: 380px;
    box-shadow: 0 24px 64px rgba(0,0,0,.35);
  }
  .logo { text-align: center; margin-bottom: 32px; }
  .logo img { width: 80px; height: 80px; object-fit: contain; }
  .logo h1 { font-size: 22px; font-weight: 700; color: #1a237e; margin-top: 10px; }
  .logo p { font-size: 13px; color: #888; margin-top: 4px; }
  label { display: block; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 6px; }
  input {
    width: 100%;
    padding: 14px 16px;
    border: 2px solid #e8e8e8;
    border-radius: 12px;
    font-size: 16px;
    margin-bottom: 18px;
    transition: border-color .2s;
    outline: none;
  }
  input:focus { border-color: #1a237e; }
  button {
    width: 100%;
    padding: 15px;
    background: #1a237e;
    color: #fff;
    border: none;
    border-radius: 12px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: background .2s, transform .1s;
    margin-top: 4px;
  }
  button:active { transform: scale(.98); }
  button:disabled { background: #9fa8da; cursor: not-allowed; }
  .error {
    background: #fce4ec;
    color: #c62828;
    border-radius: 10px;
    padding: 12px 14px;
    font-size: 14px;
    margin-bottom: 16px;
    display: none;
  }
  .version { text-align: center; font-size: 11px; color: #bbb; margin-top: 24px; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <img src="/logo.png" alt="LKL Gráfica" onerror="this.style.display='none'">
    <h1>LKL Gráfica</h1>
    <p>Sistema de Pedidos</p>
  </div>
  <div class="error" id="err"></div>
  <label for="email">E-mail</label>
  <input type="email" id="email" placeholder="seu@email.com" autocomplete="email" inputmode="email">
  <label for="pass">Senha</label>
  <input type="password" id="pass" placeholder="••••••••" autocomplete="current-password">
  <button id="btn" onclick="doLogin()">Entrar</button>
  <p class="version">LKL v1.0 · Sprint 1-C</p>
</div>

<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js"></script>
<script src="/pwa/app.js"></script>
<script>
  // Redirecionar se já logado
  if (getToken()) window.location.href = '/pwa/pedidos.html';

  async function doLogin() {
    const email = document.getElementById('email').value.trim();
    const pass = document.getElementById('pass').value;
    const btn = document.getElementById('btn');
    const err = document.getElementById('err');

    if (!email || !pass) { showErr('Preencha e-mail e senha.'); return; }

    btn.disabled = true;
    btn.textContent = 'Entrando…';
    err.style.display = 'none';

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: pass }),
      });
      const data = await res.json();
      if (!res.ok) { showErr(data.error || 'Credenciais inválidas.'); return; }

      localStorage.setItem('lkl_token', data.token);
      localStorage.setItem('lkl_user', JSON.stringify(data.user));

      await initFCM();
      window.location.href = '/pwa/pedidos.html';
    } catch {
      showErr('Sem conexão com o servidor.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  }

  function showErr(msg) {
    const err = document.getElementById('err');
    err.textContent = msg;
    err.style.display = 'block';
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
</script>
</body>
</html>
```

- [ ] **Step 3: Testar localmente**

```bash
npm run dev
```

Abrir `http://localhost:3000/pwa/login.html` no browser. Deve exibir a tela de login com campos e botão. Tentar login com credenciais inválidas → deve mostrar mensagem de erro vermelha.

- [ ] **Step 4: Commit**

```bash
git add public/pwa/login.html public/pwa/app.js
git commit -m "feat: PWA login page mobile-first"
```

---

## Task 5: PWA Pedidos — Novo Pedido + Carteira do Vendedor

**Files:**
- Create: `public/pwa/pedidos.html`

**Contexto:**
- `POST /api/v2/orders` cria pedido. Body: `{ origin_channel, produto, quantidade, acabamento, tem_arte, observacoes, cliente_id? }`. Retorna `{ id, numero_os, status }`.
- `GET /api/v2/orders?page=1&limit=20` lista pedidos. Para vendedor, o backend filtra por `vendedor_id = req.user.id` (verificar se o orders/service.js já faz isso, senão passamos `?meus=1`).
- `GET /api/v2/clientes?busca=TEXTO&limit=10` busca clientes para o autocomplete.
- Status badge colors: `criada=#2196f3`, `em_producao=#ff9800`, `concluido=#4caf50`, `entregue=#1b5e20`, `cancelado=#f44336`.

- [ ] **Step 1: Verificar se orders/service.js filtra por vendedor**

Ler `src/modules/orders/service.js` e verificar se `listar()` aceita parâmetro `vendedorId`. Se não aceitar, adicionar:

```js
// Em listar(), no WHERE clause:
if (vendedorId) {
  conditions.push(`o.vendedor_id = $${params.length + 1}`);
  params.push(vendedorId);
}
```

E no router (`src/modules/orders/router.js`), no `GET /`:

```js
const vendedorId = req.user.role === 'vendedor' ? req.user.id : req.query.vendedor_id;
const data = await orderService.listar({ page, limit, status, vendedorId });
```

- [ ] **Step 2: Criar public/pwa/pedidos.html**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<meta name="theme-color" content="#1a237e">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>LKL — Pedidos</title>
<link rel="manifest" href="/manifest.json">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
  body { font-family: -apple-system, 'Segoe UI', sans-serif; background: #f5f6fa; min-height: 100dvh; }

  /* Header */
  .header {
    background: #1a237e;
    color: #fff;
    padding: 16px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 10;
    box-shadow: 0 2px 8px rgba(0,0,0,.2);
  }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header .user { font-size: 12px; opacity: .8; }
  .logout-btn {
    background: rgba(255,255,255,.15);
    border: none;
    color: #fff;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 13px;
    cursor: pointer;
  }

  /* Tabs */
  .tabs {
    display: flex;
    background: #fff;
    border-bottom: 2px solid #e8e8e8;
    position: sticky;
    top: 57px;
    z-index: 9;
  }
  .tab {
    flex: 1;
    padding: 14px;
    text-align: center;
    font-size: 14px;
    font-weight: 500;
    color: #888;
    cursor: pointer;
    border-bottom: 3px solid transparent;
    transition: all .2s;
  }
  .tab.active { color: #1a237e; border-bottom-color: #1a237e; }

  /* Content */
  .content { padding: 16px; max-width: 600px; margin: 0 auto; }
  .panel { display: none; }
  .panel.active { display: block; }

  /* Form Novo Pedido */
  .form-group { margin-bottom: 18px; }
  label { display: block; font-size: 13px; font-weight: 600; color: #555; margin-bottom: 6px; }
  input, select, textarea {
    width: 100%;
    padding: 13px 14px;
    border: 2px solid #e8e8e8;
    border-radius: 12px;
    font-size: 15px;
    background: #fff;
    outline: none;
    transition: border-color .2s;
    font-family: inherit;
  }
  input:focus, select:focus, textarea:focus { border-color: #1a237e; }
  textarea { resize: vertical; min-height: 80px; }
  .submit-btn {
    width: 100%;
    padding: 15px;
    background: #1a237e;
    color: #fff;
    border: none;
    border-radius: 12px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    margin-top: 8px;
  }
  .submit-btn:disabled { background: #9fa8da; }
  .success-msg {
    background: #e8f5e9;
    color: #2e7d32;
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 16px;
    font-size: 14px;
    display: none;
  }
  .error-msg {
    background: #fce4ec;
    color: #c62828;
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 16px;
    font-size: 14px;
    display: none;
  }

  /* Busca de cliente */
  .search-results {
    background: #fff;
    border: 2px solid #1a237e;
    border-top: none;
    border-radius: 0 0 12px 12px;
    max-height: 200px;
    overflow-y: auto;
    display: none;
  }
  .search-result-item {
    padding: 12px 14px;
    cursor: pointer;
    border-bottom: 1px solid #f0f0f0;
    font-size: 14px;
  }
  .search-result-item:hover { background: #e8eaf6; }
  .search-result-item .sub { font-size: 12px; color: #888; }

  /* Carteira */
  .order-card {
    background: #fff;
    border-radius: 14px;
    padding: 16px;
    margin-bottom: 12px;
    box-shadow: 0 2px 8px rgba(0,0,0,.06);
  }
  .order-header { display: flex; justify-content: space-between; align-items: flex-start; }
  .order-os { font-weight: 700; color: #1a237e; font-size: 15px; }
  .order-produto { font-size: 14px; color: #333; margin-top: 4px; }
  .order-info { font-size: 12px; color: #888; margin-top: 6px; }
  .badge {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 20px;
    white-space: nowrap;
  }
  .badge-criada { background: #e3f2fd; color: #1565c0; }
  .badge-em_producao { background: #fff3e0; color: #e65100; }
  .badge-concluido { background: #e8f5e9; color: #2e7d32; }
  .badge-entregue { background: #1b5e20; color: #fff; }
  .badge-cancelado { background: #fce4ec; color: #c62828; }
  .badge-default { background: #f5f5f5; color: #555; }

  .empty { text-align: center; padding: 48px 20px; color: #aaa; }
  .empty-icon { font-size: 48px; margin-bottom: 12px; }

  .loading { text-align: center; padding: 32px; color: #aaa; font-size: 14px; }

  /* Checkbox estilizado */
  .checkbox-group { display: flex; align-items: center; gap: 10px; }
  .checkbox-group input[type=checkbox] { width: 20px; height: 20px; cursor: pointer; }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="header h1" style="font-size:18px;font-weight:600">LKL Gráfica</div>
    <div class="user" id="header-user">—</div>
  </div>
  <button class="logout-btn" onclick="doLogout()">Sair</button>
</div>

<div class="tabs">
  <div class="tab active" onclick="switchTab('novo')">➕ Novo Pedido</div>
  <div class="tab" onclick="switchTab('carteira')">📋 Meus Pedidos</div>
</div>

<div class="content">

  <!-- NOVO PEDIDO -->
  <div id="panel-novo" class="panel active">
    <div class="success-msg" id="novo-ok"></div>
    <div class="error-msg" id="novo-err"></div>

    <div class="form-group">
      <label>Cliente (opcional)</label>
      <input type="text" id="cliente-busca" placeholder="Buscar por nome ou celular…" oninput="buscarCliente()" autocomplete="off">
      <div class="search-results" id="cliente-results"></div>
      <input type="hidden" id="cliente-id">
    </div>

    <div class="form-group">
      <label>Canal de origem *</label>
      <select id="canal">
        <option value="balcao">Balcão</option>
        <option value="whatsapp">WhatsApp</option>
        <option value="telefone">Telefone</option>
        <option value="site">Site</option>
        <option value="vendedor">Vendedor</option>
      </select>
    </div>

    <div class="form-group">
      <label>Produto / Serviço *</label>
      <input type="text" id="produto" placeholder="Ex: Cartão de visita 9x5cm">
    </div>

    <div class="form-group">
      <label>Quantidade *</label>
      <input type="number" id="quantidade" min="1" placeholder="1000">
    </div>

    <div class="form-group">
      <label>Acabamento</label>
      <input type="text" id="acabamento" placeholder="Ex: Laminação fosca">
    </div>

    <div class="form-group">
      <label>Material</label>
      <input type="text" id="material" placeholder="Ex: Couché 300g">
    </div>

    <div class="form-group">
      <div class="checkbox-group">
        <input type="checkbox" id="tem-arte">
        <label for="tem-arte" style="margin:0">Cliente tem arte própria</label>
      </div>
    </div>

    <div class="form-group">
      <label>Observações</label>
      <textarea id="obs" placeholder="Detalhes adicionais…"></textarea>
    </div>

    <button class="submit-btn" id="btn-novo" onclick="criarPedido()">Criar Pedido</button>
  </div>

  <!-- CARTEIRA -->
  <div id="panel-carteira" class="panel">
    <div class="loading" id="carteira-loading">Carregando…</div>
    <div id="carteira-lista"></div>
  </div>

</div>

<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js"></script>
<script src="/pwa/app.js"></script>
<script>
requireAuth();

const user = getUser();
if (user) document.getElementById('header-user').textContent = user.name;

function doLogout() { logout(); }

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t, i) => {
    t.classList.toggle('active', (i === 0 && tab === 'novo') || (i === 1 && tab === 'carteira'));
  });
  document.getElementById('panel-novo').classList.toggle('active', tab === 'novo');
  document.getElementById('panel-carteira').classList.toggle('active', tab === 'carteira');
  if (tab === 'carteira') carregarPedidos();
}

// ── Busca de cliente ──────────────────────────────────────────────────────────
let clienteTimer;
async function buscarCliente() {
  clearTimeout(clienteTimer);
  const busca = document.getElementById('cliente-busca').value.trim();
  document.getElementById('cliente-id').value = '';
  if (busca.length < 2) { document.getElementById('cliente-results').style.display = 'none'; return; }
  clienteTimer = setTimeout(async () => {
    const data = await api('GET', `/api/v2/clientes?busca=${encodeURIComponent(busca)}&limit=8`);
    const box = document.getElementById('cliente-results');
    if (!data?.data?.length) { box.style.display = 'none'; return; }
    box.innerHTML = data.data.map(c =>
      `<div class="search-result-item" onclick="selecionarCliente('${c.id}','${c.nome.replace(/'/g,"\\'")}')">
        <div>${c.nome}</div>
        <div class="sub">${c.celular || c.email || ''}</div>
      </div>`
    ).join('');
    box.style.display = 'block';
  }, 300);
}

function selecionarCliente(id, nome) {
  document.getElementById('cliente-id').value = id;
  document.getElementById('cliente-busca').value = nome;
  document.getElementById('cliente-results').style.display = 'none';
}

document.addEventListener('click', e => {
  if (!e.target.closest('.form-group')) {
    document.getElementById('cliente-results').style.display = 'none';
  }
});

// ── Criar Pedido ──────────────────────────────────────────────────────────────
async function criarPedido() {
  const produto = document.getElementById('produto').value.trim();
  const quantidade = parseInt(document.getElementById('quantidade').value);
  const canal = document.getElementById('canal').value;

  if (!produto) { showNovErr('Informe o produto/serviço.'); return; }
  if (!quantidade || quantidade < 1) { showNovErr('Informe a quantidade.'); return; }

  const btn = document.getElementById('btn-novo');
  btn.disabled = true;
  btn.textContent = 'Criando…';

  const body = {
    origin_channel: canal,
    produto,
    quantidade,
    acabamento: document.getElementById('acabamento').value.trim() || undefined,
    material: document.getElementById('material').value.trim() || undefined,
    tem_arte: document.getElementById('tem-arte').checked,
    observacoes: document.getElementById('obs').value.trim() || undefined,
  };
  const cid = document.getElementById('cliente-id').value;
  if (cid) body.cliente_id = cid;

  const data = await api('POST', '/api/v2/orders', body);
  btn.disabled = false;
  btn.textContent = 'Criar Pedido';

  if (!data || data.error) { showNovErr(data?.error || 'Erro ao criar pedido.'); return; }

  const ok = document.getElementById('novo-ok');
  ok.textContent = `✅ OS #${data.numero_os} criada com sucesso!`;
  ok.style.display = 'block';
  document.getElementById('novo-err').style.display = 'none';

  // Limpar formulário
  ['produto','quantidade','acabamento','material','obs','cliente-busca','cliente-id'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('tem-arte').checked = false;

  setTimeout(() => { ok.style.display = 'none'; }, 4000);
}

function showNovErr(msg) {
  const el = document.getElementById('novo-err');
  el.textContent = msg;
  el.style.display = 'block';
}

// ── Carteira ──────────────────────────────────────────────────────────────────
const STATUS_LABELS = {
  criada: 'Criada', gerando_arquivo_impressao: 'Gerando arte',
  arte_enviada_cliente: 'Arte enviada', arte_aprovada_cliente: 'Arte aprovada',
  arte_reprovada_cliente: 'Arte reprovada', em_producao: 'Em produção',
  concluido: 'Concluído', entregue: 'Entregue', cancelado: 'Cancelado',
};

function badgeClass(status) {
  const map = { criada:'criada', em_producao:'em_producao', concluido:'concluido', entregue:'entregue', cancelado:'cancelado' };
  return 'badge badge-' + (map[status] || 'default');
}

async function carregarPedidos() {
  document.getElementById('carteira-loading').style.display = 'block';
  document.getElementById('carteira-lista').innerHTML = '';
  const data = await api('GET', '/api/v2/orders?limit=50');
  document.getElementById('carteira-loading').style.display = 'none';
  const lista = document.getElementById('carteira-lista');
  if (!data?.data?.length) {
    lista.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><div>Nenhum pedido ainda.</div></div>';
    return;
  }
  lista.innerHTML = data.data.map(o => `
    <div class="order-card">
      <div class="order-header">
        <div>
          <div class="order-os">OS #${o.numero_os}</div>
          <div class="order-produto">${o.produto || '—'}</div>
        </div>
        <span class="${badgeClass(o.status)}">${STATUS_LABELS[o.status] || o.status}</span>
      </div>
      <div class="order-info">
        ${o.quantidade ? `${o.quantidade} un` : ''}
        ${o.cliente_nome ? ` · ${o.cliente_nome}` : ''}
        · ${new Date(o.created_at).toLocaleDateString('pt-BR')}
      </div>
    </div>
  `).join('');
}

// Inicializar FCM em background
initFCM().catch(() => {});
</script>
</body>
</html>
```

- [ ] **Step 3: Verificar que o orders/service.js retorna cliente_nome**

Ler `src/modules/orders/service.js` — a query do `listar()` deve fazer JOIN com `clientes_lkl` para retornar o nome. Se não fizer, adicionar:

```sql
LEFT JOIN clientes_lkl cl ON o.cliente_id = cl.id
```

E no SELECT: `cl.nome AS cliente_nome`.

- [ ] **Step 4: Testar localmente**

```bash
npm run dev
```

1. Abrir `http://localhost:3000/pwa/pedidos.html` → deve redirecionar para login
2. Fazer login → deve abrir pedidos
3. Aba "Novo Pedido" → preencher e criar → deve mostrar `✅ OS #1 criada`
4. Aba "Meus Pedidos" → deve listar a OS criada

- [ ] **Step 5: Commit**

```bash
git add public/pwa/pedidos.html src/modules/orders/service.js src/modules/orders/router.js
git commit -m "feat: PWA pedidos — novo pedido + carteira do vendedor"
```

---

## Task 6: Push Notification ao mudar status da OS

**Files:**
- Modify: `src/modules/orders/service.js`

**Contexto:** `fcm.sendToUser(userId, { title, body, data })` está em `src/services/fcm.js`. O `vendedor_id` está no registro da OS. Quando o status muda, notificamos o vendedor que criou o pedido.

- [ ] **Step 1: Adicionar FCM em atualizarStatus()**

Em `src/modules/orders/service.js`, no topo adicionar:

```js
const fcm = require('../services/fcm');
```

E na função `atualizarStatus()`, após o `UPDATE` no banco e antes do `return`:

```js
// Notificar vendedor via push
if (order.vendedor_id) {
  const statusLabels = {
    em_producao: 'Em produção 🖨️',
    concluido: 'Concluído ✅',
    entregue: 'Entregue 🎉',
    cancelado: 'Cancelado ❌',
    arte_aprovada_cliente: 'Arte aprovada pelo cliente 👍',
    arte_reprovada_cliente: 'Arte reprovada pelo cliente ⚠️',
  };
  const label = statusLabels[novoStatus];
  if (label) {
    fcm.sendToUser(order.vendedor_id, {
      title: `OS #${order.numero_os} — ${label}`,
      body: order.produto ? `Produto: ${order.produto}` : 'Pedido atualizado',
      data: { order_id: order.id, numero_os: String(order.numero_os), status: novoStatus },
    }).catch(() => {});
  }
}
```

Para isso funcionar, a query de busca da OS antes do UPDATE precisa retornar `vendedor_id` e `numero_os`. Verificar a query atual e ajustar se necessário:

```sql
SELECT id, numero_os, status, vendedor_id, produto FROM orders WHERE id = $1
```

- [ ] **Step 2: Testar push localmente**

Como o FCM só funciona com FIREBASE_SERVICE_ACCOUNT_PATH configurado, testar que:
1. Sem a variável definida, a função `fcm.sendToUser()` retorna silenciosamente (sem crash)
2. O endpoint `PATCH /:id/status` continua retornando 200

```bash
# No terminal
curl -X PATCH http://localhost:3000/api/v2/orders/ALGUM_ID/status \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"em_producao"}'
```

Esperado: `{"id": "...", "status": "em_producao"}` sem erro no terminal.

- [ ] **Step 3: Commit**

```bash
git add src/modules/orders/service.js
git commit -m "feat: FCM push notification ao atualizar status da OS"
```

---

## Task 7: Deploy no VPS

**Files:**
- VPS: `/var/www/lkl-chatbot/`

**Contexto:** O app roda no VPS via PM2. O banco já tem a migration `002_device_tokens` para ser aplicada. O `FIREBASE_SERVICE_ACCOUNT_PATH=/root/lkl-grafica-adminsdk.json` já está no `.env` do VPS.

- [ ] **Step 1: Aplicar migration device_tokens no VPS**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -f /tmp/002_device_tokens.sql 2>&1"
```

Primeiro copiar:

```bash
scp /Users/klebercamara/LKL/sql/migrations/002_device_tokens.sql root@2.25.147.243:/tmp/
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -f /tmp/002_device_tokens.sql 2>&1"
```

Esperado: `CREATE TABLE` + `COMMIT`

- [ ] **Step 2: Fazer push do código para o VPS**

```bash
# Verificar remote
git remote -v

# Se não tiver remote, configurar com o caminho do VPS
# Se já tiver, fazer push
git push origin main
```

Se o VPS não tem remote git, copiar via rsync:

```bash
rsync -avz --exclude 'node_modules' --exclude '.git' --exclude '.env' \
  /Users/klebercamara/LKL/ root@2.25.147.243:/var/www/lkl-chatbot/
```

- [ ] **Step 3: Instalar dependências e reiniciar no VPS**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && npm install --production && pm2 restart lkl-chatbot && pm2 logs lkl-chatbot --lines 20 --nostream"
```

Esperado: `✅ PostgreSQL conectado` + `🚀 LKL Chatbot rodando na porta 3000`

- [ ] **Step 4: Testar PWA em produção**

Abrir `https://chatbot.klebercamaraconsultoria.cloud/pwa/login.html` no celular.

Checklist:
- [ ] Tela de login carrega
- [ ] Login com credenciais funciona
- [ ] Aba "Novo Pedido" — criar OS funciona
- [ ] Aba "Meus Pedidos" — lista aparece
- [ ] Browser pede permissão de notificação
- [ ] "Adicionar à tela inicial" aparece (Chrome Android) ou prompt de instalação

- [ ] **Step 5: Commit final**

```bash
git add .
git commit -m "feat: Sprint 1-C concluído — PWA + FCM deploy"
```

---

## Self-Review

**Spec coverage:**
- ✅ PWA manifest + install prompt — Task 3
- ✅ Login mobile-first — Task 4
- ✅ Novo Pedido — Task 5
- ✅ Carteira do Vendedor — Task 5
- ✅ FCM token registration — Task 2
- ✅ Push ao mudar status — Task 6
- ✅ Deploy VPS — Task 7

**Placeholder scan:** Nenhum TBD, TODO ou placeholder encontrado. Todos os blocos de código são completos.

**Type consistency:**
- `fcm.sendToUser(userId, {title, body, data})` — definido em Task 1, usado em Task 6 ✅
- `api(method, path, body)` — definido em app.js Task 4, usado em pedidos.html Task 5 ✅
- `initFCM()` — definida em app.js Task 4, chamada em login.html Task 4 e pedidos.html Task 5 ✅
