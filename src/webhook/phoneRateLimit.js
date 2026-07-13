// Limite de mensagens por telefone dentro de uma janela fixa. O rate limit do Express
// (src/app.js) é por rota/IP — como todas as mensagens do WhatsApp chegam pelos servidores
// da Meta (mesmas faixas de IP pra todo mundo), ele não distingue um número abusando do
// bot de outro qualquer. Cada mensagem processada pelo agente custa uma chamada à OpenAI,
// então um único número girando mensagens rápido demais consome o orçamento de todos.
const WINDOW_MS = 60000;
const MAX_POR_JANELA = 20;

const contadores = new Map(); // phone -> { count, resetAt }

function excedeuLimite(phone) {
  const agora = Date.now();
  const entry = contadores.get(phone);
  if (!entry || agora >= entry.resetAt) {
    contadores.set(phone, { count: 1, resetAt: agora + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_POR_JANELA;
}

// Evita crescimento indefinido do Map em produção de longa duração.
setInterval(() => {
  const agora = Date.now();
  for (const [phone, entry] of contadores) {
    if (agora >= entry.resetAt) contadores.delete(phone);
  }
}, WINDOW_MS).unref();

module.exports = { excedeuLimite, _WINDOW_MS: WINDOW_MS, _MAX_POR_JANELA: MAX_POR_JANELA, _contadores: contadores };
