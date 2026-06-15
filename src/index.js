require('dotenv').config();
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
const db = require('./db');
const { startScheduler } = require('./services/followup');
const modulesRouter = require('./modules/index');
const fcm = require('./services/fcm');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
global.io = io;

// ── SEGURANÇA ─────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.BASE_URL, credentials: true }));

// Rate limit para webhook e API
app.use('/webhook', rateLimit({ windowMs: 60000, max: 200 }));
app.use('/api', rateLimit({ windowMs: 60000, max: 100 }));

// ── MIDDLEWARES ───────────────────────────────────────────────────────────────
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── ROTAS ─────────────────────────────────────────────────────────────────────
app.use('/webhook', webhookRoutes);
app.use('/api', apiRoutes);
app.use('/api/v2', rateLimit({ windowMs: 60000, max: 200 }));
app.use('/api/v2', modulesRouter);

// Endpoint de info do usuário logado
app.get('/api/me', (req, res) => {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    res.json(jwt.verify(token, process.env.JWT_SECRET));
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
});

// ── FRONTEND ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../public/login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html')));
app.get('/', (req, res) => res.redirect('/login'));

// ── SOCKET.IO AUTH ────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.cookie
    ?.split(';').find(c => c.trim().startsWith('token='))?.split('=')[1];
  if (!token) return next(new Error('Não autenticado'));
  try { socket.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { next(new Error('Token inválido')); }
});

io.on('connection', (socket) => {
  console.log(`Painel conectado: ${socket.user?.name}`);
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await db.query('SELECT 1'); // testa conexão com DB
    console.log('✅ PostgreSQL conectado');
  } catch (err) {
    console.error('❌ Falha ao conectar com PostgreSQL:', err.message);
    process.exit(1);
  }

  startScheduler();
  fcm.init();

  server.listen(PORT, () => {
    console.log(`🚀 LKL Chatbot rodando na porta ${PORT}`);
    console.log(`   Painel: ${process.env.BASE_URL || 'http://localhost:' + PORT}/dashboard`);
    console.log(`   Webhook: ${process.env.BASE_URL || 'http://localhost:' + PORT}/webhook`);
  });
}

start();
