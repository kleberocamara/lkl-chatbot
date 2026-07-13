const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { fluxoCaixa } = require('../src/modules/analises/service');

describe('fluxoCaixa — entradas de PIX/link Mercado Pago', () => {
  afterEach(() => jest.clearAllMocks());

  test('soma PIX/link_mp aguardando pagamento na semana em que foram enviados', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // entR (boletos)
      .mockResolvedValueOnce({ rows: [{ semana: '2026-07-13', total: 300 }] }) // entPixMp
      .mockResolvedValueOnce({ rows: [] }) // saiR
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }) // atrR (boletos)
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }) // atrPixMp
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }); // atrP

    const r = await fluxoCaixa({ dias: 30 });

    expect(r.total_entradas).toBe(300);
    expect(r.semanas).toEqual([{ inicio: '2026-07-13', fim: '2026-07-19', entradas: 300, saidas: 0, liquido: 300 }]);

    const pixMpSql = db.query.mock.calls[1][0];
    expect(pixMpSql).toMatch(/tipo_cobranca IN \('pix','link_mp'\)/);
    expect(pixMpSql).toMatch(/status_pagamento = 'aguardando_pagamento'/);
    expect(pixMpSql).toMatch(/COALESCE\(enviado_em, created_at\)/);
  });

  test('soma boleto E PIX/link_mp na mesma semana quando coincidem', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ semana: '2026-07-13', total: 1000 }] }) // entR
      .mockResolvedValueOnce({ rows: [{ semana: '2026-07-13', total: 300 }] }) // entPixMp
      .mockResolvedValueOnce({ rows: [] }) // saiR
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const r = await fluxoCaixa({ dias: 30 });

    expect(r.semanas).toHaveLength(1);
    expect(r.semanas[0].entradas).toBe(1300);
  });

  test('PIX/link_mp enviado antes de hoje e ainda não pago conta como atrasado_receber, somado ao de boleto', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // entR
      .mockResolvedValueOnce({ rows: [] }) // entPixMp (nada dentro da janela futura)
      .mockResolvedValueOnce({ rows: [] }) // saiR
      .mockResolvedValueOnce({ rows: [{ total: 500 }] }) // atrR (boleto vencido)
      .mockResolvedValueOnce({ rows: [{ total: 150 }] }) // atrPixMp
      .mockResolvedValueOnce({ rows: [{ total: 0 }] }); // atrP

    const r = await fluxoCaixa({});

    expect(r.atrasado_receber).toBe(650);
    const atrPixMpSql = db.query.mock.calls[4][0];
    expect(atrPixMpSql).toMatch(/tipo_cobranca IN \('pix','link_mp'\)/);
    expect(atrPixMpSql).toMatch(/COALESCE\(enviado_em, created_at\) < CURRENT_DATE/);
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
