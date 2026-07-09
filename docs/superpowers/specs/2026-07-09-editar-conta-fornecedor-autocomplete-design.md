# Autocomplete de fornecedor + modal fixo em Editar Conta a Pagar

## Contexto

No painel administrativo (`public/dashboard.html`), o modal "Nova/Editar Conta a Pagar" (`#cp-modal`) tem dois problemas relatados pelo usuário depois do smoke test do OCR de NF-e via WhatsApp:

1. **Campo Fornecedor/Credor é um input livre sem busca visível.** Hoje (`cp-f-fornecedor`, `dashboard.html:670`) é um `<input type="text">` solto; ao perder o foco (`cpOnFornecedorBlur()`, `dashboard.html:2374-2385`) tenta casar o texto digitado contra `GET /api/v2/fornecedores?busca=<nome>&limit=1` e silenciosamente preenche um campo oculto `cp-f-fornecedor-id` (`dashboard.html:671`) se achar 1 resultado. O atendente não vê nem escolhe entre opções — se o OCR errou o nome do fornecedor (caso real: nota da Konita saiu com "GRUPO DE GRAFICAS LKL LTDA ME"), não há como buscar e corrigir para o fornecedor certo dentro do modal; e se o fornecedor não existir, não há atalho para cadastrá-lo.
2. **O modal fecha sozinho ao clicar fora dele**, perdendo toda a edição em andamento. O backdrop tem `onclick="if(event.target===this)cpFecharModal()"` (`dashboard.html:660`), que fecha sem qualquer confirmação.

## Escopo

- Só o painel administrativo (`public/dashboard.html`, modal `#cp-modal`). O PWA financeiro (`public/pwa/financeiro.html`) tem uma implementação de modal totalmente separada e não é tocado nesta rodada.
- Campo `Fornecedor/Credor` vira autocomplete real: dropdown de sugestões enquanto digita, usando o endpoint já existente `GET /api/v2/fornecedores?busca=&limit=`.
- Se a busca não achar o fornecedor certo, uma opção fixa "+ Cadastrar novo fornecedor" abre o modal de cadastro de fornecedor já existente (`abrirModalFornecedorMain`), e ao salvar preenche automaticamente o campo do modal de conta a pagar com o fornecedor recém-criado.
- O modal `#cp-modal` deixa de fechar ao clicar fora — só fecha pelos botões Cancelar/Salvar Conta (ou X, se existir).
- **Fora de escopo**: PWA financeiro; matching fuzzy mais robusto (tipo o usado no OCR via `fornecedor-matcher.js`) — o autocomplete usa o `ILIKE` simples que o endpoint `/api/v2/fornecedores` já expõe; diálogo de confirmação para descartar edição (decisão explícita: só remover o fechamento por clique fora, sem confirmação).

## Design técnico

### 1. HTML do campo — `dashboard.html:669-671`

Envolve o input existente num container relativo e adiciona um `<div>` de dropdown (inicialmente oculto):

```html
<label style="...">Fornecedor/Credor</label>
<div style="position:relative">
  <input type="text" id="cp-f-fornecedor" placeholder="Ex: Light S.A." autocomplete="off"
         oninput="cpBuscarFornecedor(this.value)" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
  <input type="hidden" id="cp-f-fornecedor-id">
  <div id="cp-fornecedor-sugestoes" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid var(--border);border-radius:8px;margin-top:4px;max-height:220px;overflow-y:auto;z-index:1100;box-shadow:0 4px 12px rgba(0,0,0,.12)"></div>
</div>
```

Remove o `onblur="cpOnFornecedorBlur()"` (substituído pelo autocomplete) e o atributo antigo. `cpOnFornecedorBlur()` (`dashboard.html:2374-2385`) é removida por completo — sua responsabilidade (achar `fornecedor_id` + sugerir tipo de despesa) passa a acontecer só quando o usuário efetivamente escolhe um item da lista (`cpEscolherFornecedor`, ver abaixo), não mais num match silencioso de 1 resultado no blur.

### 2. JS — busca com debounce, dropdown, escolha, cadastro inline

Adiciona logo antes ou depois de `cpOnFornecedorBlur` (que será removida):

```js
let _cpFornecedorDebounce = null;

function cpBuscarFornecedor(texto) {
  document.getElementById('cp-f-fornecedor-id').value = '';
  clearTimeout(_cpFornecedorDebounce);
  const termo = texto.trim();
  if (!termo) { cpFecharSugestoesFornecedor(); return; }
  _cpFornecedorDebounce = setTimeout(() => cpCarregarSugestoesFornecedor(termo), 300);
}

function _escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function cpCarregarSugestoesFornecedor(termo) {
  const r = await api(`/api/v2/fornecedores?busca=${encodeURIComponent(termo)}&limit=8`);
  const lista = r?.fornecedores || [];
  const box = document.getElementById('cp-fornecedor-sugestoes');
  const itensHtml = lista.map(f => `
    <div class="cp-fornecedor-item" data-id="${_escapeHtml(f.id)}" data-nome="${_escapeHtml(f.nome)}"
         style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border)">
      <div style="font-weight:600">${_escapeHtml(f.nome)}</div>
      ${f.cnpj ? `<div style="font-size:11px;color:var(--text-muted)">${_escapeHtml(f.cnpj)}</div>` : ''}
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

// Delegação de evento (registrada uma vez, fora de função) — usa mousedown em vez de
// click porque o blur do input fecha o dropdown antes do click disparar.
document.getElementById('cp-fornecedor-sugestoes').addEventListener('mousedown', (ev) => {
  const item = ev.target.closest('.cp-fornecedor-item');
  if (item) { cpEscolherFornecedor(item.dataset.id, item.dataset.nome); return; }
  const novo = ev.target.closest('.cp-fornecedor-novo');
  if (novo) cpNovoFornecedorInline(novo.dataset.termo);
});

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
```

Usa `onmousedown` (não `onclick`) nos itens da lista porque o `blur` do input (que fecharia o dropdown) dispara antes do `click` — `mousedown` dispara antes do `blur`, garantindo que a seleção seja capturada. Fecha o dropdown também ao perder o foco do input, com um pequeno delay pra não brigar com o `mousedown` do item:

```js
document.getElementById('cp-f-fornecedor').addEventListener('blur', () => {
  setTimeout(cpFecharSugestoesFornecedor, 150);
});
```

(Esse listener é registrado uma vez, fora de função, no bloco de inicialização do script — mesmo padrão de outros listeners globais já existentes no arquivo.)

### 3. `abrirModalFornecedorMain` ganha parâmetros opcionais — `dashboard.html:3049-3061`

Assinatura muda de `abrirModalFornecedorMain()` para `abrirModalFornecedorMain(nomeInicial, onSalvo)`, ambos opcionais — chamada existente em `dashboard.html:861` (`onclick="abrirModalFornecedorMain()"`) continua funcionando sem mudança porque os dois parâmetros são opcionais e o comportamento default (recarregar a lista de fornecedores) é preservado quando `onSalvo` não é passado:

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

`r` já é o objeto do fornecedor criado (`{id, nome, cnpj, ...}`) — o endpoint `POST /api/v2/fornecedores` responde `res.status(201).json(result.fornecedor)` (`src/modules/fornecedores/router.js:20-25`), sem wrapper.

### 4. `cpAbrirModalNova`/`cpAbrirModalEditar` — nenhuma mudança de lógica

Continuam preenchendo `cp-f-fornecedor`/`cp-f-fornecedor-id` normalmente (`dashboard.html:2528`, `2554-2555`). Só precisam garantir que `cp-fornecedor-sugestoes` seja escondido ao abrir o modal (evita um dropdown "fantasma" de uma edição anterior):

```js
// dentro de cpAbrirModalNova() e cpAbrirModalEditar(id), antes de exibir o modal:
cpFecharSugestoesFornecedor();
```

### 5. Modal não fecha mais ao clicar fora — `dashboard.html:660`

Remove o `onclick` do backdrop:

```html
<!-- antes -->
<div id="cp-modal" style="..." onclick="if(event.target===this)cpFecharModal()">
<!-- depois -->
<div id="cp-modal" style="...">
```

`cpFecharModal()` (`dashboard.html:2576`) não muda — continua sendo chamada explicitamente pelos botões Cancelar (`dashboard.html:741`) e, internamente, depois de salvar com sucesso (`dashboard.html:2696,2703,2714,2729`).

## Testes

- Sem suíte automatizada nova: este arquivo (`dashboard.html`) é HTML/JS de página, sem testes no projeto hoje (mesmo padrão de todo o restante do painel administrativo) — verificação por leitura cuidadosa + smoke manual no navegador (abrir modal, digitar fornecedor existente, escolher da lista, digitar fornecedor inexistente, cadastrar inline, confirmar que o campo populou; clicar fora do modal e confirmar que não fecha; salvar e confirmar que fecha).
- `POST /api/v2/fornecedores` e `GET /api/v2/fornecedores?busca=` já são endpoints existentes e não são alterados nesta mudança — nenhum teste de backend novo necessário.

## Fora de escopo

- PWA financeiro (`public/pwa/financeiro.html`) — modal separado, não tocado.
- Matching fuzzy mais robusto (normalização de acentos/símbolos como em `fornecedor-matcher.js`) — o autocomplete usa a busca `ILIKE` simples já exposta pelo endpoint.
- Diálogo de confirmação "descartar alterações?" ao tentar fechar o modal — decisão explícita de só remover o fechamento por clique fora, sem substituir por confirmação.
