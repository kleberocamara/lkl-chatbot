# Limpar legado do dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remover o código legado V1 (cluster de Orçamentos V1 + página/funções de Usuários antiga + label morto) de `public/dashboard.html`, sem quebrar o V2.

**Architecture:** Só `public/dashboard.html`. Remoções cirúrgicas por âncoras de string + verificação de "zero referências" após cada uma. Sem backend.

**Backup já feito:** `/root/backups/backup_pedidos_orcamentos_20260625_090700.sql` (VPS) e `backups/…` (local). Dados intactos — esta limpeza é só de código frontend.

**Fatos verificados:**
- `#orcBody` NÃO existe no DOM → `loadOrcamentos` (V1) é morto.
- `currentOrcId` só é referenciado dentro do cluster V1.
- `deleteUser`/`toggleUser` só são chamados pela página `#page-users` (a nova usa `toggleUserActive`/`openEditUser2`).
- `#page-users` não está no `NAV` nem em `showPage('users')`.
- MANTER: `openEditUser`, `saveEditUser`, `#editUserModal` (reusados por `openEditUser2`), `loadUsuarios2`, `loadOrcamentosMain`, `#page-orcamentos`.
- Deploy: `rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html`.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:** só `public/dashboard.html`.

---

### Task 1: Remover o cluster V1 de Orçamentos

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Remover o bloco JS do cluster V1**

Remover o bloco contíguo que vai do comentário `// ── ORÇAMENTOS ──` + `let orcamentosData = [];` até o fim de `salvarCriarOrcamento`, imediatamente ANTES de `// ── TABELA DE PREÇOS ──`. Para localizar:
```bash
grep -n "// ── ORÇAMENTOS\|let orcamentosData\|// ── TABELA DE PREÇOS\|async function loadPrices" public/dashboard.html
```
Apagar tudo entre (inclusive) a linha `let orcamentosData = [];` (e o comentário `// ── ORÇAMENTOS ──` acima dela, se houver) e a linha imediatamente anterior a `// ── TABELA DE PREÇOS ──`. As funções removidas: orcamentosData, currentOrcId, ORC_STATUS_V1, loadOrcamentos, updateOrcBadge, openOrcModal, renderOrcItensModal, orcGetItens, orcRecalc, orcUpdateTotals, orcRemoveItem, orcAddItem, orcRecalcCustom, orcGetDesconto, salvarOrcamento, aprovarOrcamento, enviarOrcamento, cancelarOrcamento, abrirCriarOrcamento, adicionarItemCriar, recalcCriar, salvarCriarOrcamento. NÃO apagar `loadPrices` nem o comentário de Preços.

- [ ] **Step 2: Remover os modais V1 no DOM**

Remover os dois blocos de modal:
- `<div id="orcModal" ...> ... </div>` (o modal de visualizar/aprovar orçamento V1).
- `<div id="criarOrcModal" ...> ... </div>` (o modal de criar orçamento V1).
Localizar com `grep -n 'id="orcModal"\|id="criarOrcModal"' public/dashboard.html` e apagar cada `<div>...</div>` completo (atenção ao fechamento correto de cada modal).

- [ ] **Step 3: Remover o botão "➕ Orçamento" dos Pedidos**

Localizar e remover a linha que faz push do botão que chama `abrirCriarOrcamento`:
```bash
grep -n "abrirCriarOrcamento" public/dashboard.html
```
Apagar a linha `btns.push(\`<button ... onclick="abrirCriarOrcamento(...)">➕ Orçamento</button>\`);` (a referência externa ao cluster). Após isso, `abrirCriarOrcamento` não deve mais existir nem ser referenciado.

- [ ] **Step 4: Verificar zero referências**

```bash
grep -nE "loadOrcamentos\b|ORC_STATUS_V1|openOrcModal|abrirCriarOrcamento|salvarOrcamento|salvarCriarOrcamento|aprovarOrcamento|enviarOrcamento|cancelarOrcamento|orcAddItem|orcRemoveItem|renderOrcItensModal|updateOrcBadge|orcamentosData|currentOrcId|id=\"orcModal\"|id=\"criarOrcModal\"|adicionarItemCriar|recalcCriar|orcGetItens|orcRecalc|orcUpdateTotals|orcRecalcCustom|orcGetDesconto" public/dashboard.html
```
Expected: **nenhuma linha** (todos removidos). Se algo aparecer, é referência viva remanescente — investigar antes de prosseguir. (Confirmar que `loadOrcamentosMain` — V2 — continua presente: `grep -c "loadOrcamentosMain" public/dashboard.html` ≥ 1.)

- [ ] **Step 5: Sanidade de `<script>` / chaves**

Conferir que o arquivo não ficou com `<div>`/`<script>` desbalanceado: `grep -c "<script" public/dashboard.html` e re-ler o entorno das remoções (o fim do cluster deve emendar limpo no `// ── TABELA DE PREÇOS ──`).

- [ ] **Step 6: Deploy + verificação visual**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
No painel: abrir a aba **Orçamentos** (V2) e confirmar que carrega e os botões funcionam; abrir **Pedidos** e confirmar que NÃO há mais "➕ Orçamento" e a tela funciona; abrir uma OS. Sem erros no console. Reportar.

- [ ] **Step 7: Commit**

```bash
git add public/dashboard.html
git commit -m "chore(ui): remover cluster legado V1 de Orçamentos (funções + modais + botão)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Remover Usuários V1 + label morto + corrigir refresh

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Remover a página antiga `#page-users`**

Localizar `grep -n 'id="page-users"' public/dashboard.html` e apagar o `<div class="page" id="page-users"> ... </div>` completo (inclui o botão `createUser()` e a tabela `#usersBody`).

- [ ] **Step 2: Remover as funções V1 de usuários**

Apagar as definições de `loadUsers`, `createUser`, `deleteUser`, `toggleUser` (localizar com `grep -n "async function loadUsers\|async function createUser\|async function deleteUser\|async function toggleUser" public/dashboard.html`). MANTER `openEditUser`, `saveEditUser` (e qualquer `toggleUserActive`/`openEditUser2`/`loadUsuarios2`).

- [ ] **Step 3: Remover a entrada `users:` do dict `loaders`**

No `const loaders = { ... }`, apagar a linha `users:        loadUsers,`. (Manter `usuarios: loadUsuarios2`.)

- [ ] **Step 4: Corrigir o refresh em `saveEditUser`**

Em `saveEditUser`, trocar a chamada de refresh `loadUsers();` por `loadUsuarios2();` (após salvar, atualiza a lista da página nova).

- [ ] **Step 5: Remover o label morto `rascunho`**

No objeto `ORC_STATUS`, apagar a linha `rascunho: { label: 'Rascunho (legado)', ... },` (e o comentário "// legado congelado" logo acima, se existir).

- [ ] **Step 6: Verificar zero referências**

```bash
grep -nE "id=\"page-users\"|function loadUsers\b|loadUsers\(|function createUser|createUser\(|function deleteUser|deleteUser\(|function toggleUser\b|toggleUser\(|users:\s*loadUsers|'Rascunho \(legado\)'|rascunho:" public/dashboard.html
```
Expected: **nenhuma linha** (tudo removido; `saveEditUser` agora chama `loadUsuarios2`). Confirmar que `loadUsuarios2`, `openEditUser`, `saveEditUser`, `openEditUser2`, `toggleUserActive` CONTINUAM presentes (`grep -c`).

- [ ] **Step 7: Deploy + verificação**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
No painel: Configurações → **Usuários** (página nova) — editar um usuário e confirmar que a lista atualiza; ativar/desativar; criar/editar. Sem erros no console. Reportar.

- [ ] **Step 8: Commit**

```bash
git add public/dashboard.html
git commit -m "chore(ui): remover Usuários V1 (página/funções) + label rascunho morto; refresh→loadUsuarios2

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Atualizar memória

**Files:**
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Registrar**

"UI — limpar legado (direção C): CONCLUÍDO — 2026-06-24. Backup em /root/backups/backup_pedidos_orcamentos_20260625_090700.sql (VPS) + backups/ (local). Removidos de dashboard.html: cluster V1 de Orçamentos (loadOrcamentos/ORC_STATUS_V1/openOrcModal/abrirCriarOrcamento/salvarOrcamento etc. + modais #orcModal/#criarOrcModal + botão '➕ Orçamento' dos Pedidos), página/funções Usuários V1 (#page-users, loadUsers/createUser/deleteUser/toggleUser, loader users:), label morto 'Rascunho (legado)' em ORC_STATUS. Mantidos: openEditUser/saveEditUser/#editUserModal (reusados por openEditUser2), loadUsuarios2, loadOrcamentosMain. Corrigido: saveEditUser refresh loadUsers→loadUsuarios2. Restam direções: B (menu colapsável) e D (modais enxutos)."

- [ ] **Step 2: Sem commit** (memória fora do git).

---

## Notas de verificação final

- A maior fonte de risco é a deleção do bloco contíguo (Task 1 Step 1) — usar o `loadPrices`/`// ── TABELA DE PREÇOS ──` como âncora de fim e o `let orcamentosData` como âncora de início.
- Após tudo, o grep das duas listas de símbolos removidos deve dar vazio, e as funções V2 (loadOrcamentosMain, loadUsuarios2, openEditUser, saveEditUser) devem continuar presentes.
- Se algo quebrar visualmente, reverter é `git revert` do commit correspondente (dados já têm backup à parte).
