# M12 · Sincronização de Itens Pedido ↔ Orçamento — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o orçamento a fonte canônica dos itens, com o pedido (`order_items`) como espelho automático, permitindo editar itens a partir das duas telas com propagação para frente (OS) e para trás (pedido), e garantindo `produto`+`tipo_producao` em cada item.

**Architecture:** `orcamento_itens` ganha `produto`/`especificacao`. O CRUD de item do orçamento passa a gravar produto/tipo/especificação e renumerar `codigo`. Um helper `_rebuildOrderItems(orcamentoId)` reconstrói o `order_items` do pedido vinculado após qualquer alteração de item. No dashboard, adicionar/editar item do orçamento usa o combo de produto, e o modal "Editar Pedido" ganha a seção de itens (mesmos endpoints do orçamento).

**Tech Stack:** Express, pg (pool), dashboard HTML vanilla.

**Convenções (iguais aos OS/M anteriores):**
- Migrations em `sql/migrations/NNN_*.sql`, aplicadas MANUALMENTE via psql no VPS. **Próxima livre: 035** (033/034 já usadas).
- Sem postgres local — verificar com `node --check` + smoke server-side no VPS (`node -r dotenv/config -e '...'`) + smoke HTTP. Smokes que criam linhas DEVEM limpar no fim.
- Deploy: `rsync -az <arquivo> root@2.25.147.243:/var/www/lkl-chatbot/<arquivo>` + `pm2 restart lkl-chatbot --update-env`.
- Módulos v2 em `/api/v2`. Commit body termina com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Mapa de arquivos:**
- `sql/migrations/035_orcamento_itens_produto.sql` — produto + especificacao.
- `src/modules/orcamentos/service.js` — `_rebuildOrderItems` (exportado).
- `src/modules/orcamentos/router.js` — CRUD de itens (produto/tipo/especificação, codigo, chamar rebuild).
- `public/dashboard.html` — modais de item do orçamento (combo) + seção de itens no "Editar Pedido".

**Helpers JS já existentes no dashboard:** `PRODUTOS_LKL`, `selectProduto(id,onchange)`, `tipoPorProduto(nome)`, `campoTipoProd(id)`, `api`, `showModal`, `closeModal`, `showToast`, `escHtml`. O orçamento item add/edit já recarrega via `renderOrcItens(orcId, itens)`.

---

## Task 1: Migration 035 — produto + especificacao em orcamento_itens

**Files:** Create `sql/migrations/035_orcamento_itens_produto.sql`

- [ ] **Step 1: Criar o arquivo**

`sql/migrations/035_orcamento_itens_produto.sql`:
```sql
-- Item do orçamento ganha produto e especificação estruturados (descricao continua derivada)
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS produto       VARCHAR(150);
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS especificacao VARCHAR(255);
```

- [ ] **Step 2: Aplicar no VPS**

```bash
cat sql/migrations/035_orcamento_itens_produto.sql | ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot"
```
Esperado: `ALTER TABLE` ×2.

- [ ] **Step 3: Verificar**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -t -c \"SELECT column_name FROM information_schema.columns WHERE table_name='orcamento_itens' AND column_name IN ('produto','especificacao');\""
```
Esperado: `produto` e `especificacao`.

- [ ] **Step 4: Commit**

```bash
git add sql/migrations/035_orcamento_itens_produto.sql
git commit -m "feat(m12): migration — produto e especificacao em orcamento_itens"
```

---

## Task 2: `_rebuildOrderItems` no service + wiring no CRUD de itens

**Files:**
- Modify: `src/modules/orcamentos/service.js`
- Modify: `src/modules/orcamentos/router.js`

- [ ] **Step 1: Adicionar `_rebuildOrderItems` em service.js e exportá-lo**

READ `src/modules/orcamentos/service.js`. Adicionar a função antes do `module.exports` e incluí-la nos exports:
```javascript
// Reconstrói order_items (espelho) do pedido vinculado a partir de orcamento_itens (canônico)
async function _rebuildOrderItems(orcamentoId) {
  try {
    const ped = await db.query('SELECT id FROM orders WHERE orcamento_id=$1 LIMIT 1', [orcamentoId]);
    const pedidoId = ped.rows[0]?.id;
    if (!pedidoId) return;
    const itens = await db.query(
      'SELECT produto, descricao, quantidade, especificacao, valor_unitario, valor_total FROM orcamento_itens WHERE orcamento_id=$1 ORDER BY codigo',
      [orcamentoId]
    );
    await db.query('DELETE FROM order_items WHERE order_id=$1', [pedidoId]);
    for (const it of itens.rows) {
      await db.query(
        `INSERT INTO order_items (order_id, produto, quantidade, especificacao, valor_unitario, valor_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [pedidoId, it.produto || it.descricao, it.quantidade, it.especificacao || null, it.valor_unitario || 0, it.valor_total || 0]
      );
    }
    // resumo do pedido = 1º item
    const p = itens.rows[0];
    if (p) {
      await db.query('UPDATE orders SET produto=$1, quantidade=$2, updated_at=NOW() WHERE id=$3',
        [p.produto || p.descricao, p.quantidade, pedidoId]);
    }
  } catch (e) {
    console.warn('[REBUILD-ORDER-ITEMS]', e.message);
  }
}
```
No `module.exports`, acrescentar `_rebuildOrderItems`.

- [ ] **Step 2: Atualizar o `POST /:id/itens` (router) para produto/tipo/especificação + codigo + rebuild**

READ `src/modules/orcamentos/router.js`. Substituir o handler `router.post('/:id/itens', ...)` inteiro por:
```javascript
router.post('/:id/itens', requireRole('admin','gestor','atendente'), async (req, res) => {
  try {
    const { produto, tipo_producao, especificacao, quantidade, valor_unitario, valor_total } = req.body;
    let { descricao } = req.body;
    if (produto) descricao = especificacao ? `${produto} — ${especificacao}` : produto;
    if (!descricao || !quantidade) return res.status(400).json({ erro: ['produto/descrição e quantidade são obrigatórios'] });
    const cod = await db.query('SELECT COALESCE(MAX(codigo),0)+1 AS c FROM orcamento_itens WHERE orcamento_id=$1', [req.params.id]);
    const { rows } = await db.query(
      `INSERT INTO orcamento_itens (orcamento_id, codigo, produto, especificacao, descricao, tipo_producao, quantidade, valor_unitario, valor_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, cod.rows[0].c, produto || null, especificacao || null, descricao, tipo_producao || null, quantidade, valor_unitario || 0, valor_total || 0]
    );
    await db.query(`UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`, [req.params.id]);
    service._rebuildOrderItems(req.params.id);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ erro: [e.message] }); }
});
```
(Confirme que `service` está importado no topo do router — está, é usado em outras rotas.)

- [ ] **Step 3: Atualizar o `PATCH /:id/itens/:itemId` para produto/especificação + rebuild**

Substituir o handler `router.patch('/:id/itens/:itemId', ...)` inteiro por:
```javascript
router.patch('/:id/itens/:itemId', requireRole('admin','gestor','atendente'), async (req, res) => {
  try {
    const { produto, tipo_producao, especificacao, quantidade, valor_unitario, valor_total } = req.body;
    let { descricao } = req.body;
    if (produto !== undefined) descricao = especificacao ? `${produto} — ${especificacao}` : produto;
    const { rows } = await db.query(
      `UPDATE orcamento_itens SET
         produto=COALESCE($1,produto), especificacao=COALESCE($2,especificacao),
         descricao=COALESCE($3,descricao), tipo_producao=COALESCE($4,tipo_producao),
         quantidade=COALESCE($5,quantidade), valor_unitario=COALESCE($6,valor_unitario), valor_total=COALESCE($7,valor_total)
       WHERE id=$8 AND orcamento_id=$9 RETURNING *`,
      [produto ?? null, especificacao ?? null, descricao ?? null, tipo_producao ?? null,
       quantidade ?? null, valor_unitario ?? null, valor_total ?? null, req.params.itemId, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ erro: ['Item não encontrado'] });
    await db.query(`UPDATE orcamentos SET total = (SELECT COALESCE(SUM(valor_total),0) FROM orcamento_itens WHERE orcamento_id=$1) WHERE id=$1`, [req.params.id]);
    service._rebuildOrderItems(req.params.id);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ erro: [e.message] }); }
});
```

- [ ] **Step 4: Chamar rebuild no DELETE**

No handler `router.delete('/:id/itens/:itemId', ...)`, após o `UPDATE orcamentos SET total ...` e antes do `res.json({ ok: true })`, adicionar:
```javascript
    service._rebuildOrderItems(req.params.id);
```

- [ ] **Step 5: Verificar sintaxe**

```bash
node --check src/modules/orcamentos/service.js && node --check src/modules/orcamentos/router.js && echo OK
```

- [ ] **Step 6: Deploy + smoke (add item com produto → reflete em order_items; descricao derivada; codigo sequencial)**

```bash
rsync -az src/modules/orcamentos/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/service.js
rsync -az src/modules/orcamentos/router.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/router.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const orders=require('./src/modules/orders/service'); const orc=require('./src/modules/orcamentos/service'); const db=require('./src/db');
(async()=>{
  const c=await db.query('SELECT id FROM clientes_lkl LIMIT 1');
  const r=await orders.criarOrder({origin_channel:'balcao',cliente_id:c.rows[0].id,observacoes:'T',itens:[{produto:'BANNER',tipo_producao:'COMUNICAÇÃO VISUAL',quantidade:1}]},null);
  const oid=r.order.orcamento_id;
  // simula o endpoint POST de item (mesma lógica): insere CARTÃO offset e reconstrói espelho
  const cod=await db.query('SELECT COALESCE(MAX(codigo),0)+1 c FROM orcamento_itens WHERE orcamento_id=\\\$1',[oid]);
  await db.query(\\\"INSERT INTO orcamento_itens (orcamento_id,codigo,produto,especificacao,descricao,tipo_producao,quantidade,valor_unitario,valor_total) VALUES (\\\$1,\\\$2,'CARTÃO DE VISITA','COUCHE 300G','CARTÃO DE VISITA — COUCHE 300G','OFFSET',1000,0,0)\\\",[oid,cod.rows[0].c]);
  await orc._rebuildOrderItems(oid);
  const oi=await db.query('SELECT produto,especificacao,quantidade FROM order_items WHERE order_id=\\\$1 ORDER BY created_at',[r.order.id]);
  const ci=await db.query('SELECT codigo,produto,tipo_producao FROM orcamento_itens WHERE orcamento_id=\\\$1 ORDER BY codigo',[oid]);
  console.log('order_items espelho:',JSON.stringify(oi.rows));
  console.log('orcamento_itens:',JSON.stringify(ci.rows));
  // limpeza
  await db.query('UPDATE orders SET orcamento_id=NULL WHERE id=\\\$1',[r.order.id]);
  await db.query('DELETE FROM orcamento_itens WHERE orcamento_id=\\\$1',[oid]);
  await db.query('DELETE FROM orcamentos WHERE id=\\\$1',[oid]);
  await db.query('DELETE FROM order_items WHERE order_id=\\\$1',[r.order.id]);
  await db.query('DELETE FROM orders WHERE id=\\\$1',[r.order.id]);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
\""
```
Esperado: `order_items espelho` com 2 itens (BANNER + CARTÃO DE VISITA com especificacao COUCHE 300G); `orcamento_itens` com codigo 1 e 2 (sequencial), CARTÃO com tipo_producao OFFSET.

- [ ] **Step 7: Commit**

```bash
git add src/modules/orcamentos/service.js src/modules/orcamentos/router.js
git commit -m "feat(m12): item do orçamento com produto/tipo + espelho automático no pedido"
```

---

## Task 3: Frontend — adicionar/editar item do orçamento com combo de produto

**Files:** Modify `public/dashboard.html`

- [ ] **Step 1: Substituir `abrirAdicionarItemOrc` e `adicionarItemOrc`**

READ as funções atuais. Substituir `abrirAdicionarItemOrc(orcId)` e `adicionarItemOrc(orcId)` por:
```javascript
function abrirAdicionarItemOrc(orcId) {
  const html = `
    <div style="margin-bottom:10px">${selectProduto('ni-produto', "document.getElementById('ni-tipo').value = tipoPorProduto(this.value)")}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
      ${campoTipoProd('ni-tipo')}
      <div><label style="font-size:12px;color:#666">Especificação</label>
        <input id="ni-espec" placeholder="Ex: 20X15 COM ARTE" oninput="this.value=this.value.toUpperCase()" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:13px;text-transform:uppercase"></div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:12px">
      <div style="flex:1"><label style="font-size:12px;color:#666">Qtd</label>
        <input id="ni-qtd" type="number" min="1" value="1" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:13px"></div>
      <div style="flex:1"><label style="font-size:12px;color:#666">Valor unitário (R$)</label>
        <input id="ni-val" type="number" step="0.01" min="0" value="0" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:13px"></div>
    </div>
    <button onclick="adicionarItemOrc('${orcId}')" class="btn btn-primary" style="width:100%">➕ Adicionar item</button>`;
  showModal('Novo Item', html);
}

async function adicionarItemOrc(orcId) {
  const produto = document.getElementById('ni-produto').value;
  if (!produto) { showToast('Selecione o produto/serviço'); return; }
  const especificacao = document.getElementById('ni-espec').value.trim() || null;
  const quantidade = parseFloat(document.getElementById('ni-qtd').value);
  const valor_unitario = parseFloat(document.getElementById('ni-val').value);
  if (isNaN(quantidade) || isNaN(valor_unitario)) { showToast('Preencha quantidade e valor'); return; }
  const res = await api(`/api/v2/orcamentos/${orcId}/itens`, {
    method: 'POST',
    body: JSON.stringify({ produto, tipo_producao: document.getElementById('ni-tipo').value || null, especificacao, quantidade, valor_unitario, valor_total: quantidade * valor_unitario })
  });
  if (res && !res.erro) {
    closeModal(); showToast('✅ Item adicionado');
    const panel = document.getElementById(`orc-items-${orcId}`);
    if (panel) { panel.dataset.loaded=''; panel.innerHTML = '<p style="padding:16px;color:#999;font-size:13px">Recarregando...</p>';
      const detail = await api(`/api/v2/orcamentos/${orcId}`); if (detail) renderOrcItens(orcId, detail.itens || []); }
  } else { showToast('❌ Erro ao adicionar: ' + (res?.erro?.[0]||'')); }
}
```

- [ ] **Step 2: Substituir `abrirEditarItemOrc` e `salvarItemOrc`**

A assinatura atual é `abrirEditarItemOrc(orcId, itemId, descricao, qtd, valorUnit)`. Manter a assinatura (chamada de `renderOrcItens`), mas o modal passa a ter produto+especificação. Como a chamada não passa produto/especificação separados, derivamos do `descricao` (split por " — "). Substituir as duas funções por:
```javascript
function abrirEditarItemOrc(orcId, itemId, descricao, qtd, valorUnit) {
  const partes = String(descricao||'').split(' — ');
  const prodGuess = partes[0] || '';
  const especGuess = partes.slice(1).join(' — ') || '';
  const html = `
    <div style="margin-bottom:10px">${selectProduto('ei-produto', "document.getElementById('ei-tipo').value = tipoPorProduto(this.value)")}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
      ${campoTipoProd('ei-tipo')}
      <div><label style="font-size:12px;color:#666">Especificação</label>
        <input id="ei-espec" value="${escHtml(especGuess)}" oninput="this.value=this.value.toUpperCase()" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:13px;text-transform:uppercase"></div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:12px">
      <div style="flex:1"><label style="font-size:12px;color:#666">Qtd</label>
        <input id="ei-qtd" type="number" min="1" value="${qtd}" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:13px"></div>
      <div style="flex:1"><label style="font-size:12px;color:#666">Valor unitário (R$)</label>
        <input id="ei-val" type="number" step="0.01" min="0" value="${valorUnit}" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-top:4px;font-size:13px"></div>
    </div>
    <button onclick="salvarItemOrc('${orcId}','${itemId}')" class="btn btn-primary" style="width:100%">💾 Salvar alterações</button>`;
  showModal('Editar Item', html);
  // pré-seleciona o produto se existir na lista
  const sel = document.getElementById('ei-produto');
  if (sel && [...sel.options].some(o => o.value === prodGuess)) { sel.value = prodGuess; document.getElementById('ei-tipo').value = tipoPorProduto(prodGuess); }
}

async function salvarItemOrc(orcId, itemId) {
  const produto = document.getElementById('ei-produto').value || null;
  const especificacao = document.getElementById('ei-espec').value.trim() || null;
  const quantidade = parseFloat(document.getElementById('ei-qtd').value);
  const valor_unitario = parseFloat(document.getElementById('ei-val').value);
  if (!produto) { showToast('Selecione o produto/serviço'); return; }
  if (isNaN(quantidade) || isNaN(valor_unitario)) { showToast('Preencha quantidade e valor'); return; }
  const res = await api(`/api/v2/orcamentos/${orcId}/itens/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ produto, tipo_producao: document.getElementById('ei-tipo').value || null, especificacao, quantidade, valor_unitario, valor_total: quantidade * valor_unitario })
  });
  if (res && !res.erro) {
    closeModal(); showToast('✅ Item atualizado');
    const panel = document.getElementById(`orc-items-${orcId}`);
    if (panel) { panel.dataset.loaded=''; panel.innerHTML = '<p style="padding:16px;color:#999;font-size:13px">Recarregando...</p>';
      const detail = await api(`/api/v2/orcamentos/${orcId}`); if (detail) renderOrcItens(orcId, detail.itens || []); }
  } else { showToast('❌ Erro ao salvar: ' + (res?.erro?.[0]||'')); }
}
```

- [ ] **Step 3: Verificação estrutural**

```bash
cd /Users/klebercamara/LKL
node -e "const s=require('fs').readFileSync('public/dashboard.html','utf8');console.log('div',((s.match(/<div/g)||[]).length),'/',((s.match(/<\/div>/g)||[]).length));console.log('ni-produto',s.includes(\"selectProduto('ni-produto'\"),'ei-produto',s.includes(\"selectProduto('ei-produto'\"));"
```
Esperado: divs balanceados; ambos `true`.

- [ ] **Step 4: Deploy + commit**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
git add public/dashboard.html
git commit -m "feat(m12): adicionar/editar item do orçamento com combo de produto"
```

---

## Task 4: Frontend — seção de itens no modal "Editar Pedido"

**Files:** Modify `public/dashboard.html` (`editarPedido`)

**Contexto:** `editarPedido(id)` (≈ linha 2822) monta o modal com email/celular/prazo/obs a partir de `o = ordersData.find(...)`. O objeto `o` tem `orcamento_id` e `orcamento_status`. Os itens são editados pelos endpoints do orçamento; aqui só listamos com atalhos.

- [ ] **Step 1: Acrescentar a seção ITENS ao modal de edição do pedido**

Em `editarPedido(id)`, após o bloco de Observações e antes do botão "Salvar alterações", inserir um container e, ao final da função (após `showModal(...)`), carregar os itens. READ a função para achar o ponto. Adicionar no HTML, logo antes do botão salvar:
```javascript
      <div style="margin-top:6px"><label style="font-size:11px;font-weight:600;text-transform:uppercase;color:#555;display:block;margin-bottom:4px">Itens (editados no orçamento)</label>
        <div id="ep-itens" style="border:1px solid #eee;border-radius:8px;padding:8px;font-size:13px;color:#888">Carregando itens...</div></div>
```
E logo após `showModal('Editar Pedido', html);` na função, adicionar:
```javascript
  carregarItensPedidoEdit(o.orcamento_id, o.orcamento_status);
```

- [ ] **Step 2: Função que lista os itens do orçamento no modal do pedido**

Adicionar:
```javascript
async function carregarItensPedidoEdit(orcId, orcStatus) {
  const box = document.getElementById('ep-itens');
  if (!box) return;
  if (!orcId) { box.innerHTML = '<span style="color:#999">Pedido sem orçamento vinculado.</span>'; return; }
  const travado = ['enviado','aprovado','reprovado','cancelado'].includes(orcStatus);
  const det = await api(`/api/v2/orcamentos/${orcId}`);
  const itens = det?.itens || [];
  const linhas = itens.map(it => `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #f3f3f3">
      <span style="flex:1">${escHtml(it.descricao||it.produto||'—')}</span>
      <span style="color:#666">${it.quantidade}</span>
      ${travado ? '' : `
      <button onclick="abrirEditarItemOrc('${orcId}','${it.id}','${escHtml(it.descricao||'').replace(/'/g,"\\'")}',${it.quantidade},${it.valor_unitario||0})" style="background:none;border:none;cursor:pointer;font-size:15px">✏️</button>
      <button onclick="excluirItemPedidoEdit('${orcId}','${it.id}','${escHtml(it.descricao||'').replace(/'/g,"\\'")}')" style="background:#e53935;border:none;border-radius:50%;width:22px;height:22px;color:white;cursor:pointer">−</button>`}
    </div>`).join('');
  box.innerHTML = `${linhas || '<span style="color:#999">Sem itens</span>'}
    ${travado ? '<div style="margin-top:6px;font-size:11px;color:#e65100">🔒 Orçamento aprovado — itens bloqueados</div>'
              : `<button onclick="abrirAdicionarItemPedidoEdit('${orcId}')" style="background:#43a047;border:none;border-radius:6px;color:white;font-size:12px;font-weight:600;padding:5px 10px;cursor:pointer;margin-top:6px">+ Adicionar item</button>`}`;
}

// Reusa os modais do orçamento, recarregando a lista do pedido ao fechar
function abrirAdicionarItemPedidoEdit(orcId) { _epOrcId = orcId; abrirAdicionarItemOrc(orcId); }
async function excluirItemPedidoEdit(orcId, itemId, desc) {
  if (!confirm(`Excluir item "${desc}"?`)) return;
  const res = await api(`/api/v2/orcamentos/${orcId}/itens/${itemId}`, { method: 'DELETE' });
  if (res && !res.erro) { showToast('🗑️ Item excluído'); carregarItensPedidoEdit(orcId, 'em_orcamento'); }
  else showToast('❌ Erro ao excluir');
}
```
Declarar `let _epOrcId = null;` junto das outras variáveis de estado (ex.: perto de `let _novoPedidoClienteId`).

> Observação: ao adicionar/editar item pelo modal do pedido, o item add/edit do orçamento recarrega o painel do orçamento (se aberto); a lista do pedido é atualizada ao reabrir o "Editar Pedido". É aceitável nesta fase. O essencial — gravar produto/tipo e reconstruir o espelho — já ocorre no backend (Task 2).

- [ ] **Step 3: Verificação estrutural**

```bash
cd /Users/klebercamara/LKL
node -e "const s=require('fs').readFileSync('public/dashboard.html','utf8');console.log('div',((s.match(/<div/g)||[]).length),'/',((s.match(/<\/div>/g)||[]).length));console.log('carregarItensPedidoEdit',s.includes('function carregarItensPedidoEdit'),'_epOrcId',s.includes('let _epOrcId'));"
```
Esperado: divs balanceados; ambos `true`.

- [ ] **Step 4: Deploy + commit**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
git add public/dashboard.html
git commit -m "feat(m12): seção de itens no modal Editar Pedido (via endpoints do orçamento)"
```

---

## Task 5: Smoke E2E + memória

**Files:** nenhum (validação)

- [ ] **Step 1: Smoke E2E backend (add via endpoint HTTP reflete no pedido)**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e \"
const jwt=require('jsonwebtoken'); const t=jwt.sign({id:'00000000-0000-0000-0000-000000000002',role:'admin',name:'T',email:'t@t.com'},process.env.JWT_SECRET);
const http=require('http'); const orders=require('./src/modules/orders/service'); const db=require('./src/db');
function post(path,body){return new Promise((rs,rj)=>{const d=JSON.stringify(body);const r=http.request({host:'127.0.0.1',port:3000,path,method:'POST',headers:{Authorization:'Bearer '+t,'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}},res=>{let x='';res.on('data',c=>x+=c);res.on('end',()=>rs(res.statusCode));});r.on('error',rj);r.write(d);r.end();});}
(async()=>{
  const c=await db.query('SELECT id FROM clientes_lkl LIMIT 1');
  const r=await orders.criarOrder({origin_channel:'balcao',cliente_id:c.rows[0].id,observacoes:'T',itens:[{produto:'BANNER',tipo_producao:'COMUNICAÇÃO VISUAL',quantidade:1}]},null);
  const oid=r.order.orcamento_id;
  const st=await post('/api/v2/orcamentos/'+oid+'/itens',{produto:'CARTÃO DE VISITA',tipo_producao:'OFFSET',especificacao:'COUCHE 300G',quantidade:1000,valor_unitario:0,valor_total:0});
  console.log('POST item status', st);
  const oi=await db.query('SELECT produto FROM order_items WHERE order_id=\\\$1 ORDER BY created_at',[r.order.id]);
  console.log('order_items reflete', oi.rows.length, 'itens:', oi.rows.map(x=>x.produto).join(', '));
  await db.query('UPDATE orders SET orcamento_id=NULL WHERE id=\\\$1',[r.order.id]);
  await db.query('DELETE FROM orcamento_itens WHERE orcamento_id=\\\$1',[oid]);
  await db.query('DELETE FROM orcamentos WHERE id=\\\$1',[oid]);
  await db.query('DELETE FROM order_items WHERE order_id=\\\$1',[r.order.id]);
  await db.query('DELETE FROM orders WHERE id=\\\$1',[r.order.id]);
  console.log('limpeza orders', (await db.query('SELECT count(*) FROM orders')).rows[0].count);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
\""
```
Esperado: `POST item status 201`, `order_items reflete 2 itens: BANNER, CARTÃO DE VISITA`, `limpeza orders <n anteriores>`.

- [ ] **Step 2: Fluxo manual no dashboard**

Criar pedido com 1 item → na aba Orçamentos, adicionar item via combo → confirmar que a aba Pedidos reflete (badge +N e produto) → aprovar → o item adicionado aparece em "Gerar OS Offset" (tem tipo_producao). Editar item pelo "Editar Pedido" (✏️) e confirmar propagação.

- [ ] **Step 3: Atualizar memória**

Editar `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`: registrar **M12 CONCLUÍDO** (orçamento canônico + espelho do pedido; item com produto/tipo; editável nas duas telas).

---

## Self-Review (cobertura do spec)

- ✅ produto/especificacao em orcamento_itens (migration 035 + Task 1)
- ✅ item CRUD grava produto/tipo/especificação + descricao derivada + codigo sequencial (Task 2)
- ✅ `_rebuildOrderItems` espelha no pedido após add/edit/delete (Task 2)
- ✅ combo de produto no add/edit do orçamento (Task 3)
- ✅ seção de itens no "Editar Pedido" usando os mesmos endpoints (Task 4)
- ✅ trava por status preservada (Task 4 front; backend não bloqueia explicitamente — a UI esconde os botões quando travado)
- ✅ itens avulsos (sem produto) ainda possíveis: o POST aceita `descricao` direto se `produto` ausente (Task 2)

**Consistência:** endpoints `/api/v2/orcamentos/:id/itens[/itemId]`; service `_rebuildOrderItems`; campos `produto,tipo_producao,especificacao,quantidade,valor_unitario,valor_total`; front `ni-produto/ni-tipo/ni-espec`, `ei-produto/ei-tipo/ei-espec`, `carregarItensPedidoEdit`.

**Nota:** o backend não rejeita edição de item de orçamento travado (a UI esconde os botões). Endurecer no backend (checar status antes de alterar item) é melhoria futura — fora do escopo do M12.
