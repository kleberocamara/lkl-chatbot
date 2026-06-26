# Gate de Arte por item do orçamento (antes da geração da OS) — Design

**Data:** 2026-06-25
**Contexto:** Sub-projeto 1 do processo de produção. Hoje a aprovação de arte acontece DENTRO da OS (`ordens_servico.status` = `arte_final` → `aguardando_aprovacao_arte` → `impressao`), e a OS de Comunicação Visual é **auto-criada na aprovação do orçamento** (`orcamentos/service.js:239,459`). A LKL quer que o cliente **valide a arte antes da OS existir/entrar em produção**. Decisões do usuário: arte fica no **orçamento, por item**; "Gerar OS" offset segue **manual** (só habilita itens com arte aprovada); CV deixa de auto-gerar na aprovação do orçamento e passa a gerar **quando a arte do item é aprovada**.

Este sub-projeto é pré-requisito do Sub-projeto 2 (board de produção de 4 fases) — a OS chega ao board já com arte aprovada.

## Estado atual verificado

- `orcamento_itens`: tem produto, especificacao, tipo_producao, quantidade, largura/altura, material_id, tem_arte. **Não** tem campos de arte.
- Arte hoje: `os/service.js enviarArte(osId,{arquivo_url})` (exige OS em `arte_final`) faz upload + WhatsApp imagem; `processarRespostaArte(phone,msg)` casa a OS pendente por `status='aguardando_aprovacao_arte'` + celular do cliente, e ao aprovar muda a OS para `impressao`. Upload via multer em `os/router.js` (`/uploads/artes`). PWA `public/pwa/arte_final.html`.
- OS CV: `orcamentos/service.js` chama `osService.criarOSComunicacaoVisual(id)` ao **aprovar** o orçamento (linhas 239 e 459). OS offset: `criarOSOffset` manual via `os/router.js:68` (admin "Gerar OS"); itens elegíveis por `itensOffsetDisponiveis` (`orc.status='aprovado' AND oi.tipo_producao='OFFSET' AND NOT EXISTS os_itens`).
- `STATUS_VALIDOS` da OS inclui `arte_final`, `aguardando_aprovacao_arte` (serão aposentados do fluxo no Sub-projeto 2).

## Modelo de dados (migration)

Adicionar a `orcamento_itens`:
- `arte_status` TEXT NOT NULL DEFAULT `'pendente'` — valores: `pendente | enviada | aprovada | reprovada`.
- `arte_arquivo_url` TEXT NULL
- `arte_enviada_em` TIMESTAMPTZ NULL
- `arte_aprovada_em` TIMESTAMPTZ NULL
- `arte_comentario` TEXT NULL (motivo de reprovação / observação do cliente)

Sem enum no banco (TEXT + validação na aplicação), seguindo o padrão atual do projeto.

## Fluxo

1. **Orçamento aprovado.** Não dispara mais a criação automática de OS CV.
2. **Equipe anexa arte por item** (tela "Artes"): upload do arquivo → `enviarArteItem(orcItemId, arquivo_url)`: grava `arte_arquivo_url`, `arte_status='enviada'`, `arte_enviada_em=NOW()`, e envia ao cliente (imagem + texto WhatsApp referenciando **Pedido #N**, item/produto). Reaproveita o multer/upload atual.
3. **Cliente responde** (palavra-chave WhatsApp APROVADO/ajuste, ou link): `responderArteItem`:
   - Aprovado → `arte_status='aprovada'`, `arte_aprovada_em=NOW()`. Se o item é **CV**, dispara `criarOSComunicacaoVisual` para aquele orçamento/item (gateado: só itens com arte aprovada).
   - Reprovado/ajuste → `arte_status='reprovada'`, `arte_comentario=<texto>`; notifica a equipe (FCM) para refazer a arte.
   - O matching do WhatsApp inbound passa a procurar **itens de orçamento com `arte_status='enviada'`** do cliente (por celular), no lugar de OS em `aguardando_aprovacao_arte`.
4. **Gerar OS (offset, manual):** `itensOffsetDisponiveis` ganha `AND oi.arte_status='aprovada'`. Só itens com arte aprovada aparecem para gerar OS. `criarOSOffset` valida o mesmo no SELECT de validação.
5. **OS nasce em produção** sem etapas de arte. (As fases CORTE/IMPRESSÃO/… são o Sub-projeto 2; aqui a OS continua nascendo em `aguardando` provisoriamente até o Sub-projeto 2 trocar o status inicial.)

## Componentes

- **Migration** (`db/migrations/0xx_arte_por_item.sql` no padrão do projeto): as 5 colunas.
- **Serviço de arte (orçamento):** `enviarArteItem`, `responderArteItem` em `src/modules/orcamentos/service.js` (ou um `src/modules/artes/`), + helper de matching por celular.
- **Router:** endpoints `POST /api/v2/orcamentos/:id/itens/:itemId/arte` (upload multipart) e o reaproveitamento do webhook WhatsApp inbound para `responderArteItem`.
- **Gate de OS:** ajustar `itensOffsetDisponiveis` + `criarOSOffset` (offset) e mover o disparo de `criarOSComunicacaoVisual` da aprovação do orçamento (remover linhas 239/459) para a aprovação de arte do item CV.
- **WhatsApp inbound:** reapontar o handler que hoje chama `processarRespostaArte` (OS) para `responderArteItem` (item). Localizar onde o inbound roteia respostas de arte.
- **UI:** tela/aba "Artes" no painel (lista de itens de orçamento aprovado com `arte_status`, upload, reenviar, ver comentário) — pode evoluir `public/pwa/arte_final.html` ou um bloco no `dashboard.html`. (Layout detalhado no plano.)

## Aposentadoria / compatibilidade

- `enviarArte`/`processarRespostaArte` no nível da OS deixam de ser o caminho do cliente; manter as funções por ora (não quebrar), mas o inbound passa a usar o de item. Limpeza dos status `arte_final`/`aguardando_aprovacao_arte` fica para o Sub-projeto 2.
- OS já existentes não são afetadas; o gate vale para novas gerações.

## Tratamento de erros

- Upload sem arquivo → 400. Item inexistente/!aprovado → 404/400.
- Resposta de cliente sem item `enviada` pendente → ignora (retorna null), igual ao comportamento atual.
- CV: se `criarOSComunicacaoVisual` falhar na aprovação da arte, logar e não bloquear a aprovação (idêntico ao `.catch` atual).

## Testes

- **Unit:** máquina de transição de `arte_status` (pendente→enviada→aprovada/reprovada; reprovada→enviada de novo); o gate `itensOffsetDisponiveis` só retorna itens `arte_status='aprovada'` (com fixture/instância de teste do serviço, ou teste de query).
- **Smoke VPS:** num orçamento aprovado de teste — `enviarArteItem` (status→enviada), `responderArteItem` aprovado (status→aprovada; CV gera OS), conferir que offset só aparece em "Gerar OS" após aprovação.

## Fora de escopo (Sub-projeto 2)

- Board de 4 fases (CORTE/IMPRESSÃO/ACABAMENTO/ENTREGA por tipo), histórico append-only, aba Concluídas com timeline, aposentar status de arte da OS.
