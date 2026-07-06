const { linhasServicoAuto } = require('../src/modules/orders/service');

describe('linhasServicoAuto', () => {
  test('2 itens sem arte + 1 com arte → linha Arte qtd 2, R$ 60', () => {
    const itens = [{ tem_arte: false }, { tem_arte: false }, { tem_arte: true }];
    const linhas = linhasServicoAuto(itens, false);
    const arte = linhas.find(l => l.produto === 'Arte Final');
    expect(arte).toEqual({ produto: 'Arte Final', quantidade: 2, valor_unitario: 30, valor_total: 60 });
    expect(linhas.find(l => l.produto === 'Entrega')).toBeUndefined();
  });

  test('todos com arte → sem linha de arte', () => {
    const linhas = linhasServicoAuto([{ tem_arte: true }, { tem_arte: true }], false);
    expect(linhas.find(l => l.produto === 'Arte Final')).toBeUndefined();
  });

  test('entrega=true → linha Entrega R$ 15', () => {
    const linhas = linhasServicoAuto([{ tem_arte: true }], true);
    expect(linhas.find(l => l.produto === 'Entrega')).toEqual(
      { produto: 'Entrega', quantidade: 1, valor_unitario: 15, valor_total: 15 });
  });

  test('entrega=false → sem entrega', () => {
    const linhas = linhasServicoAuto([{ tem_arte: false }], false);
    expect(linhas.find(l => l.produto === 'Entrega')).toBeUndefined();
  });

  test('nenhum sem arte + retirada → array vazio', () => {
    expect(linhasServicoAuto([{ tem_arte: true }], false)).toEqual([]);
  });

  test('1 item sem arte + entrega → Arte 30 e Entrega 15', () => {
    const linhas = linhasServicoAuto([{ tem_arte: false }], true);
    expect(linhas).toEqual([
      { produto: 'Arte Final', quantidade: 1, valor_unitario: 30, valor_total: 30 },
      { produto: 'Entrega', quantidade: 1, valor_unitario: 15, valor_total: 15 },
    ]);
  });
});
