# Cadastros/NF-e com sub-nav + Usuários em Configurações — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enxugar o menu: Cadastros vira um item com pills (Clientes·Fornecedores·Materiais·Funcionários·Máquinas), NF-e ganha pills (Emissão·Entrada), e Usuários vai para a seção Configurações.

**Architecture:** Só `public/dashboard.html`. Mantém as páginas existentes; adiciona uma barra de pills (cada pill = `showPage`) no topo das 7 páginas + enxuga o `NAV`. Sem mover HTML grande, sem backend.

**Tech Stack:** HTML/vanilla-JS. Verificação visual.

**Fatos verificados (`public/dashboard.html`):**
- `currentUser` (global, set em ~880 com `me`) tem `.role`. `buildSidebar(me.role)` monta o menu a partir do array `NAV` (~796), filtrando por `roles`. `showPage(page, el)` (~948) ativa `.page#page-<id>` e chama `loaders[id]`.
- Páginas: `#page-clientes` (629), `#page-fornecedores` (646), `#page-materiais` (663), `#page-funcionarios` (680), `#page-maquinas` (694), `#page-nfe` (616), `#page-entradas` (710). As de cadastro têm `<div class="page-header">` logo após; nfe/entradas têm um header flex.
- `NAV`: seção Fiscal (815), seção Cadastros (818–826, com filhos clientes/fornecedores/materiais/funcionarios/maquinas/entradas/usuarios), `prices` (827), `settings` (828).
- Deploy: `rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html`.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:** só `public/dashboard.html`.

---

### Task 1: Sub-nav (pills) — SUBNAV/renderSubnav + hook no showPage + placeholders

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Adicionar as definições + renderSubnav (JS)**

Próximo às outras constantes/funções de navegação (ex.: perto de `function showPage`), adicionar:
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
  const itens = SUBNAV[group].filter(it => role === 'admin' || !it.roles || it.roles.includes(role));
  host.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
    itens.map(it => `<button class="btn ${it.id===pageId?'btn-primary':'btn-outline'}" style="padding:6px 14px" onclick="showPage('${it.id}')">${it.label}</button>`).join('') +
    '</div>';
}
```

- [ ] **Step 2: Chamar `renderSubnav` no `showPage`**

Em `function showPage(page, el)`, APÓS ativar a página e chamar `loaders[page]` (no fim da função), adicionar:
```js
  renderSubnav(page);
```
(Se houver `return` antecipado, garantir que a chamada acontece quando a página é exibida.)

- [ ] **Step 3: Inserir os placeholders nas 7 páginas**

Inserir `<div id="subnav-host-<id>"></div>` como PRIMEIRO filho dentro de cada `<div class="page" id="page-<id>">` (antes do header):
- `#page-clientes` → `<div id="subnav-host-clientes"></div>`
- `#page-fornecedores` → `<div id="subnav-host-fornecedores"></div>`
- `#page-materiais` → `<div id="subnav-host-materiais"></div>`
- `#page-funcionarios` → `<div id="subnav-host-funcionarios"></div>`
- `#page-maquinas` → `<div id="subnav-host-maquinas"></div>`
- `#page-nfe` → `<div id="subnav-host-nfe"></div>`
- `#page-entradas` → `<div id="subnav-host-entradas"></div>`

Exemplo (clientes):
```html
  <div class="page" id="page-clientes">
    <div id="subnav-host-clientes"></div>
    <div class="page-header">
      <h1>👥 Clientes</h1>
      ...
```

- [ ] **Step 4: Deploy + verificação**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
Abrir Clientes no painel: a barra de pills aparece com Clientes ativo; clicar Fornecedores/Materiais/Funcionários/Máquinas troca a página e a pill ativa acompanha. Em NF-e: pills Emissão/Entrada. (As pills aparecem mesmo antes do enxugamento do menu — Task 2 remove os itens duplicados do menu.) Reportar.

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(ui): sub-nav em pills para Cadastros e NF-e (renderSubnav + placeholders)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Enxugar o NAV (menu lateral)

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Ler o array NAV (796–829)**

```bash
sed -n '796,829p' public/dashboard.html
```

- [ ] **Step 2: Reescrever o grupo Cadastros**

Substituir a seção `{ section: 'Cadastros', ... children: [ ...7 itens... ] }` por um único item (fora de seção ou numa seção "Cadastros" com 1 filho — escolher o que casa com o estilo do NAV):
```js
    { section: 'Cadastros', roles: ['admin','gestor','analista','atendente'], children: [
      { id: 'clientes', label: 'Cadastros', icon: '🗂️', roles: ['admin','gestor','analista','atendente'] },
    ]},
```
(Remove fornecedores, materiais, funcionarios, maquinas, entradas, usuarios desse grupo — eles passam a ser pills ou vão para Configurações/NF-e.)

- [ ] **Step 3: Reescrever Configurações (settings + usuarios)**

Remover o item avulso `{ id: 'settings', label: 'Configurações', ... }` (linha 828) e criar uma seção:
```js
    { section: 'Configurações', roles: ['admin','gestor','analista','atendente'], children: [
      { id: 'settings', label: 'Configurações', icon: '⚙️', roles: ['admin'] },
      { id: 'usuarios', label: 'Usuários',      icon: '👤', roles: ['admin','gestor','analista','atendente'] },
    ]},
```
(Manter `prices` (Preços) onde está.) Garantir que a ordem das seções no array continua coerente (Configurações por último, depois de Preços).

- [ ] **Step 4: Conferir que Fiscal segue só com NF-e**

A seção Fiscal (815) deve continuar com apenas `{ id:'nfe', label:'NF-e', ... }` (a Entrada agora é pill). Nenhuma mudança além de confirmar que `entradas` não está mais no menu.

- [ ] **Step 5: Deploy + verificação**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
No painel: o menu mostra **Cadastros** (único), **NF-e** (sem Entrada avulsa), e uma seção **Configurações** com Configurações + Usuários. Clicar Cadastros abre Clientes com as pills. Conferir com um usuário não-admin (se possível) que as pills/itens respeitam o papel. Reportar.

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(ui): enxugar menu — Cadastros único, Entrada NF-e vira pill, Usuários em Configurações

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Atualizar memória

**Files:**
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Registrar**

"UI — Cadastros/NF-e com sub-nav (pills) + Usuários em Configurações: CONCLUÍDO — 2026-06-24 (enxugar interface). dashboard.html: SUBNAV/PAGE_GROUP/renderSubnav + placeholders #subnav-host-<id> no topo das páginas clientes/fornecedores/materiais/funcionarios/maquinas/nfe/entradas; showPage chama renderSubnav. Pills (cada = showPage) respeitam currentUser.role. NAV enxuto: grupo Cadastros = 1 item 'Cadastros' (→ Clientes); Entrada NF-e saiu do menu (pill dentro de NF-e: Emissão·Entrada); seção Configurações agrupa Configurações + Usuários. Sem mover HTML das páginas. Direções de enxugamento restantes: C limpar legado (ORC_STATUS_V1, 'Rascunho (legado)') + padronizar; D modais de cadastro enxutos."

- [ ] **Step 2: Sem commit** (memória fora do git).

---

## Notas de verificação final

- As pills usam `showPage`, que já carrega a lista via `loaders` — nenhuma função `load*` muda.
- Papel do usuário: `renderSubnav` esconde pills sem permissão (ex.: atendente não vê Funcionários/Máquinas/Entrada). O item de menu "Cadastros" abre Clientes (acessível a todos os papéis do grupo).
- Se `showPage` tiver `return` antes do fim para páginas especiais, garantir que `renderSubnav(page)` roda para as 7 páginas relevantes.
