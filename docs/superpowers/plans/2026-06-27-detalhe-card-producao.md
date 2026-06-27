# Detalhamento dos Cards de Produção — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicar num card do board de produção abre um modal enxuto com a galeria de artes aprovadas, os materiais/quantidades por fase (fase atual em destaque) e os acabamentos; e OS Offset só entra no board quando tem máquina + via com folhas.

**Architecture:** Duas mudanças SQL pequenas em `src/modules/os/service.js` (sem migration): `listar()` ganha `maquina_id` + flag `ficha_pronta`; `buscarPorId()` retorna `arte_arquivo_url` por item. O resto é `public/dashboard.html`: gate no `prodRenderBoard()`, card clicável, novo modal `prodAbrirCard()`, e remoção do item morto "Arte Final".

**Tech Stack:** Node.js + Express + PostgreSQL (pg), frontend vanilla JS no `dashboard.html`. Deploy rsync + `pm2 restart lkl-chatbot` no VPS `2.25.147.243`.

**Convenção de testes deste projeto:** as funções de service são SQL-heavy e validadas por **smoke E2E no VPS** (não há harness de DB nos testes Jest, que cobrem só funções puras). Seguimos essa convenção: verificação via `curl`/board real após deploy, registrada na Task 6.

---

### Task 1: Backend — `listar()` expõe `maquina_id` + `ficha_pronta`

**Files:**
- Modify: `src/modules/os/service.js` (função `listar`, SELECT por volta das linhas 201-213)

- [ ] **Step 1: Adicionar os dois campos ao SELECT**

No SELECT de `listar()`, logo após a linha `os.previsao_entrega, os.quantidade, os.data_inicio, os.data_conclusao,` adicione `os.tipo_servico` já existe no início; acrescente os campos novos. Substitua o trecho:

```js
              os.previsao_entrega, os.quantidade, os.data_inicio, os.data_conclusao,
              os.created_at, os.updated_at,
```

por:

```js
              os.previsao_entrega, os.quantidade, os.data_inicio, os.data_conclusao,
              os.created_at, os.updated_at, os.maquina_id,
              (os.maquina_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM os_materiais m WHERE m.os_id = os.id AND m.folhas_total > 0
               )) AS ficha_pronta,
```

- [ ] **Step 2: Verificar que o módulo carrega sem erro de sintaxe**

Run: `node -e "require('./src/modules/os/service.js'); console.log('OK')"`
Expected: imprime `OK` (sem erro de parse).

- [ ] **Step 3: Rodar a suíte de testes existente pra garantir que nada quebrou**

Run: `npx jest --no-coverage 2>&1 | tail -15`
Expected: todos os testes passam (mesma contagem de antes; nenhum teste novo aqui).

- [ ] **Step 4: Commit**

```bash
git add src/modules/os/service.js
git commit -m "feat(os): listar() expõe maquina_id e ficha_pronta para gate de produção"
```

---

### Task 2: Backend — `buscarPorId()` retorna `arte_arquivo_url` por item

**Files:**
- Modify: `src/modules/os/service.js` (subquery `itens` dentro de `buscarPorId`, linhas ~253-262)

- [ ] **Step 1: Incluir arte_arquivo_url e arte_status no SELECT dos itens**

Substitua o bloco:

```js
  const itens = await db.query(
    `SELECT oi.id, oi.descricao, oi.quantidade, oi.tipo_producao,
            orc.numero AS numero_orcamento, cl.nome AS cliente_nome
     FROM os_itens oit
     JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
     JOIN orcamentos orc ON orc.id = oi.orcamento_id
     LEFT JOIN clientes_lkl cl ON cl.id = orc.cliente_id
     WHERE oit.os_id = $1 ORDER BY oi.codigo`,
    [id]
  );
```

por:

```js
  const itens = await db.query(
    `SELECT oi.id, oi.descricao, oi.quantidade, oi.tipo_producao,
            oi.produto, oi.arte_arquivo_url, oi.arte_status,
            orc.numero AS numero_orcamento, cl.nome AS cliente_nome
     FROM os_itens oit
     JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
     JOIN orcamentos orc ON orc.id = oi.orcamento_id
     LEFT JOIN clientes_lkl cl ON cl.id = orc.cliente_id
     WHERE oit.os_id = $1 ORDER BY oi.codigo`,
    [id]
  );
```

- [ ] **Step 2: Verificar carga do módulo**

Run: `node -e "require('./src/modules/os/service.js'); console.log('OK')"`
Expected: imprime `OK`.

- [ ] **Step 3: Commit**

```bash
git add src/modules/os/service.js
git commit -m "feat(os): buscarPorId() retorna arte_arquivo_url por item (galeria de produção)"
```

---

### Task 3: Frontend — gate no board + card clicável

**Files:**
- Modify: `public/dashboard.html` (`prodRenderBoard`, linha ~1036 e o template do card ~1054-1060)

- [ ] **Step 1: Aplicar o gate de ficha no filtro de OSs em andamento**

Substitua a linha:

```js
  const inProg = prodAllOS.filter(os => ['corte','impressao','acabamento','entrega'].includes(os.status));
```

por:

```js
  const inProg = prodAllOS.filter(os =>
    ['corte','impressao','acabamento','entrega'].includes(os.status) &&
    (os.tipo_servico === 'comunicacao_visual' || os.ficha_pronta)
  );
```

- [ ] **Step 2: Tornar o card clicável e impedir que o botão abra o modal**

No template do card dentro de `prodRenderBoard`, substitua a `<div>` externa do card e o botão. Troque:

```js
          const btn = proximo
            ? `<button onclick="prodAvancar('${os.id}',this)" style="width:100%;padding:8px;background:${btnColor};color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;margin-top:6px">${btnLabel}</button>`
            : '';
          return `<div style="background:#fff;border-radius:8px;padding:10px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
```

por:

```js
          const btn = proximo
            ? `<button onclick="event.stopPropagation();prodAvancar('${os.id}',this)" style="width:100%;padding:8px;background:${btnColor};color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;margin-top:6px">${btnLabel}</button>`
            : '';
          return `<div onclick="prodAbrirCard('${os.id}')" style="background:#fff;border-radius:8px;padding:10px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);cursor:pointer">
```

- [ ] **Step 3: Verificar que o `<script>` continua balanceado e o app sobe**

Run: `node -e "require('./src/server.js') && setTimeout(()=>process.exit(0),500)" 2>&1 | tail -5 || true`
Expected: sem erro de sintaxe no carregamento (o servidor pode logar inicialização; encerra em ~0,5s). Alternativa rápida: `node --check` não vale pra HTML — confie na verificação de runtime do server e no smoke da Task 6.

- [ ] **Step 4: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(producao): gate de ficha no board + card clicável abre detalhe"
```

---

### Task 4: Frontend — modal `prodAbrirCard` (galeria + fases + concluir)

**Files:**
- Modify: `public/dashboard.html` (adicionar funções logo após `prodAvancar`, antes do comentário `// ===================== END PROD BOARD =====================`, ~linha 1113)

Constantes/funções já existentes e reutilizadas: `PROD_FLUXO`, `PROD_FASE_LABEL`, `PROD_TIPO_LABEL`, `prodEsc`, `prodProximaFase`, `prodAvancar`, `api`, `showModal`, `closeModal`, `showToast`.

- [ ] **Step 1: Adicionar `prodAbrirCard` e `prodAvancarModal`**

Insira este bloco imediatamente antes da linha `// ===================== END PROD BOARD =====================`:

```js
async function prodAbrirCard(osId) {
  let os;
  try { os = await api('/api/v2/os/' + osId); }
  catch (e) { showToast('Erro ao carregar OS'); return; }
  if (!os || os.error) { showToast('Erro ao carregar OS'); return; }

  const tipo = os.tipo_servico || '';
  const faseAtual = os.status;
  const isCV = tipo === 'comunicacao_visual';

  // Galeria de artes (uma por item)
  const itens = os.itens || [];
  const galeria = itens.map(it => {
    const url = it.arte_arquivo_url;
    const thumb = url
      ? `<a href="${prodEsc(url)}" target="_blank" style="display:block"><img src="${prodEsc(url)}" style="width:100px;height:120px;object-fit:cover;border:1px solid #e0e0e0;border-radius:8px" alt=""></a>`
      : `<div style="width:100px;height:120px;border:1px solid #e0e0e0;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#bbb;font-size:24px">🖼️</div>`;
    return `<div style="text-align:center;font-size:11px;color:#555">
      ${thumb}
      <div style="margin-top:4px;font-weight:600">${prodEsc(it.produto || it.descricao || 'item')}</div>
      <div style="color:#888">${it.quantidade || ''} un</div>
    </div>`;
  }).join('');

  // Vias/materiais
  const vias = (os.materiais || []).map(m => `
    <tr style="border-bottom:1px solid #f0f0f0">
      <td style="padding:4px 6px">${prodEsc(m.material_nome || m.descricao || '—')}</td>
      <td style="padding:4px 6px;text-align:right">${m.folhas_a_cortar || '—'}</td>
      <td style="padding:4px 6px;text-align:right">${m.folhas_total || '—'}</td>
      <td style="padding:4px 6px;text-align:right">${prodEsc(m.cores_tintas || '—')}</td>
    </tr>`).join('');

  // Acabamentos
  const acab = (os.especificacoes || []).map(e =>
    `<span style="font-size:11px;background:#f5f5f5;border:1px solid #e0e0e0;border-radius:12px;padding:2px 10px;margin:2px;display:inline-block">${prodEsc(e.nome)}</span>`
  ).join('') || '<span style="color:#aaa;font-size:12px">Sem acabamentos cadastrados</span>';

  // Blocos de fase — destaca a fase atual
  function bloco(fase, titulo, conteudo) {
    const ativo = fase === faseAtual;
    return `<div style="border:1px solid ${ativo?'#1a237e':'#eee'};background:${ativo?'#f5f6fc':'#fff'};border-radius:8px;padding:10px;margin-bottom:8px;opacity:${ativo?1:.6}">
      <div style="font-size:11px;font-weight:700;color:${ativo?'#1a237e':'#999'};letter-spacing:.5px;margin-bottom:6px">${titulo}${ativo?' — AGORA':''}</div>
      ${conteudo}
    </div>`;
  }

  const blocoImpressao = `
    <table style="width:100%;font-size:12px;border-collapse:collapse">
      <thead><tr style="color:#888;font-size:11px"><th style="text-align:left;padding:4px 6px">Material</th><th style="text-align:right;padding:4px 6px">A cortar</th><th style="text-align:right;padding:4px 6px">Total</th><th style="text-align:right;padding:4px 6px">Cores</th></tr></thead>
      <tbody>${vias || '<tr><td colspan="4" style="color:#aaa;padding:6px">Sem vias na ficha</td></tr>'}</tbody>
    </table>
    <div style="font-size:11px;color:#666;margin-top:6px">Máquina: ${prodEsc(os.maquina_nome || '—')} · Operador: ${prodEsc(os.operador_nome || '—')} · Total impressões: ${os.total_impressoes || '—'}</div>`;

  const blocoCorte = `<div style="font-size:12px;color:#444">Formato de corte: ${prodEsc(os.formato_corte || '—')} · Imagens por folha: ${os.imagens_folha || '—'}</div>`;

  let blocos = '';
  if (!isCV) blocos += bloco('corte', 'CORTE', blocoCorte);
  blocos += bloco('impressao', 'IMPRESSÃO', blocoImpressao);
  blocos += bloco('acabamento', 'ACABAMENTO', acab);

  const proximo = prodProximaFase(tipo, faseAtual);
  const btnLabel = faseAtual === 'entrega' ? '✅ Confirmar Entrega' : `✓ Concluir ${PROD_FASE_LABEL[faseAtual] || faseAtual}`;
  const botao = proximo
    ? `<button onclick="prodAvancarModal('${os.id}')" style="width:100%;padding:10px;background:#1a237e;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;margin-top:8px">${btnLabel}</button>`
    : '';

  const html = `
    <div style="font-size:13px;color:#666;margin-bottom:10px">
      Pedido #${os.numero_pedido || '—'} · ${prodEsc(os.cliente_nome || '—')}
      <span style="font-size:11px;background:#e3f2fd;color:#0277bd;border-radius:6px;padding:2px 8px;margin-left:6px">${prodEsc(PROD_TIPO_LABEL[tipo] || tipo)}</span>
    </div>
    <div style="font-size:11px;font-weight:700;color:#999;letter-spacing:.5px;margin-bottom:6px">MODELO (arte aprovada)</div>
    <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;margin-bottom:12px">${galeria || '<span style="color:#aaa;font-size:12px">Sem itens</span>'}</div>
    ${blocos}
    ${botao}`;

  showModal(`OS #${os.numero_os}`, html, '640px');
}

async function prodAvancarModal(osId) {
  try {
    await api('/api/v2/os/' + osId + '/avancar', { method: 'PATCH' });
    closeModal();
    await loadProdBoard();
  } catch (e) {
    showToast('Erro ao avançar fase: ' + (e.message || e));
  }
}
```

- [ ] **Step 2: Verificar runtime do server (sintaxe global do HTML não tem `node --check`)**

Run: `grep -c "function prodAbrirCard\|function prodAvancarModal" public/dashboard.html`
Expected: `2` (as duas funções presentes uma vez cada).

- [ ] **Step 3: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(producao): modal de detalhe do card (galeria de artes + fases + concluir)"
```

---

### Task 5: Frontend — remover item morto "Arte Final"

**Files:**
- Modify: `public/dashboard.html` (NAV ~789, page `#page-arte_final` ~471-475, loaders ~970, função `loadArteFinalMain` ~1905-1920)

- [ ] **Step 1: Remover o item do NAV**

Apague a linha:

```js
      { id: 'arte_final', label: 'Arte Final',           icon: '🎨', roles: ['admin','gestor','analista'] },
```

- [ ] **Step 2: Remover a entrada do mapa de loaders**

Apague a linha:

```js
    arte_final:   loadArteFinalMain,
```

- [ ] **Step 3: Remover o bloco da página**

Apague o bloco inteiro:

```html
  <!-- ARTE FINAL -->
  <div class="page" id="page-arte_final">
    <div class="page-header"><h1>🎨 Arte Final</h1><p>Aprovação e envio de artes ao cliente</p></div>
    <div id="arte-list-main"><div style="text-align:center;padding:40px;color:#999">Carregando...</div></div>
  </div>
```

- [ ] **Step 4: Remover a função `loadArteFinalMain`**

Apague a função inteira (do comentário `// ── ARTE FINAL ───` até o fechamento `}` antes de `// ── ARTES ───`):

```js
// ── ARTE FINAL ─────────────────────────────────────────────────────────────────
async function loadArteFinalMain() {
  ...
}
```

(É a função que faz `api('/api/v2/os?status=arte_final&limit=50')` e monta a tabela com link para `/pwa/arte_final.html`.)

- [ ] **Step 5: Confirmar que não sobrou referência**

Run: `grep -n "arte_final\|loadArteFinalMain\|arte-list-main" public/dashboard.html`
Expected: **nenhuma linha** retornada (zero referências). A string `arte_final` em `statusColors` (linha ~1514) é legado inofensivo de outra tabela — se aparecer, deixe; não é do menu. Confirme que `loadArteFinalMain` e `page-arte_final` não aparecem.

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "chore(ui): remover item morto 'Arte Final' do menu (status aposentado na 042)"
```

---

### Task 6: Deploy VPS + smoke E2E + memória

**Files:**
- Modify: `~/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md` (+ `MEMORY.md` se necessário)

- [ ] **Step 1: Deploy para o VPS**

```bash
rsync -az src/modules/os/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/os/service.js
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```

Expected: `pm2` reinicia `lkl-chatbot` sem erro (status `online`).

- [ ] **Step 2: Smoke — `listar()` traz `ficha_pronta`**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -e \"const s=require('./src/modules/os/service.js'); s.listar({limit:3}).then(r=>{console.log(r.data.map(o=>({os:o.numero_os,tipo:o.tipo_servico,ficha:o.ficha_pronta,maq:o.maquina_id})));process.exit(0)})\""
```

Expected: imprime as OSs com o campo `ficha` (true/false) e `maq` preenchido/null. OS Offset sem máquina → `ficha:false`.

- [ ] **Step 3: Smoke — `buscarPorId()` traz `arte_arquivo_url`**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -e \"const s=require('./src/modules/os/service.js'); s.listar({limit:1}).then(async r=>{const o=await s.buscarPorId(r.data[0].id);console.log(o.itens.map(i=>({d:i.descricao,arte:i.arte_arquivo_url})));process.exit(0)})\""
```

Expected: imprime os itens com a chave `arte` (URL `/uploads/artes/...` ou `null`).

- [ ] **Step 4: Smoke manual no painel (registrar resultado)**

Abrir `https://app.graficalkl.com.br` → aba Produção. Verificar:
- OS Offset sem ficha (sem máquina) **não** aparece no board.
- Clicar num card abre o modal com galeria de arte + bloco da fase atual destacado.
- Botão "Concluir [fase]" no modal avança e atualiza o board.
- Menu **não** tem mais "Arte Final"; "Artes" continua.

- [ ] **Step 5: Atualizar memória**

Acrescentar ao `project_sprint_status.md` um parágrafo: "Detalhe do card de produção: CONCLUÍDO 2026-06-27. Modal `prodAbrirCard` (galeria de artes via `orcamento_itens.arte_arquivo_url`, blocos de fase com destaque, botão concluir). `listar()` ganhou `maquina_id`+`ficha_pronta`; `buscarPorId()` ganhou `arte_arquivo_url` nos itens. Gate: OS Offset só entra no board com máquina+via(folhas>0); CV sempre. Removido item morto 'Arte Final' do menu. Sem migration."

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: smoke detalhe-card-producao + memória"
```

---

## Self-Review

**Spec coverage:**
- Gate Offset (máquina+vias) → Task 1 (backend flag) + Task 3 (filtro). ✓
- Modal dedicado + fase em destaque → Task 4. ✓
- Galeria de todas as artes → Task 2 (dado) + Task 4 (render). ✓
- Remover Arte Final → Task 5. ✓
- CV sempre visível → Task 3 (condição `comunicacao_visual`). ✓
- Sem migration → confirmado, nenhuma task cria SQL. ✓

**Consistência de nomes:** `ficha_pronta`, `arte_arquivo_url`, `prodAbrirCard`, `prodAvancarModal`, `maquina_nome`, `operador_nome` usados de forma idêntica entre tasks. ✓

**Premissa registrada:** CV não exige máquina (Task 3). Se o usuário quiser gate p/ CV, é mudança de uma linha na condição do filtro.
