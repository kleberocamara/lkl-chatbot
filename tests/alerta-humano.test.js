const { deveAlertarHumano } = require('../src/services/followup');

const agora = new Date('2026-07-03T15:00:00Z');
const h3 = new Date('2026-07-03T11:30:00Z'); // 3.5h antes
const h1 = new Date('2026-07-03T14:00:00Z'); // 1h antes

const base = { status: 'aguardando_humano', alerta_humano_em: null, ultima_msg_at: h3 };

describe('deveAlertarHumano', () => {
  test('elegível: aguardando_humano, sem flag, >2h', () => {
    expect(deveAlertarHumano(base, agora)).toBe(true);
  });
  test('não elegível: outro status', () => {
    expect(deveAlertarHumano({ ...base, status: 'active' }, agora)).toBe(false);
  });
  test('não elegível: já alertado', () => {
    expect(deveAlertarHumano({ ...base, alerta_humano_em: h3 }, agora)).toBe(false);
  });
  test('não elegível: última mensagem há menos de 2h', () => {
    expect(deveAlertarHumano({ ...base, ultima_msg_at: h1 }, agora)).toBe(false);
  });
  test('não elegível: sem última mensagem', () => {
    expect(deveAlertarHumano({ ...base, ultima_msg_at: null }, agora)).toBe(false);
  });
});
