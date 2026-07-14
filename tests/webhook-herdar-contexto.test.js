jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/ai/agent', () => ({ processMessage: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn(), markAsRead: jest.fn(), downloadMedia: jest.fn() }));
jest.mock('../src/modules/orcamentos/service', () => ({ responderArteItem: jest.fn(), aprovar: jest.fn(), buscarEnviadoPorTelefone: jest.fn() }));
jest.mock('../src/services/email', () => ({ notifyAnalyst: jest.fn() }));
jest.mock('../src/services/logger', () => ({ log: jest.fn() }));

const db = require('../src/db');
const { createConversation, _herdarContextoRecente } = require('../src/webhook/handler');

beforeEach(() => jest.clearAllMocks());

describe('_herdarContextoRecente', () => {
  test('conversa anterior recente com ai_context → copia pra conversa nova', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ ai_context: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá!' }] }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    await _herdarContextoRecente('contact-1', 'conv-nova');

    expect(db.query.mock.calls[0][0]).toMatch(/updated_at > NOW\(\) - INTERVAL '7 days'/);
    expect(db.query.mock.calls[0][1]).toEqual(['contact-1', 'conv-nova']);
    expect(db.query.mock.calls[1][0]).toMatch(/UPDATE conversations SET ai_context/);
    expect(JSON.parse(db.query.mock.calls[1][1][0])).toEqual([{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'olá!' }]);
    expect(db.query.mock.calls[1][1][1]).toBe('conv-nova');
  });

  test('sem conversa anterior recente → não faz UPDATE', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await _herdarContextoRecente('contact-1', 'conv-nova');

    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('conversa anterior com ai_context vazio ([]) → não faz UPDATE', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ai_context: [] }] });

    await _herdarContextoRecente('contact-1', 'conv-nova');

    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('erro na query não propaga (fail-safe)', async () => {
    db.query.mockRejectedValueOnce(new Error('db offline'));
    await expect(_herdarContextoRecente('contact-1', 'conv-nova')).resolves.toBeUndefined();
  });
});

describe('createConversation', () => {
  test('cria a conversa e tenta herdar contexto da conversa recente anterior', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'conv-nova', contact_id: 'contact-1', status: 'active' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [{ ai_context: [{ role: 'user', content: 'contexto antigo' }] }] }) // SELECT herdar
      .mockResolvedValueOnce({ rows: [] }); // UPDATE herdar

    const conv = await createConversation('contact-1');

    expect(conv).toEqual({ id: 'conv-nova', contact_id: 'contact-1', status: 'active' });
    expect(db.query).toHaveBeenCalledTimes(3);
  });
});
