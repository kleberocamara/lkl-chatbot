const cheerio = require('cheerio');

// "R$ 1.005,15" | "R$ 74,00" → 1005.15 / 74.00
function moeda(txt) {
  const limpo = String(txt).replace(/[^0-9,.]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = parseFloat(limpo);
  return Number.isFinite(n) ? n : null;
}
// "2.500 un" | "50 un" → 2500 / 50
function inteiro(txt) {
  const n = parseInt(String(txt).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
// id "express_0" → 12, "normal_0" → 24, "slow_0" → 48
function prazoDoId(id) {
  if (/^express/.test(id)) return 12;
  if (/^normal/.test(id)) return 24;
  if (/^slow/.test(id)) return 48;
  return null;
}

// Matriz de preço (tiragem × prazo) + acabamentos/serviços da página de produto renderizada.
function parseTabelaPreco(html) {
  const $ = cheerio.load(html);
  const linhas = [];
  const acabamentos = [];

  // === MATRIZ ===
  $('.row.m-0.p-0').each((i, el) => {
    const $el = $(el);
    const qtdTxt = $el.find('.ref-esquerda span').first().text();
    if (!/\d/.test(qtdTxt) || /quantidade/i.test(qtdTxt)) return; // pula header e linhas sem qtd
    const quantidade = inteiro(qtdTxt);
    if (!quantidade) return;
    const precos = {};
    $el.find('.conteudo-body').each((j, c) => {
      const prazo = prazoDoId($(c).attr('id') || '');
      const preco = moeda($(c).find('span').first().text());
      if (prazo && preco != null) precos[prazo] = preco;
    });
    if (Object.keys(precos).length) linhas.push({ quantidade, precos });
  });

  // === ACABAMENTOS / SERVIÇOS ===
  // Bloco #prodAcab agrupa acabamentos; itens com nome + preço (.opc-row-preco).
  // Heurística de tipo: textos de "serviço" conhecidos (checagem) → 'servico'; senão 'acabamento'.
  $('#prodAcab .opc-row').each((i, el) => {
    const $el = $(el);
    const precoEl = $el.find('.opc-row-preco');
    if (!precoEl.length) return;
    const preco = moeda(precoEl.text());
    if (preco == null) return;
    // nome = primeiro span/label que não é o preço
    let nome = '';
    $el.find('span,label').each((j, s) => {
      const t = $(s).text().trim();
      if (t && !/R\$/.test(t) && !nome) nome = t;
    });
    nome = nome.replace(/\s+/g, ' ').trim();
    if (!nome) return;
    const dias = (String($el.text()).match(/\+\s*(\d+)\s*dia/i) || [])[1];
    const tipo = /checagem|servi[cç]/i.test(nome) ? 'servico' : 'acabamento';
    acabamentos.push({ nome, preco, tipo, prazo_extra_dias: dias ? parseInt(dias, 10) : 0 });
  });

  return { linhas, acabamentos };
}

// Lista de produtos da página de categoria renderizada: { ref, nome, url }.
function parseListaProdutos(html) {
  const $ = cheerio.load(html);
  const out = [];
  const vistos = new Set();
  $('.card-produto').each((i, el) => {
    const $card = $(el);
    const nome = $card.find('.produto--nome').first().text().trim();
    const refMatch = $card.find('.produto--detalhes').text().match(/Ref\.?:?\s*([A-Za-z0-9]+)/i);
    const ref = refMatch ? refMatch[1].toLowerCase() : null;
    // url: o link "Comprar" (a.sg-botao) é o último filho do card; buscar DENTRO do card primeiro
    let url = $card.find('a[href*="/p/"]').first().attr('href')
      || $card.closest('a[href*="/p/"]').attr('href');
    if (ref && nome && url && !vistos.has(ref)) {
      vistos.add(ref);
      out.push({ ref, nome, url });
    }
  });
  return out;
}

module.exports = { parseTabelaPreco, parseListaProdutos, moeda, inteiro, prazoDoId };
