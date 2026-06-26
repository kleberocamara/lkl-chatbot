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

module.exports = { FLUXO, FASE_LABEL, proximaFase };
