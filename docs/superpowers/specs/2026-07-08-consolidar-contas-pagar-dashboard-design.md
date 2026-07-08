# Consolidar Contas a Pagar — migrar financeiro.html pra dentro do dashboard.html

## Contexto

`public/pwa/financeiro.html` é uma PWA standalone completa (KPIs, filtros por prazo, CRUD de conta com sugestão automática de tipo de despesa, fluxo completo de Lote C6 Bank com carrinho, histórico de lotes). `public/dashboard.html` tem uma view `page-contas_pagar` que nunca foi terminada — mostra só uma lista simples (sem KPIs, sem filtros, sem Nova Conta, sem Lote C6 funcional) e nunca foi linkada a partir do `financeiro.html`. As duas implementações evoluíram desconectadas: toda a automação construída nesta sessão (taxonomia de 38 tipos, classificação automática, badges de origem) só chegou no `financeiro.html`.

Decisão: consolidar tudo em `dashboard.html` (onde o usuário realmente navega) e deixar o `financeiro.html` órfão no disco (sem apagar, sem nenhum link apontando pra ele).

## Escopo

- Migrar HTML+CSS+JS completos do `financeiro.html` pra dentro de `page-contas_pagar` em `dashboard.html`: KPIs, chips de filtro, toolbar (Nova Conta/Sincronizar DDA/Reconciliar), tabela principal com seleção por checkbox, modal de Nova/Editar Conta (com sugestão automática por fornecedor), aba Lote C6 completa (seleção, carrinho, steps de validação/aprovação no C6, histórico de lotes).
- Remover o botão temporário `✏️` (que hoje abre `/pwa/financeiro.html` numa aba nova) e o `loadContasPagar()`/`cpPagar`/`cpCancelar` simplificados atuais — são substituídos pela versão completa migrada.
- **Fora de escopo**: qualquer outra página do `/pwa/` (admin.html, orcamentos.html, pedidos.html, motorista.html, producao.html, arte_final.html, login.html) — atendem papéis específicos sem equivalente no dashboard, não são tocadas.
- **Fora de escopo**: apagar `financeiro.html` do disco/servidor — fica órfão, intocado.

## Design técnico

**Namespacing:** todo elemento/função migrado ganha prefixo `cp` (contas-pagar) pra não colidir com outras views do dashboard, que é um único arquivo grande com dezenas de páginas coexistindo no mesmo DOM/escopo global. Exemplos: `#f-descricao` → `#cp-f-descricao`; `carregarKPIs()` → `cpCarregarKPIs()`; `renderTabela()` → `cpRenderTabela()`; `modal-nova` → `cp-modal-nova`. As duas funções já existentes `cpPagar`/`cpCancelar` (criadas na sessão anterior) são substituídas pelas versões completas vindas do `financeiro.html` (mesmo nome, comportamento mais completo — usam o modal e KPIs reais em vez de recarregar só a lista).

**Adaptação do helper de API:** `financeiro.html` usa `api(method, path, body)` com token via `Authorization: Bearer`. `dashboard.html` usa `api(url, options)` com `credentials: 'include'` (cookie de sessão, sem Bearer token) e trata 401 redirecionando pra `/login` (não `/pwa/login.html`). Toda chamada migrada troca de `api('GET', '/contas-pagar/kpis')` pra `api('/api/v2/contas-pagar/kpis')`, e `api('POST', '/x', body)` pra `api('/api/v2/x', { method: 'POST', body: JSON.stringify(body) })` — usando o `api()` que já existe em `dashboard.html`, sem criar um segundo helper.

**CSS:** as classes específicas do `financeiro.html` que não existem em `dashboard.html` (`.kpi`, `.chip`, `.badge-*`, `.modal-bg`/`.modal` no formato do financeiro, `.carrinho`, `.steps`) são adicionadas à tag `<style>` global do `dashboard.html`, prefixadas `cp-` quando o nome genérico (`.modal`, `.badge`) já é usado por outra parte do dashboard com estilo diferente — checar colisão antes de cada classe nova ser adicionada, renomeando se necessário.

**Navegação:** a estrutura de abas (`Visão Geral` / `Lote C6 Bank`) do `financeiro.html` vira as sub-abas já existentes em `dashboard.html` (`btn-cp-lote`/`showSubPage`), reaproveitando o mecanismo atual (`cp-lista`/`cp-lote`/`cp-historico`) em vez de recriar um sistema de abas novo. A aba "Histórico" que já existe separadamente em `dashboard.html` (`cp-historico`, com `loadHistoricoLotes()` já funcional) passa a viver dentro da mesma área da aba "Lote C6" do jeito que está no `financeiro.html` (lá, o histórico aparece embaixo do carrinho, na mesma aba) — **decisão**: manter as 3 sub-abas do dashboard como estão hoje (Lista / Lote C6 / Histórico, cada uma sua própria aba), só preenchendo o conteúdo de "Lote C6" com o fluxo completo (seleção+carrinho+steps) e deixando "Histórico" com o `loadHistoricoLotes()` que já existe e já funciona — não precisa duplicar a tabela de histórico dentro da aba Lote C6 como o financeiro.html faz.

## Testes

Sem suíte automatizada pra HTML/JS de UI neste projeto (mesmo padrão da Task 13 anterior). Verificação via:
1. Parse check de sintaxe JS (`new Function(...)` sobre o conteúdo do `<script>`).
2. Leitura cuidadosa comparando cada função migrada contra o original.
3. Smoke test manual do usuário após deploy (like a sessão já vem fazendo).

## Fora de escopo

- Testes automatizados de UI (não há infraestrutura pra isso no projeto).
- Apagar `financeiro.html`.
- Tocar em qualquer outra página do `/pwa/`.
