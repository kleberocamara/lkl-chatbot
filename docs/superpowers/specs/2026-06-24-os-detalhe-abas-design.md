# Detalhe da OS em abas internas — Design

**Data:** 2026-06-24
**Contexto:** Primeira ação de "enxugar a interface" (usuário achou o painel poluído). A tela
mais carregada é o modal **Detalhe da OS** (`abrirDetalheOS`), que empilha cabeçalho + ficha de
produção (grid de ~19 campos) + vias/materiais + requisição num modal de 920px.

## Objetivo

Dividir o conteúdo do modal de detalhe da OS em **abas internas** (pills), mostrando uma seção
por vez, sem alterar a lógica de carregamento/salvamento existente.

## Decisão (confirmada com o usuário)

Quebrar o detalhe da OS em abas: **Produção · Materiais · Requisição**. Cabeçalho fixo no topo.

## Estado atual (verificado — `public/dashboard.html`, `abrirDetalheOS` ~1514)

- Monta `html` com: cabeçalho (OS #, tipo, cliente, status, itens, especificações, máquina/
  operador read-only) + `fichaHtml` (FICHA DE PRODUÇÃO offset: grid de campos + combos
  `ficha-maquina`/`ficha-operador` + botão `abrirMelhorCorte()` + `#of-vias-area` + botão
  `salvarFichaOS()`) + `#os-requisicao-bloco`.
- Após `showModal(...)`: `if (isOffset) { renderViasOS(); popularCombosFicha(os); }` e
  `renderRequisicaoOS(os)`.
- `renderViasOS` injeta em `#of-vias-area`; `renderRequisicaoOS` em `#os-requisicao-bloco`;
  `popularCombosFicha` preenche `ficha-maquina`/`ficha-operador`. `salvarFichaOS` lê os ids
  `of-*` + `ficha-maquina`/`ficha-operador`.

## Mudança (só `public/dashboard.html`)

### Estrutura do modal
1. **Cabeçalho** (inalterado) no topo, sempre visível.
2. **Sub-nav em pills** logo abaixo:
   - Offset: `🏭 Produção` · `📦 Materiais` · `📥 Requisição` (default: Produção).
   - Comunicação Visual (não-offset): apenas `📥 Requisição` (a nota "ficha offset não se
     aplica" aparece como conteúdo da seção Produção, mas as pills Produção/Materiais ficam
     ocultas — mostra só Requisição).
3. **Seções** (cada uma um `<div>` que o toggle exibe/oculta):
   - `#osd-producao`: a grid de campos da ficha (de `of-jogos` até `of-totimp`, incluindo
     `ficha-maquina`/`ficha-operador` e o botão Melhor corte) + botão **Salvar ficha**.
     **NÃO** inclui `#of-vias-area` (vai para Materiais).
   - `#osd-materiais`: `<div id="of-vias-area"></div>` (alvo do `renderViasOS`, inalterado).
   - `#osd-requisicao`: `<div id="os-requisicao-bloco"></div>` (alvo do `renderRequisicaoOS`).

### Reorganização do `fichaHtml`
- Mover o `<div id="of-vias-area"></div>` de dentro do `fichaHtml` para a seção Materiais.
- O botão "Salvar ficha de produção" fica na seção Produção (salva os campos `of-*` +
  máquina/operador, como hoje — `renderViasOS` já lê as vias do DOM em `salvarFichaOS`?
  CONFIRMAR: se `salvarFichaOS` lê as vias de `#of-vias-area`, elas continuam acessíveis no DOM
  mesmo na aba oculta — `display:none` não remove do DOM, então `salvarFichaOS` continua
  funcionando lendo os inputs das vias).

### Função de toggle
```js
function osDetalheTab(secao) {
  ['producao','materiais','requisicao'].forEach(s => {
    const sec = document.getElementById('osd-' + s);
    const tab = document.getElementById('osdtab-' + s);
    if (sec) sec.style.display = (s === secao) ? '' : 'none';
    if (tab) tab.className = 'btn ' + (s === secao ? 'btn-primary' : 'btn-outline');
  });
}
```
- Chamar `osDetalheTab(isOffset ? 'producao' : 'requisicao')` após `showModal` e os renders.

## Pontos críticos

- `display:none` mantém os elementos no DOM → `renderViasOS`/`popularCombosFicha`/
  `renderRequisicaoOS` e `salvarFichaOS` continuam funcionando independentemente da aba ativa.
- Os ids `of-vias-area`, `ficha-maquina`, `ficha-operador`, `os-requisicao-bloco` e todos os
  `of-*` permanecem idênticos — nenhuma outra função muda.

## Testes

- Sem backend; verificação visual no painel: abrir uma OS offset → alternar Produção/Materiais/
  Requisição; editar a ficha e salvar (confirma que os campos das vias, mesmo em aba oculta,
  salvam); abrir uma OS de CV → ver só Requisição.
- Conferir que "Melhor corte" e baixar/estornar requisição seguem funcionando.

## Fora de escopo

- Outras telas (menu colapsável, legado, cadastros) — direções futuras de simplificação.
