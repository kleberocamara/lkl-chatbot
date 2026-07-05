const FLUXO = {
  offset:             ['corte', 'impressao', 'acabamento', 'entrega'],
  comunicacao_visual: ['impressao', 'acabamento', 'entrega'],
};

const FASE_LABEL = {
  corte:     'Corte',
  impressao: 'Impressão',
  acabamento: 'Acabamento',
  entrega:   'Entrega',
  entregue:  'Entregue',
};

function proximaFase(tipo_servico, statusAtual) {
  const fases = FLUXO[tipo_servico];
  if (!fases) return null;
  if (statusAtual === 'entrega') return 'entregue';
  const idx = fases.indexOf(statusAtual);
  if (idx === -1 || idx === fases.length - 1) return null;
  return fases[idx + 1];
}

const RANK_PRODUCAO = { em_producao: 1, concluido: 2, entregue: 3 };
const PRE_PRODUCAO = new Set([
  'novo', 'em_orcamento', 'aguardando_aprovacao', 'aprovado',
  'aguardando_pagamento', 'pago',
]);

// Mapeia os status das OS (não canceladas) de um orçamento para o status
// de produção do pedido. Retorna null quando não há OS ativa (no-op).
function pedidoStatusDaOS(statuses) {
  const ativos = (statuses || []).filter(s => s !== 'cancelado');
  if (ativos.length === 0) return null;
  if (ativos.every(s => s === 'entregue')) return 'entregue';
  if (ativos.every(s => s === 'entrega' || s === 'entregue')) return 'concluido';
  return 'em_producao';
}

// Guarda "só avança": produção nunca regride; pré-produção/pagamento sempre
// podem avançar; cancelado/reprovado nunca são tocados.
function podeAvancarPedido(atual, alvo) {
  if (atual === 'cancelado' || atual === 'reprovado') return false;
  if (PRE_PRODUCAO.has(atual)) return true;
  return (RANK_PRODUCAO[alvo] || 0) > (RANK_PRODUCAO[atual] || 0);
}

module.exports = { FLUXO, FASE_LABEL, proximaFase, pedidoStatusDaOS, podeAvancarPedido };
