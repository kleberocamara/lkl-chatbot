jest.mock('../../src/db', () => ({ query: jest.fn() }));
jest.mock('../../src/services/conversas', () => ({
  enviarClienteImagem: jest.fn(),
  enviarClienteTexto: jest.fn(),
  sairDeAguardandoHumano: jest.fn().mockResolvedValue(undefined),
}));

const db = require('../../src/db');
const conversas = require('../../src/services/conversas');
const service = require('../../src/modules/orcamentos/service');

const ITEM = {
  id: 5, produto: 'FOLDER', descricao: null, orcamento_id: 1,
  cliente_celular: '21988596449', cliente_nome: 'KLEBER', pedido_numero: 42,
};

beforeEach(() => { jest.clearAllMocks(); process.env.BASE_URL = 'https://app.graficalkl.com.br'; });

test('envio OK → envia imagem sem botões, depois texto com link, e marca arte_status=enviada', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [ITEM] }) // SELECT item
    .mockResolvedValueOnce({ rows: [] });    // UPDATE status

  conversas.enviarClienteImagem.mockResolvedValueOnce({ ok: true, via: 'imagem' });
  conversas.enviarClienteTexto.mockResolvedValueOnce({ ok: true });

  const r = await service.enviarArteItem(5, '/uploads/artes/arte_1.png');

  expect(conversas.enviarClienteImagem).toHaveBeenCalledWith(
    '21988596449',
    'https://app.graficalkl.com.br/uploads/artes/arte_1.png',
    null,
    expect.objectContaining({ mediaRef: '/uploads/artes/arte_1.png' })
  );
  expect(conversas.enviarClienteImagem.mock.calls[0][3]).not.toHaveProperty('buttons');

  expect(conversas.enviarClienteTexto).toHaveBeenCalledWith(
    '21988596449',
    expect.stringMatching(/Pedido #42/),
    expect.objectContaining({ nome: 'KLEBER' })
  );
  const textoEnviado = conversas.enviarClienteTexto.mock.calls[0][1];
  expect(textoEnviado).toMatch(/\*SIM\*/);
  expect(textoEnviado).toMatch(/\*NÃO\*/);
  expect(textoEnviado).toMatch(/arte-resposta\?token=5/);

  const upd = db.query.mock.calls[1];
  expect(upd[0]).toMatch(/arte_status='enviada'/);
  expect(r).toEqual({ ok: true, item_id: 5, status: 'enviada' });
});

test('envio falha total → arte_status=erro_envio, não envia texto, e retorna erro', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [ITEM] }) // SELECT item
    .mockResolvedValueOnce({ rows: [] });    // UPDATE erro_envio
  conversas.enviarClienteImagem.mockResolvedValueOnce({ ok: false, via: null });

  const r = await service.enviarArteItem(5, '/uploads/artes/arte_1.png');

  expect(conversas.enviarClienteTexto).not.toHaveBeenCalled();
  expect(db.query.mock.calls[1][0]).toMatch(/arte_status='erro_envio'/);
  expect(r.status).toBe('erro_envio');
  expect(r.erro[0]).toMatch(/Falha ao enviar arte/);
});

test('envio de texto falha → loga warning mas ainda marca arte_status=enviada', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [ITEM] }) // SELECT item
    .mockResolvedValueOnce({ rows: [] });    // UPDATE status

  conversas.enviarClienteImagem.mockResolvedValueOnce({ ok: true, via: 'imagem' });
  conversas.enviarClienteTexto.mockResolvedValueOnce({ ok: false });
  const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

  const r = await service.enviarArteItem(5, '/uploads/artes/arte_1.png');

  expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/Falha ao enviar texto/), 5);
  const upd = db.query.mock.calls[1];
  expect(upd[0]).toMatch(/arte_status='enviada'/);
  expect(r).toEqual({ ok: true, item_id: 5, status: 'enviada' });

  warnSpy.mockRestore();
});

test('item não encontrado → erro', async () => {
  db.query.mockResolvedValueOnce({ rows: [] });
  const r = await service.enviarArteItem(999, '/uploads/x.png');
  expect(r.erro[0]).toMatch(/não encontrado/);
});

test('item sem celular → salva status enviada sem tentar enviar', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [{ ...ITEM, cliente_celular: null }] })
    .mockResolvedValueOnce({ rows: [] });
  const r = await service.enviarArteItem(5, '/uploads/x.png');
  expect(conversas.enviarClienteImagem).not.toHaveBeenCalled();
  expect(r.status).toBe('enviada');
});

describe('buscarArtePorToken', () => {
  test('item encontrado → monta arte_arquivo_url_publica a partir de BASE_URL', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 5, produto: 'FOLDER', arte_status: 'enviada', arte_arquivo_url: '/uploads/artes/arte_1.png', pedido_numero: 42 }],
    });
    const r = await service.buscarArtePorToken('5');
    expect(r.arte_arquivo_url_publica).toBe('https://app.graficalkl.com.br/uploads/artes/arte_1.png');
  });

  test('item não encontrado → null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await service.buscarArtePorToken('999');
    expect(r).toBeNull();
  });

  test('itemId vazio → null sem consultar o banco', async () => {
    const r = await service.buscarArtePorToken(null);
    expect(r).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('processarRespostaArteToken', () => {
  const ITEM_ENVIADA = { id: 5, produto: 'FOLDER', arte_status: 'enviada', tipo_producao: 'OFFSET', orcamento_id: 1, vendedor_id: 3, pedido_numero: 42 };

  test('aprovado → arte_status=aprovada e resposta de confirmação', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [ITEM_ENVIADA] }) // SELECT item
      .mockResolvedValueOnce({ rows: [] });             // UPDATE aprovada
    const r = await service.processarRespostaArteToken('5', 'aprovado');
    expect(r).toEqual(expect.objectContaining({ aprovado: true, item_id: 5 }));
    expect(db.query.mock.calls[1][0]).toMatch(/arte_status='aprovada'/);
  });

  test('reprovado → arte_status=reprovada', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [ITEM_ENVIADA] })
      .mockResolvedValueOnce({ rows: [] });
    const r = await service.processarRespostaArteToken('5', 'reprovado');
    expect(r).toEqual(expect.objectContaining({ aprovado: false, item_id: 5 }));
    expect(db.query.mock.calls[1][0]).toMatch(/arte_status='reprovada'/);
  });

  test('item já processado (arte_status=aprovada) → erro, nenhum UPDATE', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ...ITEM_ENVIADA, arte_status: 'aprovada' }] });
    const r = await service.processarRespostaArteToken('5', 'aprovado');
    expect(r.erro[0]).toMatch(/já foi/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('item inexistente → erro', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await service.processarRespostaArteToken('999', 'aprovado');
    expect(r.erro[0]).toMatch(/não encontrada/);
  });
});

describe('responderArteItem', () => {
  const PEND = { id: 9, orcamento_id: 1, produto: 'BANNER', tipo_producao: 'OFFSET', vendedor_id: 3, pedido_numero: 31 };

  test('texto de aprovação ("sim") → arte_status=aprovada', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [PEND] }) // _acharArtePendente
      .mockResolvedValueOnce({ rows: [] });    // UPDATE aprovada
    const r = await service.responderArteItem('21988596449', 'sim');
    expect(r).toEqual(expect.objectContaining({ aprovado: true, item_id: 9 }));
    expect(db.query.mock.calls[1][0]).toMatch(/arte_status='aprovada'/);
  });

  test('texto de reprovação ("não, mudar a cor") → arte_status=reprovada e grava arte_comentario', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [PEND] }) // _acharArtePendente
      .mockResolvedValueOnce({ rows: [] });    // UPDATE reprovada
    const r = await service.responderArteItem('21988596449', 'não, mudar a cor');
    expect(r).toEqual(expect.objectContaining({ aprovado: false, item_id: 9 }));
    expect(db.query.mock.calls[1][0]).toMatch(/arte_status='reprovada'/);
    expect(db.query.mock.calls[1][1]).toEqual(['não, mudar a cor', 9]);
  });

  test('sem arte pendente → null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await service.responderArteItem('21988596449', 'sim');
    expect(r).toBeNull();
  });
});
