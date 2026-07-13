const crypto = require('crypto');

// routes.js importa vários módulos pesados (handler, whatsapp, orcamentos/service, contas-pagar/whatsapp)
// no topo do arquivo — mocka tudo pra poder importar só a função de validação de assinatura.
jest.mock('../src/webhook/handler', () => ({ handleInboundMessage: jest.fn(), handleInboundMedia: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ markAsRead: jest.fn(), sendMessage: jest.fn(), downloadMedia: jest.fn() }));
jest.mock('../src/webhook/c6bank', () => ({ handleC6Webhook: jest.fn() }));
jest.mock('../src/webhook/mercadopago', () => ({ handleMercadoPagoWebhook: jest.fn() }));
jest.mock('../src/modules/orcamentos/service', () => ({ processarRespostaWA: jest.fn() }));
jest.mock('../src/modules/contas-pagar/whatsapp', () => ({ isNumeroAutorizado: jest.fn(), handleComprovanteDespesa: jest.fn(), processarRespostaDespesaWA: jest.fn() }));

const { _assinaturaValida } = require('../src/webhook/routes');

beforeEach(() => { delete process.env.WHATSAPP_APP_SECRET; });

test('WHATSAPP_APP_SECRET não configurado → aceita (sem essa defesa, mas não bloqueia)', () => {
  const req = { headers: {}, rawBody: Buffer.from('{"a":1}') };
  expect(_assinaturaValida(req)).toBe(true);
});

test('assinatura ausente (secret configurado) → rejeita', () => {
  process.env.WHATSAPP_APP_SECRET = 'segredo';
  const req = { headers: {}, rawBody: Buffer.from('{"a":1}') };
  expect(_assinaturaValida(req)).toBe(false);
});

test('assinatura inválida → rejeita', () => {
  process.env.WHATSAPP_APP_SECRET = 'segredo';
  const req = { headers: { 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) }, rawBody: Buffer.from('{"a":1}') };
  expect(_assinaturaValida(req)).toBe(false);
});

test('assinatura válida → aceita', () => {
  process.env.WHATSAPP_APP_SECRET = 'segredo';
  const raw = Buffer.from('{"a":1}');
  const sig = crypto.createHmac('sha256', 'segredo').update(raw).digest('hex');
  const req = { headers: { 'x-hub-signature-256': `sha256=${sig}` }, rawBody: raw };
  expect(_assinaturaValida(req)).toBe(true);
});

test('corpo alterado depois de assinado → assinatura não bate, rejeita', () => {
  process.env.WHATSAPP_APP_SECRET = 'segredo';
  const rawOriginal = Buffer.from('{"boletoId":"x","status":"pendente"}');
  const sig = crypto.createHmac('sha256', 'segredo').update(rawOriginal).digest('hex');
  const rawAdulterado = Buffer.from('{"boletoId":"x","status":"LIQUIDADO"}');
  const req = { headers: { 'x-hub-signature-256': `sha256=${sig}` }, rawBody: rawAdulterado };
  expect(_assinaturaValida(req)).toBe(false);
});
