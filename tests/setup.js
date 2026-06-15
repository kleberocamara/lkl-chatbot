process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-lkl-2026';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/lkl_chatbot_test';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-placeholder';

// Individual DB vars used by src/db/index.js
if (!process.env.DB_HOST) {
  const url = new URL(process.env.DATABASE_URL);
  process.env.DB_HOST = url.hostname;
  process.env.DB_PORT = url.port || '5432';
  process.env.DB_NAME = url.pathname.slice(1);
  process.env.DB_USER = url.username;
  process.env.DB_PASSWORD = url.password;
}
