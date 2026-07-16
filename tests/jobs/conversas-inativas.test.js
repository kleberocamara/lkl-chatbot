jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../src/db', () => ({ query: jest.fn() }));

describe('job conversas-inativas', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  // jest.resetModules() invalida qualquer referência a 'node-cron'/'../../src/db'
  // capturada antes do reset (o require seguinte recria os mocks). Por isso
  // essas dependências são requisitadas de novo aqui, DEPOIS do reset, na
  // mesma ordem em que o job as requisita.
  function carregarJobECapturarCallback() {
    const cron = require('node-cron');
    const db = require('../../src/db');
    require('../../src/jobs/conversas-inativas');
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    const [expressao, callback, opcoes] = cron.schedule.mock.calls[0];
    return { expressao, callback, opcoes, db };
  }

  test('agenda o cron às 03h00 no fuso America/Sao_Paulo', () => {
    const { expressao, opcoes } = carregarJobECapturarCallback();
    expect(expressao).toBe('0 3 * * *');
    expect(opcoes).toEqual({ timezone: 'America/Sao_Paulo' });
  });

  test('callback fecha conversas ativas sem mensagem há 3+ dias', async () => {
    const { callback, db } = carregarJobECapturarCallback();
    db.query.mockResolvedValueOnce({ rowCount: 2, rows: [{ id: 1 }, { id: 2 }] });

    await callback();

    expect(db.query).toHaveBeenCalledTimes(1);
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE conversations SET status = 'resolved'/);
    expect(sql).toMatch(/status IN \('active', 'aguardando_humano', 'orcamento_enviado'\)/);
    expect(sql).toMatch(/INTERVAL '3 days'/);
  });

  test('callback não lança se a query falhar — só loga', async () => {
    const { callback, db } = carregarJobECapturarCallback();
    db.query.mockRejectedValueOnce(new Error('conexão perdida'));
    const warnSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(callback()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/ERRO/));
    warnSpy.mockRestore();
  });
});
