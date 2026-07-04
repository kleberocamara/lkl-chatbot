jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn(), sendImage: jest.fn() }));

const db = require('../src/db');
const conversas = require('../src/services/conversas');

beforeEach(() => { jest.clearAllMocks(); delete global.io; });

describe('registrarMensagemCliente', () => {
  test('telefone vazio → retorna null, não toca no banco', async () => {
    const r = await conversas.registrarMensagemCliente('', 'oi');
    expect(r).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('contato+conversa existentes → insere outbound system na conversa achada', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'KLEBER', profile_name: 'K' }] }) // acharContato
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })                                     // update contato
      .mockResolvedValueOnce({ rows: [{ id: 30, contact_id: 7, status: 'active' }] })   // conversa ativa
      .mockResolvedValueOnce({ rows: [] });                                             // insert message
    const r = await conversas.registrarMensagemCliente('5521988596449', 'valor R$ 10', { sentBy: 'system' });
    expect(r).toEqual({ conversationId: 30, contactId: 7 });
    const insert = db.query.mock.calls[3];
    expect(insert[0]).toMatch(/INSERT INTO messages/i);
    expect(insert[1]).toEqual([30, 7, 'valor R$ 10', 'outbound', null, 'system']);
  });

  test('sem conversa ativa → cria conversa e insere', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'KLEBER' }] }) // acharContato
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })                 // update contato
      .mockResolvedValueOnce({ rows: [] })                          // sem conversa ativa
      .mockResolvedValueOnce({ rows: [{ id: 55, contact_id: 7, status: 'active' }] }) // cria conversa
      .mockResolvedValueOnce({ rows: [] });                        // insert message
    const r = await conversas.registrarMensagemCliente('21988596449', 'oi');
    expect(r.conversationId).toBe(55);
    expect(db.query.mock.calls[3][0]).toMatch(/INSERT INTO conversations/i);
  });

  test('sem contato → cria contato pelos dígitos', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })                          // acharContato: nada
      .mockResolvedValueOnce({ rows: [{ id: 99, name: null }] })    // cria contato
      .mockResolvedValueOnce({ rows: [{ id: 60, contact_id: 99 }] })// cria conversa
      .mockResolvedValueOnce({ rows: [] });                        // insert message
    const r = await conversas.registrarMensagemCliente('(21) 98859-6449', 'oi');
    expect(r.contactId).toBe(99);
    const insContato = db.query.mock.calls[1];
    expect(insContato[0]).toMatch(/INSERT INTO contacts/i);
    expect(insContato[1][0]).toBe('988596449'); // só dígitos, últimos 9
  });
});
