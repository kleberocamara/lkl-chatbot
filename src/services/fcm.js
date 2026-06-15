const admin = require('firebase-admin');
const fs = require('fs');
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
    const serviceAccount = JSON.parse(fs.readFileSync(path, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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
