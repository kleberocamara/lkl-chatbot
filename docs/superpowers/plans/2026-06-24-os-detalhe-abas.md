# Detalhe da OS em abas internas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dividir o modal de Detalhe da OS em abas internas (Produção · Materiais · Requisição) para enxugar a tela.

**Architecture:** Refatorar a montagem do HTML em `abrirDetalheOS` (public/dashboard.html): cabeçalho fixo + sub-nav em pills + 3 seções. Adicionar `osDetalheTab(secao)`. Sem backend; sem mudança nas funções de render/save (ids preservados).

**Tech Stack:** HTML/vanilla-JS. Verificação visual no painel.

**Fatos verificados (`public/dashboard.html`):**
- `abrirDetalheOS(id)` (~1514): monta `fichaHtml` (offset) com a grid de campos `of-*` + combos `ficha-maquina`/`ficha-operador` + botão `abrirMelhorCorte()` + `<div id="of-vias-area"></div>` + botão `salvarFichaOS()`. Depois monta `html` = cabeçalho + `${fichaHtml}` + `<div id="os-requisicao-bloco">`. Chama `showModal(..., '920px')`, depois `if (isOffset){ renderViasOS(); popularCombosFicha(os); } renderRequisicaoOS(os);`.
- `salvarFichaOS` lê os ids `of-*` + `ficha-maquina`/`ficha-operador` + `_osMateriais` (variável JS — independe do DOM/visibilidade).
- `renderViasOS` injeta em `#of-vias-area`; `renderRequisicaoOS` em `#os-requisicao-bloco`; `popularCombosFicha` preenche os selects da ficha. Todos por id — funcionam mesmo com a aba em `display:none`.
- `showModal(title, html, width)` injeta em `#generic-modal`.
- Deploy: `rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html`.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:** só `public/dashboard.html`.

---

### Task 1: Refatorar `abrirDetalheOS` em abas + `osDetalheTab`

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Ler `abrirDetalheOS` (1514–1566)**

```bash
sed -n '1514,1566p' public/dashboard.html
```
Entender as 3 partes: cabeçalho, `fichaHtml` (com `#of-vias-area` dentro), `#os-requisicao-bloco`.

- [ ] **Step 2: Tirar `#of-vias-area` de dentro do `fichaHtml`**

No `fichaHtml`, REMOVER a linha `<div id="of-vias-area"></div>` (ela passa para a seção Materiais). O botão "Salvar ficha de produção" PERMANECE no `fichaHtml` (seção Produção).

- [ ] **Step 3: Reescrever a montagem do `html` com pills + seções**

Substituir o bloco `const html = \`...\`; showModal(...);` por:
```js
  const pills = isOffset ? `
    <div style="display:flex;gap:8px;margin:12px 0">
      <button id="osdtab-producao" class="btn btn-primary" onclick="osDetalheTab('producao')">🏭 Produção</button>
      <button id="osdtab-materiais" class="btn btn-outline" onclick="osDetalheTab('materiais')">📦 Materiais</button>
      <button id="osdtab-requisicao" class="btn btn-outline" onclick="osDetalheTab('requisicao')">📥 Requisição</button>
    </div>` : '';

  const html = `
    <div style="font-size:12px;color:#888;margin-bottom:8px">
      OS #${os.numero_os||'—'} · <b>${os.tipo_servico==='offset'?'Offset':(os.tipo_servico==='comunicacao_visual'?'Com. Visual':'—')}</b> · ${escHtml(os.cliente_nome||'(multi-cliente)')} · status: ${os.status}
    </div>
    <div style="font-size:13px;margin-bottom:4px"><b>Itens:</b> ${itensTxt}</div>
    <div style="font-size:13px;margin-bottom:4px"><b>Especificações:</b> ${especsTxt}</div>
    <div style="font-size:13px;color:#555;margin-bottom:6px">Máquina: ${escHtml(os.maquina_nome||'—')} · Operador: ${escHtml(os.operador_nome||'—')}</div>
    ${pills}
    <div id="osd-producao">${fichaHtml}</div>
    <div id="osd-materiais" style="display:none"><div id="of-vias-area"></div></div>
    <div id="osd-requisicao" style="display:none"><div id="os-requisicao-bloco" style="margin-top:8px"></div></div>`;
  showModal(`Detalhe da OS #${os.numero_os||''}`, html, '860px');
  if (isOffset) { renderViasOS(); popularCombosFicha(os); }
  renderRequisicaoOS(os);
  osDetalheTab(isOffset ? 'producao' : 'requisicao');
```
NOTA: o `#of-vias-area` agora vive em `#osd-materiais` (não mais dentro do `fichaHtml`); o `#os-requisicao-bloco` agora vive em `#osd-requisicao`. Para CV (não offset): `pills` é vazio e a aba inicial é `requisicao` — `osDetalheTab` esconde producao/materiais; o conteúdo do `fichaHtml` (a nota "não se aplica") fica em `#osd-producao` mas oculto, e só a Requisição aparece.

- [ ] **Step 4: Adicionar a função `osDetalheTab`**

Logo após `abrirDetalheOS`, adicionar:
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

- [ ] **Step 5: Sanidade de chaves/backticks**

Re-ler o bloco editado para garantir template literals balanceados e que `fichaHtml` não tem mais `#of-vias-area`.

- [ ] **Step 6: Deploy**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```

- [ ] **Step 7: Verificação visual (no painel)**

Abrir uma OS offset → ver as pills, alternar Produção/Materiais/Requisição; editar a ficha + uma via e Salvar (confere que salva mesmo a via tendo sido editada em outra aba); abrir uma OS de CV → ver só Requisição. Testar "Melhor corte" e baixar/estornar. Reportar o que viu.

- [ ] **Step 8: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(ui): detalhe da OS em abas internas (Produção/Materiais/Requisição)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Atualizar memória

**Files:**
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Registrar**

"UI — Detalhe da OS em abas internas: CONCLUÍDO — 2026-06-24. abrirDetalheOS (dashboard.html) reorganizado: cabeçalho fixo + sub-nav em pills (osDetalheTab) com seções #osd-producao (ficha offset + máquina/operador + melhor corte + salvar), #osd-materiais (#of-vias-area), #osd-requisicao (#os-requisicao-bloco). Offset abre em Produção; CV mostra só Requisição. Ids preservados → renderViasOS/popularCombosFicha/renderRequisicaoOS/salvarFichaOS inalterados. Primeira ação do esforço de enxugar a interface (direção A). Próximas direções possíveis: menu colapsável (B), limpar legado ORC_STATUS_V1/rascunho (C), modais de cadastro enxutos (D)."

- [ ] **Step 2: Sem commit** (memória fora do git).

---

## Notas de verificação final

- `_osMateriais` é a fonte das vias no save → independe da aba visível. `display:none` mantém tudo no DOM.
- Reduzi a largura do modal de 920px → 860px (cabe melhor já que cada aba mostra menos por vez); ajustar se preferir manter 920.
