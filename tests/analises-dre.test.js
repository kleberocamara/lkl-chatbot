const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { dre } = require('../src/modules/analises/service');

function linha(r, id) { return r.linhas.find(l => l.id === id); }

describe('dre — receita pela última entrega do pedido', () => {
  afterEach(() => jest.clearAllMocks());

  test('usa a query de entregas (não mais pago_em de orçamentos)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ numero: 42, cliente: 'Cliente Teste', total: 5000, data_entrega: '15/08/2026' }] })
      .mockResolvedValueOnce({ rows: [] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(linha(r, 'receita_bruta').valor).toBe(5000);
    const receitaSql = db.query.mock.calls[0][0];
    expect(receitaSql).toMatch(/os_historico/);
    expect(receitaSql).toMatch(/para_status = 'entregue'/);
    expect(receitaSql).toMatch(/total_os = e\.os_entregues/);
    expect(receitaSql).not.toMatch(/status_pagamento/);
  });
});

describe('dre — despesas por competência', () => {
  afterEach(() => jest.clearAllMocks());

  test('despesa pendente (não paga) dentro da competência do período conta', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ categoria: 'CUSTOS DE PRODUÇÃO (CPV)', valor: 900 }] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(linha(r, 'cpv').valor).toBe(-900);
    const despesasSql = db.query.mock.calls[1][0];
    expect(despesasSql).toMatch(/cp\.competencia BETWEEN/);
    expect(despesasSql).not.toMatch(/pago_em/);
    expect(despesasSql).toMatch(/status != 'cancelado'/);
  });
});

describe('dre — cascata completa', () => {
  afterEach(() => jest.clearAllMocks());

  test('cada subtotal soma corretamente a partir das linhas de dedução', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { numero: 1, cliente: 'Cliente A', total: 6000, data_entrega: '10/08/2026' },
        { numero: 2, cliente: 'Cliente B', total: 4000, data_entrega: '20/08/2026' },
      ] })
      .mockResolvedValueOnce({ rows: [
        { categoria: 'DEDUÇÕES DE VENDAS', valor: 600 },
        { categoria: 'CUSTOS DE PRODUÇÃO (CPV)', valor: 3000 },
        { categoria: 'DEDUÇÕES E DESPESAS COMERCIAIS', valor: 900 },
        { categoria: 'MÃO DE OBRA DIRETA (MOD)', valor: 1200 },
        { categoria: 'CUSTOS OPERACIONAIS DA FÁBRICA', valor: 300 },
        { categoria: 'OCUPAÇÃO E INFRAESTRUTURA', valor: 800 },
        { categoria: 'SEGUROS', valor: 100 },
        { categoria: 'DESPESAS FINANCEIRAS', valor: 200 },
      ] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(linha(r, 'receita_bruta').valor).toBe(10000);
    expect(linha(r, 'deducoes_vendas').valor).toBe(-600);
    expect(linha(r, 'receita_liquida').valor).toBe(9400);
    expect(linha(r, 'cpv').valor).toBe(-3000);
    expect(linha(r, 'despesas_comerciais').valor).toBe(-900);
    expect(linha(r, 'margem_contribuicao').valor).toBe(5500);
    expect(linha(r, 'custos_fixos_producao').valor).toBe(-1500);
    expect(linha(r, 'lucro_bruto').valor).toBe(4000);
    expect(linha(r, 'despesas_operacionais').valor).toBe(-900);
    expect(linha(r, 'ebitda').valor).toBe(3100);
    expect(linha(r, 'resultado_financeiro').valor).toBe(-200);
    expect(linha(r, 'impostos_lucro').valor).toBe(0);
    expect(linha(r, 'lucro_liquido').valor).toBe(2900);
    expect(r.margem_liquida).toBeCloseTo(2900 / 9400, 4);
  });

  test('linha com detalhamento traz cada categoria; linha sem lançamento fica sem detalhamento', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ numero: 1, cliente: 'Cliente A', total: 10000, data_entrega: '10/08/2026' }] })
      .mockResolvedValueOnce({ rows: [
        { categoria: 'MÃO DE OBRA DIRETA (MOD)', valor: 1200 },
      ] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    const custosFixos = linha(r, 'custos_fixos_producao');
    expect(custosFixos.valor).toBe(-1200);
    expect(custosFixos.detalhamento).toEqual([
      { categoria: 'MÃO DE OBRA DIRETA (MOD)', valor: -1200, percentual: -12 },
    ]);

    const cpv = linha(r, 'cpv');
    expect(cpv.valor).toBe(0);
    expect(cpv.detalhamento).toBeUndefined();
  });

  test('receita_bruta = 0 → todos os percentuais retornam 0, sem erro de divisão', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ categoria: 'CUSTOS DE PRODUÇÃO (CPV)', valor: 500 }] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(r.linhas.every(l => Number.isFinite(l.percentual))).toBe(true);
    expect(linha(r, 'lucro_liquido').percentual).toBe(0);
    expect(r.margem_liquida).toBe(0);
  });

  test('período sem nenhuma despesa → todas as linhas de dedução ficam com valor 0, sem detalhamento', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ numero: 1, cliente: 'Cliente A', total: 5000, data_entrega: '10/08/2026' }] })
      .mockResolvedValueOnce({ rows: [] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    r.linhas.filter(l => l.tipo === 'deducao').forEach(l => {
      expect(l.valor).toBe(0);
      expect(l.detalhamento).toBeUndefined();
    });
    expect(linha(r, 'lucro_liquido').valor).toBe(5000);
  });

  test('categoria_dre sem bucket mapeado → gera warning no console, não trava nem some silenciosamente do total', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    db.query
      .mockResolvedValueOnce({ rows: [{ numero: 1, cliente: 'Cliente A', total: 10000, data_entrega: '10/08/2026' }] })
      .mockResolvedValueOnce({ rows: [
        { categoria: 'CUSTOS DE PRODUÇÃO (CPV)', valor: 1000 },
        { categoria: 'CATEGORIA_INEXISTENTE_NO_MAPEAMENTO', valor: 500 },
      ] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0].join(' ')).toMatch(/CATEGORIA_INEXISTENTE_NO_MAPEAMENTO/);
    warnSpy.mockRestore();
  });

  test('SQL da receita considera vínculo indireto via os_itens/orcamento_itens (OS offset/revenda)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    const receitaSql = db.query.mock.calls[0][0];
    expect(receitaSql).toMatch(/os_itens/);
    expect(receitaSql).toMatch(/orcamento_itens/);
  });

  test('SQL da receita exclui OS canceladas da contagem de "totalmente entregue"', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    const receitaSql = db.query.mock.calls[0][0];
    const ocorrencias = receitaSql.match(/status != 'cancelado'/g) || [];
    expect(ocorrencias).toHaveLength(2);
  });
});

describe('dre — detalhamento da Receita Bruta de Vendas', () => {
  afterEach(() => jest.clearAllMocks());

  test('cada orçamento entregue no período aparece no detalhamento com número, cliente, valor e data', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { numero: 37, cliente: 'Kleber de Oliveira Camara', total: 663, data_entrega: '04/07/2026' },
        { numero: 30, cliente: 'Kleber de Oliveira Câmara', total: 1030, data_entrega: '06/07/2026' },
        { numero: 31, cliente: 'Cliente Evolution', total: 1500, data_entrega: '06/07/2026' },
      ] })
      .mockResolvedValueOnce({ rows: [] });

    const r = await dre({ inicio: '2026-07-01', fim: '2026-07-31' });

    const receitaBruta = linha(r, 'receita_bruta');
    expect(receitaBruta.valor).toBe(3193);
    expect(receitaBruta.detalhamento).toEqual([
      { categoria: '#37 — Kleber de Oliveira Camara (04/07/2026)', valor: 663, percentual: expect.any(Number) },
      { categoria: '#30 — Kleber de Oliveira Câmara (06/07/2026)', valor: 1030, percentual: expect.any(Number) },
      { categoria: '#31 — Cliente Evolution (06/07/2026)', valor: 1500, percentual: expect.any(Number) },
    ]);
  });

  test('orçamento sem cliente vinculado usa rótulo padrão', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ numero: 5, cliente: null, total: 200, data_entrega: '01/08/2026' }] })
      .mockResolvedValueOnce({ rows: [] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    expect(linha(r, 'receita_bruta').detalhamento[0].categoria).toBe('#5 — Cliente não identificado (01/08/2026)');
  });

  test('sem nenhum orçamento entregue no período → receita_bruta aparece com valor 0 e sem detalhamento', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const r = await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

    const receitaBruta = linha(r, 'receita_bruta');
    expect(receitaBruta.valor).toBe(0);
    expect(receitaBruta.detalhamento).toBeUndefined();
  });
});
