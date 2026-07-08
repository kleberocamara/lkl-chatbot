jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/modules/orders/service', () => ({}));
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } },
  }));
});

const db = require('../src/db');
const OpenAI = require('openai');
const agent = require('../src/ai/agent');
const openaiInstance = OpenAI.mock.results[0].value;

function mockDb() {
  db.query.mockImplementation((sql) => {
    if (sql.startsWith('SELECT ai_context')) return Promise.resolve({ rows: [{ ai_context: [] }] });
    if (sql.startsWith('SELECT value FROM settings')) return Promise.resolve({ rows: [] });
    if (sql.includes('SELECT ct.phone')) return Promise.resolve({ rows: [{ phone: null }] });
    if (sql.startsWith('UPDATE conversations SET ai_context')) return Promise.resolve({ rows: [] });
    if (sql.startsWith('UPDATE conversations SET status')) return Promise.resolve({ rows: [] });
    throw new Error('query inesperada: ' + sql);
  });
}

describe('processMessage — tag [FALAR_HUMANO]', () => {
  beforeEach(() => {
    db.query.mockReset();
    openaiInstance.chat.completions.create.mockReset();
  });

  test('resposta com [FALAR_HUMANO] no início → tag removida da mensagem e status vira aguardando_humano', async () => {
    mockDb();
    openaiInstance.chat.completions.create.mockResolvedValueOnce({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '[FALAR_HUMANO] Claro, Thiago! Vou deixar nossa equipe ciente do seu pedido.' },
      }],
    });

    const r = await agent.processMessage(42, 'Posso falar com um atendente?');

    expect(r.response).not.toMatch(/FALAR_HUMANO/);
    expect(r.response.trim()).toBe('Claro, Thiago! Vou deixar nossa equipe ciente do seu pedido.');
    const statusCall = db.query.mock.calls.find(c => c[0].startsWith('UPDATE conversations SET status'));
    expect(statusCall).toBeDefined();
    expect(statusCall[1]).toEqual([42]);
  });

  test('resposta com FALAR_HUMANO em minúsculas → ainda detectada (case-insensitive)', async () => {
    mockDb();
    openaiInstance.chat.completions.create.mockResolvedValueOnce({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '[falar_humano] Já vou chamar alguém para te ajudar.' },
      }],
    });

    const r = await agent.processMessage(7, 'Quero falar com atendente');

    expect(r.response).not.toMatch(/falar_humano/i);
    const statusCall = db.query.mock.calls.find(c => c[0].startsWith('UPDATE conversations SET status'));
    expect(statusCall).toBeDefined();
  });

  test('resposta normal sem a tag → não mexe no status da conversa', async () => {
    mockDb();
    openaiInstance.chat.completions.create.mockResolvedValueOnce({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Claro! Qual o tamanho do banner que você precisa?' },
      }],
    });

    const r = await agent.processMessage(9, 'Quero um banner');

    expect(r.response).toBe('Claro! Qual o tamanho do banner que você precisa?');
    const statusCall = db.query.mock.calls.find(c => c[0].startsWith('UPDATE conversations SET status'));
    expect(statusCall).toBeUndefined();
  });
});
