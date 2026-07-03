const { SYSTEM_PROMPT } = require('../src/ai/agent');

describe('SYSTEM_PROMPT — regras de treino AO', () => {
  test('exporta o prompt', () => {
    expect(typeof SYSTEM_PROMPT).toBe('string');
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(500);
  });
  test('contém o guia de materiais', () => {
    expect(SYSTEM_PROMPT).toMatch(/GUIA DE MATERIAIS/);
    expect(SYSTEM_PROMPT).toMatch(/lona 440/i);
  });
  test('contém a regra de normalização em metros', () => {
    expect(SYSTEM_PROMPT).toMatch(/METRO/);
    expect(SYSTEM_PROMPT).toMatch(/0,30m/);
  });
});
