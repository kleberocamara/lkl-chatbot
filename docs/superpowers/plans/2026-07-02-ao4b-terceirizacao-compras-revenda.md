# AO-4b — Terceirização: Compras na Revenda — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Organizar a compra dos itens terceirizados (revenda_matriz) no Graficonauta: listar "a comprar", agrupar numa compra com o nº do pedido, receber, e gerar a entrega ao cliente pelo fluxo do motorista.

**Architecture:** Módulo novo `revenda-compras` (service + router) + migration (revenda_compras/revenda_compra_itens). Reusa o módulo de OS só para a entrega (cria uma OS status='entrega' ao receber). UI nova aba "Compras Revenda".

**Tech Stack:** Node.js + Express, PostgreSQL (`pg`), frontend vanilla em `public/dashboard.html`.

**Spec:** `docs/superpowers/specs/2026-07-02-ao4b-terceirizacao-compras-revenda-design.md`

---

## File Structure

- **Create** `sql/migrations/047_revenda_compras.sql` — tabelas + sequence.
- **Create** `src/modules/revenda-compras/service.js` — itensACompra, criarCompra, receber, listar, detalhe.
- **Create** `src/modules/revenda-compras/router.js` — `/api/v2/revenda-compras`.
- **Modify** `src/modules/index.js` — registrar o módulo.
- **Modify** `public/dashboard.html` — aba "Compras Revenda".

> **Convenções:** sem Postgres local (integração = smoke VPS). Tabelas novas como `lkl_user`. `ordens_servico.tipo_servico` é VARCHAR(20) sem CHECK → `'revenda'` é válido. `numero_os` tem default `nextval('os_numero_seq')`. `api(path,{...})` no front usa `/api/v2/...` completo. Deploy = `rsync` + `pm2 restart lkl-chatbot --update-env`. Próxima migration livre: **047**.

---

## Task 1: Migration 047 — tabelas de compra

**Files:**
- Create: `sql/migrations/047_revenda_compras.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- 047_revenda_compras.sql — AO-4b terceirização (compras na revenda)
CREATE SEQUENCE IF NOT EXISTS revenda_compra_seq START 1;

CREATE TABLE IF NOT EXISTS revenda_compras (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero                INTEGER NOT NULL DEFAULT nextval('revenda_compra_seq'),
  status                VARCHAR(20) NOT NULL DEFAULT 'pedido_feito'
                        CHECK (status IN ('pedido_feito','recebido')),
  pedido_graficonauta   VARCHAR(60),
  cliente_id            UUID REFERENCES clientes_lkl(id) ON DELETE SET NULL,
  previsao_entrega      DATE,
  observacao            TEXT,
  responsavel_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  os_entrega_id         UUID REFERENCES ordens_servico(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  recebido_em           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS revenda_compra_itens (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id         UUID NOT NULL REFERENCES revenda_compras(id) ON DELETE CASCADE,
  orcamento_item_id UUID NOT NULL REFERENCES orcamento_itens(id) ON DELETE CASCADE,
  UNIQUE (orcamento_item_id)
);
CREATE INDEX IF NOT EXISTS idx_revenda_compra_itens_compra ON revenda_compra_itens(compra_id);
```

- [ ] **Step 2: Sanidade**

Run: `node -e "const s=require('fs').readFileSync('sql/migrations/047_revenda_compras.sql','utf8'); ['revenda_compra_seq','revenda_compras','revenda_compra_itens','pedido_graficonauta','os_entrega_id'].forEach(k=>{if(!new RegExp(k).test(s))throw new Error('falta '+k)}); console.log('OK 047');"`
Expected: `OK 047`

- [ ] **Step 3: Commit**

```bash
git add sql/migrations/047_revenda_compras.sql
git commit -m "feat(ao4b): migration 047 revenda_compras + revenda_compra_itens"
```

---

## Task 2: Service `revenda-compras`

**Files:**
- Create: `src/modules/revenda-compras/service.js`

- [ ] **Step 1: Implementar** `src/modules/revenda-compras/service.js`:

```javascript
const db = require('../../db');

// Itens elegíveis a comprar: revenda_matriz (tipo_producao='REVENDA'), orçamento aprovado,
// arte aprovada, e ainda não vinculados a nenhuma compra.
async function itensACompra() {
  const r = await db.query(
    `SELECT oi.id, oi.descricao, oi.quantidade, oi.arte_arquivo_url, oi.revenda_prazo_horas,
            orc.id AS orcamento_id, orc.numero AS numero_orcamento,
            cl.id AS cliente_id, cl.nome AS cliente_nome,
            rp.ref, rp.nome AS produto_revenda
     FROM orcamento_itens oi
     JOIN orcamentos orc ON orc.id = oi.orcamento_id
     LEFT JOIN clientes_lkl cl ON cl.id = orc.cliente_id
     LEFT JOIN revenda_produtos rp ON rp.id = oi.revenda_produto_id
     WHERE orc.status = 'aprovado'
       AND oi.tipo_producao = 'REVENDA'
       AND oi.arte_status = 'aprovada'
       AND NOT EXISTS (SELECT 1 FROM revenda_compra_itens rci WHERE rci.orcamento_item_id = oi.id)
     ORDER BY cl.nome, orc.numero, oi.codigo`
  );
  return r.rows;
}

async function criarCompra({ item_ids, pedido_graficonauta, previsao_entrega, observacao }, userId) {
  if (!Array.isArray(item_ids) || !item_ids.length) return { erro: ['Selecione ao menos um item'] };
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    // valida elegibilidade dos itens selecionados
    const val = await client.query(
      `SELECT oi.id, orc.cliente_id
       FROM orcamento_itens oi JOIN orcamentos orc ON orc.id = oi.orcamento_id
       WHERE oi.id = ANY($1) AND orc.status='aprovado' AND oi.tipo_producao='REVENDA' AND oi.arte_status='aprovada'
         AND NOT EXISTS (SELECT 1 FROM revenda_compra_itens rci WHERE rci.orcamento_item_id = oi.id)`,
      [item_ids]
    );
    if (val.rows.length !== item_ids.length) {
      await client.query('ROLLBACK');
      return { erro: ['Um ou mais itens não são elegíveis (não são revenda aprovada com arte, ou já estão em outra compra)'] };
    }
    const clienteId = val.rows[0].cliente_id || null;
    const compraR = await client.query(
      `INSERT INTO revenda_compras (status, pedido_graficonauta, cliente_id, previsao_entrega, observacao, responsavel_id)
       VALUES ('pedido_feito', $1, $2, $3, $4, $5) RETURNING id, numero`,
      [pedido_graficonauta || null, clienteId, previsao_entrega || null, observacao || null, userId || null]
    );
    const compraId = compraR.rows[0].id;
    for (const it of val.rows) {
      await client.query('INSERT INTO revenda_compra_itens (compra_id, orcamento_item_id) VALUES ($1,$2)', [compraId, it.id]);
    }
    await client.query('COMMIT');
    return { item: { id: compraId, numero: compraR.rows[0].numero } };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Marca recebido e gera a OS de entrega (reusa o board do motorista).
async function receber(compraId, userId) {
  const compra = (await db.query('SELECT id, status, cliente_id FROM revenda_compras WHERE id=$1', [compraId])).rows[0];
  if (!compra) return { erro: ['Compra não encontrada'] };
  if (compra.status === 'recebido') return { erro: ['Compra já recebida'] };

  const itens = (await db.query(
    `SELECT rci.orcamento_item_id, oi.quantidade
     FROM revenda_compra_itens rci JOIN orcamento_itens oi ON oi.id = rci.orcamento_item_id
     WHERE rci.compra_id = $1`, [compraId]
  )).rows;
  const qtdTotal = itens.reduce((s, i) => s + (parseInt(i.quantidade) || 0), 0);

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const osR = await client.query(
      `INSERT INTO ordens_servico (status, tipo_servico, cliente_id, quantidade)
       VALUES ('entrega', 'revenda', $1, $2) RETURNING id, numero_os`,
      [compra.cliente_id, qtdTotal]
    );
    const osId = osR.rows[0].id;
    for (const it of itens) {
      await client.query('INSERT INTO os_itens (os_id, orcamento_item_id) VALUES ($1,$2)', [osId, it.orcamento_item_id]);
    }
    await client.query('INSERT INTO os_historico (os_id, de_status, para_status, usuario_id) VALUES ($1,$2,$3,$4)', [osId, null, 'entrega', userId || null]);
    await client.query('UPDATE revenda_compras SET status=$2, recebido_em=NOW(), os_entrega_id=$3 WHERE id=$1', [compraId, 'recebido', osId]);
    await client.query('COMMIT');
    if (global.io) global.io.emit('nova_os', { os_id: osId });
    return { item: { compra_id: compraId, os_id: osId, numero_os: osR.rows[0].numero_os } };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listar({ status } = {}) {
  const params = []; let where = '';
  if (status) { params.push(status); where = 'WHERE c.status = $1'; }
  const compras = (await db.query(
    `SELECT c.*, cl.nome AS cliente_nome,
            (SELECT count(*) FROM revenda_compra_itens rci WHERE rci.compra_id = c.id) AS num_itens
     FROM revenda_compras c LEFT JOIN clientes_lkl cl ON cl.id = c.cliente_id
     ${where} ORDER BY c.created_at DESC`, params
  )).rows;
  return compras;
}

async function detalhe(id) {
  const compra = (await db.query('SELECT * FROM revenda_compras WHERE id=$1', [id])).rows[0];
  if (!compra) return null;
  compra.itens = (await db.query(
    `SELECT oi.id, oi.descricao, oi.quantidade, oi.arte_arquivo_url, rp.ref, rp.nome AS produto_revenda,
            orc.numero AS numero_orcamento
     FROM revenda_compra_itens rci
     JOIN orcamento_itens oi ON oi.id = rci.orcamento_item_id
     JOIN orcamentos orc ON orc.id = oi.orcamento_id
     LEFT JOIN revenda_produtos rp ON rp.id = oi.revenda_produto_id
     WHERE rci.compra_id = $1 ORDER BY oi.codigo`, [id]
  )).rows;
  return compra;
}

module.exports = { itensACompra, criarCompra, receber, listar, detalhe };
```

- [ ] **Step 2: Sanidade**

Run: `node -e "const s=require('./src/modules/revenda-compras/service'); console.log(Object.keys(s).sort().join(','))"`
Expected: `criarCompra,detalhe,itensACompra,listar,receber`

- [ ] **Step 3: Commit**

```bash
git add src/modules/revenda-compras/service.js
git commit -m "feat(ao4b): service de compras na revenda (itensACompra/criarCompra/receber gera OS entrega/listar/detalhe)"
```

---

## Task 3: Router + registro

**Files:**
- Create: `src/modules/revenda-compras/router.js`
- Modify: `src/modules/index.js`

- [ ] **Step 1: Implementar** `src/modules/revenda-compras/router.js`:

```javascript
const express = require('express');
const service = require('./service');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();
const equipe = requireRole('admin', 'gestor', 'atendente');
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); } };

router.get('/a-comprar', equipe, wrap(async (req, res) => res.json(await service.itensACompra())));

router.get('/', equipe, wrap(async (req, res) => res.json(await service.listar({ status: req.query.status }))));

router.get('/:id', equipe, wrap(async (req, res) => {
  const c = await service.detalhe(req.params.id);
  if (!c) return res.status(404).json({ error: 'Compra não encontrada' });
  res.json(c);
}));

router.post('/', equipe, wrap(async (req, res) => {
  const r = await service.criarCompra(req.body, req.user?.id);
  if (r.erro) return res.status(400).json({ errors: r.erro });
  res.status(201).json(r.item);
}));

router.patch('/:id/receber', equipe, wrap(async (req, res) => {
  const r = await service.receber(req.params.id, req.user?.id);
  if (r.erro) return res.status(400).json({ errors: r.erro });
  res.json(r.item);
}));

module.exports = router;
```

> Padrão de userId **confirmado**: `os/router.js` usa `req.user.id` (o middleware `requireAuthApi` popula `req.user`). `req.user?.id` aqui é equivalente e seguro.

- [ ] **Step 2: Registrar** em `src/modules/index.js` — após a linha do `revenda`:

```javascript
router.use('/revenda', requireAuthApi, require('./revenda/router'));
router.use('/revenda-compras', requireAuthApi, require('./revenda-compras/router'));
```

- [ ] **Step 3: Sanidade — aggregate carrega**

Run: `node -e "const r=require('./src/modules'); console.log('modules OK:', typeof r)"`
Expected: `modules OK: function`

- [ ] **Step 4: Commit**

```bash
git add src/modules/revenda-compras/router.js src/modules/index.js
git commit -m "feat(ao4b): router /api/v2/revenda-compras + registro"
```

---

## Task 4: UI — aba "Compras Revenda"

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Localizar âncoras**

Run: `grep -n "id: 'revenda'\|revenda:      loadRevenda\|<!-- REVENDA -->\|// ── REVENDA" public/dashboard.html | head`
Expected: imprime o item de NAV `revenda`, a entrada no mapa de loaders, a página `#page-revenda` e a seção JS de revenda. Anotar os números de linha.

- [ ] **Step 2: Item de NAV + loader**

No array `NAV`, logo após o item `{ id: 'revenda', ... }`, adicionar:
```javascript
    { id: 'revenda_compras', label: 'Compras Revenda', icon: '🛒', roles: ['admin','gestor','atendente'] },
```
No mapa de loaders, após `revenda:      loadRevenda,`, adicionar:
```javascript
    revenda_compras: loadComprasRevenda,
```

- [ ] **Step 3: Página `#page-revenda_compras`**

Logo após o fechamento da `<div class="page" id="page-revenda"> ... </div>`, inserir:
```html
  <!-- COMPRAS REVENDA -->
  <div class="page" id="page-revenda_compras">
    <div class="page-header"><div><h1>🛒 Compras Revenda (Graficonauta)</h1><p>Itens terceirizados a comprar e acompanhamento dos pedidos</p></div></div>
    <h3 style="margin:0 0 8px">A comprar</h3>
    <div id="rc-a-comprar">Carregando…</div>
    <button class="btn btn-primary" style="margin-top:8px" onclick="criarCompraRevenda()">🛒 Criar compra dos selecionados</button>
    <h3 style="margin:20px 0 8px">Compras</h3>
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <button class="btn btn-outline" onclick="loadComprasLista('pedido_feito')">Pedido feito</button>
      <button class="btn btn-outline" onclick="loadComprasLista('recebido')">Recebidas</button>
      <button class="btn btn-outline" onclick="loadComprasLista('')">Todas</button>
    </div>
    <div id="rc-compras">Carregando…</div>
  </div>
```

- [ ] **Step 4: Funções JS**

Adicionar no `<script>` (perto da seção de revenda):
```javascript
async function loadComprasRevenda() { loadAComprar(); loadComprasLista('pedido_feito'); }

async function loadAComprar() {
  const host = document.getElementById('rc-a-comprar'); if (!host) return;
  const itens = await api('/api/v2/revenda-compras/a-comprar');
  host.innerHTML = (Array.isArray(itens) && itens.length)
    ? '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#f5f7ff;text-align:left"><th style="padding:6px"></th><th style="padding:6px">Cliente</th><th style="padding:6px">Orç.</th><th style="padding:6px">Produto</th><th style="padding:6px">Ref</th><th style="padding:6px">Qtd</th><th style="padding:6px">Arte</th></tr></thead><tbody>'
      + itens.map(i => `<tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:6px"><input type="checkbox" class="rc-item" value="${i.id}"></td>
          <td style="padding:6px">${escHtml(i.cliente_nome || '-')}</td>
          <td style="padding:6px">#${i.numero_orcamento || '-'}</td>
          <td style="padding:6px">${escHtml(i.produto_revenda || i.descricao || '-')}</td>
          <td style="padding:6px">${escHtml(i.ref || '-')}</td>
          <td style="padding:6px">${i.quantidade}</td>
          <td style="padding:6px">${i.arte_arquivo_url ? `<a href="${i.arte_arquivo_url}" target="_blank">🖼️</a>` : '—'}</td>
        </tr>`).join('') + '</tbody></table>'
    : '<p style="color:#888;font-size:13px">Nenhum item terceirizado a comprar (aprovado + arte aprovada).</p>';
}

function criarCompraRevenda() {
  const ids = [...document.querySelectorAll('.rc-item:checked')].map(c => c.value);
  if (!ids.length) { showToast('Selecione ao menos um item'); return; }
  showModal('Criar compra na revenda', `
    <p style="font-size:13px;color:#666">${ids.length} item(ns) selecionado(s).</p>
    <label style="font-size:13px">Nº do pedido no Graficonauta<br><input id="rc-pedido" placeholder="ex.: 123456" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px"></label>
    <label style="font-size:13px">Previsão de entrega (opcional)<br><input id="rc-prev" type="date" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:8px"></label>
    <label style="font-size:13px">Observação (opcional)<br><input id="rc-obs" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px"></label>
    <button class="btn btn-primary" style="width:100%;margin-top:10px" onclick='salvarCompraRevenda(${JSON.stringify(ids)})'>Criar compra</button>`);
}
async function salvarCompraRevenda(ids) {
  const body = { item_ids: ids, pedido_graficonauta: document.getElementById('rc-pedido').value || null,
    previsao_entrega: document.getElementById('rc-prev').value || null, observacao: document.getElementById('rc-obs').value || null };
  const r = await api('/api/v2/revenda-compras', { method: 'POST', body: JSON.stringify(body) });
  if (r && !r.errors) { closeModal(); showToast('✅ Compra criada'); loadAComprar(); loadComprasLista('pedido_feito'); }
  else showToast('❌ ' + (r?.errors?.[0] || 'Erro'));
}

async function loadComprasLista(status) {
  const host = document.getElementById('rc-compras'); if (!host) return;
  const compras = await api('/api/v2/revenda-compras' + (status ? '?status=' + status : ''));
  host.innerHTML = (Array.isArray(compras) && compras.length)
    ? compras.map(c => `<div style="border:1px solid #eee;border-radius:8px;padding:10px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div><b>Compra #${c.numero}</b> · ${escHtml(c.cliente_nome || '-')} · ${c.num_itens} item(ns)
            ${c.pedido_graficonauta ? '· pedido ' + escHtml(c.pedido_graficonauta) : ''}
            <span style="padding:2px 8px;border-radius:10px;font-size:11px;background:${c.status === 'recebido' ? '#e8f5e9' : '#fff3e0'}">${c.status}</span></div>
          ${c.status === 'pedido_feito' ? `<button class="btn btn-outline" style="font-size:12px;padding:4px 10px" onclick="receberCompraRevenda('${c.id}')">📦 marcar recebido</button>` : ''}
        </div></div>`).join('')
    : '<p style="color:#888;font-size:13px">Nenhuma compra.</p>';
}
async function receberCompraRevenda(id) {
  const r = await api('/api/v2/revenda-compras/' + id + '/receber', { method: 'PATCH', body: '{}' });
  if (r && !r.errors) { showToast('✅ Recebido — entrega gerada'); loadComprasLista('pedido_feito'); }
  else showToast('❌ ' + (r?.errors?.[0] || 'Erro'));
}
```

- [ ] **Step 5: Verificar sintaxe dos `<script>`**

Run: `node -e "const h=require('fs').readFileSync('public/dashboard.html','utf8');const re=/<script[^>]*>([\s\S]*?)<\/script>/g;const cp=require('child_process');let m,i=0,f=0;while((m=re.exec(h))){i++;const c=m[1];if(!c.trim())continue;const t='/tmp/c'+i+'.js';require('fs').writeFileSync(t,c);try{cp.execSync('node --check '+t,{stdio:'pipe'})}catch(e){f++;console.log('script#'+i+' ERRO')}}console.log(f?'FAIL '+f:'ALL SCRIPTS OK')"`
Expected: `ALL SCRIPTS OK`

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(ao4b): aba Compras Revenda (a comprar -> criar compra -> receber)"
```

---

## Task 5: Deploy VPS + migration + smoke + memória

**Files:**
- Modify: `~/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Deploy + migration 047**

```bash
rsync -az --exclude node_modules --exclude .git --exclude backups --exclude 'tests/fixtures/revenda' /Users/klebercamara/LKL/ root@2.25.147.243:/var/www/lkl-chatbot/
ssh root@2.25.147.243 'set -a; . /var/www/lkl-chatbot/.env; set +a; PGPASSWORD="$DB_PASSWORD" psql -h localhost -U "$DB_USER" -d "$DB_NAME" -f /var/www/lkl-chatbot/sql/migrations/047_revenda_compras.sql'
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1; pm2 status lkl-chatbot | grep -oE 'online|errored'"
```
Expected: `CREATE SEQUENCE`/`CREATE TABLE` sem erro; app `online`.

- [ ] **Step 2: Sanidade das rotas no VPS**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -e \"require('./src/modules/revenda-compras/service'); require('./src/modules/revenda-compras/router'); require('./src/modules'); console.log('AO-4b modulos OK')\""
```
Expected: `AO-4b modulos OK`

- [ ] **Step 3: Smoke — itensACompra + fluxo (com dados reais se existirem)**

```bash
ssh root@2.25.147.243 'cd /var/www/lkl-chatbot && node -e "
require(\"dotenv\").config();
const svc=require(\"./src/modules/revenda-compras/service\");
(async()=>{
  const itens = await svc.itensACompra();
  console.log(\"a-comprar:\", itens.length, \"itens\");
  if (itens.length >= 1) {
    const c = await svc.criarCompra({ item_ids:[itens[0].id], pedido_graficonauta:\"SMOKE-001\" }, null);
    console.log(\"criarCompra:\", JSON.stringify(c));
    if (c.item) {
      const r = await svc.receber(c.item.id, null);
      console.log(\"receber (gera OS entrega):\", JSON.stringify(r));
    }
  } else { console.log(\"(sem itens terceirizados aprovados+arte para testar o fluxo completo — rotas OK)\"); }
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
"'
```
Expected: imprime a contagem de "a-comprar"; se houver item, cria a compra e o `receber` retorna `{compra_id, os_id, numero_os}` (OS de entrega criada). Se não houver item elegível, confirma só que as rotas carregam.

- [ ] **Step 4: Atualizar memória**

Acrescentar ao `project_sprint_status.md`: AO-4b concluído — módulo revenda-compras (rastreio assistido, sem checkout automático). Migration 047: revenda_compras (numero seq, status pedido_feito|recebido, pedido_graficonauta, cliente, os_entrega_id) + revenda_compra_itens (UNIQUE orcamento_item_id). service: itensACompra (REVENDA + orçamento aprovado + arte aprovada + fora de compra), criarCompra (operador agrupa + nº do pedido), receber (marca recebido + cria OS status='entrega' tipo_servico='revenda' → board do motorista, fecha por entregar()), listar/detalhe. router /api/v2/revenda-compras. Dashboard: aba 'Compras Revenda' (a comprar → criar compra com nº do pedido → marcar recebido). Smoke VPS. **CICLO DA REVENDA COMPLETO (AO-1..AO-4).** FORA DE ESCOPO: compra automática no site (robô/checkout/pagamento); lançar conta a pagar da compra; sincronizar status real do pedido do Graficonauta. Próxima migration livre: 048.

- [ ] **Step 5: Commit final**

```bash
git add -A
git commit -m "chore(ao4b): smoke VPS + memoria (ciclo da revenda completo)"
```

---

## Self-Review (autor do plano)

**Cobertura do spec:** tabelas compras/itens → Task 1 ✓; itensACompra/criarCompra/receber(OS entrega)/listar/detalhe → Task 2 ✓; rotas → Task 3 ✓; UI a-comprar/criar/receber → Task 4 ✓; deploy+smoke+memória → Task 5 ✓; entrega via OS status='entrega' tipo_servico='revenda' (reuso do motorista) ✓.

**Consistência:** `itensACompra/criarCompra/receber/listar/detalhe` idênticos em service, router e UI. Status `pedido_feito`/`recebido` iguais em migration, service, UI. `ordens_servico` INSERT segue o padrão de `criarOSComunicacaoVisual` (status/tipo_servico/cliente_id/quantidade + os_itens + os_historico); numero_os vem do default. `req.user?.id` a confirmar contra um router existente (Task 3 Step 1 nota).

**Notas:** sem testes puros (lógica é SQL) → validação por smoke no VPS (padrão do projeto). A Task 4 mexe no dashboard grande — usar as âncoras do Step 1 e checar o balanceamento de `<script>` no Step 5. `req.user` — se o projeto usa outro campo para o id do usuário logado, o implementador deve replicar o padrão de um router existente (ex.: `os/router.js`).
