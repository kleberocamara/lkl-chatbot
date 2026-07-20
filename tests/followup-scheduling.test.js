jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn() }));
jest.mock('../src/services/logger', () => ({ log: jest.fn() }));
jest.mock('../src/services/fcm', () => ({ sendToUser: jest.fn() }));
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })));

const db = require('../src/db');
const { calcScheduledAt, scheduleFollowUps } = require('../src/services/followup');

beforeEach(() => jest.clearAllMocks());

describe('calcScheduledAt', () => {
  test('regressão: orçamento enviado numa sexta-feira faz tentativa 2 (sábado→segunda) colidir com tentativa 3 (já segunda)', () => {
    // 2026-07-17 é sexta-feira
    const sentAt = new Date('2026-07-17T20:18:30.869Z');
    const t2 = calcScheduledAt(sentAt, 2); // +1 dia = sábado → empurra pra segunda 10h
    const t3 = calcScheduledAt(sentAt, 3); // +3 dias = segunda, já é dia útil
    expect(t2.toISOString()).toBe(t3.toISOString()); // confirma a colisão que calcScheduledAt sozinha não evita
  });
});

describe('scheduleFollowUps — evita colisão de horário entre tentativas', () => {
  test('envio numa sexta-feira → as 5 tentativas ficam em horários estritamente crescentes, sem duplicar', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const sentAt = new Date('2026-07-17T20:18:30.869Z');
    await scheduleFollowUps('conv-1', sentAt);

    const [, params] = db.query.mock.calls[0];
    // params = [conversationId, attempt, scheduledAt] x5, em sequência
    const agendados = [];
    for (let i = 0; i < 5; i++) agendados.push(new Date(params[i * 3 + 2]).getTime());

    for (let i = 1; i < agendados.length; i++) {
      expect(agendados[i]).toBeGreaterThan(agendados[i - 1]);
    }

    // As datas conflitantes (2 e 3) não podem mais ser iguais
    expect(agendados[1]).not.toBe(agendados[2]);
  });

  test('sem colisão (envio numa segunda-feira) → mantém os horários originais de calcScheduledAt', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    // 2026-07-13 é segunda-feira
    const sentAt = new Date('2026-07-13T14:00:00.000Z');
    await scheduleFollowUps('conv-2', sentAt);

    const [, params] = db.query.mock.calls[0];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const esperado = calcScheduledAt(sentAt, attempt).toISOString();
      const gravado = new Date(params[(attempt - 1) * 3 + 2]).toISOString();
      expect(gravado).toBe(esperado);
    }
  });
});
