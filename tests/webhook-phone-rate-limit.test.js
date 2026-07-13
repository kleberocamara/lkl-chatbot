describe('phoneRateLimit', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('permite até MAX_POR_JANELA mensagens do mesmo telefone dentro da janela', () => {
    const { excedeuLimite, _MAX_POR_JANELA } = require('../src/webhook/phoneRateLimit');
    let excedeu = false;
    for (let i = 0; i < _MAX_POR_JANELA; i++) {
      excedeu = excedeuLimite('5521988596449');
    }
    expect(excedeu).toBe(false);
  });

  test('a mensagem seguinte (acima do limite) é bloqueada', () => {
    const { excedeuLimite, _MAX_POR_JANELA } = require('../src/webhook/phoneRateLimit');
    for (let i = 0; i < _MAX_POR_JANELA; i++) excedeuLimite('5521988596449');
    expect(excedeuLimite('5521988596449')).toBe(true);
  });

  test('telefones diferentes têm contadores independentes', () => {
    const { excedeuLimite, _MAX_POR_JANELA } = require('../src/webhook/phoneRateLimit');
    for (let i = 0; i < _MAX_POR_JANELA; i++) excedeuLimite('5521988596449');
    expect(excedeuLimite('5521988596449')).toBe(true); // esse número já estourou
    expect(excedeuLimite('5521999999999')).toBe(false); // número diferente, começa do zero
  });

  test('janela expira e reseta o contador', () => {
    jest.useFakeTimers();
    const { excedeuLimite, _MAX_POR_JANELA, _WINDOW_MS } = require('../src/webhook/phoneRateLimit');
    for (let i = 0; i < _MAX_POR_JANELA; i++) excedeuLimite('5521988596449');
    expect(excedeuLimite('5521988596449')).toBe(true);
    jest.advanceTimersByTime(_WINDOW_MS + 1);
    expect(excedeuLimite('5521988596449')).toBe(false);
    jest.useRealTimers();
  });
});
