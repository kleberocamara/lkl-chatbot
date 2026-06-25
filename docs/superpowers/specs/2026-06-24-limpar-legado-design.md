# Limpar legado do dashboard (V1 Orçamentos + Usuários antigo) — Design

**Data:** 2026-06-24
**Contexto:** Direção C do enxugamento. O `public/dashboard.html` acumulou código V1
(legado) coexistindo com o V2 atual. Limpeza conservadora: remover só o que foi **verificado
como órfão/redundante**, mantendo helpers compartilhados.

## Inventário verificado

### Remover (órfão/redundante)
1. **Label morto:** `rascunho: { label:'Rascunho (legado)', ... }` em `ORC_STATUS` (sem uso;
   0 no banco; chatbot não cria mais).
2. **Cluster V1 de Orçamentos (JS):** bloco contíguo de `// ── ORÇAMENTOS ──` /
   `let orcamentosData = [];` até o fim de `salvarCriarOrcamento`, logo antes de
   `// ── TABELA DE PREÇOS ──`. Inclui: `orcamentosData`, `currentOrcId`, `ORC_STATUS_V1`,
   `loadOrcamentos`, `updateOrcBadge`, `openOrcModal`, `renderOrcItensModal`, `orcGetItens`,
   `orcRecalc`, `orcUpdateTotals`, `orcRemoveItem`, `orcAddItem`, `orcRecalcCustom`,
   `orcGetDesconto`, `salvarOrcamento`, `aprovarOrcamento`, `enviarOrcamento`,
   `cancelarOrcamento`, `abrirCriarOrcamento`, `adicionarItemCriar`, `recalcCriar`,
   `salvarCriarOrcamento`. (Renderizam num `#orcBody` inexistente; só entrada externa era o
   botão "➕ Orçamento".)
3. **Modais V1 no DOM:** `<div id="orcModal">…</div>` e `<div id="criarOrcModal">…</div>`.
4. **Botão "➕ Orçamento" nos Pedidos:** a linha `btns.push(...onclick="abrirCriarOrcamento(...)"...)`
   (redundante — o orçamento é auto-criado junto do pedido).
5. **Usuários V1:** página `<div class="page" id="page-users">…</div>`, funções `loadUsers`,
   `createUser`, `deleteUser`, `toggleUser`, e a entrada `users: loadUsers` no dict `loaders`.

### Manter (compartilhado com o V2)
- `openEditUser`, `saveEditUser`, `#editUserModal` (reusados por `openEditUser2`).
- `loadUsuarios2`, `openEditUser2`, `toggleUserActive`, `#page-usuarios` (página nova).
- `loadOrcamentosMain` e `#page-orcamentos` (orçamentos V2 atuais).

### Corrigir
- Em `saveEditUser`, o refresh `loadUsers()` → `loadUsuarios2()` (hoje aponta para a página V1
  removida).

## Verificações de segurança (já feitas)

- `#orcBody` não existe no DOM → `loadOrcamentos` é morto.
- `currentOrcId` só é referenciado dentro do cluster V1.
- `deleteUser`/`toggleUser` só são chamados pela página `#page-users` (a nova usa
  `toggleUserActive`).
- Não há item `users` no `NAV` nem `showPage('users')` → `#page-users` é inalcançável.
- `abrirCriarOrcamento`/`salvarOrcamento`/etc. só têm referências dentro do próprio cluster +
  o botão "➕ Orçamento" (que será removido).

## Critério de "feito sem quebrar"

Após cada remoção, `grep` deve mostrar **zero referências** aos símbolos removidos (fora das
próprias definições removidas). A página deve carregar e: abrir Orçamentos (V2), abrir/editar/
excluir/ativar um Usuário pela página nova, abrir uma OS — tudo funcionando.

## Testes

- Sem backend; verificação visual no painel: Orçamentos V2 ok; Usuários (página nova) — editar
  um usuário e ver a lista atualizar (confirma o refresh repontado); Pedidos sem o botão
  "➕ Orçamento"; nenhum erro no console.
- Sanidade de chaves/`</script>` após as remoções.

## Fora de escopo

- Padronização de chips/botões/modais (parte D do enxugamento) — futura.
- Remoção de eventuais outros mortos não verificados (conservador: só o inventário acima).
