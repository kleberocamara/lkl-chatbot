const fs = require('fs');
const path = require('path');
const { parseTabelaPreco, parseListaProdutos, moeda, inteiro, prazoDoId } = require('../src/modules/revenda/parser');

const FIX = path.join(__dirname, 'fixtures', 'revenda');
const tabelaHtml = fs.readFileSync(path.join(FIX, 'tabela.html'), 'utf8');
const listaHtml = fs.readFileSync(path.join(FIX, 'lista.html'), 'utf8');

describe('helpers', () => {
  test('moeda', () => {
    expect(moeda('R$ 1.005,15')).toBeCloseTo(1005.15, 2);
    expect(moeda('R$ 74,00')).toBeCloseTo(74, 2);
  });
  test('inteiro', () => { expect(inteiro('2.500 un')).toBe(2500); expect(inteiro('50 un')).toBe(50); });
  test('prazoDoId', () => { expect(prazoDoId('express_0')).toBe(12); expect(prazoDoId('normal_3')).toBe(24); expect(prazoDoId('slow_9')).toBe(48); });
});

describe('parseTabelaPreco (fixture: Folheto 80g 10x14 4/0)', () => {
  const r = parseTabelaPreco(tabelaHtml);

  test('extrai as faixas de quantidade', () => {
    expect(r.linhas.map(l => l.quantidade)).toEqual([2500, 5000, 10000, 20000, 30000, 40000, 50000]);
  });
  test('preços da faixa 2500 (12h/24h/48h)', () => {
    const l = r.linhas.find(x => x.quantidade === 2500);
    expect(l.precos[12]).toBeCloseTo(76.29, 2);
    expect(l.precos[24]).toBeCloseTo(74.00, 2);
    expect(l.precos[48]).toBeCloseTo(71.78, 2);
  });
  test('preço da faixa 50000 (24h)', () => {
    expect(r.linhas.find(x => x.quantidade === 50000).precos[24]).toBeCloseTo(975.00, 2);
  });
  test('acabamentos com preço e tipo', () => {
    const corte = r.acabamentos.find(a => /corte extra/i.test(a.nome));
    expect(corte.preco).toBeCloseTo(3.00, 2);
    expect(corte.tipo).toBe('acabamento');
    const checagem = r.acabamentos.find(a => /checagem/i.test(a.nome));
    expect(checagem.preco).toBeCloseTo(9.00, 2);
    expect(checagem.tipo).toBe('servico');
  });
});

describe('parseListaProdutos (fixture: categoria Folheto Couchê 80g)', () => {
  const prods = parseListaProdutos(listaHtml);

  test('encontra produtos com ref/nome/url', () => {
    expect(prods.length).toBeGreaterThan(10);
    const p = prods.find(x => x.ref === 'flt001');
    expect(p.nome).toMatch(/Folheto 80g \| 10x14cm \| 4\/0/);
    expect(p.url).toMatch(/\/p\/207\//);
  });
  test('cada produto tem URL própria (refs e urls únicos)', () => {
    const refs = prods.map(p => p.ref);
    const urls = prods.map(p => p.url);
    expect(new Set(refs).size).toBe(refs.length);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.every(u => /^https?:\/\/.*\/p\//.test(u))).toBe(true);
  });
});
