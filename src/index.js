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
