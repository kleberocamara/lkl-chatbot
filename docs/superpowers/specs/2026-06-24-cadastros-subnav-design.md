# Enxugar menu — Cadastros/NF-e com sub-nav + Usuários em Configurações — Design

**Data:** 2026-06-24
**Contexto:** Segunda ação de "enxugar a interface". O grupo Cadastros do menu tem 7 itens.
Objetivo: aplicar o modelo de "pills" (como nos Orçamentos) para internalizar os cadastros
numa navegação por abas, reduzir o menu lateral e reagrupar itens.

## Objetivo

- **Cadastros:** um único item de menu "Cadastros" que abre uma área com **abas internas**
  (pills): Clientes · Fornecedores · Materiais · Funcionários · Máquinas.
- **NF-e:** a página NF-e ganha abas **Emissão · Entrada NF-e** (a antiga "Entrada NF-e" deixa
  de ser item de menu).
- **Usuários:** sai do grupo Cadastros e vira subitem de menu na seção **Configurações**.

## Decisões (confirmadas com o usuário)

1. Máquinas entra como 5ª aba interna em Cadastros.
2. Usuários = subitem de menu sob Configurações (não vira pill).
3. Entrada NF-e vira aba dentro de NF-e.

## Abordagem (baixo risco — sem mover blocos grandes de HTML)

As páginas existentes (`#page-clientes`, `#page-fornecedores`, `#page-materiais`,
`#page-funcionarios`, `#page-maquinas`, `#page-nfe`, `#page-entradas`) **permanecem onde
estão**. Adiciona-se uma **barra de pills** no topo de cada uma; cada pill chama
`showPage('<id>')`. O usuário percebe uma área única "Cadastros" (e uma NF-e com 2 abas), mas
internamente continua sendo a troca de página já existente — nenhuma função `load*` muda.

### Estado atual verificado (`public/dashboard.html`)

- Cada cadastro é um `.page` próprio com `load*` no dict `loaders` de `showPage`:
  `clientes→loadClientesMain(1)`, `fornecedores→loadFornecedoresMain(1)`,
  `materiais→loadMateriaisMain(1)`, `funcionarios→loadFuncionariosMain(1)`,
  `maquinas→loadMaquinasMain(1)`, `entradas→loadEntradasMain()`, `nfe→loadNfeMain()`,
  `usuarios→loadUsuarios2`, `settings→loadSettings`.
- `NAV` é um array de itens/seções com `roles`; o sidebar é renderizado filtrando por role.
- `showPage(id)` ativa a `.page#page-<id>` e chama `loaders[id]`.

## Mudanças (só `public/dashboard.html`)

### a) Sub-nav compartilhada (pills)

Definir os grupos e um renderizador:
```js
const SUBNAV = {
  cadastros: [
    { id: 'clientes',     label: 'Clientes',     roles: ['admin','gestor','analista','atendente'] },
    { id: 'fornecedores', label: 'Fornecedores', roles: ['admin','gestor','analista','atendente'] },
    { id: 'materiais',    label: 'Materiais',    roles: ['admin','gestor','analista'] },
    { id: 'funcionarios', label: 'Funcionários', roles: ['admin','gestor'] },
    { id: 'maquinas',     label: 'Máquinas',     roles: ['admin','gestor'] },
  ],
  nfe: [
    { id: 'nfe',      label: 'Emissão',      roles: ['admin','gestor','financeiro'] },
    { id: 'entradas', label: 'Entrada NF-e', roles: ['admin','gestor'] },
  ],
};
const PAGE_GROUP = { clientes:'cadastros', fornecedores:'cadastros', materiais:'cadastros', funcionarios:'cadastros', maquinas:'cadastros', nfe:'nfe', entradas:'nfe' };

function renderSubnav(pageId) {
  const group = PAGE_GROUP[pageId];
  const host = document.getElementById('subnav-host-' + pageId);
  if (!group || !host) return;
  const role = (currentUser && currentUser.role) || '';
  const itens = SUBNAV[group].filter(it => !it.roles || it.roles.includes(role) || role === 'admin');
  host.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">` +
    itens.map(it => `<button class="btn ${it.id===pageId?'btn-primary':'btn-outline'}" onclick="showPage('${it.id}')">${it.label}</button>`).join('') +
    `</div>`;
}
```
(Confirmar o nome real da variável de usuário/role — ler como o NAV filtra roles; usar a mesma fonte.)

- Adicionar `<div id="subnav-host-<pageId>"></div>` no topo do conteúdo de cada uma das 7
  páginas (logo após o `page-header`/título).
- Em `showPage(id)`, após ativar a página e antes/depois de chamar o loader, chamar
  `renderSubnav(id)`.

### b) NAV — enxugar o menu

No array `NAV`:
- **Grupo Cadastros:** substituir os 7 filhos por **um único** item:
  `{ id: 'clientes', label: 'Cadastros', icon: '🗂️', roles: ['admin','gestor','analista','atendente'] }`
  (aponta para a página Clientes, que já mostra as pills do grupo). Remover os itens
  `fornecedores`, `materiais`, `funcionarios`, `maquinas`, `entradas`, `usuarios` do grupo.
- **Fiscal:** manter só `{ id:'nfe', label:'NF-e' }` (a Entrada vira pill dentro de NF-e).
- **Configurações:** criar uma seção no sidebar agrupando Configurações + Usuários:
  ```js
  { section: 'Configurações', roles: ['admin'], children: [
    { id: 'settings', label: 'Configurações', icon: '⚙️', roles: ['admin'] },
    { id: 'usuarios', label: 'Usuários',      icon: '👤', roles: ['admin','gestor','analista','atendente'] },
  ]},
  ```
  Remover o item `settings` avulso anterior (ele passa a viver nessa seção). Manter `prices`
  (Preços) onde está, ou mover para a seção Configurações se fizer sentido (decisão: manter
  como está para não ampliar o escopo).

## Comportamento

- Clicar "Cadastros" no menu → abre Clientes com as pills (Clientes ativo). Trocar de pill →
  `showPage` troca a página e a pill ativa acompanha (cada página re-renderiza sua sub-nav).
- Clicar "NF-e" → abre Emissão com pills [Emissão][Entrada]. Entrada NF-e acessível pela pill.
- Pills respeitam `roles`: quem não tem acesso a Funcionários/Máquinas/Entrada não vê a pill.

## Erros & testes

- Sem backend; verificação visual: menu mostra "Cadastros" único + seção Configurações com
  Usuários; abrir Cadastros e alternar as 5 pills (cada lista carrega); NF-e com Emissão/Entrada;
  Usuários e Configurações acessíveis pela seção Configurações.
- Conferir que pills somem conforme o papel do usuário logado.

## Fora de escopo

- Mover fisicamente o HTML das páginas (mantém-se a abordagem de pills + showPage).
- Direções C (limpar legado) e D (modais enxutos) — futuras.
