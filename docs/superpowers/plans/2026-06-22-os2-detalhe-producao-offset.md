# OS-2 · Detalhe de Produção Offset — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar a ficha de produção offset à OS (parâmetros + vias/materiais do catálogo) com uma tela de detalhe da OS no dashboard.

**Architecture:** Colunas de ficha em `ordens_servico` (uma ficha por OS) + tabela `os_materiais` (vias). `buscarPorId` passa a retornar `materiais`. Novo endpoint `PATCH /api/v2/os/:id/producao` salva ficha + substitui vias. Tela de detalhe nova no dashboard (aba OS) com seletor de material reaproveitando `GET /api/v2/materiais?busca=`.

**Tech Stack:** Express, pg (pool), dashboard HTML vanilla.

**Convenções deste repositório (iguais ao OS-1):**
- Migrations incrementais em `sql/migrations/NNN_*.sql`, aplicadas MANUALMENTE via psql no VPS. Última migration existente: **029**.
- **Sem postgres local** — verificar com `node --check` + smoke server-side no VPS (`node -r dotenv/config -e '...'`) + smoke HTTP em produção.
- Deploy: `rsync -az <arquivo> root@2.25.147.243:/var/www/lkl-chatbot/<arquivo>` + `ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"`.
- DB no VPS: `ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot ..."`.
- Módulos v2 montados em `/api/v2/*`. Commit body termina com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **IMPORTANTE — limpar resíduo dos smokes:** todo smoke que cria pedido/orçamento/OS DEVE apagar o que criou no fim (o banco de produção deve voltar ao estado anterior). Conferir com `SELECT count(*) FROM ordens_servico;` após cada task que rodou smoke.

**Mapa de arquivos:**
- `sql/migrations/030_os_ficha_producao.sql`, `031_os_materiais.sql` — schema.
- `src/modules/os/service.js` — `buscarPorId` (incluir materiais) + `atualizarFichaProducao`.
- `src/modules/os/router.js` — `PATCH /:id/producao`.
- `public/dashboard.html` — tela de detalhe da OS (abrir + ficha + vias/materiais + salvar) e clique na linha da lista.

---

## Task 1: Migrations 030–031

**Files:**
- Create: `sql/migrations/030_os_ficha_producao.sql`
- Create: `sql/migrations/031_os_materiais.sql`

- [ ] **Step 1: Criar 030 — ficha de produção em ordens_servico**

`sql/migrations/030_os_ficha_producao.sql`:
```sql
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS nro_jogos          INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS nro_vias           INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS tipo_unidade       VARCHAR(5);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS frente_verso       VARCHAR(20);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS numeracao_inicial  INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS numeracao_final    INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS formato_corte_alt  NUMERIC(8,2);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS formato_corte_larg NUMERIC(8,2);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS imagem_alt         NUMERIC(8,2);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS imagem_larg        NUMERIC(8,2);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS imagens_folha      INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS imagens_impressao  INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS cores_tintas       VARCHAR(50);
```

- [ ] **Step 2: Criar 031 — os_materiais (vias)**

`sql/migrations/031_os_materiais.sql`:
```sql
CREATE TABLE IF NOT EXISTS os_materiais (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  os_id          UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  via            INTEGER NOT NULL,
  material_id    UUID REFERENCES materiais(id),
  descricao      VARCHAR(200),
  cor_papel      VARCHAR(60),
  cores_tintas   VARCHAR(60),
  tipo_impressao VARCHAR(60),
  cores_frente   INTEGER,
  cores_verso    INTEGER,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_os_materiais_os ON os_materiais(os_id);
```

- [ ] **Step 3: Aplicar no VPS**

```bash
cd /Users/klebercamara/LKL
for n in 030_os_ficha_producao 031_os_materiais; do
  cat sql/migrations/$n.sql | ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot"
done
```
Esperado: vários `ALTER TABLE` + `CREATE TABLE`/`CREATE INDEX` sem erro.

- [ ] **Step 4: Verificar**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"\d os_materiais\" -c \"SELECT column_name FROM information_schema.columns WHERE table_name='ordens_servico' AND column_name IN ('nro_jogos','frente_verso','formato_corte_alt','imagens_folha','cores_tintas');\""
```
Esperado: tabela `os_materiais` com FK para `ordens_servico` (CASCADE) e `materiais`; e as 5 colunas listadas presentes.

- [ ] **Step 5: Commit**

```bash
git add sql/migrations/030_os_ficha_producao.sql sql/migrations/031_os_materiais.sql
git commit -m "feat(os-2): migrations — ficha de produção em ordens_servico + os_materiais"
```

---

## Task 2: os/service.js — buscarPorId inclui materiais + atualizarFichaProducao

**Files:**
- Modify: `src/modules/os/service.js`

- [ ] **Step 1: Incluir `materiais` no retorno de `buscarPorId`**

READ o arquivo. No final de `buscarPorId(id)`, hoje retorna `{ ...os, itens: itens.rows, especificacoes: especs.rows }`. Antes desse `return`, acrescentar a busca das vias e incluí-la:
```javascript
  const mats = await db.query(
    `SELECT m.id, m.via, m.material_id, m.descricao, m.cor_papel, m.cores_tintas,
            m.tipo_impressao, m.cores_frente, m.cores_verso,
            mat.codigo AS material_codigo, mat.nome AS material_nome
     FROM os_materiais m
     LEFT JOIN materiais mat ON mat.id = m.material_id
     WHERE m.os_id = $1 ORDER BY m.via`,
    [id]
  );
  return { ...os, itens: itens.rows, especificacoes: especs.rows, materiais: mats.rows };
```
(Substituir o `return { ...os, itens: itens.rows, especificacoes: especs.rows };` existente por este bloco.)

- [ ] **Step 2: Adicionar `atualizarFichaProducao`**

Adicionar antes do `module.exports` e incluí-la nos exports:
```javascript
// Atualiza a ficha de produção da OS e substitui as vias/materiais
async function atualizarFichaProducao(osId, dados) {
  const COLS = ['nro_jogos','nro_vias','tipo_unidade','frente_verso','numeracao_inicial',
    'numeracao_final','formato_corte_alt','formato_corte_larg','imagem_alt','imagem_larg',
    'imagens_folha','imagens_impressao','cores_tintas'];
  const sets = [], vals = [];
  for (const c of COLS) {
    if (dados[c] !== undefined) { vals.push(dados[c] === '' ? null : dados[c]); sets.push(`${c}=$${vals.length}`); }
  }
  if (sets.length) {
    vals.push(osId);
    const r = await db.query(
      `UPDATE ordens_servico SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING id`, vals);
    if (!r.rows[0]) return { erro: ['OS não encontrada'] };
  } else {
    const r = await db.query('SELECT id FROM ordens_servico WHERE id=$1', [osId]);
    if (!r.rows[0]) return { erro: ['OS não encontrada'] };
  }

  // Substitui as vias
  if (Array.isArray(dados.materiais)) {
    await db.query('DELETE FROM os_materiais WHERE os_id=$1', [osId]);
    let via = 1;
    for (const m of dados.materiais) {
      await db.query(
        `INSERT INTO os_materiais (os_id, via, material_id, descricao, cor_papel, cores_tintas, tipo_impressao, cores_frente, cores_verso)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [osId, m.via || via, m.material_id || null, m.descricao || null, m.cor_papel || null,
         m.cores_tintas || null, m.tipo_impressao || null,
         m.cores_frente != null && m.cores_frente !== '' ? parseInt(m.cores_frente) : null,
         m.cores_verso  != null && m.cores_verso  !== '' ? parseInt(m.cores_verso)  : null]
      );
      via++;
    }
  }
  const os = await buscarPorId(osId);
  return { os };
}
```

- [ ] **Step 3: Verificar sintaxe**

```bash
node --check src/modules/os/service.js
```
Esperado: sem saída.

- [ ] **Step 4: Deploy + smoke (cria OS offset mínima, grava ficha + 1 via, relê, limpa)**

```bash
rsync -az src/modules/os/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/os/service.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const os=require('./src/modules/os/service'); const db=require('./src/db');
(async()=>{
  const cli=await db.query('SELECT id FROM clientes_lkl LIMIT 1');
  const mat=await db.query('SELECT id, nome FROM materiais LIMIT 1');
  const osR=await db.query(\\\"INSERT INTO ordens_servico (status,tipo_servico,cliente_id) VALUES ('aguardando','offset',\\\$1) RETURNING id\\\",[cli.rows[0].id]);
  const osId=osR.rows[0].id;
  const upd=await os.atualizarFichaProducao(osId,{ nro_jogos:2, nro_vias:1, tipo_unidade:'FLS', frente_verso:'fv_diferentes', formato_corte_alt:44, formato_corte_larg:64, cores_tintas:'CMYK',
    materiais:[{ via:1, material_id:mat.rows[0].id, descricao:mat.rows[0].nome, cor_papel:'BRANCO', cores_tintas:'CMYK', tipo_impressao:'Frente e Verso Diferentes', cores_frente:4, cores_verso:4 }] });
  console.log('ficha:', upd.os.nro_jogos, upd.os.frente_verso, upd.os.cores_tintas, '| vias:', upd.os.materiais.length, '| via1 material:', upd.os.materiais[0].material_nome, upd.os.materiais[0].cor_papel);
  await db.query('DELETE FROM os_materiais WHERE os_id=\\\$1',[osId]);
  await db.query('DELETE FROM ordens_servico WHERE id=\\\$1',[osId]);
  const fin=await db.query('SELECT count(*) FROM ordens_servico'); console.log('limpeza ordens_servico:', fin.rows[0].count);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
\""
```
Esperado: `ficha: 2 fv_diferentes CMYK | vias: 1 | via1 material: <nome> BRANCO` e `limpeza ordens_servico: 0`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/os/service.js
git commit -m "feat(os-2): buscarPorId inclui materiais + atualizarFichaProducao"
```

---

## Task 3: Endpoint PATCH /api/v2/os/:id/producao

**Files:**
- Modify: `src/modules/os/router.js`

- [ ] **Step 1: Adicionar a rota**

READ o arquivo. Adicionar (perto das outras rotas PATCH, e ANTES de qualquer `GET /:id` não tem conflito pois método/path diferem) usando `service` e `requireRole` já importados:
```javascript
// Ficha de produção offset (parâmetros + vias/materiais)
router.patch('/:id/producao', requireRole('admin','gestor','analista','operador'), async (req, res) => {
  try {
    const result = await service.atualizarFichaProducao(req.params.id, req.body);
    if (result.erro) {
      const nf = result.erro.some(e => e.includes('não encontrada'));
      return res.status(nf ? 404 : 400).json(nf ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result.os);
  } catch (e) { console.error('[OS-PRODUCAO]', e); res.status(500).json({ error: 'Erro interno' }); }
});
```

- [ ] **Step 2: Verificar sintaxe**

```bash
node --check src/modules/os/router.js
```
Esperado: sem saída.

- [ ] **Step 3: Deploy + smoke HTTP (cria OS, PATCH ficha via HTTP autenticado, confere, limpa)**

```bash
rsync -az src/modules/os/router.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/os/router.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const jwt=require('jsonwebtoken'); const t=jwt.sign({id:'00000000-0000-0000-0000-000000000002',role:'admin',name:'T',email:'t@t.com'},process.env.JWT_SECRET);
const http=require('http'); const db=require('./src/db');
function patch(path,body){return new Promise((res,rej)=>{const data=JSON.stringify(body);const r=http.request({host:'127.0.0.1',port:3000,path,method:'PATCH',headers:{Authorization:'Bearer '+t,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},rs=>{let d='';rs.on('data',c=>d+=c);rs.on('end',()=>res(rs.statusCode+' '+d.slice(0,90)));});r.on('error',rej);r.write(data);r.end();});}
(async()=>{ const cli=await db.query('SELECT id FROM clientes_lkl LIMIT 1');
 const osR=await db.query(\\\"INSERT INTO ordens_servico (status,tipo_servico,cliente_id) VALUES ('aguardando','offset',\\\$1) RETURNING id\\\",[cli.rows[0].id]);
 console.log('PATCH:', await patch('/api/v2/os/'+osR.rows[0].id+'/producao',{nro_jogos:3,cores_tintas:'CMYK',materiais:[]}));
 const chk=await db.query('SELECT nro_jogos,cores_tintas FROM ordens_servico WHERE id=\\\$1',[osR.rows[0].id]); console.log('depois:',JSON.stringify(chk.rows[0]));
 await db.query('DELETE FROM ordens_servico WHERE id=\\\$1',[osR.rows[0].id]);
 console.log('limpeza:', (await db.query('SELECT count(*) FROM ordens_servico')).rows[0].count);
 process.exit(0); })().catch(e=>{console.error(e.message);process.exit(1);});
\""
```
Esperado: `PATCH: 200 {...}`, `depois: {"nro_jogos":3,"cores_tintas":"CMYK"}`, `limpeza: 0`.

- [ ] **Step 4: Commit**

```bash
git add src/modules/os/router.js
git commit -m "feat(os-2): endpoint PATCH /api/v2/os/:id/producao"
```

---

## Task 4: Dashboard — tela de detalhe da OS + ficha de produção

**Files:**
- Modify: `public/dashboard.html` (função `loadOsMain` para clique + novas funções de detalhe)

**Contexto:** `loadOsMain` (≈ linha 1179) renderiza as linhas de OS sem clique. Helpers disponíveis: `api`, `showModal`, `closeModal`, `showToast`, `escHtml`.

- [ ] **Step 1: Tornar a linha da OS clicável**

Em `loadOsMain`, na `<tr>` de cada OS, adicionar `onclick` e cursor. Trocar `return \`<tr>` por:
```javascript
      return `<tr style="cursor:pointer" onclick="abrirDetalheOS('${o.id}')">
```

- [ ] **Step 2: Adicionar as funções de detalhe (ficha) no `<script>`**

Adicionar (ex.: logo após `loadOsMain`):
```javascript
let _osDetalheId = null;
const FV_OPCOES = [['so_frente','Só Frente'],['fv_iguais','Frente e Verso Iguais'],['fv_diferentes','Frente e Verso Diferentes']];
const UNID_OPCOES = ['FLS','BLS','PCS','JGS','TLS'];

async function abrirDetalheOS(id) {
  _osDetalheId = id;
  const os = await api(`/api/v2/os/${id}`);
  if (!os || os.error) { showToast('Erro ao carregar OS'); return; }
  _osMateriais = (os.materiais || []).map(m => ({ ...m }));

  const itensTxt = (os.itens||[]).map(i => `${escHtml(i.descricao)} (${i.quantidade})`).join(' · ') || '—';
  const especsTxt = (os.especificacoes||[]).map(e => escHtml(e.nome)).join(', ') || '—';
  const isOffset = os.tipo_servico === 'offset';
  const inp = (id2, val, type='text', extra='') => `<input id="${id2}" type="${type}" value="${val!=null?escHtml(String(val)):''}" ${extra} style="width:100%;padding:7px;border:1px solid #ddd;border-radius:6px;font-size:13px;box-sizing:border-box">`;
  const fvSel = `<select id="of-fv" style="width:100%;padding:7px;border:1px solid #ddd;border-radius:6px;font-size:13px"><option value="">—</option>${FV_OPCOES.map(([v,l])=>`<option value="${v}" ${os.frente_verso===v?'selected':''}>${l}</option>`).join('')}</select>`;
  const unidSel = `<select id="of-unid" style="width:100%;padding:7px;border:1px solid #ddd;border-radius:6px;font-size:13px"><option value="">—</option>${UNID_OPCOES.map(u=>`<option value="${u}" ${os.tipo_unidade===u?'selected':''}>${u}</option>`).join('')}</select>`;

  const fichaHtml = !isOffset ? '<p style="color:#888;font-size:13px;padding:10px 0">Ficha de produção offset não se aplica a OS de Comunicação Visual.</p>' : `
    <div style="font-size:11px;font-weight:700;color:#7986cb;letter-spacing:.5px;margin:16px 0 8px">FICHA DE PRODUÇÃO (OFFSET)</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
      <div><label style="font-size:11px;color:#666">Nº Jogos</label>${inp('of-jogos',os.nro_jogos,'number','min="0"')}</div>
      <div><label style="font-size:11px;color:#666">Nº Vias</label>${inp('of-vias',os.nro_vias,'number','min="0"')}</div>
      <div><label style="font-size:11px;color:#666">Tipo unidade</label>${unidSel}</div>
      <div><label style="font-size:11px;color:#666">Frente e Verso</label>${fvSel}</div>
      <div><label style="font-size:11px;color:#666">Numeração inicial</label>${inp('of-numini',os.numeracao_inicial,'number')}</div>
      <div><label style="font-size:11px;color:#666">Numeração final</label>${inp('of-numfim',os.numeracao_final,'number')}</div>
      <div><label style="font-size:11px;color:#666">Formato corte Alt</label>${inp('of-fcalt',os.formato_corte_alt,'number','step="0.01"')}</div>
      <div><label style="font-size:11px;color:#666">Formato corte Larg</label>${inp('of-fclarg',os.formato_corte_larg,'number','step="0.01"')}</div>
      <div><label style="font-size:11px;color:#666">Cores das tintas</label>${inp('of-cores',os.cores_tintas)}</div>
      <div><label style="font-size:11px;color:#666">Imagem Alt</label>${inp('of-imgalt',os.imagem_alt,'number','step="0.01"')}</div>
      <div><label style="font-size:11px;color:#666">Imagem Larg</label>${inp('of-imglarg',os.imagem_larg,'number','step="0.01"')}</div>
      <div></div>
      <div><label style="font-size:11px;color:#666">Imagens/folha</label>${inp('of-imgfolha',os.imagens_folha,'number','min="0"')}</div>
      <div><label style="font-size:11px;color:#666">Imagens/impressão</label>${inp('of-imgimp',os.imagens_impressao,'number','min="0"')}</div>
      <div></div>
    </div>
    <div id="of-vias-area"></div>
    <button onclick="salvarFichaOS()" class="btn btn-primary" style="width:100%;margin-top:14px">💾 Salvar ficha de produção</button>`;

  const html = `
    <div style="font-size:12px;color:#888;margin-bottom:8px">
      OS #${os.numero_os||'—'} · <b>${os.tipo_servico==='offset'?'Offset':(os.tipo_servico==='comunicacao_visual'?'Com. Visual':'—')}</b> · ${escHtml(os.cliente_nome||'(multi-cliente)')} · status: ${os.status}
    </div>
    <div style="font-size:13px;margin-bottom:4px"><b>Itens:</b> ${itensTxt}</div>
    <div style="font-size:13px;margin-bottom:6px"><b>Especificações:</b> ${especsTxt}</div>
    ${fichaHtml}`;
  showModal(`Detalhe da OS #${os.numero_os||''}`, html);
  if (isOffset) renderViasOS();
}

async function salvarFichaOS() {
  const val = id2 => { const e=document.getElementById(id2); return e? e.value : ''; };
  const body = {
    nro_jogos: val('of-jogos'), nro_vias: val('of-vias'), tipo_unidade: val('of-unid'),
    frente_verso: val('of-fv'), numeracao_inicial: val('of-numini'), numeracao_final: val('of-numfim'),
    formato_corte_alt: val('of-fcalt'), formato_corte_larg: val('of-fclarg'),
    imagem_alt: val('of-imgalt'), imagem_larg: val('of-imglarg'),
    imagens_folha: val('of-imgfolha'), imagens_impressao: val('of-imgimp'),
    cores_tintas: val('of-cores'),
    materiais: _osMateriais,
  };
  const r = await api(`/api/v2/os/${_osDetalheId}/producao`, { method:'PATCH', body: JSON.stringify(body) });
  if (r?.error || r?.errors) { showToast(r.error || (r.errors||[]).join(', '), 'error'); return; }
  closeModal();
  showToast('✅ Ficha de produção salva');
  loadOsMain();
}
```
> `renderViasOS`, `_osMateriais` e o seletor de material são da Task 5. Para esta task, declare `let _osMateriais = [];` junto de `_osDetalheId` e crie um stub temporário `function renderViasOS(){}` que será substituído na Task 5 (assim a Task 4 já salva ficha sem vias).

- [ ] **Step 3: Verificação estrutural + preview**

```bash
cd /Users/klebercamara/LKL
node -e "const s=require('fs').readFileSync('public/dashboard.html','utf8');console.log('div',((s.match(/<div/g)||[]).length),'/',((s.match(/<\/div>/g)||[]).length));console.log('abrirDetalheOS',s.includes('function abrirDetalheOS'),'salvarFichaOS',s.includes('function salvarFichaOS'));"
```
Abrir o dashboard, aba OS, clicar numa OS offset → modal abre com a ficha; salvar persiste (recarrega lista sem erro).

- [ ] **Step 4: Deploy + commit**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
git add public/dashboard.html
git commit -m "feat(os-2): dashboard — detalhe da OS + ficha de produção offset"
```

---

## Task 5: Dashboard — vias/materiais com seletor do catálogo

**Files:**
- Modify: `public/dashboard.html` (substituir o stub `renderViasOS` e adicionar funções de via/material)

- [ ] **Step 1: Substituir o stub `renderViasOS` e adicionar as funções de via**

Remover `function renderViasOS(){}` (stub da Task 4) e adicionar:
```javascript
function renderViasOS() {
  const area = document.getElementById('of-vias-area');
  if (!area) return;
  const linhas = _osMateriais.map((m, idx) => `
    <div style="display:grid;grid-template-columns:1.6fr 1fr 0.8fr 1fr 0.5fr 0.5fr auto;gap:6px;align-items:center;margin-bottom:6px">
      <input value="${escHtml(m.descricao||m.material_nome||'')}" readonly placeholder="Material..."
        onclick="buscarMaterialVia(${idx})" title="Clique para buscar material"
        style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px;cursor:pointer;background:#fafbff">
      <input value="${escHtml(m.cor_papel||'')}" placeholder="Cor papel" oninput="_osMateriais[${idx}].cor_papel=this.value"
        style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px">
      <input value="${escHtml(m.cores_tintas||'')}" placeholder="Tintas" oninput="_osMateriais[${idx}].cores_tintas=this.value"
        style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px">
      <input value="${escHtml(m.tipo_impressao||'')}" placeholder="Impressão" oninput="_osMateriais[${idx}].tipo_impressao=this.value"
        style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px">
      <input value="${m.cores_frente!=null?m.cores_frente:''}" type="number" min="0" placeholder="Fre" oninput="_osMateriais[${idx}].cores_frente=this.value"
        style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px">
      <input value="${m.cores_verso!=null?m.cores_verso:''}" type="number" min="0" placeholder="Ver" oninput="_osMateriais[${idx}].cores_verso=this.value"
        style="padding:6px;border:1px solid #ddd;border-radius:6px;font-size:12px">
      <button onclick="removerViaOS(${idx})" title="Remover via" style="background:#e53935;border:none;border-radius:50%;width:24px;height:24px;color:white;cursor:pointer">−</button>
    </div>`).join('');
  area.innerHTML = `
    <div style="font-size:11px;font-weight:700;color:#7986cb;letter-spacing:.5px;margin:16px 0 8px">VIAS / MATERIAIS</div>
    <div style="font-size:10px;color:#999;display:grid;grid-template-columns:1.6fr 1fr 0.8fr 1fr 0.5fr 0.5fr auto;gap:6px;margin-bottom:4px">
      <span>Material</span><span>Cor papel</span><span>Tintas</span><span>Impressão</span><span>Fre</span><span>Ver</span><span></span></div>
    ${linhas || '<p style="font-size:12px;color:#999">Nenhuma via. Adicione abaixo.</p>'}
    <button onclick="adicionarViaOS()" style="background:#43a047;border:none;border-radius:6px;color:white;font-size:12px;font-weight:600;padding:6px 12px;cursor:pointer;margin-top:6px">+ Adicionar via</button>`;
}

function adicionarViaOS() {
  _osMateriais.push({ via: _osMateriais.length+1, material_id:null, descricao:'', cor_papel:'', cores_tintas:'', tipo_impressao:'', cores_frente:'', cores_verso:'' });
  renderViasOS();
}
function removerViaOS(idx) { _osMateriais.splice(idx,1); renderViasOS(); }

// Busca INLINE dentro da área de vias (não usa modal — preserva a ficha já preenchida)
async function buscarMaterialVia(idx) {
  const area = document.getElementById('of-vias-area');
  if (!area) return;
  area.innerHTML = `
    <div style="font-size:11px;font-weight:700;color:#7986cb;letter-spacing:.5px;margin:16px 0 8px">SELECIONAR MATERIAL — VIA ${idx+1}</div>
    <input id="of-mat-busca" placeholder="Código ou nome do material..." autofocus
      oninput="buscarMaterialViaQuery(${idx}, this.value)"
      style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;box-sizing:border-box">
    <div id="of-mat-result" style="max-height:200px;overflow:auto;border:1px solid #eee;border-radius:6px;margin-top:6px"></div>
    <button onclick="renderViasOS()" style="background:none;border:1px solid #ddd;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;margin-top:8px">← Voltar</button>`;
}

let _osMatTimer = null;
function buscarMaterialViaQuery(idx, q) {
  clearTimeout(_osMatTimer);
  _osMatTimer = setTimeout(async () => {
    const result = document.getElementById('of-mat-result');
    if (!result) return;
    if (!q || !q.trim()) { result.innerHTML = ''; return; }
    const res = await api(`/api/v2/materiais?busca=${encodeURIComponent(q.trim())}&limit=12`);
    const lista = res?.data || res || [];
    if (!lista.length) { result.innerHTML = '<div style="padding:8px;color:#999;font-size:12px">Nenhum material</div>'; return; }
    result.innerHTML = lista.map(m => `
      <div onclick="selecionarMaterialVia(${idx},'${m.id}','${escHtml(((m.codigo?m.codigo+' - ':'')+m.nome)).replace(/'/g,"\\'")}')"
        style="padding:8px;border-bottom:1px solid #eee;cursor:pointer;font-size:13px"
        onmouseenter="this.style.background='#f5f7ff'" onmouseleave="this.style.background='#fff'">
        <b>${escHtml(m.codigo||'')}</b> ${escHtml(m.nome)} <span style="color:#888;font-size:11px">${m.unidade||''}</span></div>`).join('');
  }, 250);
}

function selecionarMaterialVia(idx, materialId, descricao) {
  _osMateriais[idx].material_id = materialId;
  _osMateriais[idx].descricao = descricao;
  renderViasOS(); // volta para a lista de vias; a ficha acima permanece intacta
}
```

> Por ser inline (substitui só o conteúdo de `of-vias-area`), os campos da ficha acima permanecem preenchidos. Sem perda de edição e sem troca de modal.

- [ ] **Step 3: Verificação estrutural + preview**

```bash
cd /Users/klebercamara/LKL
node -e "const s=require('fs').readFileSync('public/dashboard.html','utf8');console.log('div',((s.match(/<div/g)||[]).length),'/',((s.match(/<\/div>/g)||[]).length));console.log('renderViasOS',(s.match(/function renderViasOS/g)||[]).length,'buscarMaterialVia',s.includes('function buscarMaterialVia'));"
```
Esperado: `renderViasOS` aparece **1 vez** (stub removido), `buscarMaterialVia true`. Divs balanceados.
No preview: abrir OS offset → adicionar via → buscar material (código/nome) → selecionar → preencher cores → salvar → reabrir mostra as vias.

- [ ] **Step 4: Deploy + commit**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
git add public/dashboard.html
git commit -m "feat(os-2): vias/materiais na OS com seletor do catálogo"
```

---

## Task 6: Smoke E2E + memória

**Files:** nenhum (validação)

- [ ] **Step 1: Smoke E2E server-side (ficha + vias persistem e relê)**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e \"
const os=require('./src/modules/os/service'); const db=require('./src/db');
(async()=>{
  const cli=await db.query('SELECT id FROM clientes_lkl LIMIT 1');
  const mat=await db.query('SELECT id,nome FROM materiais LIMIT 2');
  const osR=await db.query(\\\"INSERT INTO ordens_servico (status,tipo_servico,cliente_id) VALUES ('aguardando','offset',\\\$1) RETURNING id\\\",[cli.rows[0].id]);
  const osId=osR.rows[0].id;
  await os.atualizarFichaProducao(osId,{nro_jogos:2,tipo_unidade:'FLS',frente_verso:'fv_diferentes',cores_tintas:'CMYK',
    materiais:[{material_id:mat.rows[0].id,descricao:mat.rows[0].nome,cor_papel:'BRANCO',cores_tintas:'CMYK',cores_frente:4,cores_verso:4},
               {material_id:mat.rows[1].id,descricao:mat.rows[1].nome,cor_papel:'AZUL',cores_tintas:'PRETO',cores_frente:1,cores_verso:0}]});
  const det=await os.buscarPorId(osId);
  console.log('ficha:',det.nro_jogos,det.tipo_unidade,det.frente_verso,'| vias:',det.materiais.length,'| via2 cor:',det.materiais[1].cor_papel);
  // re-salvar com 1 via só (testa substituição)
  await os.atualizarFichaProducao(osId,{materiais:[{material_id:mat.rows[0].id,descricao:mat.rows[0].nome,cor_papel:'BRANCO'}]});
  const det2=await os.buscarPorId(osId); console.log('após re-salvar vias:',det2.materiais.length);
  await db.query('DELETE FROM os_materiais WHERE os_id=\\\$1',[osId]);
  await db.query('DELETE FROM ordens_servico WHERE id=\\\$1',[osId]);
  console.log('limpeza:',(await db.query('SELECT count(*) FROM ordens_servico')).rows[0].count);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
\""
```
Esperado: `ficha: 2 FLS fv_diferentes | vias: 2 | via2 cor: AZUL`, `após re-salvar vias: 1`, `limpeza: 0`.

- [ ] **Step 2: Fluxo manual no dashboard**

Aprovar um orçamento com item offset → gerar OS Offset → abrir a OS → preencher ficha + adicionar via com material do catálogo → salvar → reabrir e conferir que tudo persistiu.

- [ ] **Step 3: Atualizar memória**

Editar `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`: marcar **OS-2 CONCLUÍDO** e apontar OS-3 como próximo.

---

## Self-Review (cobertura do spec)

- ✅ Ficha por OS (migration 030 + Task 2) — uma ficha por OS, modelo Sisgraf
- ✅ os_materiais / vias (migration 031 + Task 2/5)
- ✅ buscarPorId inclui materiais (Task 2)
- ✅ Endpoint salvar ficha + substituir vias (Task 3)
- ✅ Tela de detalhe da OS com ficha (Task 4) e vias com seletor do catálogo (Task 5)
- ✅ CV não exibe ficha offset (Task 4, branch `isOffset`)
- ✅ Critérios de aceite cobertos pelo smoke (Task 6)

**Consistência de nomes:** `atualizarFichaProducao` (service/router), endpoint `PATCH /:id/producao`, estado de UI `_osMateriais`/`_osDetalheId`, colunas `nro_jogos/nro_vias/tipo_unidade/frente_verso/numeracao_inicial/numeracao_final/formato_corte_alt/formato_corte_larg/imagem_alt/imagem_larg/imagens_folha/imagens_impressao/cores_tintas`. `frente_verso` ∈ {so_frente|fv_iguais|fv_diferentes}; `tipo_unidade` ∈ {FLS,BLS,PCS,JGS,TLS}.

**Busca de material:** inline dentro da área de vias (substitui só `of-vias-area`), preservando a ficha já preenchida — sem troca de modal e sem perda de edição.
