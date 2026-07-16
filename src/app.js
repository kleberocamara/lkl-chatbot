const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const webhookRoutes = require('./webhook/routes');
const apiRoutes = require('./dashboard/api');
const modulesRouter = require('./modules/index');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
global.io = io;
require('./jobs/contas-pagar');

// Revenda: sync diária às 04:00 (spawn do job em processo filho — Chromium fora do web)
const _revCron = require('node-cron');
const { spawn: _revSpawn } = require('child_process');
_revCron.schedule('0 4 * * *', () => {
  const p = _revSpawn('node', [require('path').join(__dirname, 'jobs', 'revenda-sync.js')], { stdio: 'inherit' });
  p.on('exit', (code) => console.log(`[REVENDA-SYNC] cron finalizou code=${code}`));
}, { timezone: 'America/Sao_Paulo' });

app.set('trust proxy', 1);
// CSP desabilitada: o painel usa onclick="" inline em milhares de pontos (legado), e mesmo
// com 'unsafe-inline' em script-src o CSP quebrou a navegação lateral em produção — revertido.
// A defesa real contra XSS aqui é a correção de escape em escHtml()/escJs() (ver commit
// "fix(seguranca): corrige XSS armazenado no painel"), não a CSP.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.BASE_URL, credentials: true }));
app.use('/webhook', rateLimit({ windowMs: 60000, max: 200 }));
app.use('/api', rateLimit({ windowMs: 60000, max: 100 }));
app.use(morgan('combined'));
// Guarda o corpo bruto (bytes exatos recebidos) para permitir verificar a assinatura
// HMAC do webhook do WhatsApp/Meta (X-Hub-Signature-256) — não dá pra recalcular a
// assinatura a partir de req.body já parseado, porque JSON.stringify não garante
// reproduzir os mesmos bytes que a Meta assinou.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/webhook', webhookRoutes);
app.use('/api', apiRoutes);
app.use('/api/v2', rateLimit({ windowMs: 60000, max: 200 }));
app.use('/api/v2', modulesRouter);

app.get('/api/me', async (req, res) => {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const pool = require('./db/index');
    const { rows } = await pool.query(
      'SELECT matricula, setor FROM users WHERE id=$1', [decoded.id]
    );
    const extra = rows[0] || {};
    res.json({ id: decoded.id, name: decoded.name, email: decoded.email, role: decoded.role, matricula: extra.matricula, setor: extra.setor });
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
});

// PWA
app.get('/pwa', (_req, res) => res.redirect('/pwa/login.html'));

app.use(express.static(path.join(__dirname, '../public'), { extensions: ['html'] }));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html')));
app.get('/manual', (req, res) => res.sendFile(path.join(__dirname, '../public/manual.html')));
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
