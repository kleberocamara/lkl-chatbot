/**
 * Configuração centralizada do sidebar — M10-A
 * Cada item define: id, label, icon, roles permitidos, e opcionalmente children.
 * 'section' é apenas um agrupador visual (sem rota própria).
 */
const NAV_CONFIG = [
  {
    id: 'dashboard', label: 'Dashboard', icon: '📊',
    roles: ['admin','gestor','financeiro','atendente','analista','operador'],
    view: 'dashboard'
  },
  {
    id: 'atendimento', label: 'Atendimento', icon: '🎧', section: true,
    roles: ['admin','gestor','atendente'],
    children: [
      { id: 'conversas',  label: 'Conversas',  icon: '💬', roles: ['admin','gestor','atendente'], view: 'conversas' },
      { id: 'orcamentos', label: 'Orçamentos', icon: '📋', roles: ['admin','gestor','atendente'], view: 'orcamentos' },
      { id: 'pedidos',    label: 'Pedidos',    icon: '🛒', roles: ['admin','gestor','atendente'], view: 'pedidos' },
    ]
  },
  {
    id: 'operacao', label: 'Operação', icon: '⚙️', section: true,
    roles: ['admin','gestor','analista','operador'],
    children: [
      { id: 'os',         label: 'Ordens de Serviço', icon: '📝', roles: ['admin','gestor','analista'], view: 'os' },
      { id: 'arte_final', label: 'Arte Final',         icon: '🎨', roles: ['admin','gestor','analista'], view: 'arte_final' },
      { id: 'producao',   label: 'Produção',           icon: '🏭', roles: ['admin','gestor','analista','operador'], view: 'producao' },
      { id: 'entregas',   label: 'Motorista / Entregas', icon: '🚚', roles: ['admin','gestor','analista','operador'], view: 'entregas' },
    ]
  },
  {
    id: 'financeiro', label: 'Financeiro', icon: '💰', section: true,
    roles: ['admin','gestor','financeiro','atendente'],
    children: [
      { id: 'contas_pagar',   label: 'Contas a Pagar',        icon: '📤', roles: ['admin','gestor','financeiro','atendente'], view: 'contas_pagar' },
      { id: 'cobrancas',      label: 'Cobranças / Boletos / PIX', icon: '💳', roles: ['admin','gestor','financeiro'], view: 'cobrancas' },
      { id: 'analises',       label: 'Análises Gerenciais',   icon: '📈', roles: ['admin','gestor','financeiro'], view: 'analises' },
    ]
  },
  {
    id: 'fiscal', label: 'Fiscal', icon: '🧾', section: true,
    roles: ['admin','gestor','financeiro'],
    children: [
      { id: 'nfe', label: 'NF-e', icon: '📄', roles: ['admin','gestor','financeiro'], view: 'nfe' },
    ]
  },
  {
    id: 'cadastros', label: 'Cadastros', icon: '🗂️', section: true,
    roles: ['admin','gestor','analista','atendente'],
    children: [
      { id: 'clientes',    label: 'Clientes',    icon: '👥', roles: ['admin','gestor','analista','atendente'], view: 'clientes' },
      { id: 'fornecedores',label: 'Fornecedores',icon: '🏢', roles: ['admin','gestor','analista','atendente'], view: 'fornecedores' },
      { id: 'usuarios',    label: 'Usuários',    icon: '👤', roles: ['admin','gestor','analista','atendente'], view: 'usuarios' },
    ]
  },
  {
    id: 'configuracoes', label: 'Configurações', icon: '⚙️',
    roles: ['admin'],
    view: 'configuracoes'
  },
];

// Retorna apenas itens/seções visíveis para o role do usuário logado
function filtrarNav(role) {
  return NAV_CONFIG
    .filter(item => item.roles.includes(role))
    .map(item => ({
      ...item,
      children: item.children
        ? item.children.filter(c => c.roles.includes(role))
        : undefined
    }))
    .filter(item => !item.section || (item.children && item.children.length > 0));
}

// Dado um view id, retorna se o role tem acesso
function temAcesso(viewId, role) {
  for (const item of NAV_CONFIG) {
    if (item.view === viewId && item.roles.includes(role)) return true;
    if (item.children) {
      for (const c of item.children) {
        if (c.view === viewId && c.roles.includes(role)) return true;
      }
    }
  }
  return false;
}

// Acesso especial: atendente em contas_pagar só pode cadastrar manualmente
function acessoRestrito(viewId, role) {
  if (viewId === 'contas_pagar' && role === 'atendente') return 'somente_cadastro';
  return 'completo';
}
