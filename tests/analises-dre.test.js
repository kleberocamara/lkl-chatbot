const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { dre } = require('../src/modules/analises/service');

describe('dre — despesas por competência', () => {
  afterEach(() => jest.clearAllMocks());

  test('despesa pendente (não paga) dentro da competência do período conta', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ receita: 0 }] })
      .mockResolvedValueOnce({ rows: [{ categoria: 'CUSTOS DE PRODUÇÃO (CPV)', valor: 900 }] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(r.total_despesas).toBe(900);
    const despesasSql = db.query.mock.calls[1][0];
    expect(despesasSql).toMatch(/cp\.competencia BETWEEN/);
    expect(despesasSql).not.toMatch(/pago_em/);
    expect(despesasSql).toMatch(/status != 'cancelado'/);
  });
});

describe('dre — receita pela última entrega do pedido', () => {
  afterEach(() => jest.clearAllMocks());

  test('usa a query de entregas (não mais pago_em de orçamentos)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ receita: 5000 }] })
      .mockResolvedValueOnce({ rows: [] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(r.receita).toBe(5000);
    const receitaSql = db.query.mock.calls[0][0];
    expect(receitaSql).toMatch(/os_historico/);
    expect(receitaSql).toMatch(/para_status = 'entregue'/);
    expect(receitaSql).toMatch(/total_os = e\.os_entregues/);
    expect(receitaSql).not.toMatch(/status_pagamento/);
  });
});
