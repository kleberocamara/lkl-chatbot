const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { fluxoCaixa } = require('../src/modules/analises/service');

describe('fluxoCaixa — entradas de PIX/link Mercado Pago', () => {
  afterEach(() => jest.clearAllMocks());

  test('soma PIX/link_mp aguardando pagamento na semana em que foram enviados', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // entRItens (boletos)
      .mockResolvedValueOnce({ rows: [{ semana: '2026-07-13', data: '2026-07-13', valor: 300, numero: 50, tipo_cobranca: 'pix', cliente: 'Ana' }] }) // entPixMpItens
      .mockResolvedValueOnce({ rows: [] }) // saiRItens
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }) // atrR (boletos)
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }) // atrPixMp
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }); // atrP

    const r = await fluxoCaixa({ dias: 30 });

    expect(r.total_entradas).toBe(300);
    expect(r.semanas).toHaveLength(1);
    expect(r.semanas[0]).toEqual(expect.objectContaining({ inicio: '2026-07-13', fim: '2026-07-19', entradas: 300, saidas: 0, liquido: 300 }));
    expect(r.semanas[0].itens).toEqual([
      { tipo: 'entrada', origem: 'pix', descricao: 'Pedido #50 — Ana (PIX)', valor: 300, data: '2026-07-13' },
    ]);

    const pixMpSql = db.query.mock.calls[1][0];
    expect(pixMpSql).toMatch(/tipo_cobranca IN \('pix','link_mp'\)/);
    expect(pixMpSql).toMatch(/status_pagamento = 'aguardando_pagamento'/);
    expect(pixMpSql).toMatch(/COALESCE\(o\.enviado_em, o\.created_at\)/);
  });

  test('soma boleto E PIX/link_mp na mesma semana quando coincidem, e mistura os itens', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ semana: '2026-07-13', data: '2026-07-15', valor: 1000, numero: 40, cliente: 'João', parcela: 1, total_parcelas: 1 }] }) // entRItens
      .mockResolvedValueOnce({ rows: [{ semana: '2026-07-13', data: '2026-07-13', valor: 300, numero: 50, tipo_cobranca: 'link_mp', cliente: 'Ana' }] }) // entPixMpItens
      .mockResolvedValueOnce({ rows: [] }) // saiRItens
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const r = await fluxoCaixa({ dias: 30 });

    expect(r.semanas).toHaveLength(1);
    expect(r.semanas[0].entradas).toBe(1300);
    expect(r.semanas[0].itens).toHaveLength(2);
    expect(r.semanas[0].itens.map(it => it.origem).sort()).toEqual(['boleto', 'link_mp']);
    // ordenado por data dentro da semana
    expect(r.semanas[0].itens[0].data).toBe('2026-07-13');
    expect(r.semanas[0].itens[1].data).toBe('2026-07-15');
  });

  test('boleto parcelado inclui "(parcela X/Y)" na descrição quando total_parcelas > 1', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ semana: '2026-07-13', data: '2026-07-14', valor: 200, numero: 41, cliente: 'Marta', parcela: 2, total_parcelas: 3 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const r = await fluxoCaixa({});

    expect(r.semanas[0].itens[0].descricao).toBe('Pedido #41 — Marta (parcela 2/3)');
  });

  test('PIX/link_mp enviado antes de hoje e ainda não pago conta como atrasado_receber, somado ao de boleto', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // entRItens
      .mockResolvedValueOnce({ rows: [] }) // entPixMpItens (nada dentro da janela futura)
      .mockResolvedValueOnce({ rows: [] }) // saiRItens
      .mockResolvedValueOnce({ rows: [{ total: 500 }] }) // atrR (boleto vencido)
      .mockResolvedValueOnce({ rows: [{ total: 150 }] }) // atrPixMp
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }); // atrP

    const r = await fluxoCaixa({});

    expect(r.atrasado_receber).toBe(650);
    const atrPixMpSql = db.query.mock.calls[4][0];
    expect(atrPixMpSql).toMatch(/tipo_cobranca IN \('pix','link_mp'\)/);
    expect(atrPixMpSql).toMatch(/COALESCE\(enviado_em, created_at\) < CURRENT_DATE/);
  });

  test('contas a pagar viram itens de saída, com fornecedor concatenado na descrição', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ semana: '2026-07-13', data: '2026-07-16', valor: 400, descricao: 'Papel sulfite', fornecedor: 'Fornecedor X' }] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const r = await fluxoCaixa({});

    expect(r.semanas[0].saidas).toBe(400);
    expect(r.semanas[0].itens[0]).toEqual({ tipo: 'saida', origem: 'conta_pagar', descricao: 'Papel sulfite — Fornecedor X', valor: 400, data: '2026-07-16' });
  });

  test('sem nenhuma entrada/saída → totais zerados, sem quebrar', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const r = await fluxoCaixa({ dias: 90 });

    expect(r.total_entradas).toBe(0);
    expect(r.total_saidas).toBe(0);
    expect(r.atrasado_receber).toBe(0);
    expect(r.semanas).toEqual([]);
  });
});
