jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/modules/orders/service', () => ({ criarOrder: jest.fn() }));
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } },
  }));
});

const db = require('../src/db');
const ordersService = require('../src/modules/orders/service');
const OpenAI = require('openai');
const agent = require('../src/ai/agent');
const openaiInstance = OpenAI.mock.results[0].value;

const CLIENTE = { id: 'cliente-1', nome: 'WENDELL', tipo_pessoa: 'PF', celular: '21993367766', telefone: null, email: 'wendell@example.com', cpf_cnpj: null, updated_at: new Date(), created_at: new Date() };
const PEDIDO_ABERTO = { numero_os: 44, status: 'em_producao', produto: 'ADESIVO' };

function mockDb({ pedidosAbertos = [] } = {}) {
  db.query.mockImplementation((sql, params) => {
    if (sql.startsWith('SELECT ai_context')) return Promise.resolve({ rows: [{ ai_context: [] }] });
    if (sql.startsWith('SELECT value FROM settings')) return Promise.resolve({ rows: [] });
    if (sql.includes('SELECT ct.phone FROM conversations')) return Promise.resolve({ rows: [{ phone: '21993367766' }] });
    if (sql.includes('FROM clientes_lkl')) return Promise.resolve({ rows: [CLIENTE] });
    if (sql.includes('FROM orders') && sql.includes('cliente_id = ANY')) return Promise.resolve({ rows: pedidosAbertos });
    if (sql.includes('SELECT c.contact_id, ct.phone')) return Promise.resolve({ rows: [{ contact_id: 'contato-1', phone: '21993367766', contact_name: 'WENDELL' }] });
    if (sql.includes('UPDATE clientes_lkl')) return Promise.resolve({ rows: [] });
    if (sql.includes('UPDATE conversations') && sql.includes('needs_details')) return Promise.resolve({ rows: [] });
    if (sql.includes('UPDATE contacts SET name')) return Promise.resolve({ rows: [] });
    if (sql.includes('UPDATE conversations SET ai_context')) return Promise.resolve({ rows: [] });
    throw new Error('query inesperada: ' + sql);
  });
}

function mockToolCall(args) {
  openaiInstance.chat.completions.create.mockResolvedValueOnce({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          function: { name: 'registrar_pedido', arguments: JSON.stringify(args) },
        }],
      },
    }],
  });
}

const ARGS_BASE = {
  mensagem_encerramento: 'Pedido registrado! Número: {NUMERO_PEDIDO}',
  tipo_servico: 'Adesivo', produto: 'ADESIVO', quantidade: 1,
  nome_cliente: 'WENDELL', email: 'wendell@example.com',
  cliente_existente_confirmado: true,
};

describe('processMessage — pedido em aberto do cliente', () => {
  beforeEach(() => {
    db.query.mockReset();
    openaiInstance.chat.completions.create.mockReset();
    ordersService.criarOrder.mockReset();
  });

  test('sem pedido em aberto → cria o pedido normalmente', async () => {
    mockDb({ pedidosAbertos: [] });
    mockToolCall(ARGS_BASE);
    ordersService.criarOrder.mockResolvedValueOnce({ order: { numero_os: 50 } });

    const r = await agent.processMessage(1, 'Quero um adesivo novo, pode confirmar');

    expect(ordersService.criarOrder).toHaveBeenCalledTimes(1);
    expect(r.isComplete).toBe(true);
    expect(r.response).toMatch(/#50/);
  });

  test('com pedido em aberto e SEM pedido_novo_confirmado → não cria pedido, pergunta antes', async () => {
    mockDb({ pedidosAbertos: [PEDIDO_ABERTO] });
    mockToolCall(ARGS_BASE); // sem pedido_novo_confirmado

    const r = await agent.processMessage(1, 'Preciso de orientação de instalação');

    expect(ordersService.criarOrder).not.toHaveBeenCalled();
    expect(r.isComplete).toBe(false);
    expect(r.orderDetails).toBeNull();
    expect(r.response).toMatch(/#44/);
    expect(r.response).toMatch(/pedido novo/i);
  });

  test('com pedido em aberto e pedido_novo_confirmado=true → cria o pedido normalmente', async () => {
    mockDb({ pedidosAbertos: [PEDIDO_ABERTO] });
    mockToolCall({ ...ARGS_BASE, pedido_novo_confirmado: true });
    ordersService.criarOrder.mockResolvedValueOnce({ order: { numero_os: 51 } });

    const r = await agent.processMessage(1, 'Sim, é um pedido novo mesmo, confirmo');

    expect(ordersService.criarOrder).toHaveBeenCalledTimes(1);
    expect(r.isComplete).toBe(true);
    expect(r.response).toMatch(/#51/);
  });
});
