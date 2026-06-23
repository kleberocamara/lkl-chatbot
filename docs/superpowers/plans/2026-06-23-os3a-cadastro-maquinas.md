# OS-3A — Cadastro de Máquinas + Seleção na OS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cadastrar máquinas de impressão offset e selecionar uma máquina (com operador padrão) por OS na ficha de produção.

**Architecture:** Novo catálogo `maquinas` (módulo espelhando `materiais`), duas colunas FK em `ordens_servico` (`maquina_id`, `operador_id`), integração na ficha de produção existente, e UI no `dashboard.html` (aba de cadastro + combos na ficha da OS).

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), vanilla-JS dashboard. Sem postgres local — verificação por `node --check` + smoke E2E no VPS (rsync + pm2).

**Convenções do projeto (importante):**
- Migrations em `sql/migrations/NNN_*.sql`; aplicadas manualmente via `psql` no VPS. Próximo número livre: **036**.
- Services retornam `{ chave }` em sucesso ou `{ erro: ['msg'] }` em falha de validação.
- Routers usam `requireRole(...)` de `../../middleware/auth`.
- Deploy: `rsync -az <arquivo> root@2.25.147.243:/var/www/lkl-chatbot/<arquivo>` + `ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"`.
- VPS smoke: `ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e '<js>'"`.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:**
- Create: `sql/migrations/036_maquinas.sql` — tabela `maquinas` + colunas em `ordens_servico`.
- Create: `src/modules/maquinas/service.js` — listar/buscarPorId/criar/atualizar.
- Create: `src/modules/maquinas/router.js` — CRUD REST.
- Modify: `src/modules/index.js` — registrar `/maquinas`.
- Modify: `src/modules/os/service.js` — `maquina_id`/`operador_id` na ficha + joins em `buscarPorId`.
- Modify: `public/dashboard.html` — aba Máquinas (CRUD) + combos na ficha da OS.

---

### Task 1: Migration 036 — tabela `maquinas` + colunas em `ordens_servico`

**Files:**
- Create: `sql/migrations/036_maquinas.sql`

- [ ] **Step 1: Escrever a migration**

Create `sql/migrations/036_maquinas.sql`:

```sql
-- OS-3A: cadastro de máquinas de impressão + vínculo na OS
CREATE TABLE IF NOT EXISTS maquinas (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome               VARCHAR(120) NOT NULL,
  fabricante         VARCHAR(80),
  modelo             VARCHAR(80),
  num_cores          INTEGER,
  formato_max_larg   NUMERIC(8,2),
  formato_max_alt    NUMERIC(8,2),
  velocidade_iph     INTEGER,
  operador_padrao_id UUID REFERENCES funcionarios(id) ON DELETE SET NULL,
  custo_lavagem      NUMERIC(10,2),
  status             VARCHAR(20) DEFAULT 'ativa' CHECK (status IN ('ativa','inativa')),
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS maquina_id  UUID REFERENCES maquinas(id) ON DELETE SET NULL;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS operador_id UUID REFERENCES funcionarios(id) ON DELETE SET NULL;
```

- [ ] **Step 2: Aplicar a migration no VPS**

Run:
```bash
rsync -az sql/migrations/036_maquinas.sql root@2.25.147.243:/var/www/lkl-chatbot/sql/migrations/036_maquinas.sql
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && psql \$DATABASE_URL -f sql/migrations/036_maquinas.sql"
```
Expected: saída `CREATE TABLE` e dois `ALTER TABLE` sem erro (re-execução é idempotente via IF NOT EXISTS).

- [ ] **Step 3: Verificar o schema no VPS**

Run:
```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && psql \$DATABASE_URL -c '\\d maquinas' -c 'SELECT column_name FROM information_schema.columns WHERE table_name=''ordens_servico'' AND column_name IN (''maquina_id'',''operador_id'') ORDER BY column_name'"
```
Expected: a tabela `maquinas` lista as colunas acima; a segunda query retorna `maquina_id` e `operador_id`.

- [ ] **Step 4: Commit**

```bash
git add sql/migrations/036_maquinas.sql
git commit -m "feat(os3a): migration 036 — tabela maquinas + maquina_id/operador_id na OS

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Módulo `maquinas` (service + router) + registro

**Files:**
- Create: `src/modules/maquinas/service.js`
- Create: `src/modules/maquinas/router.js`
- Modify: `src/modules/index.js`

- [ ] **Step 1: Criar o service**

Create `src/modules/maquinas/service.js`:

```js
const db = require('../../db');

async function listar({ busca, status, page = 1, limit = 50 } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { params.push(status); where += ` AND m.status = $${params.length}`; }
  if (busca) {
    params.push(`%${busca}%`);
    where += ` AND (m.nome ILIKE $${params.length} OR m.fabricante ILIKE $${params.length} OR m.modelo ILIKE $${params.length})`;
  }
  const offset = (page - 1) * limit;
  const base = `FROM maquinas m LEFT JOIN funcionarios f ON f.id = m.operador_padrao_id ${where}`;
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT m.*, f.nome AS operador_padrao_nome ${base}
       ORDER BY m.nome LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    db.query(`SELECT COUNT(*) ${base}`, params),
  ]);
  return { maquinas: rows.rows, total: parseInt(count.rows[0].count), page, limit };
}

async function buscarPorId(id) {
  const r = await db.query(
    `SELECT m.*, f.nome AS operador_padrao_nome
     FROM maquinas m LEFT JOIN funcionarios f ON f.id = m.operador_padrao_id
     WHERE m.id = $1`, [id]
  );
  return r.rows[0] || null;
}

function _validar(d) {
  if (!d.nome || !String(d.nome).trim()) return ['Nome é obrigatório'];
  for (const [campo, label] of [['num_cores','Nº de cores'],['velocidade_iph','Velocidade'],['custo_lavagem','Custo de lavagem'],['formato_max_larg','Formato (largura)'],['formato_max_alt','Formato (altura)']]) {
    if (d[campo] !== undefined && d[campo] !== null && d[campo] !== '' && !(parseFloat(d[campo]) >= 0)) {
      return [`${label} deve ser um número ≥ 0`];
    }
  }
  return null;
}

async function _operadorExiste(id) {
  if (!id) return true;
  const r = await db.query('SELECT 1 FROM funcionarios WHERE id = $1', [id]);
  return !!r.rows[0];
}

const _num = v => (v != null && v !== '' ? parseFloat(v) : null);
const _int = v => (v != null && v !== '' ? parseInt(v) : null);

async function criar(dados) {
  const erro = _validar(dados);
  if (erro) return { erro };
  if (!(await _operadorExiste(dados.operador_padrao_id))) return { erro: ['Operador padrão inválido'] };
  const r = await db.query(
    `INSERT INTO maquinas (nome, fabricante, modelo, num_cores, formato_max_larg, formato_max_alt,
       velocidade_iph, operador_padrao_id, custo_lavagem, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [dados.nome.trim(), dados.fabricante || null, dados.modelo || null, _int(dados.num_cores),
     _num(dados.formato_max_larg), _num(dados.formato_max_alt), _int(dados.velocidade_iph),
     dados.operador_padrao_id || null, _num(dados.custo_lavagem),
     dados.status === 'inativa' ? 'inativa' : 'ativa']
  );
  return { maquina: r.rows[0] };
}

async function atualizar(id, dados) {
  const existente = await buscarPorId(id);
  if (!existente) return { erro: ['Máquina não encontrada'] };
  const merged = { ...existente, ...dados };
  const erro = _validar(merged);
  if (erro) return { erro };
  if (!(await _operadorExiste(merged.operador_padrao_id))) return { erro: ['Operador padrão inválido'] };
  const r = await db.query(
    `UPDATE maquinas SET nome=$1, fabricante=$2, modelo=$3, num_cores=$4, formato_max_larg=$5,
       formato_max_alt=$6, velocidade_iph=$7, operador_padrao_id=$8, custo_lavagem=$9, status=$10, updated_at=NOW()
     WHERE id=$11 RETURNING *`,
    [merged.nome.trim(), merged.fabricante || null, merged.modelo || null, _int(merged.num_cores),
     _num(merged.formato_max_larg), _num(merged.formato_max_alt), _int(merged.velocidade_iph),
     merged.operador_padrao_id || null, _num(merged.custo_lavagem),
     merged.status === 'inativa' ? 'inativa' : 'ativa', id]
  );
  return { maquina: r.rows[0] };
}

module.exports = { listar, buscarPorId, criar, atualizar };
```

- [ ] **Step 2: Criar o router**

Create `src/modules/maquinas/router.js`:

```js
const express = require('express');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');

const router = express.Router();

// GET / — lista (qualquer autenticado: operador/atendente montam a OS)
router.get('/', async (req, res) => {
  try {
    const { busca, status, page, limit } = req.query;
    res.json(await service.listar({ busca, status, page: parseInt(page) || 1, limit: parseInt(limit) || 50 }));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const m = await service.buscarPorId(req.params.id);
    if (!m) return res.status(404).json({ error: 'Máquina não encontrada' });
    res.json(m);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.post('/', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.criar(req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.status(201).json(result.maquina);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.patch('/:id', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.atualizar(req.params.id, req.body);
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrada'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result.maquina);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
```

- [ ] **Step 3: Registrar no index.js**

Modify `src/modules/index.js` — adicionar após a linha do `funcionarios`:

```js
router.use('/funcionarios', requireAuthApi, require('./funcionarios/router'));
router.use('/maquinas', requireAuthApi, require('./maquinas/router'));
```

- [ ] **Step 4: node --check**

Run:
```bash
node --check src/modules/maquinas/service.js && node --check src/modules/maquinas/router.js && node --check src/modules/index.js && echo OK
```
Expected: `OK`.

- [ ] **Step 5: Deploy + smoke (criar/listar)**

Run:
```bash
rsync -az src/modules/maquinas/ root@2.25.147.243:/var/www/lkl-chatbot/src/modules/maquinas/
rsync -az src/modules/index.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/index.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const s=require('./src/modules/maquinas/service');
s.criar({nome:'Heidelberg SM 74',fabricante:'Heidelberg',num_cores:4,custo_lavagem:35.5}).then(r=>{
  if(r.erro){console.log('ERRO',r.erro);process.exit(1);}
  console.log('CRIADA',r.maquina.id,r.maquina.nome);
  return s.listar({status:'ativa'});
}).then(l=>{console.log('TOTAL',l.total);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)});
\""
```
Expected: `CRIADA <uuid> Heidelberg SM 74` e `TOTAL` ≥ 1.

- [ ] **Step 6: Commit**

```bash
git add src/modules/maquinas/ src/modules/index.js
git commit -m "feat(os3a): módulo maquinas (CRUD) + registro em /api/v2/maquinas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Integração na OS — ficha grava `maquina_id`/`operador_id` e detalhe retorna nomes

**Files:**
- Modify: `src/modules/os/service.js` (função `atualizarFichaProducao`, array `COLS` ~linha 369; função `buscarPorId`)

- [ ] **Step 1: Adicionar colunas ao COLS da ficha**

Modify `src/modules/os/service.js` — na função `atualizarFichaProducao`, no array `COLS`, acrescentar `'maquina_id'` e `'operador_id'` ao final:

```js
  const COLS = ['nro_jogos','nro_vias','tipo_unidade','frente_verso','numeracao_inicial',
    'numeracao_final','formato_corte','formato_corte_alt','formato_corte_larg','imagem_alt','imagem_larg',
    'imagens_folha','imagens_impressao','total_impressoes','cores_tintas','maquina_id','operador_id'];
```

- [ ] **Step 2: Adicionar joins em buscarPorId da OS**

Localizar a query principal de `buscarPorId` em `src/modules/os/service.js` (a que carrega a OS por id) e acrescentar os joins + colunas. Primeiro, inspecionar:

Run:
```bash
grep -n "async function buscarPorId" src/modules/os/service.js
```

Abrir a query SELECT dessa função e adicionar ao SELECT as colunas `mq.nome AS maquina_nome` e `op.nome AS operador_nome`, e ao FROM os joins:

```sql
LEFT JOIN maquinas mq   ON mq.id = os.maquina_id
LEFT JOIN funcionarios op ON op.id = os.operador_id
```

(o alias da tabela `ordens_servico` na query existente é `os`; usar o alias real caso difira — confirmar no grep do passo).

- [ ] **Step 3: node --check**

Run:
```bash
node --check src/modules/os/service.js && echo OK
```
Expected: `OK`.

- [ ] **Step 4: Deploy + smoke (vincular máquina a uma OS)**

Run:
```bash
rsync -az src/modules/os/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/os/service.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const os=require('./src/modules/os/service'); const mq=require('./src/modules/maquinas/service'); const db=require('./src/db');
(async()=>{
  const m=(await mq.listar({status:'ativa'})).maquinas[0];
  const r=await db.query('SELECT id FROM ordens_servico ORDER BY created_at DESC LIMIT 1');
  if(!r.rows[0]){console.log('SEM OS para testar (ok se banco vazio)');process.exit(0);}
  const osId=r.rows[0].id;
  await os.atualizarFichaProducao(osId,{maquina_id:m.id});
  const det=await os.buscarPorId(osId);
  console.log('OS',osId,'maquina_nome=',det.maquina_nome);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
\""
```
Expected: `OS <uuid> maquina_nome= Heidelberg SM 74` (ou `SEM OS para testar` se não houver OS — aceitável).

- [ ] **Step 5: Commit**

```bash
git add src/modules/os/service.js
git commit -m "feat(os3a): ficha da OS grava maquina_id/operador_id e detalhe retorna nomes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Dashboard — aba "Máquinas" (lista + cadastro)

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Inspecionar a estrutura de abas e o modelo da aba Materiais**

Run:
```bash
grep -n "Materiais\|Funcionários\|switchTab\|data-tab\|loadMateriais" public/dashboard.html | head -30
```
Identificar: (a) onde os botões/itens de menu são declarados, (b) o container das views/seções, (c) a função que troca de aba e a que carrega a lista de materiais (modelo a espelhar).

- [ ] **Step 2: Adicionar o item de menu e a seção da aba**

No bloco de navegação (junto de Materiais/Funcionários) adicionar o item "Máquinas" e, no container de seções, adicionar a `<section>` da aba com um cabeçalho, botão **+ Nova máquina** e um container de lista. Usar exatamente o mesmo padrão de markup das abas vizinhas (classes/ids equivalentes), apenas trocando o id base para `maquinas`:

```html
<section id="tab-maquinas" class="tab-section" style="display:none">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
    <h2 style="margin:0">Máquinas</h2>
    <button class="btn btn-primary" onclick="abrirMaquinaModal()">+ Nova máquina</button>
  </div>
  <input id="maq-busca" placeholder="Buscar por nome/fabricante…" oninput="loadMaquinas()"
         style="width:100%;padding:8px 12px;border:1px solid #ddd;border-radius:8px;margin-bottom:12px">
  <div id="maq-list">Carregando…</div>
</section>
```

(Se as abas do projeto usam `data-tab`/`switchTab`, registrar `maquinas` no mesmo mecanismo, espelhando a aba Materiais. Ajustar classes/ids para casar com o padrão real encontrado no Step 1.)

- [ ] **Step 3: Adicionar as funções JS da aba**

Adicionar (junto às demais funções de aba, ex.: perto de `loadMateriais`):

```js
let _funcionariosCache = null;
async function _getFuncionarios() {
  if (_funcionariosCache) return _funcionariosCache;
  const r = await api('/api/v2/funcionarios?limit=200');
  _funcionariosCache = r?.funcionarios || r?.items || r || [];
  return _funcionariosCache;
}

async function loadMaquinas() {
  const box = document.getElementById('maq-list');
  if (!box) return;
  const busca = (document.getElementById('maq-busca')?.value || '').trim();
  const r = await api(`/api/v2/maquinas?${busca ? 'busca=' + encodeURIComponent(busca) : ''}`);
  const list = r?.maquinas || [];
  if (!list.length) { box.innerHTML = '<p style="color:#999;padding:20px">Nenhuma máquina cadastrada</p>'; return; }
  box.innerHTML = list.map(m => {
    const fmt = (m.formato_max_larg && m.formato_max_alt) ? `${m.formato_max_larg}×${m.formato_max_alt} cm` : '—';
    const lav = m.custo_lavagem != null ? `R$ ${parseFloat(m.custo_lavagem).toLocaleString('pt-BR',{minimumFractionDigits:2})}` : '—';
    const chip = m.status === 'inativa'
      ? '<span style="background:#fce4ec;color:#c62828;padding:2px 8px;border-radius:12px;font-size:11px">inativa</span>'
      : '<span style="background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:12px;font-size:11px">ativa</span>';
    return `<div class="card" style="display:flex;align-items:center;gap:12px;padding:12px 16px;margin-bottom:8px">
      <div style="flex:1">
        <div style="font-weight:600">${escHtml(m.nome)} ${chip}</div>
        <div style="font-size:12px;color:#777">${escHtml([m.fabricante,m.modelo].filter(Boolean).join(' '))||'—'} · ${m.num_cores||'—'} cores · ${fmt} · op: ${escHtml(m.operador_padrao_nome||'—')} · lavagem: ${lav}</div>
      </div>
      <button onclick='abrirMaquinaModal(${JSON.stringify(m).replace(/'/g,"&#39;")})' style="background:none;border:none;cursor:pointer;font-size:16px">✏️</button>
    </div>`;
  }).join('');
}

async function abrirMaquinaModal(m) {
  const ed = m && m.id ? m : null;
  const funcs = await _getFuncionarios();
  const opts = ['<option value="">— sem operador padrão —</option>']
    .concat(funcs.map(f => `<option value="${f.id}" ${ed && ed.operador_padrao_id===f.id?'selected':''}>${escHtml(f.nome)}</option>`)).join('');
  const v = (k, d='') => ed && ed[k] != null ? ed[k] : d;
  const html = `
    <div style="display:grid;gap:10px">
      <label>Nome*<input id="mq-nome" value="${escHtml(String(v('nome')))}" style="width:100%"></label>
      <div style="display:flex;gap:8px">
        <label style="flex:1">Fabricante<input id="mq-fab" value="${escHtml(String(v('fabricante')))}" style="width:100%"></label>
        <label style="flex:1">Modelo<input id="mq-mod" value="${escHtml(String(v('modelo')))}" style="width:100%"></label>
      </div>
      <div style="display:flex;gap:8px">
        <label style="flex:1">Nº cores<input id="mq-cores" type="number" min="0" value="${v('num_cores')}" style="width:100%"></label>
        <label style="flex:1">Veloc. (imp/h)<input id="mq-vel" type="number" min="0" value="${v('velocidade_iph')}" style="width:100%"></label>
      </div>
      <div style="display:flex;gap:8px">
        <label style="flex:1">Formato máx larg (cm)<input id="mq-larg" type="number" step="0.01" min="0" value="${v('formato_max_larg')}" style="width:100%"></label>
        <label style="flex:1">Formato máx alt (cm)<input id="mq-alt" type="number" step="0.01" min="0" value="${v('formato_max_alt')}" style="width:100%"></label>
      </div>
      <label>Operador padrão<select id="mq-op" style="width:100%">${opts}</select></label>
      <div style="display:flex;gap:8px">
        <label style="flex:1">Custo lavagem (R$)<input id="mq-lav" type="number" step="0.01" min="0" value="${v('custo_lavagem')}" style="width:100%"></label>
        <label style="flex:1">Status<select id="mq-status" style="width:100%">
          <option value="ativa" ${v('status','ativa')==='ativa'?'selected':''}>ativa</option>
          <option value="inativa" ${v('status')==='inativa'?'selected':''}>inativa</option>
        </select></label>
      </div>
      <button class="btn btn-primary" onclick="salvarMaquina('${ed?ed.id:''}')">💾 Salvar</button>
    </div>`;
  showModal(ed ? 'Editar Máquina' : 'Nova Máquina', html);
}

async function salvarMaquina(id) {
  const payload = {
    nome: document.getElementById('mq-nome').value.trim(),
    fabricante: document.getElementById('mq-fab').value.trim() || null,
    modelo: document.getElementById('mq-mod').value.trim() || null,
    num_cores: document.getElementById('mq-cores').value || null,
    velocidade_iph: document.getElementById('mq-vel').value || null,
    formato_max_larg: document.getElementById('mq-larg').value || null,
    formato_max_alt: document.getElementById('mq-alt').value || null,
    operador_padrao_id: document.getElementById('mq-op').value || null,
    custo_lavagem: document.getElementById('mq-lav').value || null,
    status: document.getElementById('mq-status').value,
  };
  if (!payload.nome) { showToast('Nome é obrigatório', 'error'); return; }
  const res = id
    ? await api(`/api/v2/maquinas/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })
    : await api('/api/v2/maquinas', { method: 'POST', body: JSON.stringify(payload) });
  if (res?.errors || res?.error) { showToast('Erro: ' + (res.errors?.[0] || res.error), 'error'); return; }
  _funcionariosCache = null;
  closeModal();
  showToast('✅ Máquina salva!');
  loadMaquinas();
}
```

(Os nomes `api`, `showModal`, `closeModal`, `showToast`, `escHtml` já existem no dashboard — confirmar a assinatura de `showModal`/`closeModal` no Step 1 e ajustar se o projeto usar nomes diferentes.)

- [ ] **Step 4: Ligar o carregamento da aba**

No mecanismo de troca de abas (identificado no Step 1), garantir que ao abrir a aba "Máquinas" seja chamado `loadMaquinas()` (espelhando como Materiais chama `loadMateriais()`).

- [ ] **Step 5: Deploy**

Run:
```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```
Expected: rsync sem erro.

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(os3a): aba Máquinas (lista + cadastro) no dashboard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Dashboard — combos Máquina/Operador na ficha de produção da OS

**Files:**
- Modify: `public/dashboard.html` (tela de detalhe/ficha da OS)

- [ ] **Step 1: Localizar a ficha de produção da OS**

Run:
```bash
grep -n "producao\|atualizarFichaProducao\|os/:id/producao\|formato_corte\|cores_tintas\|renderOSDetalhe\|salvarFicha" public/dashboard.html | head -30
```
Identificar: a função que renderiza a ficha (campos como `formato_corte`, `cores_tintas`) e a função que envia `PATCH /api/v2/os/:id/producao`.

- [ ] **Step 2: Adicionar os combos Máquina/Operador na ficha**

No HTML da ficha (perto de `cores_tintas`), inserir dois selects. Carregar opções ao renderizar a ficha (usar `_getFuncionarios()` da Task 4 e uma nova `_getMaquinasAtivas()`):

```js
async function _getMaquinasAtivas() {
  const r = await api('/api/v2/maquinas?status=ativa&limit=200');
  return r?.maquinas || [];
}
```

Markup dos combos (inserir no template da ficha; `os` é o objeto da OS já carregado no detalhe):

```html
<label>Máquina
  <select id="ficha-maquina" onchange="onMaquinaChange()" style="width:100%"></select>
</label>
<label>Operador
  <select id="ficha-operador" style="width:100%"></select>
</label>
```

Após injetar o HTML da ficha, popular os selects:

```js
async function popularCombosFicha(os) {
  const [maquinas, funcs] = await Promise.all([_getMaquinasAtivas(), _getFuncionarios()]);
  window._maquinasFicha = maquinas;
  const selM = document.getElementById('ficha-maquina');
  selM.innerHTML = '<option value="">— selecione —</option>' +
    maquinas.map(m => `<option value="${m.id}" data-op="${m.operador_padrao_id||''}" ${os.maquina_id===m.id?'selected':''}>${escHtml(m.nome)}</option>`).join('');
  const selO = document.getElementById('ficha-operador');
  selO.innerHTML = '<option value="">— selecione —</option>' +
    funcs.map(f => `<option value="${f.id}" ${os.operador_id===f.id?'selected':''}>${escHtml(f.nome)}</option>`).join('');
}

function onMaquinaChange() {
  const selM = document.getElementById('ficha-maquina');
  const opId = selM.options[selM.selectedIndex]?.getAttribute('data-op') || '';
  const selO = document.getElementById('ficha-operador');
  if (opId && !selO.value) selO.value = opId;   // preenche operador padrão se ainda vazio
  if (opId) selO.value = opId;                   // ao trocar de máquina, sugere o operador dela
}
```

Chamar `popularCombosFicha(os)` logo após renderizar a ficha (no mesmo ponto em que os outros campos são preenchidos).

- [ ] **Step 3: Enviar maquina_id/operador_id ao salvar a ficha**

Na função que monta o payload do `PATCH /api/v2/os/:id/producao`, incluir:

```js
  maquina_id: document.getElementById('ficha-maquina')?.value || null,
  operador_id: document.getElementById('ficha-operador')?.value || null,
```

- [ ] **Step 4: Exibir Máquina/Operador no modo leitura da OS**

No bloco de cabeçalho/resumo do detalhe da OS, adicionar uma linha (usando os campos `maquina_nome`/`operador_nome` que `buscarPorId` agora retorna):

```js
`<div style="font-size:13px;color:#555">Máquina: ${escHtml(os.maquina_nome||'—')} · Operador: ${escHtml(os.operador_nome||'—')}</div>`
```

- [ ] **Step 5: Deploy + smoke E2E completo**

Run:
```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e \"
const os=require('./src/modules/os/service'); const mq=require('./src/modules/maquinas/service'); const db=require('./src/db');
(async()=>{
  const m=(await mq.listar({status:'ativa'})).maquinas[0];
  const r=await db.query('SELECT id FROM ordens_servico ORDER BY created_at DESC LIMIT 1');
  if(!r.rows[0]){console.log('SEM OS (ok)');process.exit(0);}
  await os.atualizarFichaProducao(r.rows[0].id,{maquina_id:m.id,operador_id:m.operador_padrao_id||null});
  const d=await os.buscarPorId(r.rows[0].id);
  console.log('maquina_nome=',d.maquina_nome,'| operador_nome=',d.operador_nome);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
\""
```
Expected: imprime `maquina_nome=` preenchido (e `operador_nome=` se a máquina tiver operador padrão).

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(os3a): combos Máquina/Operador na ficha da OS + exibição no detalhe

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Atualizar memória do projeto

**Files:**
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Registrar OS-3A como concluído**

Atualizar a linha `**OS-3A (máquinas)**: PENDENTE` para `CONCLUÍDO — 2026-06-23`, com resumo: tabela `maquinas` (migration 036) + `maquina_id`/`operador_id` na OS; módulo `/api/v2/maquinas`; aba Máquinas no dashboard; combo na ficha da OS com operador padrão auto-preenchido. Remover OS-3A da "Fila pós-M12". Atualizar próximo número de migration livre para **037**.

- [ ] **Step 2: Sem commit**

Arquivo de memória fica fora do git do projeto (diretório `~/.claude/...`). Não commitar.

---

## Notas de verificação final

- Após a Task 5, abrir o dashboard em produção, criar uma máquina pela aba Máquinas, abrir uma OS offset e confirmar visualmente que o combo Máquina aparece, preenche o operador padrão ao selecionar, salva e reaparece ao reabrir.
- Confirmar que máquina `inativa` não aparece no combo da OS, mas continua listada na aba Máquinas.
