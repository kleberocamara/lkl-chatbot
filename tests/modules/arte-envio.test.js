jest.mock('../../src/db', () => ({ query: jest.fn() }));
jest.mock('../../src/services/conversas', () => ({ enviarClienteImagem: jest.fn(), enviarClienteTexto: jest.fn() }));

const db = require('../../src/db');
const conversas = require('../../src/services/conversas');
const service = require('../../src/modules/orcamentos/service');

const ITEM = {
  id: 5, produto: 'FOLDER', descricao: null, orcamento_id: 1,
  cliente_celular: '21988596449', cliente_nome: 'KLEBER', pedido_numero: 42,
};

beforeEach(() => { jest.clearAllMocks(); process.env.BASE_URL = 'https://app.graficalkl.com.br'; });

test('envio OK → arte_status=enviada e usa enviarClienteImagem com mediaRef relativo', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [ITEM] }) // SELECT item
    .mockResolvedValueOnce({ rows: [] });    // UPDATE status
  conversas.enviarClienteImagem.mockResolvedValueOnce({ ok: true, via: 'imagem' });

  const r = await service.enviarArteItem(5, '/uploads/artes/arte_1.png');

  expect(conversas.enviarClienteImagem).toHaveBeenCalledWith(
    '21988596449',
    'https://app.graficalkl.com.br/uploads/artes/arte_1.png',
    expect.stringMatching(/Pedido #42/),
    expect.objectContaining({ mediaRef: '/uploads/artes/arte_1.png' })
  );
  const upd = db.query.mock.calls[1];
  expect(upd[0]).toMatch(/arte_status='enviada'/);
  expect(r).toEqual({ ok: true, item_id: 5, status: 'enviada' });
});

test('envio falha total → arte_status=erro_envio e retorna erro', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [ITEM] }) // SELECT item
    .mockResolvedValueOnce({ rows: [] });    // UPDATE erro_envio
  conversas.enviarClienteImagem.mockResolvedValueOnce({ ok: false, via: null });

  const r = await service.enviarArteItem(5, '/uploads/artes/arte_1.png');

  expect(db.query.mock.calls[1][0]).toMatch(/arte_status='erro_envio'/);
  expect(r.status).toBe('erro_envio');
  expect(r.erro[0]).toMatch(/Falha ao enviar arte/);
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
