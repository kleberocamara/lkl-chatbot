jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn(), sendImage: jest.fn(), sendInteractiveButtons: jest.fn() }));
jest.mock('../src/services/logger', () => ({ log: jest.fn() }));

const db = require('../src/db');
const conversas = require('../src/services/conversas');

beforeEach(() => { jest.clearAllMocks(); delete global.io; });

describe('sairDeAguardandoHumano', () => {
  test('conversa em aguardando_humano + para=resolved → UPDATE resolved + emite socket', async () => {
    const emit = jest.fn();
    global.io = { emit };
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'KLEBER' }] })
      .mockResolvedValueOnce({ rows: [{ id: 30, status: 'aguardando_humano' }] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await conversas.sairDeAguardandoHumano('5521988596449', { para: 'resolved', motivo: 'arte_enviada' });
    expect(r).toEqual({ conversationId: 30, de: 'aguardando_humano', para: 'resolved' });
    const upd = db.query.mock.calls[2];
    expect(upd[0]).toMatch(/UPDATE conversations/i);
    expect(upd[0]).toMatch(/status = \$2/);
    expect(upd[0]).toMatch(/resolved_at = NOW\(\)/);
    expect(upd[0]).toMatch(/alerta_humano_em = NULL/);
    expect(upd[1]).toEqual([30, 'resolved']);
    expect(emit).toHaveBeenCalledWith('conversation_updated', { id: 30, status: 'resolved' });
  });

  test('conversa em aguardando_humano + para=orcamento_enviado → UPDATE sem resolved_at', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rows: [{ id: 30, status: 'aguardando_humano' }] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await conversas.sairDeAguardandoHumano('21988596449', { para: 'orcamento_enviado', motivo: 'orcamento_enviado' });
    expect(r).toEqual({ conversationId: 30, de: 'aguardando_humano', para: 'orcamento_enviado' });
    const upd = db.query.mock.calls[2];
    expect(upd[0]).not.toMatch(/resolved_at = NOW\(\)/);
    expect(upd[0]).toMatch(/alerta_humano_em = NULL/);
    expect(upd[1]).toEqual([30, 'orcamento_enviado']);
  });

  test('conversa em active → no-op (nenhum UPDATE), retorna null', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rows: [{ id: 30, status: 'active' }] });
    const r = await conversas.sairDeAguardandoHumano('21988596449', { para: 'resolved', motivo: 'x' });
    expect(r).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('conversa em orcamento_enviado → no-op, retorna null', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rows: [{ id: 30, status: 'orcamento_enviado' }] });
    const r = await conversas.sairDeAguardandoHumano('21988596449', { para: 'resolved', motivo: 'x' });
    expect(r).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('sem contato → no-op sem erro, retorna null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await conversas.sairDeAguardandoHumano('21988596449', { para: 'resolved', motivo: 'x' });
    expect(r).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('contato sem conversa ativa → no-op, retorna null', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await conversas.sairDeAguardandoHumano('21988596449', { para: 'resolved', motivo: 'x' });
    expect(r).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('telefone vazio → retorna null sem tocar no banco', async () => {
    const r = await conversas.sairDeAguardandoHumano('', { para: 'resolved', motivo: 'x' });
    expect(r).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('casa por sufixo de 9 dígitos (telefone formatado diferente)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rows: [{ id: 30, status: 'aguardando_humano' }] })
      .mockResolvedValueOnce({ rows: [] });
    await conversas.sairDeAguardandoHumano('+55 (21) 98859-6449', { para: 'resolved', motivo: 'x' });
    const acharCall = db.query.mock.calls[0];
    expect(acharCall[1]).toEqual(['%988596449', '5521988596449']);
  });
});
