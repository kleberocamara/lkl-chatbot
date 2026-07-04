jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn(), sendImage: jest.fn(), sendInteractiveButtons: jest.fn() }));

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

const whatsapp = require('../src/services/whatsapp');

function mockRegistroOK() {
  // acharContato → update → conversa ativa → insert message
  db.query
    .mockResolvedValueOnce({ rows: [{ id: 7, name: 'K' }] })
    .mockResolvedValueOnce({ rows: [{ id: 7 }] })
    .mockResolvedValueOnce({ rows: [{ id: 30 }] })
    .mockResolvedValueOnce({ rows: [] });
}

describe('enviarClienteTexto', () => {
  test('envia por WhatsApp e registra o texto', async () => {
    whatsapp.sendMessage.mockResolvedValueOnce();
    mockRegistroOK();
    const r = await conversas.enviarClienteTexto('21988596449', 'valor R$ 10');
    expect(whatsapp.sendMessage).toHaveBeenCalledWith('21988596449', 'valor R$ 10');
    expect(db.query.mock.calls[3][1][2]).toBe('valor R$ 10'); // conteúdo registrado
    expect(r.conversationId).toBe(30);
  });
});

describe('enviarImagemComRetry', () => {
  test('sucesso na 1ª tentativa → true, 1 chamada', async () => {
    whatsapp.sendImage.mockResolvedValueOnce();
    const ok = await conversas.enviarImagemComRetry('21988596449', 'http://x/a.png', 'cap', 0);
    expect(ok).toBe(true);
    expect(whatsapp.sendImage).toHaveBeenCalledTimes(1);
  });
  test('falha 1x, sucesso no retry → true, 2 chamadas', async () => {
    whatsapp.sendImage.mockRejectedValueOnce(new Error('400')).mockResolvedValueOnce();
    const ok = await conversas.enviarImagemComRetry('21988596449', 'http://x/a.png', 'cap', 0);
    expect(ok).toBe(true);
    expect(whatsapp.sendImage).toHaveBeenCalledTimes(2);
  });
  test('falha nas 2 → false', async () => {
    whatsapp.sendImage.mockRejectedValue(new Error('400'));
    const ok = await conversas.enviarImagemComRetry('21988596449', 'http://x/a.png', 'cap', 0);
    expect(ok).toBe(false);
    expect(whatsapp.sendImage).toHaveBeenCalledTimes(2);
  });
});

describe('enviarClienteImagem', () => {
  test('imagem OK → registra formato de mídia com mediaRef relativo', async () => {
    whatsapp.sendImage.mockResolvedValueOnce();
    mockRegistroOK();
    const r = await conversas.enviarClienteImagem('21988596449', 'https://app/uploads/a.png', 'legenda WA',
      { mediaRef: '/uploads/a.png', legenda: 'Arte Pedido #12', delayMs: 0 });
    expect(r).toEqual(expect.objectContaining({ ok: true, via: 'imagem' }));
    expect(db.query.mock.calls[3][1][2]).toBe('[imagem recebido: /uploads/a.png | Arte Pedido #12]');
  });
  test('imagem falha 2x → fallback texto, registra o texto, via=texto', async () => {
    whatsapp.sendImage.mockRejectedValue(new Error('400'));
    whatsapp.sendMessage.mockResolvedValueOnce();
    mockRegistroOK();
    const r = await conversas.enviarClienteImagem('21988596449', 'https://app/uploads/a.png', 'cap',
      { mediaRef: '/uploads/a.png', legenda: 'Arte', fallbackTexto: 'Segue: https://app/uploads/a.png', delayMs: 0 });
    expect(r).toEqual(expect.objectContaining({ ok: true, via: 'texto' }));
    expect(whatsapp.sendMessage).toHaveBeenCalledWith('21988596449', 'Segue: https://app/uploads/a.png');
    expect(db.query.mock.calls[3][1][2]).toBe('Segue: https://app/uploads/a.png');
  });
  test('imagem e texto falham → ok=false, não registra', async () => {
    whatsapp.sendImage.mockRejectedValue(new Error('400'));
    whatsapp.sendMessage.mockRejectedValue(new Error('500'));
    const r = await conversas.enviarClienteImagem('21988596449', 'https://app/uploads/a.png', 'cap',
      { mediaRef: '/uploads/a.png', legenda: 'Arte', fallbackTexto: 'Segue', delayMs: 0 });
    expect(r.ok).toBe(false);
    expect(db.query).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO messages/i), expect.anything());
  });
});

describe('enviarClienteImagem com botões', () => {
  const botoes = [{ id: 'arte_aprovar', title: '✅ Aprovar' }, { id: 'arte_reprovar', title: '✏️ Reprovar' }];

  test('imagem+botões OK → interativo com header de imagem, registra mídia, via=imagem', async () => {
    whatsapp.sendInteractiveButtons.mockResolvedValueOnce();
    mockRegistroOK();
    const r = await conversas.enviarClienteImagem('21988596449', 'https://app/uploads/a.png', 'corpo',
      { mediaRef: '/uploads/a.png', legenda: 'Arte Pedido #12', buttons: botoes, delayMs: 0 });
    expect(r).toEqual(expect.objectContaining({ ok: true, via: 'imagem' }));
    const call = whatsapp.sendInteractiveButtons.mock.calls[0];
    expect(call[0]).toBe('21988596449');
    expect(call[1]).toEqual(expect.objectContaining({ headerImage: 'https://app/uploads/a.png', bodyText: 'corpo', buttons: botoes }));
    expect(db.query.mock.calls[3][1][2]).toBe('[imagem recebido: /uploads/a.png | Arte Pedido #12]');
  });

  test('imagem+botões falha 2x → fallback texto+botões, registra o corpo, via=texto_botoes', async () => {
    whatsapp.sendInteractiveButtons
      .mockRejectedValueOnce(new Error('400')).mockRejectedValueOnce(new Error('400')) // imagem: 2 tentativas
      .mockResolvedValueOnce();                                                          // texto+botões: ok
    whatsapp.sendMessage.mockClear();
    mockRegistroOK();
    const r = await conversas.enviarClienteImagem('21988596449', 'https://app/uploads/a.png', 'corpo',
      { mediaRef: '/uploads/a.png', legenda: 'Arte', fallbackTexto: 'Segue: https://app/uploads/a.png', buttons: botoes, delayMs: 0 });
    expect(r).toEqual(expect.objectContaining({ ok: true, via: 'texto_botoes' }));
    // 3ª chamada de sendInteractiveButtons foi só-texto (sem headerImage)
    const ultimaCall = whatsapp.sendInteractiveButtons.mock.calls[2][1];
    expect(ultimaCall.headerImage).toBeUndefined();
    expect(ultimaCall.bodyText).toBe('Segue: https://app/uploads/a.png');
    expect(db.query.mock.calls[3][1][2]).toBe('Segue: https://app/uploads/a.png');
  });

  test('imagem+botões e texto+botões falham → texto puro, via=texto', async () => {
    whatsapp.sendInteractiveButtons.mockRejectedValue(new Error('400')); // todas falham
    whatsapp.sendMessage.mockResolvedValueOnce();
    mockRegistroOK();
    const r = await conversas.enviarClienteImagem('21988596449', 'https://app/uploads/a.png', 'corpo',
      { mediaRef: '/uploads/a.png', legenda: 'Arte', fallbackTexto: 'Segue link', buttons: botoes, delayMs: 0 });
    expect(r).toEqual(expect.objectContaining({ ok: true, via: 'texto' }));
    expect(whatsapp.sendMessage).toHaveBeenCalledWith('21988596449', 'Segue link');
  });
});
