# Autocomplete de Fornecedor + Modal Fixo em Editar Conta a Pagar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No modal "Nova/Editar Conta a Pagar" do painel admin, trocar o campo Fornecedor/Credor (hoje um input livre com match silencioso no blur) por um autocomplete real com dropdown de sugestões e atalho de cadastro inline; e impedir que o modal feche sozinho ao clicar fora dele.

**Architecture:** O campo `cp-f-fornecedor` ganha busca com debounce contra o endpoint já existente `GET /api/v2/fornecedores?busca=`, populando um dropdown (`cp-fornecedor-sugestoes`) com delegação de evento (mousedown, pra disparar antes do blur). `abrirModalFornecedorMain()` ganha dois parâmetros opcionais (`nomeInicial`, `onSalvo`) pra ser reaproveitada tanto pela tela de Fornecedores quanto pelo atalho "+ Cadastrar novo fornecedor" dentro do modal de Conta a Pagar. O backdrop do `#cp-modal` perde o `onclick` de fechar.

**Tech Stack:** HTML/JS vanilla em `public/dashboard.html` (sem framework, sem build step), endpoints REST já existentes (`/api/v2/fornecedores`).

---

### Task 1: Campo Fornecedor vira autocomplete com dropdown

**Files:**
- Modify: `public/dashboard.html:669-671` (HTML do campo)
- Modify: `public/dashboard.html:2374-2385` (remove `cpOnFornecedorBlur`, adiciona novas funções)

Este arquivo é HTML/JS de página sem suíte de testes automatizada (mesmo padrão de todo o painel administrativo hoje). A verificação é por leitura cuidadosa + checagem de sintaxe JS + smoke manual no navegador.

- [ ] **Step 1: Atualizar o HTML do campo Fornecedor/Credor**

Em `public/dashboard.html`, substitua as linhas 668-672 (bloco `<div>` do campo Fornecedor/Credor):

```html
        <div>
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Fornecedor/Credor</label>
          <input type="text" id="cp-f-fornecedor" placeholder="Ex: Light S.A." onblur="cpOnFornecedorBlur()" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
          <input type="hidden" id="cp-f-fornecedor-id">
        </div>
```

Por:

```html
        <div style="position:relative">
          <label style="display:block;font-size:13px;font-weight:600;margin-bottom:5px;color:#555">Fornecedor/Credor</label>
          <input type="text" id="cp-f-fornecedor" placeholder="Ex: Light S.A." autocomplete="off" oninput="cpBuscarFornecedor(this.value)" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
          <input type="hidden" id="cp-f-fornecedor-id">
          <div id="cp-fornecedor-sugestoes" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid var(--border);border-radius:8px;margin-top:4px;max-height:220px;overflow-y:auto;z-index:1100;box-shadow:0 4px 12px rgba(0,0,0,.12)"></div>
        </div>
```

- [ ] **Step 2: Substituir `cpOnFornecedorBlur` pelas novas funções de autocomplete**

Em `public/dashboard.html`, substitua o bloco inteiro (linhas 2374-2385):

```js
async function cpOnFornecedorBlur() {
  const nome = document.getElementById('cp-f-fornecedor').value.trim();
  document.getElementById('cp-f-fornecedor-id').value = '';
  if (!nome) return;
  const r = await api(`/api/v2/fornecedores?busca=${encodeURIComponent(nome)}&limit=1`);
  const fornecedorId = r?.fornecedores?.[0]?.id || null;
  if (fornecedorId) document.getElementById('cp-f-fornecedor-id').value = fornecedorId;
  const sugestao = await api(`/api/v2/contas-pagar/sugerir-tipo?${fornecedorId ? 'fornecedor_id=' + fornecedorId : ''}&fornecedor=${encodeURIComponent(nome)}`);
  if (sugestao?.tipo_despesa_id && !document.getElementById('cp-f-tipo-despesa').value) {
    document.getElementById('cp-f-tipo-despesa').value = sugestao.tipo_despesa_id;
  }
}
```

Por:

```js
function _escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

let _cpFornecedorDebounce = null;

function cpBuscarFornecedor(texto) {
  document.getElementById('cp-f-fornecedor-id').value = '';
  clearTimeout(_cpFornecedorDebounce);
  const termo = texto.trim();
  if (!termo) { cpFecharSugestoesFornecedor(); return; }
  _cpFornecedorDebounce = setTimeout(() => cpCarregarSugestoesFornecedor(termo), 300);
}

async function cpCarregarSugestoesFornecedor(termo) {
  const r = await api(`/api/v2/fornecedores?busca=${encodeURIComponent(termo)}&limit=8`);
  const lista = r?.fornecedores || [];
  const box = document.getElementById('cp-fornecedor-sugestoes');
  const itensHtml = lista.map(f => `
    <div class="cp-fornecedor-item" data-id="${_escapeHtml(f.id)}" data-nome="${_escapeHtml(f.nome)}"
         style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border)">
      <div style="font-weight:600">${_escapeHtml(f.nome)}</div>
      ${f.cnpj ? `<div style="font-size:11px;color:var(--muted)">${_escapeHtml(f.cnpj)}</div>` : ''}
    </div>`).join('');
  box.innerHTML = itensHtml + `
    <div class="cp-fornecedor-novo" data-termo="${_escapeHtml(termo)}"
         style="padding:8px 12px;cursor:pointer;font-size:13px;color:var(--primary);font-weight:600">
      + Cadastrar novo fornecedor
    </div>`;
  box.style.display = 'block';
}

function cpFecharSugestoesFornecedor() {
  const box = document.getElementById('cp-fornecedor-sugestoes');
  if (box) box.style.display = 'none';
}

async function cpEscolherFornecedor(id, nome) {
  document.getElementById('cp-f-fornecedor').value = nome;
  document.getElementById('cp-f-fornecedor-id').value = id;
  cpFecharSugestoesFornecedor();
  const sugestao = await api(`/api/v2/contas-pagar/sugerir-tipo?fornecedor_id=${id}&fornecedor=${encodeURIComponent(nome)}`);
  if (sugestao?.tipo_despesa_id && !document.getElementById('cp-f-tipo-despesa').value) {
    document.getElementById('cp-f-tipo-despesa').value = sugestao.tipo_despesa_id;
  }
}

function cpNovoFornecedorInline(nomeInicial) {
  cpFecharSugestoesFornecedor();
  abrirModalFornecedorMain(nomeInicial, (fornecedorCriado) => {
    document.getElementById('cp-f-fornecedor').value = fornecedorCriado.nome;
    document.getElementById('cp-f-fornecedor-id').value = fornecedorCriado.id;
  });
}

document.getElementById('cp-fornecedor-sugestoes').addEventListener('mousedown', (ev) => {
  const item = ev.target.closest('.cp-fornecedor-item');
  if (item) { cpEscolherFornecedor(item.dataset.id, item.dataset.nome); return; }
  const novo = ev.target.closest('.cp-fornecedor-novo');
  if (novo) cpNovoFornecedorInline(novo.dataset.termo);
});

document.getElementById('cp-f-fornecedor').addEventListener('blur', () => {
  setTimeout(cpFecharSugestoesFornecedor, 150);
});
```

Nota: `onmousedown`/`mousedown` (não `click`) é usado na delegação porque o `blur` do input dispara antes do `click` do item da lista, fechando o dropdown antes da seleção ser capturada — `mousedown` dispara antes do `blur`. O listener de `blur` no input fecha o dropdown com um delay de 150ms pra não competir com o `mousedown` do item.

`_escapeHtml` evita que nome/CNPJ de fornecedor com caracteres especiais (aspas, `&`, `<`) quebrem o HTML do dropdown — o dado vem do banco (cadastro de fornecedor), não é garantido que esteja "limpo".

- [ ] **Step 3: Verificar sintaxe do arquivo**

Este é um `<script>` inline dentro de HTML, não um arquivo `.js` isolado — não dá pra rodar `node --check` diretamente nele. Extraia o conteúdo do `<script>` (linha 992 até o próximo `</script>`) pra um arquivo temporário e valide:

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/dashboard.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const target = scripts.find(m => m[1].includes('cpBuscarFornecedor'));
fs.writeFileSync('/tmp/cp-script-check.js', target[1]);
"
node --check /tmp/cp-script-check.js
```

Esperado: sem erro de sintaxe (pode dar erro de `document is not defined`/`ReferenceError` se tentar EXECUTAR — mas `node --check` só valida sintaxe, não executa, então isso não deve aparecer).

- [ ] **Step 4: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(contas-pagar): campo Fornecedor/Credor vira autocomplete com dropdown"
```

---

### Task 2: `abrirModalFornecedorMain` ganha parâmetros opcionais + atalho de cadastro inline

**Files:**
- Modify: `public/dashboard.html:3049-3061`

- [ ] **Step 1: Atualizar `abrirModalFornecedorMain`**

Em `public/dashboard.html`, substitua a função inteira (linhas 3049-3061):

```js
function abrirModalFornecedorMain() {
  document.getElementById('modal-cadastro-title').textContent = 'Novo Fornecedor';
  document.getElementById('modal-cadastro-body').innerHTML = _formFornecedor();
  aplicarMascaras();
  document.getElementById('modal-cadastro-save').onclick = async () => {
    const body = _salvarFornecedor(); if (!body) return;
    if (!body.nome) { showToast('Nome é obrigatório','error'); return; }
    const r = await api('/api/v2/fornecedores', { method:'POST', body: JSON.stringify(body) });
    if (r?.erro||r?.errors) { showToast((r.erro||r.errors||['Erro']).join?.(', ')||'Erro','error'); return; }
    showToast('Fornecedor cadastrado'); fecharModalCadastro(); loadFornecedoresMain(1);
  };
  document.getElementById('modal-cadastro').style.display = 'block';
}
```

Por:

```js
function abrirModalFornecedorMain(nomeInicial, onSalvo) {
  document.getElementById('modal-cadastro-title').textContent = 'Novo Fornecedor';
  document.getElementById('modal-cadastro-body').innerHTML = _formFornecedor(nomeInicial ? { nome: nomeInicial } : {});
  aplicarMascaras();
  document.getElementById('modal-cadastro-save').onclick = async () => {
    const body = _salvarFornecedor(); if (!body) return;
    if (!body.nome) { showToast('Nome é obrigatório','error'); return; }
    const r = await api('/api/v2/fornecedores', { method:'POST', body: JSON.stringify(body) });
    if (r?.erro||r?.errors) { showToast((r.erro||r.errors||['Erro']).join?.(', ')||'Erro','error'); return; }
    showToast('Fornecedor cadastrado');
    fecharModalCadastro();
    if (onSalvo) onSalvo(r);
    else loadFornecedoresMain(1);
  };
  document.getElementById('modal-cadastro').style.display = 'block';
}
```

Isso é retrocompatível: a chamada existente em `public/dashboard.html:861` (`onclick="abrirModalFornecedorMain()"`, botão "+ Novo" da tela de Fornecedores) continua funcionando sem mudança — `nomeInicial` e `onSalvo` ficam `undefined`, `_formFornecedor(undefined ? ... : {})` vira `_formFornecedor({})` (mesmo comportamento de hoje), e `if (onSalvo)` é falso, então cai no `else loadFornecedoresMain(1)` (comportamento de hoje, preservado).

`r` já é o objeto do fornecedor recém-criado (`{id, nome, cnpj, ...}`) — confirmado em `src/modules/fornecedores/router.js:20-25` (`res.status(201).json(result.fornecedor)`, sem wrapper) — por isso `onSalvo(r)` (não `onSalvo(r.fornecedor)`) está correto.

- [ ] **Step 2: Verificar sintaxe** (mesmo processo do Task 1, Step 3 — reextrai o script e roda `node --check`)

- [ ] **Step 3: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(contas-pagar): abrirModalFornecedorMain aceita nome inicial e callback pós-cadastro"
```

---

### Task 3: `cpAbrirModalNova`/`cpAbrirModalEditar` escondem sugestões residuais + modal não fecha ao clicar fora

**Files:**
- Modify: `public/dashboard.html:660` (remove onclick do backdrop)
- Modify: `public/dashboard.html:2524-2542` (`cpAbrirModalNova`)
- Modify: `public/dashboard.html:2544-2574` (`cpAbrirModalEditar`)

- [ ] **Step 1: Remover o fechamento por clique fora do modal**

Em `public/dashboard.html`, linha 660, troque:

```html
  <div id="cp-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center;padding:16px" onclick="if(event.target===this)cpFecharModal()">
```

Por:

```html
  <div id="cp-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center;padding:16px">
```

(Só removido o atributo `onclick`, nada mais muda nessa linha.)

- [ ] **Step 2: `cpAbrirModalNova` esconde o dropdown de sugestões residual**

Em `public/dashboard.html`, dentro de `cpAbrirModalNova()` (linha 2524), logo após a linha `cpConvertendoParcelado = false;` (linha 2526), adicione uma linha nova:

```js
function cpAbrirModalNova() {
  cpEditandoId = null;
  cpConvertendoParcelado = false;
  cpFecharSugestoesFornecedor();
  document.getElementById('cp-modal-titulo').textContent = 'Nova Conta a Pagar';
  ...
```

(Resto da função sem alteração — só a linha `cpFecharSugestoesFornecedor();` é inserida.)

- [ ] **Step 3: `cpAbrirModalEditar` esconde o dropdown de sugestões residual**

Em `public/dashboard.html`, dentro de `cpAbrirModalEditar(id)` (linha 2544), logo após a linha `cpConvertendoParcelado = false;` (linha 2551), adicione uma linha nova:

```js
  cpEditandoId = id;
  cpConvertendoParcelado = false;
  cpFecharSugestoesFornecedor();
  document.getElementById('cp-modal-titulo').textContent = 'Editar Conta';
  ...
```

(Resto da função sem alteração — só a linha `cpFecharSugestoesFornecedor();` é inserida.)

- [ ] **Step 4: Verificar sintaxe** (mesmo processo do Task 1, Step 3)

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "fix(contas-pagar): modal Editar Conta nao fecha mais ao clicar fora + limpa sugestoes residuais"
```

---

### Task 4: Deploy no VPS + smoke test manual

**Files:** nenhum (só deploy e verificação)

- [ ] **Step 1: Deploy**

Este deploy toca produção — confirmar com o usuário (AskUserQuestion) antes do rsync.

```bash
rsync -av public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```

Não precisa de `pm2 restart` — `dashboard.html` é servido estaticamente via `express.static`, sem processo Node pra reiniciar.

- [ ] **Step 2: Smoke test manual no navegador (produção)**

Acessar `https://chatbot.klebercamaraconsultoria.cloud/dashboard`, ir em Contas a Pagar, clicar "+ Nova Conta" (ou editar uma existente), e confirmar:

1. Digitar no campo Fornecedor/Credor um nome parcial de fornecedor já cadastrado → dropdown aparece com sugestões (nome + CNPJ).
2. Clicar numa sugestão → campo preenche com o nome exato, `Tipo de Despesa` é sugerido automaticamente se estava vazio.
3. Digitar um nome que não bate com nenhum fornecedor cadastrado → dropdown mostra só "+ Cadastrar novo fornecedor".
4. Clicar em "+ Cadastrar novo fornecedor" → abre o modal de cadastro de fornecedor com o nome pré-preenchido; salvar → volta pro modal de Conta a Pagar com o campo Fornecedor/Credor já preenchido com o fornecedor recém-criado.
5. Com o modal de Conta a Pagar aberto (e algum campo já preenchido), clicar fora do modal (na área escura) → modal continua aberto, nada é perdido.
6. Clicar em "Cancelar" → modal fecha normalmente.
7. Preencher os campos obrigatórios e clicar "Salvar Conta" → modal fecha e a conta aparece na lista.
8. Abrir a tela de Fornecedores (cadastros) e clicar "+ Novo" → confirma que o fluxo de cadastro direto (sem vir do autocomplete) continua funcionando normalmente (retrocompatibilidade do Task 2).

## Fora de escopo (reafirmado do spec)

- PWA financeiro (`public/pwa/financeiro.html`) — modal separado, não tocado nesta rodada.
- Matching fuzzy mais robusto (normalização de acentos/símbolos) — usa o `ILIKE` simples já exposto pelo endpoint `/api/v2/fornecedores`.
- Diálogo de confirmação "descartar alterações?" — decisão explícita de só remover o fechamento por clique fora, sem substituir por confirmação.
