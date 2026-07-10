# Novo Pedido — Seleção de SKU Específico do Catálogo de Revenda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o operador escolha um SKU específico do catálogo de revenda na tela "Novo Pedido" (hoje o combo nem carrega esses SKUs), e fazer o backend precificar direto por esse id em vez de tentar advinhar por texto — eliminando a causa raiz de itens como "BANNERS" ficarem com preço R$0 silenciosamente. Além disso, mostrar um aviso visível na listagem de pedidos quando um item ficar sem preço automático.

**Architecture:** Frontend (`public/dashboard.html`): `abrirNovoPedido()` carrega o catálogo de revenda antes de montar o combo (mesmo padrão já usado em "Novo Item"); `npColetarItens()` extrai `revenda_produto_id` do valor do combo quando o operador escolhe um SKU específico. Backend (`src/modules/orders/service.js`): `_normalizarItens`/`criarOrder` usam esse id diretamente (pulando o matching por texto) quando presente; `listar()` expõe um flag `sem_preco_auto` usado pra mostrar o aviso na listagem.

**Tech Stack:** Node.js/Express/PostgreSQL, HTML/JS vanilla (sem build step), Jest.

---

### Task 1: Backend — `criarOrder` usa `revenda_produto_id` quando presente

**Files:**
- Modify: `src/modules/orders/service.js:69-99` (`_normalizarItens`) e `:172-189` (bloco de auto-precificação em `criarOrder`)
- Create: `tests/orders-revenda-produto-id.test.js`

- [ ] **Step 1: Escrever os testes primeiro (vão falhar)**

Crie `tests/orders-revenda-produto-id.test.js`:

```js
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/modules/revenda/service', () => ({
  resolverProdutoRevenda: jest.fn(),
  precificarItemRevenda: jest.fn(),
}));

const db = require('../src/db');
const revendaService = require('../src/modules/revenda/service');
const { criarOrder } = require('../src/modules/orders/service');

describe('criarOrder — revenda_produto_id explícito', () => {
  afterEach(() => jest.clearAllMocks());

  test('item com revenda_produto_id → não chama resolverProdutoRevenda, precifica direto por esse id', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'order-1', cliente_id: 'cli-1', vendedor_id: 'vend-1' }] }) // INSERT orders
      .mockResolvedValueOnce({ rows: [] }) // INSERT order_items
      .mockResolvedValueOnce({ rows: [{ id: 'orc-1' }] }) // INSERT orcamentos
      .mockResolvedValueOnce({ rows: [{ id: 'sku-banner-240', nome: 'Banner | Lona Fosca 240g', estrategia: 'interno_m2' }] }) // SELECT revenda_produtos WHERE id=$1
      .mockResolvedValueOnce({ rows: [] }); // INSERT orcamento_itens

    revendaService.precificarItemRevenda.mockResolvedValueOnce({
      valor_unitario: 28.8, valor_total: 28.8, memoria: 'Bobina 1.6m...', estrategia: 'interno_m2',
    });

    await criarOrder({
      origin_channel: 'balcao',
      cliente_id: 'cli-1',
      itens: [{ produto: 'Banner | Lona Fosca 240g', revenda_produto_id: 'sku-banner-240', quantidade: 1, especificacao: '1,20 X 0,80' }],
    }, 'user-1');

    expect(revendaService.resolverProdutoRevenda).not.toHaveBeenCalled();
    expect(revendaService.precificarItemRevenda).toHaveBeenCalledWith(expect.objectContaining({ revenda_produto_id: 'sku-banner-240' }));
    const insertItem = db.query.mock.calls[4];
    expect(insertItem[0]).toMatch(/INSERT INTO orcamento_itens/);
    expect(insertItem[1]).toEqual(expect.arrayContaining([28.8, 28.8, 'auto']));
  });

  test('item sem revenda_produto_id → continua chamando resolverProdutoRevenda (comportamento inalterado)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'order-2', cliente_id: 'cli-1', vendedor_id: 'vend-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'orc-2' }] })
      .mockResolvedValueOnce({ rows: [] }); // INSERT orcamento_itens (sem match, valor 0)

    revendaService.resolverProdutoRevenda.mockResolvedValueOnce(null);

    await criarOrder({
      origin_channel: 'balcao',
      cliente_id: 'cli-1',
      itens: [{ produto: 'BANNERS', quantidade: 1, especificacao: '1,20 X 0,80' }],
    }, 'user-1');

    expect(revendaService.resolverProdutoRevenda).toHaveBeenCalledTimes(1);
    expect(revendaService.precificarItemRevenda).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npx jest tests/orders-revenda-produto-id.test.js --verbose`
Expected: FAIL — `_normalizarItens` ainda não repassa `revenda_produto_id`, e o bloco de precificação ainda sempre chama `resolverProdutoRevenda`.

- [ ] **Step 3: Adicionar `revenda_produto_id` em `_normalizarItens`**

Em `src/modules/orders/service.js`, localize `_normalizarItens` (linhas 69-99) e troque o bloco `.map(it => ({...}))`:

```js
function _normalizarItens(dados) {
  let itens = Array.isArray(dados.itens) ? dados.itens : [];
  itens = itens
    .map(it => ({
      produto: (it.produto || '').trim(),
      tipo_producao: it.tipo_producao || null,
      quantidade: parseInt(it.quantidade) || 1,
      especificacao: (it.especificacao || '').trim() || null,
      tem_arte: !!it.tem_arte,
      dimensoes: it.dimensoes || null,
      material: it.material || null,
      largura_cm: it.largura_cm != null ? it.largura_cm : null,
      altura_cm: it.altura_cm != null ? it.altura_cm : null,
      material_id: it.material_id || null,
      revenda_produto_id: it.revenda_produto_id || null,
    }))
    .filter(it => it.produto);
  if (!itens.length && dados.produto) {
    itens = [{
      produto: dados.produto,
      tipo_producao: dados.tipo_producao || null,
      quantidade: parseInt(dados.quantidade) || 1,
      especificacao: null,
      tem_arte: dados.tem_arte || false,
      dimensoes: dados.dimensoes || null,
      material: dados.material || null,
      largura_cm: null,
      altura_cm: null,
      material_id: null,
      revenda_produto_id: null,
    }];
  }
  return itens;
}
```

- [ ] **Step 4: Usar `revenda_produto_id` no bloco de auto-precificação de `criarOrder`**

No mesmo arquivo, localize o bloco (dentro do `for (const it of itens)` de `criarOrder`, linhas ~172-189):

```js
      // Auto-precificação (rascunho): casa o item a um SKU e usa o motor de preço da revenda.
      let valorUnit = 0, valorTotal = 0, precoOrigem = 'manual', precoMemoria = null, revProdId = null;
      try {
        const prod = await revendaService.resolverProdutoRevenda({ produto: it.produto, material: it.material, tipo_producao: tipo, largura_cm: larg, altura_cm: alt, impressao: it.impressao, especificacao: it.especificacao });
        if (prod && prod.estrategia !== 'manual') {
          const calc = await revendaService.precificarItemRevenda({
            revenda_produto_id: prod.id, quantidade: it.quantidade,
            largura_cm: larg, altura_cm: alt, prazo_horas: null, acabamentos: [], dobras: it.dobras,
          });
          if (calc && Number(calc.valor_total) > 0) {
            valorUnit = calc.valor_unitario; valorTotal = calc.valor_total;
            precoOrigem = 'auto'; revProdId = prod.id;
            precoMemoria = `${calc.estrategia} · ${prod.nome}${calc.memoria ? ` · ${calc.memoria}` : ''}`;
          }
        }
      } catch (e) {
        console.warn('[CHATBOT-PRECO] auto-precificação falhou:', e.message);
      }
```

Substitua por:

```js
      // Auto-precificação (rascunho): usa o SKU escolhido explicitamente pelo operador (revenda_produto_id),
      // ou tenta casar por texto (resolverProdutoRevenda) quando nenhum SKU específico foi informado.
      let valorUnit = 0, valorTotal = 0, precoOrigem = 'manual', precoMemoria = null, revProdId = null;
      try {
        let prod = null;
        if (it.revenda_produto_id) {
          const r = await db.query('SELECT id, nome, estrategia FROM revenda_produtos WHERE id=$1 AND ativo=TRUE', [it.revenda_produto_id]);
          prod = r.rows[0] || null;
        } else {
          prod = await revendaService.resolverProdutoRevenda({ produto: it.produto, material: it.material, tipo_producao: tipo, largura_cm: larg, altura_cm: alt, impressao: it.impressao, especificacao: it.especificacao });
        }
        if (prod && prod.estrategia !== 'manual') {
          const calc = await revendaService.precificarItemRevenda({
            revenda_produto_id: prod.id, quantidade: it.quantidade,
            largura_cm: larg, altura_cm: alt, prazo_horas: null, acabamentos: [], dobras: it.dobras,
          });
          if (calc && Number(calc.valor_total) > 0) {
            valorUnit = calc.valor_unitario; valorTotal = calc.valor_total;
            precoOrigem = 'auto'; revProdId = prod.id;
            precoMemoria = `${calc.estrategia} · ${prod.nome}${calc.memoria ? ` · ${calc.memoria}` : ''}`;
          }
        }
      } catch (e) {
        console.warn('[CHATBOT-PRECO] auto-precificação falhou:', e.message);
      }
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `npx jest tests/orders-revenda-produto-id.test.js --verbose`
Expected: PASS (2 testes).

- [ ] **Step 6: Rodar a suíte completa como checagem de sanidade**

Run: `npx jest 2>&1 | tail -10`
Expected: mesma baseline conhecida (6 suítes falhando por falta de Postgres local) + os 2 testes novos passando (não fazem parte das suítes que dependem de banco real).

- [ ] **Step 7: Commit**

```bash
git add src/modules/orders/service.js tests/orders-revenda-produto-id.test.js
git commit -m "feat(orders): criarOrder usa revenda_produto_id explicito quando informado, sem advinhar por texto"
```

---

### Task 2: Backend — `listar()` expõe flag `sem_preco_auto`

**Files:**
- Modify: `src/modules/orders/service.js:289-323` (`listar`)

Este arquivo não tem suíte automatizada pra `listar()` hoje (mesmo padrão de `criarOrder` antes da Task 1) — verificação por leitura + smoke manual (Task 5).

- [ ] **Step 1: Adicionar a subquery `sem_preco_auto` na query principal de `listar()`**

Em `src/modules/orders/service.js`, dentro de `listar()`, localize a query principal (por volta da linha 307-321):

```js
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT o.*,
              c.nome   AS cliente_nome,
              c.celular AS cliente_celular,
              c.email  AS cliente_email,
              u.name   AS vendedor_nome,
              orc.numero AS orcamento_numero,
              orc.status AS orcamento_status,
              orc.status_pagamento AS pagamento_status,
              (SELECT COALESCE(SUM(i.valor_total),0) FROM orcamento_itens i WHERE i.orcamento_id = orc.id) AS orcamento_total,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS itens_count
       FROM orders o
       LEFT JOIN clientes_lkl c  ON c.id  = o.cliente_id
       LEFT JOIN users u          ON u.id  = o.vendedor_id
       LEFT JOIN orcamentos orc   ON orc.id = o.orcamento_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    ),
```

Troque por (adiciona uma linha na lista de colunas do SELECT, nada mais muda):

```js
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT o.*,
              c.nome   AS cliente_nome,
              c.celular AS cliente_celular,
              c.email  AS cliente_email,
              u.name   AS vendedor_nome,
              orc.numero AS orcamento_numero,
              orc.status AS orcamento_status,
              orc.status_pagamento AS pagamento_status,
              (SELECT COALESCE(SUM(i.valor_total),0) FROM orcamento_itens i WHERE i.orcamento_id = orc.id) AS orcamento_total,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS itens_count,
              EXISTS(SELECT 1 FROM orcamento_itens i WHERE i.orcamento_id = orc.id AND i.preco_origem = 'manual' AND i.valor_total = 0) AS sem_preco_auto
       FROM orders o
       LEFT JOIN clientes_lkl c  ON c.id  = o.cliente_id
       LEFT JOIN users u          ON u.id  = o.vendedor_id
       LEFT JOIN orcamentos orc   ON orc.id = o.orcamento_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    ),
```

`sem_preco_auto` fica `true` quando existe pelo menos 1 item do orçamento vinculado com `preco_origem='manual'` e `valor_total=0` — a assinatura exata de "a precificação automática não encontrou nada e ninguém preencheu manualmente ainda".

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check src/modules/orders/service.js`
Expected: sem erro.

- [ ] **Step 3: Commit**

```bash
git add src/modules/orders/service.js
git commit -m "feat(orders): listar() expoe flag sem_preco_auto pra avisar quando item ficou sem preco automatico"
```

---

### Task 3: Frontend — "Novo Pedido" carrega catálogo e captura `revenda_produto_id`

**Files:**
- Modify: `public/dashboard.html:4961-4975` (`npColetarItens`) e `:4977-5017` (`abrirNovoPedido`)

Arquivo sem suíte de testes automatizada (mesmo padrão de todo o painel administrativo) — verificação por leitura + checagem de sintaxe do script inline.

- [ ] **Step 1: `npColetarItens()` extrai `revenda_produto_id`**

Em `public/dashboard.html`, substitua a função inteira (linhas 4961-4975):

```js
function npColetarItens() {
  const itens = [];
  document.querySelectorAll('#np-itens .np-item-row').forEach(row => {
    const i = row.dataset.idx;
    const produto = document.getElementById('np-produto-' + i)?.value || '';
    if (!produto) return;
    itens.push({
      produto,
      tipo_producao: document.getElementById('np-tipo-' + i)?.value || null,
      quantidade: parseInt(document.getElementById('np-qtd-' + i)?.value) || null,
      especificacao: document.getElementById('np-espec-' + i)?.value?.trim() || null,
    });
  });
  return itens;
}
```

Por:

```js
function npColetarItens() {
  const itens = [];
  document.querySelectorAll('#np-itens .np-item-row').forEach(row => {
    const i = row.dataset.idx;
    const produtoRaw = document.getElementById('np-produto-' + i)?.value || '';
    if (!produtoRaw) return;
    const revSel = produtoRaw.startsWith('revenda:');
    const revenda_produto_id = revSel ? produtoRaw.slice(8) : null;
    const produto = revSel
      ? (REVENDA_CATALOGO.find(x => String(x.id) === revenda_produto_id)?.nome || 'Revenda')
      : produtoRaw;
    itens.push({
      produto,
      revenda_produto_id,
      tipo_producao: document.getElementById('np-tipo-' + i)?.value || null,
      quantidade: parseInt(document.getElementById('np-qtd-' + i)?.value) || null,
      especificacao: document.getElementById('np-espec-' + i)?.value?.trim() || null,
    });
  });
  return itens;
}
```

- [ ] **Step 2: `abrirNovoPedido()` carrega o catálogo de revenda antes de montar o combo**

Em `public/dashboard.html`, localize a função (linhas 4977-5017) e troque a assinatura e a primeira linha do corpo:

```js
function abrirNovoPedido() {
  _novoPedidoClienteId = null;
  _npItemSeq = 0;
  document.getElementById('modal-cadastro-title').textContent = 'Novo Pedido';
```

Por:

```js
async function abrirNovoPedido() {
  _novoPedidoClienteId = null;
  _npItemSeq = 0;
  await carregarCatalogoRevenda();
  document.getElementById('modal-cadastro-title').textContent = 'Novo Pedido';
```

(O resto da função — todo o HTML do modal, `npAddItem()`, `npAtualizarCamposContato()` no final — continua exatamente igual, sem nenhuma outra mudança.)

- [ ] **Step 3: Verificar sintaxe do script**

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/dashboard.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const target = scripts.find(m => m[1].includes('abrirNovoPedido'));
fs.writeFileSync('/tmp/np-script-check.js', target[1]);
"
node --check /tmp/np-script-check.js
```

Expected: sem saída (sintaxe válida).

- [ ] **Step 4: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(orders): Novo Pedido carrega catalogo de revenda e captura revenda_produto_id ao escolher SKU especifico"
```

---

### Task 4: Frontend — badge de aviso "sem preço automático" na listagem de pedidos

**Files:**
- Modify: `public/dashboard.html:4725-4733` (`pedidoStatusBadges`)

- [ ] **Step 1: Adicionar o badge em `pedidoStatusBadges`**

Em `public/dashboard.html`, substitua a função inteira (linhas 4725-4733):

```js
function pedidoStatusBadges(o) {
  const prod = `<span style="background:${statusColor(o.status)};color:white;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600">${statusLabel(o.status)}</span>`;
  const pg = o.pagamento_status;
  if (pg !== 'pago' && pg !== 'aguardando_pagamento') return prod;
  const pgLabel = pg === 'pago' ? 'Pago' : 'Aguard. pagamento';
  const pgColor = pg === 'pago' ? '#16a34a' : '#f97316';
  const pgBadge = `<span style="background:${pgColor};color:white;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600;margin-left:4px">${pgLabel}</span>`;
  return `${prod}${pgBadge}`;
}
```

Por:

```js
function pedidoStatusBadges(o) {
  const prod = `<span style="background:${statusColor(o.status)};color:white;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600">${statusLabel(o.status)}</span>`;
  const semPrecoBadge = o.sem_preco_auto
    ? `<span title="Nenhum item deste pedido foi precificado automaticamente — confira o orçamento" style="background:#f59e0b;color:white;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600;margin-left:4px">⚠️ sem preço automático</span>`
    : '';
  const pg = o.pagamento_status;
  if (pg !== 'pago' && pg !== 'aguardando_pagamento') return `${prod}${semPrecoBadge}`;
  const pgLabel = pg === 'pago' ? 'Pago' : 'Aguard. pagamento';
  const pgColor = pg === 'pago' ? '#16a34a' : '#f97316';
  const pgBadge = `<span style="background:${pgColor};color:white;padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600;margin-left:4px">${pgLabel}</span>`;
  return `${prod}${pgBadge}${semPrecoBadge}`;
}
```

- [ ] **Step 2: Verificar sintaxe do script**

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('public/dashboard.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const target = scripts.find(m => m[1].includes('pedidoStatusBadges'));
fs.writeFileSync('/tmp/badge-script-check.js', target[1]);
"
node --check /tmp/badge-script-check.js
```

Expected: sem saída (sintaxe válida).

- [ ] **Step 3: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(orders): badge de aviso na listagem quando pedido tem item sem preco automatico"
```

---

### Task 5: Deploy no VPS + smoke test manual

**Files:** nenhum (só deploy e verificação)

- [ ] **Step 1: Rodar a suíte completa localmente**

```bash
npx jest 2>&1 | tail -10
```

Expected: mesma baseline conhecida (6 suítes falhando por falta de Postgres local, nada relacionado a este plano) + `tests/orders-revenda-produto-id.test.js` passando.

- [ ] **Step 2: Deploy**

Este deploy toca produção — confirmar com o usuário (AskUserQuestion) antes do rsync.

```bash
rsync -av src/modules/orders/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orders/service.js
rsync -av public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
ssh root@2.25.147.243 "md5sum /var/www/lkl-chatbot/src/modules/orders/service.js /var/www/lkl-chatbot/public/dashboard.html"
```

Comparar os checksums com `md5 src/modules/orders/service.js public/dashboard.html` local antes de prosseguir — se não baterem, reenviar o arquivo que divergiu antes de reiniciar o pm2 (já aconteceu de um rsync falhar silenciosamente numa deploy anterior desta mesma sessão).

- [ ] **Step 3: Reiniciar o pm2** (necessário — `orders/service.js` é código de servidor)

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env && sleep 2 && pm2 logs lkl-chatbot --lines 15 --nostream --err"
```

Expected: processo `online`, sem erro no log.

- [ ] **Step 4: Smoke test manual no navegador (produção)**

Acessar `https://chatbot.klebercamaraconsultoria.cloud/dashboard`, ir em Pedidos, clicar "+ Novo Pedido", e confirmar:

1. No combo "PRODUTO/SERVIÇO" do item, o grupo "🛰️ Revenda (Graficonauta)" aparece com os SKUs (ex: "🛰️ Banner | Lona Fosca 240g [sign19p8]") — antes do fix, esse grupo não aparecia.
2. Escolher um SKU específico de banner, preencher cliente/quantidade/observações, salvar.
3. Abrir o orçamento gerado (via "Ver Orc." na listagem de pedidos) e confirmar que o item tem valor calculado (não R$0).
4. Criar um segundo pedido escolhendo um produto genérico sem SKU equivalente no catálogo (ex: "NOTAS") — confirmar que aparece o badge "⚠️ sem preço automático" na listagem de pedidos pra esse pedido.
5. Confirmar que pedidos já existentes com preço correto (ex: pedido 41, já corrigido manualmente nesta sessão) **não** mostram o badge de aviso.

## Fora de escopo (reafirmado do spec)

- Algoritmo de matching por texto (`pontuarSku`/`tokensMaterial`) — não mexido.
- Cadastro dos 3 produtos sem SKU equivalente no catálogo (ETIQUETA ADESIVA, LÂMINAS, NOTAS).
- Mudanças na tela "Novo Item" (já funciona corretamente, usada como referência).
