# Detalhamento dos Cards de Produção — Design

**Data:** 2026-06-27
**Status:** Aprovado para plano

## Objetivo

Ao clicar num card do board de produção, abrir um **modal dedicado e enxuto** que mostra, para o operador da fábrica: o **modelo** (arte aprovada) de cada item, os **materiais e quantidades** a cortar/imprimir, e os **acabamentos** — com destaque para a fase atual da OS. Além disso, **só deixar entrar no board** as OSs Offset que já têm ficha de produção gerada.

## Contexto / Estado atual

- O board (`#page-producao` em `public/dashboard.html`) carrega `GET /api/v2/os?limit=200` e renderiza cards por status (`corte/impressao/acabamento/entrega`) + aba Concluídas.
- Cada card hoje mostra apenas: `OS #`, `ORC #`, badge de tipo, descrição do item, cliente e botão "Concluir [fase]". **Não abre detalhe.**
- `GET /api/v2/os/:id` (`buscarPorId` em `src/modules/os/service.js`) já retorna: ficha (`formato_corte`, `imagens_folha`, `imagens_impressao`, `total_impressoes`, `cores_tintas`, `quantidade`), `maquina_nome`, `operador_nome`, `materiais` (vias com `material_nome`, `cor_papel`, `cores_tintas`, `tipo_impressao`, `cores_frente/verso`, `folhas_a_cortar`, `folhas_total`), `especificacoes` (acabamentos) e `itens`.
- A arte aprovada por item fica em `orcamento_itens.arte_arquivo_url`, no formato `/uploads/artes/<arquivo>`. A pasta `public/` é servida estática (`src/app.js:56`), então a miniatura exibe direto com `<img>`.
- A ficha de produção da OS Offset é preenchida **manualmente** pelo admin no detalhe da OS. OSs Offset sem ficha não deveriam estar em produção.

## Decisões (do brainstorming)

1. **Abertura:** modal dedicado e enxuto, focado em produção (não reaproveitar o detalhe completo da OS).
2. **Conteúdo por fase:** mostrar tudo (corte/impressão/acabamento), **destacando a fase atual**.
3. **Modelo/arte:** **galeria** com a miniatura da arte de **cada item** da OS; clicar amplia em tamanho real.
4. **Gate de entrada no board (Offset):** entra automaticamente quando tem **máquina atribuída E ≥1 via com `folhas_total > 0`**. Antes disso, não aparece no board.
5. **Limpeza:** remover do menu o item órfão "Arte Final" (status `arte_final` foi aposentado na migration 042). "Artes" permanece.

**Premissa:** OS de Comunicação Visual (CV) **sempre** aparece no board — é auto-gerada da arte aprovada e não tem ficha manual de máquina/vias. O gate de máquina+vias vale só para Offset.

## Componentes

### A. Backend — `listar()` (gate)
Adicionar ao SELECT de `listar()` em `src/modules/os/service.js`:
- `os.maquina_id`
- `ficha_pronta` (boolean): `os.maquina_id IS NOT NULL AND EXISTS (SELECT 1 FROM os_materiais m WHERE m.os_id = os.id AND m.folhas_total > 0)`

`tipo_servico` já é retornado. Nenhuma migration.

### B. Backend — `buscarPorId()` (galeria de artes)
No subselect de `itens` de `buscarPorId`, adicionar `oi.arte_arquivo_url` e `oi.arte_status`. Nenhuma migration.

### C. Frontend — gate no board
Em `prodRenderBoard()` (`public/dashboard.html`), ao montar `inProg`, filtrar:
- mostra a OS se `tipo_servico === 'comunicacao_visual'` **OU** `ficha_pronta === true`.
OSs Offset sem ficha simplesmente não entram no board (continuam visíveis na tela "Ordens de Serviço").

### D. Frontend — modal de produção
- Card vira clicável → `prodAbrirCard(osId)`.
- `prodAbrirCard` faz `GET /api/v2/os/:id` e renderiza modal (reusa o `showModal`/`#generic-modal` ou um container próprio, seguindo o padrão do `dashboard.html`):
  - **Cabeçalho:** `OS #<numero_os> · Pedido #<numero_pedido> · <cliente_nome>` + badge da fase atual.
  - **Galeria de artes:** para cada `item` com `arte_arquivo_url`, miniatura (`<img>`), descrição e quantidade; clique amplia (lightbox simples). Itens sem arte mostram placeholder.
  - **Três blocos de fase** (Corte / Impressão / Acabamento), o da fase atual em destaque e os demais esmaecidos:
    - **Corte** (offset): material, formato de corte, folhas a cortar, imagens por folha.
    - **Impressão:** cores/tintas, frente/verso, imagens, total de impressões, máquina/operador.
    - **Acabamento:** lista de `especificacoes`.
  - **Botão "✓ Concluir [fase]"**: chama o mesmo fluxo do `prodAvancar(os.id)` e fecha/atualiza o board.
- Roles: mesmas do board (admin, gestor, operador, atendente, analista). Modal é só leitura + avançar.

### E. Limpeza — remover "Arte Final"
- Remover do `NAV` o item `arte_final`, o `#page-arte_final` e a entrada `arte_final: loadArteFinalMain` no mapa de loaders (`public/dashboard.html`). A função `loadArteFinalMain` e a PWA `arte_final.html` saem do fluxo (PWA permanece no disco, sem link).

## Fora de escopo
- Editar a ficha de produção dentro do modal (continua no detalhe da OS).
- Máquina/ficha para CV.
- Novos campos no banco / migrations.

## Testes
- Unit (backend): `listar()` devolve `ficha_pronta=false` para OS Offset sem máquina ou sem via com folhas; `true` quando ambos presentes. `buscarPorId()` inclui `arte_arquivo_url` nos itens.
- Smoke E2E no VPS: OS Offset sem ficha não aparece no board; após atribuir máquina+via, aparece; modal abre com galeria + bloco da fase destacado; botão concluir avança a fase.
