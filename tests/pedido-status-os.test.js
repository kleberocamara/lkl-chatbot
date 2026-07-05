const { pedidoStatusDaOS, podeAvancarPedido } = require('../src/constants/fluxoProducao');

describe('pedidoStatusDaOS', () => {
  test('nenhuma OS → null', () => {
    expect(pedidoStatusDaOS([])).toBeNull();
  });
  test('todas canceladas → null', () => {
    expect(pedidoStatusDaOS(['cancelado', 'cancelado'])).toBeNull();
  });
  test('uma OS em corte → em_producao', () => {
    expect(pedidoStatusDaOS(['corte'])).toBe('em_producao');
  });
  test('multi-OS parcial (acabamento + entregue) → em_producao', () => {
    expect(pedidoStatusDaOS(['acabamento', 'entregue'])).toBe('em_producao');
  });
  test('todas em entrega → concluido', () => {
    expect(pedidoStatusDaOS(['entrega', 'entrega'])).toBe('concluido');
  });
  test('entrega + entregue → concluido', () => {
    expect(pedidoStatusDaOS(['entrega', 'entregue'])).toBe('concluido');
  });
  test('todas entregue → entregue', () => {
    expect(pedidoStatusDaOS(['entregue', 'entregue'])).toBe('entregue');
  });
  test('cancelada ignorada; resto entregue → entregue', () => {
    expect(pedidoStatusDaOS(['entregue', 'cancelado'])).toBe('entregue');
  });
  test('impressao + acabamento → em_producao', () => {
    expect(pedidoStatusDaOS(['impressao', 'acabamento'])).toBe('em_producao');
  });
});

describe('podeAvancarPedido', () => {
  test('de aguardando_pagamento avança para em_producao', () => {
    expect(podeAvancarPedido('aguardando_pagamento', 'em_producao')).toBe(true);
  });
  test('de pago avança para entregue', () => {
    expect(podeAvancarPedido('pago', 'entregue')).toBe(true);
  });
  test('de novo avança para em_producao', () => {
    expect(podeAvancarPedido('novo', 'em_producao')).toBe(true);
  });
  test('em_producao avança para concluido', () => {
    expect(podeAvancarPedido('em_producao', 'concluido')).toBe(true);
  });
  test('entregue NÃO regride para em_producao', () => {
    expect(podeAvancarPedido('entregue', 'em_producao')).toBe(false);
  });
  test('concluido NÃO regride para em_producao', () => {
    expect(podeAvancarPedido('concluido', 'em_producao')).toBe(false);
  });
  test('mesmo status → false (no-op)', () => {
    expect(podeAvancarPedido('em_producao', 'em_producao')).toBe(false);
  });
  test('cancelado nunca avança', () => {
    expect(podeAvancarPedido('cancelado', 'entregue')).toBe(false);
  });
  test('reprovado nunca avança', () => {
    expect(podeAvancarPedido('reprovado', 'entregue')).toBe(false);
  });
});
