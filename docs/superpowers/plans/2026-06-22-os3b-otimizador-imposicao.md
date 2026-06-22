# OS-3B · Otimizador de Imposição ("Melhor Corte") — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dado o tamanho da imagem, calcular o melhor aproveitamento de papel (imagens montadas por formato de corte) e preencher automaticamente formato de corte + imagens/folha na ficha da OS (OS-2).

**Architecture:** Tabela `formatos_papel` (107 cortes do Sisgraf) + módulo `formatos` com `GET /api/v2/formatos/melhor-corte` que aplica a fórmula validada de imposição. No dashboard, botão "🔍 Melhor corte" na ficha da OS abre um grid inline; ao escolher uma linha, preenche os campos da ficha.

**Tech Stack:** Express, pg (pool), dashboard HTML vanilla.

**Fórmula de imposição (validada contra o Sisgraf — reproduz a tela 6 para 42×30):**
```
imagens_montadas = max(
  Math.floor(alt_corte/img_alt) * Math.floor(larg_corte/img_larg),   // normal
  Math.floor(alt_corte/img_larg) * Math.floor(larg_corte/img_alt)    // girada 90°
)
```
Sem margem de refile (cortes já são área útil; imagem inclui sangria).

**Convenções deste repositório (iguais ao OS-1/OS-2):**
- Migrations em `sql/migrations/NNN_*.sql`, aplicadas MANUALMENTE via psql no VPS. Última migration existente: **031**.
- Sem postgres local — verificar com `node --check` + smoke server-side no VPS (`node -r dotenv/config -e '...'`) + smoke HTTP em produção.
- Deploy: `rsync -az <arquivo> root@2.25.147.243:/var/www/lkl-chatbot/<arquivo>` + `pm2 restart lkl-chatbot --update-env`.
- Módulos v2 montados em `/api/v2`. Commit body termina com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Smokes que criam linhas no DB devem limpar no fim.

**Mapa de arquivos:**
- `sql/migrations/032_formatos_papel.sql` — tabela + seed (gerado do arquivo `docs/superpowers/os3b-formatos-seed.txt`, já commitado).
- `src/modules/formatos/service.js`, `src/modules/formatos/router.js` — cálculo + endpoints (módulo novo).
- `src/modules/index.js` — registrar `/formatos`.
- `public/dashboard.html` — botão "Melhor corte" + grid inline na ficha da OS (dentro de `abrirDetalheOS`/`of-vias-area`).

---

## Task 1: Migration 032 — formatos_papel + seed

**Files:**
- Create: `sql/migrations/032_formatos_papel.sql`

- [ ] **Step 1: Gerar o arquivo de migration a partir do seed commitado**

O arquivo `docs/superpowers/os3b-formatos-seed.txt` contém as 107 linhas no formato `(formato,altura,largura),`. Gerar a migration deterministicamente:
```bash
cd /Users/klebercamara/LKL
python3 -c "
vals=[l.strip().rstrip(',') for l in open('docs/superpowers/os3b-formatos-seed.txt') if l.strip()]
assert len(vals)==107, f'esperado 107, veio {len(vals)}'
sql = '''-- Formatos de corte para o otimizador de imposição (\"melhor corte\") — seed do Sisgraf (MELHORCORTE.xlsx)
CREATE TABLE IF NOT EXISTS formatos_papel (
  id            SERIAL PRIMARY KEY,
  formato       INTEGER NOT NULL,
  altura_corte  INTEGER NOT NULL,
  largura_corte INTEGER NOT NULL,
  ativo         BOOLEAN DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_formatos_papel_formato ON formatos_papel(formato);

INSERT INTO formatos_papel (formato, altura_corte, largura_corte) VALUES
''' + ',\n'.join(vals) + ''';
'''
open('sql/migrations/032_formatos_papel.sql','w').write(sql)
print('migration gerada com', len(vals), 'linhas')
"
```
Esperado: `migration gerada com 107 linhas`.

- [ ] **Step 2: Conferir o arquivo gerado**

```bash
head -16 sql/migrations/032_formatos_papel.sql; echo '...'; tail -2 sql/migrations/032_formatos_papel.sql
grep -c '),\|);' sql/migrations/032_formatos_papel.sql
```
Esperado: cabeçalho com CREATE TABLE + INSERT; última linha `(32,22,14);`; contagem de linhas de valores = 107.

- [ ] **Step 3: Aplicar no VPS**

```bash
cat sql/migrations/032_formatos_papel.sql | ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot"
```
Esperado: `CREATE TABLE`, `CREATE INDEX`, `INSERT 0 107`.

- [ ] **Step 4: Verificar**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"SELECT count(*) total, count(DISTINCT formato) tiers FROM formatos_papel; SELECT formato,altura_corte,largura_corte FROM formatos_papel WHERE formato=1 ORDER BY altura_corte;\""
```
Esperado: `total=107`, `tiers=31`; formato 1 lista 50×66 … 89×117.

- [ ] **Step 5: Commit**

```bash
git add sql/migrations/032_formatos_papel.sql
git commit -m "feat(os-3b): migration formatos_papel + seed (107 cortes do Sisgraf)"
```

---

## Task 2: Módulo formatos — cálculo melhor-corte + endpoints

**Files:**
- Create: `src/modules/formatos/service.js`
- Create: `src/modules/formatos/router.js`
- Modify: `src/modules/index.js`

- [ ] **Step 1: Criar `src/modules/formatos/service.js`**

```javascript
const db = require('../../db');

// Imposição: quantas imagens (img_alt x img_larg) montam num corte (alt x larg), considerando rotação 90°
function _imagensMontadas(alt, larg, ia, il) {
  if (!alt || !larg || !ia || !il) return 0;
  const normal  = Math.floor(alt / ia) * Math.floor(larg / il);
  const girada  = Math.floor(alt / il) * Math.floor(larg / ia);
  return Math.max(normal, girada);
}

// Lista formatos com imagens montadas calculadas, melhor aproveitamento primeiro
async function melhorCorte({ imagem_alt, imagem_larg, formato } = {}) {
  const ia = parseFloat(imagem_alt), il = parseFloat(imagem_larg);
  if (!(ia > 0) || !(il > 0)) return { erro: ['Informe imagem_alt e imagem_larg maiores que zero'] };

  const params = [];
  let where = 'WHERE ativo = true';
  if (formato != null && formato !== '') { params.push(parseInt(formato)); where += ` AND formato = $${params.length}`; }

  const r = await db.query(
    `SELECT formato, altura_corte, largura_corte FROM formatos_papel ${where} ORDER BY formato, altura_corte`,
    params
  );
  const linhas = r.rows
    .map(f => ({
      formato: f.formato,
      altura_corte: f.altura_corte,
      largura_corte: f.largura_corte,
      imagens_montadas: _imagensMontadas(f.altura_corte, f.largura_corte, ia, il),
    }))
    .filter(x => x.imagens_montadas >= 1)
    .sort((a, b) => b.imagens_montadas - a.imagens_montadas
      || (a.altura_corte * a.largura_corte) - (b.altura_corte * b.largura_corte));
  return { imagem_alt: ia, imagem_larg: il, resultados: linhas };
}

async function listar() {
  const r = await db.query('SELECT id, formato, altura_corte, largura_corte FROM formatos_papel WHERE ativo = true ORDER BY formato, altura_corte');
  return r.rows;
}

module.exports = { melhorCorte, listar, _imagensMontadas };
```

- [ ] **Step 2: Criar `src/modules/formatos/router.js`**

```javascript
const express = require('express');
const service = require('./service');
const router = express.Router();

// Otimizador de imposição
router.get('/melhor-corte', async (req, res) => {
  try {
    const result = await service.melhorCorte(req.query);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (e) { console.error('[MELHOR-CORTE]', e); res.status(500).json({ error: 'Erro interno' }); }
});

// Lista de formatos cadastrados
router.get('/', async (req, res) => {
  try {
    res.json(await service.listar());
  } catch (e) { console.error('[FORMATOS]', e); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
```
> `GET /melhor-corte` declarado ANTES de `GET /` — ok (paths distintos, sem conflito de `:id`).

- [ ] **Step 3: Registrar no `src/modules/index.js`**

READ o arquivo. Após a linha de `/especificacoes` (ou `/os`), adicionar, com o mesmo middleware de auth usado nas outras linhas:
```javascript
router.use('/formatos', requireAuthApi, require('./formatos/router'));
```

- [ ] **Step 4: Verificar sintaxe**

```bash
node --check src/modules/formatos/service.js && node --check src/modules/formatos/router.js && node --check src/modules/index.js
node -e "const s=require('./src/modules/formatos/service'); console.log('89x117 p/ 42x30 =', s._imagensMontadas(89,117,42,30), '(esperado 6)'); console.log('64x88 =', s._imagensMontadas(64,88,42,30), '(esperado 4)'); console.log('50x66 =', s._imagensMontadas(50,66,42,30), '(esperado 2)');"
```
Esperado: `89x117 ... = 6`, `64x88 = 4`, `50x66 = 2`.

- [ ] **Step 5: Deploy + smoke HTTP autenticado**

```bash
rsync -az src/modules/formatos/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/formatos/service.js
rsync -az src/modules/formatos/router.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/formatos/router.js
rsync -az src/modules/index.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/index.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const jwt=require('jsonwebtoken'); const t=jwt.sign({id:'00000000-0000-0000-0000-000000000002',role:'admin',name:'T',email:'t@t.com'},process.env.JWT_SECRET);
const http=require('http');
function get(p){return new Promise(r=>{http.get({host:'127.0.0.1',port:3000,path:p,headers:{Authorization:'Bearer '+t}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>r(res.statusCode+' '+d.slice(0,160)));});});}
(async()=>{ console.log(await get('/api/v2/formatos/melhor-corte?imagem_alt=42&imagem_larg=30&formato=1')); process.exit(0); })();
\""
```
Esperado: `200 {"imagem_alt":42,"imagem_larg":30,"resultados":[{"formato":1,"altura_corte":89,"largura_corte":117,"imagens_montadas":6},...]}` (89×117→6 primeiro).

- [ ] **Step 6: Commit**

```bash
git add src/modules/formatos/service.js src/modules/formatos/router.js src/modules/index.js
git commit -m "feat(os-3b): módulo formatos — cálculo melhor-corte + endpoints"
```

---

## Task 3: Dashboard — botão "Melhor corte" na ficha da OS

**Files:**
- Modify: `public/dashboard.html` (dentro do detalhe da OS — função `abrirDetalheOS` / área `of-vias-area`)

**Contexto:** A ficha (OS-2) tem inputs `of-imgalt`/`of-imglarg` (tamanho da imagem), `of-fcalt`/`of-fclarg` (formato de corte) e `of-imgfolha` (imagens/folha), e um `<div id="of-vias-area">`. Helpers: `api`, `escHtml`, `showToast`.

- [ ] **Step 1: Adicionar o botão "Melhor corte" na ficha**

Em `abrirDetalheOS`, no bloco `fichaHtml`, localizar a linha do campo "Imagem Larg" (`of-imglarg`). Logo após o `</div>` que fecha a célula de Imagem Larg, dentro do mesmo grid, trocar a célula vazia seguinte (`<div></div>`) por:
```html
      <div style="display:flex;align-items:flex-end"><button type="button" onclick="abrirMelhorCorte()" style="background:#5c6bc0;border:none;border-radius:6px;color:white;font-size:12px;font-weight:600;padding:7px 10px;cursor:pointer;white-space:nowrap">🔍 Melhor corte</button></div>
```
(Se não houver `<div></div>` exatamente após Imagem Larg, inserir a nova célula com o botão logo após a célula de Imagem Larg.)

- [ ] **Step 2: Adicionar as funções do otimizador**

Adicionar no `<script>` (perto de `renderViasOS`):
```javascript
async function abrirMelhorCorte() {
  const ia = parseFloat(document.getElementById('of-imgalt')?.value);
  const il = parseFloat(document.getElementById('of-imglarg')?.value);
  if (!(ia > 0) || !(il > 0)) { showToast('Preencha o tamanho da imagem (Alt e Larg) primeiro'); return; }
  const area = document.getElementById('of-vias-area');
  if (!area) return;
  area.innerHTML = '<p style="font-size:12px;color:#999;margin-top:12px">Calculando melhor corte...</p>';
  const res = await api(`/api/v2/formatos/melhor-corte?imagem_alt=${ia}&imagem_larg=${il}`);
  const lista = res?.resultados || [];
  if (!lista.length) { area.innerHTML = '<p style="font-size:12px;color:#c00;margin-top:12px">Nenhum formato comporta essa imagem.</p>'; setTimeout(renderViasOS, 1500); return; }
  const linhas = lista.slice(0, 40).map(r => `
    <div onclick="escolherCorte(${r.altura_corte},${r.largura_corte},${r.imagens_montadas})"
      style="display:grid;grid-template-columns:0.6fr 1fr 0.8fr;gap:6px;padding:7px 8px;border-bottom:1px solid #eee;cursor:pointer;font-size:13px"
      onmouseenter="this.style.background='#f5f7ff'" onmouseleave="this.style.background='#fff'">
      <span style="color:#888">Fmt ${r.formato}</span>
      <span><b>${r.altura_corte} × ${r.largura_corte}</b></span>
      <span style="text-align:right;font-weight:700;color:#2e7d32">${r.imagens_montadas} img</span>
    </div>`).join('');
  area.innerHTML = `
    <div style="font-size:11px;font-weight:700;color:#7986cb;letter-spacing:.5px;margin:16px 0 8px">MELHOR CORTE — imagem ${ia} × ${il} (clique para aplicar)</div>
    <div style="font-size:10px;color:#999;display:grid;grid-template-columns:0.6fr 1fr 0.8fr;gap:6px;padding:0 8px 4px">
      <span>Formato</span><span>Corte (Alt × Larg)</span><span style="text-align:right">Imagens/folha</span></div>
    <div style="max-height:240px;overflow:auto;border:1px solid #eee;border-radius:6px">${linhas}</div>
    <button onclick="renderViasOS()" style="background:none;border:1px solid #ddd;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;margin-top:8px">← Voltar para vias</button>`;
}

function escolherCorte(alt, larg, imagensFolha) {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
  set('of-fcalt', alt);
  set('of-fclarg', larg);
  set('of-imgfolha', imagensFolha);
  showToast(`✅ Corte ${alt}×${larg} aplicado (${imagensFolha} imagens/folha)`);
  renderViasOS();
}
```

- [ ] **Step 3: Verificação estrutural**

```bash
cd /Users/klebercamara/LKL
node -e "const s=require('fs').readFileSync('public/dashboard.html','utf8');console.log('div',((s.match(/<div/g)||[]).length),'/',((s.match(/<\/div>/g)||[]).length));console.log('abrirMelhorCorte',s.includes('function abrirMelhorCorte'),'escolherCorte',s.includes('function escolherCorte'),'botao',s.includes('🔍 Melhor corte'));"
```
Esperado: divs balanceados; os três booleanos `true`.

- [ ] **Step 4: Deploy + commit**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
git add public/dashboard.html
git commit -m "feat(os-3b): dashboard — botão Melhor corte na ficha da OS"
```

---

## Task 4: Smoke E2E + memória

**Files:** nenhum (validação)

- [ ] **Step 1: Smoke do cálculo (vários casos + filtro de tier)**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e \"
const s=require('./src/modules/formatos/service');
(async()=>{
  const r1=await s.melhorCorte({imagem_alt:42,imagem_larg:30,formato:1});
  console.log('42x30 fmt1 top3:', r1.resultados.slice(0,3).map(x=>x.altura_corte+'x'+x.largura_corte+'='+x.imagens_montadas).join(' | '));
  const r2=await s.melhorCorte({imagem_alt:10,imagem_larg:7});
  console.log('10x7 (todos) melhor:', r2.resultados[0].altura_corte+'x'+r2.resultados[0].largura_corte+'='+r2.resultados[0].imagens_montadas, '| total formatos:', r2.resultados.length);
  const r3=await s.melhorCorte({imagem_alt:0});
  console.log('imagem invalida:', JSON.stringify(r3.erro));
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
\""
```
Esperado: `42x30 fmt1 top3: 89x117=6 | 64x88=4 | 66x96=4` (ou 66x96/64x88 em ordem de área), `10x7 (todos) melhor: ...` com nº alto, `imagem invalida: ["Informe imagem_alt e imagem_larg maiores que zero"]`.

- [ ] **Step 2: Fluxo manual no dashboard**

Abrir uma OS offset → na ficha, preencher Imagem Alt=42, Larg=30 → clicar "🔍 Melhor corte" → o grid lista 89×117=6 no topo → clicar numa linha → os campos Formato corte e Imagens/folha são preenchidos → salvar a ficha persiste.

- [ ] **Step 3: Atualizar memória**

Editar `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`: registrar **OS-3B CONCLUÍDO** e apontar próximos: OS-3A (máquinas) e OS-3C (estoque).

---

## Self-Review (cobertura do spec)

- ✅ Tabela formatos_papel + seed 107 (migration 032 + Task 1)
- ✅ Cálculo de imposição com rotação, fórmula validada (Task 2, `_imagensMontadas`)
- ✅ Endpoint `GET /api/v2/formatos/melhor-corte` ordenado por imagens montadas (Task 2)
- ✅ `GET /api/v2/formatos` lista (Task 2)
- ✅ Botão "Melhor corte" na ficha + grid inline + aplica formato_corte/imagens_folha (Task 3)
- ✅ Imagem inválida → erro claro (Task 2 service + Task 3 front)
- ✅ Critérios de aceite cobertos (Task 4)

**Consistência de nomes:** `melhorCorte`/`_imagensMontadas` (service), endpoint `/formatos/melhor-corte`, retorno `{ imagem_alt, imagem_larg, resultados:[{formato,altura_corte,largura_corte,imagens_montadas}] }`; front `abrirMelhorCorte`/`escolherCorte`; campos da ficha `of-imgalt/of-imglarg/of-fcalt/of-fclarg/of-imgfolha` (definidos no OS-2).

**Premissa:** sem margem de refile (validada contra o Sisgraf). Ajuste fica para o teste em caso real, conforme combinado.
