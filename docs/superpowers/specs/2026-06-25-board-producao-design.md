# Board de Produção (4 fases por tipo) + histórico — Design

**Data:** 2026-06-25
**Contexto:** Sub-projeto 2 do processo de produção (o Sub-projeto 1 — gate de arte — já garante que a OS chega em produção com arte aprovada). A OS deve tramitar por fases em colunas; concluir uma fase avança automaticamente para a próxima e grava histórico; OS entregues vão para "Concluídas" com timeline.

## Decisões do usuário (2026-06-25)
- Fases **por tipo**: Offset `CORTE → IMPRESSÃO → ACABAMENTO → ENTREGA`; Comunicação Visual `IMPRESSÃO → ACABAMENTO → ENTREGA`. Terminal: `ENTREGUE`.
- Avanço por **botão "Concluir etapa"** no card (não drag).
- ENTREGA: **board pode marcar entregue** (retirada no balcão, sem foto) **e** o motorista confirma com recebedor/foto (fluxo atual).
- Visível em **producao.html (operadores), dashboard (gestão), motorista (entrega)**.
- Substituir os status atuais por fases limpas; **aposentar** `aguardando/arte_final/aguardando_aprovacao_arte/embalagem/pronto` e as funções de arte no nível da OS.

## Estado atual verificado
- `os/service.js`: `STATUS_VALIDOS = ['aguardando','arte_final','aguardando_aprovacao_arte','impressao','acabamento','embalagem','pronto','entregue','cancelado']`. `atualizarStatus(id,novoStatus,...)` valida contra essa lista; `entregar(...)` exige `status='pronto'` e seta `entregue`. `criarOSOffset` cria status `'aguardando'`; `criarOSComunicacaoVisual` idem. `enviarArte`/`processarRespostaArte` (OS-level) ficaram órfãos após o Sub-projeto 1 (inbound já usa `responderArteItem`).
- `producao.html`: lista 1 coluna, abas Em Andamento/Concluídas; `NEXT_STATUS`/`NEXT_LABEL`/`STATUS_LABEL`/`IN_PROGRESS`/`DONE` no JS; `advanceOS(id,next)` faz `PATCH /api/v2/os/:id/status`; polling 30s.
- `motorista.html` + `os/router.js`: `entregar` via `PATCH /os/:id/entregar` (multer foto), exige `status='pronto'`.
- Migrations em `sql/migrations/` (última 041). `ordens_servico` owned por postgres → ALTER via sudo.

## Modelo de fases (state machine por tipo)
Fonte única no backend: `src/constants/fluxoProducao.js`:
```
FLUXO = {
  offset:             ['corte', 'impressao', 'acabamento', 'entrega'],
  comunicacao_visual: ['impressao', 'acabamento', 'entrega'],
}
FASE_LABEL = { corte:'Corte', impressao:'Impressão', acabamento:'Acabamento', entrega:'Entrega', entregue:'Entregue' }
proximaFase(tipo_servico, statusAtual) -> próximo status no array do tipo, ou 'entregue' quando statusAtual==='entrega', ou null se desconhecido/terminal.
```
Status novos da OS: `corte, impressao, acabamento, entrega, entregue, cancelado`. (Aposentados: aguardando/arte_final/aguardando_aprovacao_arte/embalagem/pronto.)

## Migration (042)
- Cria `os_historico (id uuid pk default, os_id uuid fk, de_status text, para_status text, usuario_id uuid null, em timestamptz default now())` + índice por os_id.
- **Remapeia** `ordens_servico.status` existentes:
  - `embalagem` → `entrega`; `pronto` → `entrega`;
  - `arte_final`/`aguardando_aprovacao_arte`/`aguardando` → primeira fase do tipo (`corte` se offset, `impressao` se comunicacao_visual);
  - `impressao`/`acabamento`/`entregue`/`cancelado` → mantêm.
- Sem enum no banco (TEXT + validação na aplicação), padrão do projeto.

## Backend (os/service.js + router + constants)
- `STATUS_VALIDOS` passa a `['corte','impressao','acabamento','entrega','entregue','cancelado']`.
- `avancarFase(osId, userId)`: lê `tipo_servico` + status; calcula `proximaFase`; se null → erro; grava `UPDATE status`, escreve `os_historico(de,para,usuario)`; em transições especiais mantém os timestamps existentes (`data_inicio` na 1ª fase de produção, `data_conclusao` ao virar entregue). Retorna a OS atualizada. Emite FCM/`global.io` como hoje.
- `entregar(...)`: passa a exigir `status='entrega'` (era 'pronto'); grava histórico (`entrega`→`entregue`).
- `criarOSOffset` → status inicial `'corte'`; `criarOSComunicacaoVisual` → `'impressao'` (grava histórico inicial opcional `null→fase`).
- Helper `historico(osId)`: SELECT do `os_historico` ordenado por `em`.
- Endpoints: `PATCH /api/v2/os/:id/avancar` (avancarFase, role operador/admin/gestor/atendente) e `GET /api/v2/os/:id/historico`. Mantém `PATCH /:id/status` para casos administrativos (cancelar etc.), também gravando histórico.
- **Aposentar**: remover `enviarArte`/`processarRespostaArte` do `os/service.js` (e o endpoint de upload de arte da OS em `os/router.js`, se houver) — já não referenciados. Confirmar zero referências antes de remover.

## Frontend
- **producao.html:** aba "Em Andamento" vira board de colunas = união ordenada das fases (`Corte · Impressão · Acabamento · Entrega`); cada OS aparece na coluna do seu `status`; CV não aparece em Corte. Card mostra Pedido #N · OS #N · item, e botão **"✓ Concluir <fase>"** (chama `/avancar`); na coluna Entrega o botão é **"✅ Confirmar entrega"** (→ entregue via `/avancar`, que detecta entrega→entregue). Aba "Concluídas" lista `entregue` com **timeline** (de `/historico`). Remove o `NEXT_STATUS` antigo; o board replica um `FLUXO`/`FASE_LABEL` no JS do front (mesma ordem do backend) para saber a coluna e o rótulo do botão a partir do `status` e do `tipo_servico` da OS. (Front e backend mantêm o FLUXO em sincronia — duplicação aceita, como já fazemos com PRODUTOS_LKL.)
- **dashboard.html:** página "Produção" com o mesmo board (colunas + Concluir), reusando o endpoint `/api/v2/os` + `/avancar`.
- **motorista.html:** ajustar para entregar OS em `status='entrega'` (lista/permite).

## Tratamento de erros
- `avancarFase` em OS terminal (entregue/cancelado) → erro "OS já finalizada".
- `proximaFase` desconhecida → erro claro.
- Histórico é best-effort dentro da mesma transação lógica; falha ao gravar histórico não deve reverter o avanço (log + segue), mas registrar é o caminho normal.

## Testes
- **Unit (`fluxoProducao`):** `proximaFase('offset','corte')==='impressao'`; `('offset','entrega')==='entregue'`; `('comunicacao_visual','impressao')==='acabamento'`; `('comunicacao_visual','entrega')==='entregue'`; terminal/desconhecido → null.
- **Smoke VPS:** criar/escolher OS offset, `avancarFase` corte→impressao→acabamento→entrega→entregue, conferir `os_historico` com 4–5 linhas na ordem; conferir remap da migration (nenhuma OS com status aposentado).
- **Visual:** board nas 3 superfícies; Concluídas com timeline.

## Fora de escopo
- Drag-and-drop (decidido: botão).
- Métricas/tempo por fase (poderá usar `os_historico` depois).
- Reabrir/voltar fase (apenas avanço; correção via `/status` administrativo).
