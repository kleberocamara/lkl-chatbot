const request = require('supertest');
const { app } = require('../../src/app');
const db = require('../../src/db');
const jwt = require('jsonwebtoken');

let token;
let userId;

beforeAll(async () => {
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
  await db.query("DELETE FROM users WHERE email = 'vendedor.test@lkl.com'");
  await db.pool.end();
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
