const { deveReengajar } = require('../src/services/followup');

const agora = new Date('2026-07-03T15:00:00Z'); // dia útil (sexta), 12h SP
const h72 = new Date('2026-06-30T12:00:00Z');   // ~3 dias antes
const h1  = new Date('2026-07-03T14:00:00Z');   // 1h antes

const base = { status: 'aguardando_humano', pedido_numero: null, reengajado_em: null, ultima_msg_at: h72 };

describe('deveReengajar', () => {
  test('elegível: aguardando_humano, sem pedido, sem flag, >48h', () => {
    expect(deveReengajar(base, agora)).toBe(true);
  });
  test('não elegível: outro status', () => {
    expect(deveReengajar({ ...base, status: 'active' }, agora)).toBe(false);
  });
  test('não elegível: pedido já registrado', () => {
    expect(deveReengajar({ ...base, pedido_numero: 42 }, agora)).toBe(false);
  });
  test('não elegível: já reengajado', () => {
    expect(deveReengajar({ ...base, reengajado_em: h72 }, agora)).toBe(false);
  });
  test('não elegível: última mensagem há menos de 48h', () => {
    expect(deveReengajar({ ...base, ultima_msg_at: h1 }, agora)).toBe(false);
  });
  test('não elegível: sem última mensagem', () => {
    expect(deveReengajar({ ...base, ultima_msg_at: null }, agora)).toBe(false);
  });
});
