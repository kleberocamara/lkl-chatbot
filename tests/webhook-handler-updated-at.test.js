jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/ai/agent', () => ({ processMessage: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn(), markAsRead: jest.fn(), downloadMedia: jest.fn() }));
jest.mock('../src/modules/orcamentos/service', () => ({ responderArteItem: jest.fn(), aprovar: jest.fn(), buscarEnviadoPorTelefone: jest.fn() }));
jest.mock('../src/services/email', () => ({ notifyAnalyst: jest.fn() }));
jest.mock('../src/services/logger', () => ({ log: jest.fn() }));

const db = require('../src/db');
const { responderArteItem } = require('../src/modules/orcamentos/service');
const { handleInboundMessage } = require('../src/webhook/handler');

beforeEach(() => jest.clearAllMocks());

// Regressão: a lista de conversas do painel ordena por conversations.updated_at, mas esse
// campo só era tocado em alguns fluxos específicos — quando um analista estava conduzindo a
// conversa (status='aguardando_humano', o caso mais comum de conversa ativa) a chegada de uma
// nova mensagem do cliente nunca atualizava updated_at, então a conversa não subia na lista.
test('cliente escreve com analista conduzindo (aguardando_humano) → bump em conversations.updated_at', async () => {
  responderArteItem.mockResolvedValueOnce(null);
  db.query.mockImplementation((sql) => {
    if (sql.startsWith('SELECT * FROM contacts')) return Promise.resolve({ rows: [{ id: 'contato-1', phone: '21988596449' }] });
    if (sql.startsWith('UPDATE contacts SET profile_name')) return Promise.resolve({ rows: [] });
    if (sql.startsWith('SELECT * FROM conversations WHERE contact_id')) {
      return Promise.resolve({ rows: [{ id: 'conv-1', contact_id: 'contato-1', status: 'aguardando_humano' }] });
    }
    if (sql.startsWith('INSERT INTO messages')) return Promise.resolve({ rows: [] });
    if (sql.startsWith('UPDATE conversations SET updated_at')) return Promise.resolve({ rows: [] });
    if (sql.startsWith('UPDATE contacts SET total_conversations')) return Promise.resolve({ rows: [] });
    if (sql.includes('reengajado_em = NULL')) return Promise.resolve({ rows: [] });
    throw new Error('query inesperada: ' + sql);
  });

  await handleInboundMessage('21988596449', 'Cliente', 'Preciso de ajuda com a arte', 'wamid-1');

  const bumpCall = db.query.mock.calls.find(c => c[0].startsWith('UPDATE conversations SET updated_at'));
  expect(bumpCall).toBeDefined();
  expect(bumpCall[1]).toEqual(['conv-1']);
});
