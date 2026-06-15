process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-lkl-2026';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/lkl_chatbot_test';
