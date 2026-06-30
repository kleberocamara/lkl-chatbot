const { chromium } = require('playwright');

const BASE = 'https://sistema.graficonauta.com.br';

function cookiesFromHeader(header) {
  return String(header || '').split(';').map(p => p.trim()).filter(Boolean).map(p => {
    const i = p.indexOf('=');
    return { name: p.slice(0, i), value: p.slice(i + 1), domain: 'sistema.graficonauta.com.br', path: '/' };
  });
}

// Abre um contexto autenticado pelo cookie (REVENDA_GRAFICONAUTA_COOKIE) e executa fn(page).
// O site é um SPA Vue: o cookie evita o login (reCAPTCHA v3), o Chromium renderiza o conteúdo.
async function comCookie(fn) {
  const header = process.env.REVENDA_GRAFICONAUTA_COOKIE;
  if (!header) throw new Error('REVENDA_GRAFICONAUTA_COOKIE ausente no .env');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ locale: 'pt-BR' });
    await ctx.addCookies(cookiesFromHeader(header));
    const page = await ctx.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}

function checarLogin(page) {
  if (/\/login(\?|$)/.test(page.url())) throw new Error('Cookie de revenda inválido/expirado (redirecionou para /login)');
}

// HTML da página de categoria, após o Vue renderizar os cards de produto.
async function fetchCategoria(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  checarLogin(page);
  await page.waitForSelector('.card-produto', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return page.content();
}

// HTML da página de produto, após o Vue renderizar a matriz de preço.
async function fetchProduto(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  checarLogin(page);
  await page.waitForSelector('.conteudo-body', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return page.content();
}

module.exports = { comCookie, fetchCategoria, fetchProduto, BASE };
