# Entrada de Estoque via NF-e de Compra — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Importar o XML de uma NF-e de compra, casar itens com materiais (EAN/código) e dar entrada no estoque com custo médio ponderado, de forma estornável.

**Architecture:** Parsing do XML em Node (`fast-xml-parser`). Novo módulo `src/modules/entradas/` (service + router) com fluxo preview → confirmar → estornar. Tabelas `entradas_estoque` + `entradas_estoque_itens`; `materiais` ganha `codigo_barras` e `fator_entrada`. UI no dashboard (aba Entrada NF-e: importar → pré-visualizar → confirmar).

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), `multer` (memoryStorage), `fast-xml-parser`, vanilla-JS dashboard. Sem postgres local — verificação por `node --check` + smoke E2E no VPS.

**Convenções do projeto:**
- Migrations em `sql/migrations/NNN_*.sql`, aplicadas via psql no VPS. Próximo número livre: **038**.
- ATENÇÃO: tabelas antigas (ex.: `materiais`, criada na 001) podem pertencer ao user `postgres`; `ALTER TABLE` nelas pode exigir `sudo -u postgres psql` (como ocorreu com `orcamento_itens` na migration 037). Tabelas NOVAS criadas pela migration podem ser criadas pelo user da app normalmente.
- Services retornam `{ chave }`/objeto em sucesso ou `{ erro: ['msg'] }` em falha.
- `const db = require('../../db')`; `src/db` exporta `{ query, pool }` (use `db.pool.connect()` para transação).
- Router catálogo: ver `src/modules/materiais/router.js`. Registro em `src/modules/index.js` (`router.use('/<nome>', requireAuthApi, require('./<nome>/router'))`).
- `multer` já é dependência; padrão de uso em `src/modules/os/router.js` (diskStorage). Aqui usaremos `multer.memoryStorage()` para ler o buffer do XML.
- Deploy: `rsync -az <path> root@2.25.147.243:/var/www/lkl-chatbot/<path>`; restart `ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"`; node server-side `ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e '<js>'"`.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Fatos do código (verificados):**
- `materiais(id, codigo UNIQUE, nome, unidade, estoque_atual NUMERIC(10,3), custo_medio NUMERIC(10,4), fornecedor_id)`. `materiais/service.js` tem `atualizar`, `atualizarEstoque(id, quantidade, tipo)`.
- `fornecedores(id, nome, cnpj VARCHAR(18))`.
- `fast-xml-parser` já presente em node_modules (será fixado no package.json).

**File Structure:**
- Create: `sql/migrations/038_entradas_estoque.sql`
- Create: `src/modules/entradas/service.js` — parse + preview + confirmar + estornar + listar.
- Create: `src/modules/entradas/router.js` — rotas REST (multer memoryStorage).
- Modify: `src/modules/index.js` — registrar `/entradas`.
- Modify: `package.json` — fixar `fast-xml-parser`.
- Modify: `public/dashboard.html` — aba Entrada NF-e (importar/preview/confirmar/histórico).

---

### Task 1: Migration 038 — colunas em materiais + tabelas de entrada

**Files:**
- Create: `sql/migrations/038_entradas_estoque.sql`

- [ ] **Step 1: Escrever a migration**

Create `sql/migrations/038_entradas_estoque.sql`:

```sql
-- Entrada de estoque via NF-e de compra
ALTER TABLE materiais ADD COLUMN IF NOT EXISTS codigo_barras VARCHAR(20);
ALTER TABLE materiais ADD COLUMN IF NOT EXISTS fator_entrada NUMERIC(12,4) DEFAULT 1;

CREATE TABLE IF NOT EXISTS entradas_estoque (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fornecedor_id UUID REFERENCES fornecedores(id) ON DELETE SET NULL,
  nnf           VARCHAR(20),
  chave         VARCHAR(44) UNIQUE,
  emitida_em    DATE,
  valor_total   NUMERIC(12,2),
  status        VARCHAR(12) NOT NULL DEFAULT 'lancada' CHECK (status IN ('lancada','estornada')),
  criada_em     TIMESTAMPTZ DEFAULT now(),
  criada_por    UUID REFERENCES users(id) ON DELETE SET NULL,
  estornada_em  TIMESTAMPTZ,
  estornada_por UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS entradas_estoque_itens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entrada_id          UUID NOT NULL REFERENCES entradas_estoque(id) ON DELETE CASCADE,
  material_id         UUID REFERENCES materiais(id),
  cprod               VARCHAR(60),
  cean                VARCHAR(20),
  xprod               VARCHAR(200),
  ucom                VARCHAR(10),
  qcom                NUMERIC(14,4),
  vun                 NUMERIC(14,6),
  fator_aplicado      NUMERIC(12,4),
  quantidade_estoque  NUMERIC(14,4),
  custo_unit_estoque  NUMERIC(14,6)
);
CREATE INDEX IF NOT EXISTS idx_entradas_itens_entrada ON entradas_estoque_itens(entrada_id);
```

- [ ] **Step 2: Aplicar no VPS**

Rode primeiro como o user padrão; se os `ALTER TABLE materiais` falharem por permissão (owner `postgres`), rode com `sudo -u postgres`:

```bash
rsync -az sql/migrations/038_entradas_estoque.sql root@2.25.147.243:/var/www/lkl-chatbot/sql/migrations/038_entradas_estoque.sql
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && (psql \$DATABASE_URL -f sql/migrations/038_entradas_estoque.sql || sudo -u postgres psql -d \$(psql \$DATABASE_URL -tAc 'SELECT current_database()') -f sql/migrations/038_entradas_estoque.sql)"
```
Se o fallback ainda exigir o nome do banco explícito, rode os ALTERs assim:
```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl -c \"ALTER TABLE materiais ADD COLUMN IF NOT EXISTS codigo_barras VARCHAR(20); ALTER TABLE materiais ADD COLUMN IF NOT EXISTS fator_entrada NUMERIC(12,4) DEFAULT 1;\""
```
(Descubra o nome do banco com `grep DATABASE_URL /var/www/lkl-chatbot/.env` se necessário.)
Expected: 2× ALTER TABLE, 2× CREATE TABLE, 1× CREATE INDEX, sem erro.

- [ ] **Step 3: Verificar**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && psql \$DATABASE_URL -c \"SELECT column_name FROM information_schema.columns WHERE table_name='materiais' AND column_name IN ('codigo_barras','fator_entrada') ORDER BY column_name\" -c '\\dt entradas_estoque*'"
```
Expected: retorna `codigo_barras`, `fator_entrada`; e lista as tabelas `entradas_estoque` e `entradas_estoque_itens`.

- [ ] **Step 4: Commit**

```bash
git add sql/migrations/038_entradas_estoque.sql
git commit -m "feat(estoque): migration 038 — entradas_estoque + codigo_barras/fator_entrada em materiais

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Parser do XML (`parseNfeCompra`) — função pura

**Files:**
- Create: `src/modules/entradas/service.js`
- Modify: `package.json`

- [ ] **Step 1: Fixar a dependência**

```bash
npm install fast-xml-parser
```
Expected: adiciona `fast-xml-parser` em `dependencies` (já presente em node_modules; isto fixa a versão).

- [ ] **Step 2: Criar o service com `parseNfeCompra`**

Create `src/modules/entradas/service.js`:

```js
const db = require('../../db');
const { XMLParser } = require('fast-xml-parser');

// Parsing puro do XML de uma NF-e de compra → estrutura normalizada
function parseNfeCompra(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });
  let doc;
  try { doc = parser.parse(xml); } catch (e) { throw new Error('XML de NF-e inválido'); }
  const nfe = doc?.nfeProc?.NFe || doc?.NFe;
  const inf = nfe?.infNFe;
  if (!inf) throw new Error('XML de NF-e inválido');
  const chave = String(inf['@_Id'] || '').replace(/^NFe/i, '').replace(/\D/g, '').slice(0, 44) || null;
  const emit = inf.emit || {};
  const ide = inf.ide || {};
  const tot = inf.total?.ICMSTot || {};
  const dets = Array.isArray(inf.det) ? inf.det : (inf.det ? [inf.det] : []);
  const itens = dets.map(d => {
    const p = d.prod || {};
    const ceanRaw = p.cEAN != null ? String(p.cEAN) : '';
    const cean = (ceanRaw && !/SEM\s*GTIN/i.test(ceanRaw)) ? ceanRaw : null;
    return {
      cprod: p.cProd != null ? String(p.cProd) : null,
      cean,
      xprod: p.xProd || null,
      ucom: p.uCom || null,
      qcom: p.qCom != null ? parseFloat(p.qCom) : null,
      vun: p.vUnCom != null ? parseFloat(p.vUnCom) : null,
      vprod: p.vProd != null ? parseFloat(p.vProd) : null,
      ncm: p.NCM != null ? String(p.NCM) : null,
    };
  });
  const dh = ide.dhEmi || ide.dEmi || null;
  return {
    emitente: { cnpj: emit.CNPJ != null ? String(emit.CNPJ) : null, nome: emit.xNome || null },
    nnf: ide.nNF != null ? String(ide.nNF) : null,
    chave,
    emitida_em: dh ? String(dh).slice(0, 10) : null,
    valor_total: tot.vNF != null ? parseFloat(tot.vNF) : null,
    itens,
  };
}

module.exports = { parseNfeCompra };
```

- [ ] **Step 3: Testar o parser localmente (sem DB)**

Run (cria um XML mínimo e parseia):
```bash
node -e '
const { parseNfeCompra } = require("./src/modules/entradas/service");
const xml = `<?xml version="1.0"?><nfeProc><NFe><infNFe Id="NFe35200114200166000187550010000000071000000071"><ide><nNF>71</nNF><dhEmi>2026-06-20T10:00:00-03:00</dhEmi></ide><emit><CNPJ>14200166000187</CNPJ><xNome>PAPELARIA FORNECEDOR LTDA</xNome></emit><det nItem="1"><prod><cProd>SULFITE90</cProd><cEAN>7891234567890</cEAN><xProd>SULFITE 90G 66X96</xProd><uCom>RESMA</uCom><qCom>10.0000</qCom><vUnCom>25.000000</vUnCom><vProd>250.00</vProd><NCM>48025690</NCM></prod></det><total><ICMSTot><vNF>250.00</vNF></ICMSTot></total></infNFe></NFe></nfeProc>`;
const r = parseNfeCompra(xml);
console.log(JSON.stringify(r, null, 2));
if (r.chave !== "35200114200166000187550010000000071000000071") throw new Error("chave errada: "+r.chave);
if (r.emitente.cnpj !== "14200166000187") throw new Error("cnpj errado");
if (r.itens.length !== 1 || r.itens[0].cean !== "7891234567890" || r.itens[0].qcom !== 10) throw new Error("item errado");
console.log("PARSE OK");
'
```
Expected: imprime o JSON e `PARSE OK`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/modules/entradas/service.js
git commit -m "feat(estoque): parseNfeCompra (parser de NF-e de compra com fast-xml-parser)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Service — preview, confirmar, estornar, listar

**Files:**
- Modify: `src/modules/entradas/service.js`

- [ ] **Step 1: Adicionar `preview`**

Em `src/modules/entradas/service.js`, antes do `module.exports`, adicionar:

```js
function _soDigitos(s) { return (s || '').replace(/\D/g, ''); }

// Parse + casa fornecedor (CNPJ) e cada item (EAN/código). NÃO grava.
async function preview(xml) {
  const nf = parseNfeCompra(xml);
  // fornecedor por CNPJ (compara só dígitos)
  let fornecedor = null;
  if (nf.emitente.cnpj) {
    const f = await db.query(
      `SELECT id, nome, cnpj FROM fornecedores WHERE regexp_replace(COALESCE(cnpj,''),'\\D','','g') = $1 LIMIT 1`,
      [_soDigitos(nf.emitente.cnpj)]);
    fornecedor = f.rows[0] || null;
  }
  const itens = [];
  for (const it of nf.itens) {
    let material = null;
    if (it.cean) {
      const m = await db.query('SELECT id, nome, codigo, codigo_barras, fator_entrada, estoque_atual FROM materiais WHERE codigo_barras = $1 LIMIT 1', [it.cean]);
      material = m.rows[0] || null;
    }
    if (!material && it.cprod) {
      const m = await db.query('SELECT id, nome, codigo, codigo_barras, fator_entrada, estoque_atual FROM materiais WHERE codigo = $1 LIMIT 1', [it.cprod]);
      material = m.rows[0] || null;
    }
    itens.push({
      ...it,
      material_id: material ? material.id : null,
      material_nome: material ? material.nome : null,
      fator: material && material.fator_entrada != null ? Number(material.fator_entrada) : 1,
    });
  }
  return { ...nf, fornecedor, fornecedor_cnpj: nf.emitente.cnpj, fornecedor_nome: nf.emitente.nome, itens };
}
```

- [ ] **Step 2: Adicionar `confirmar`**

```js
// Confirma a entrada: grava cabeçalho+itens, dá entrada no estoque e recalcula custo médio.
async function confirmar({ chave, nnf, emitida_em, valor_total, fornecedor_id, itens }) {
  if (!Array.isArray(itens)) return { erro: ['itens é obrigatório'] };
  if (chave) {
    const dup = await db.query('SELECT id FROM entradas_estoque WHERE chave = $1', [chave]);
    if (dup.rows[0]) return { erro: ['NF já lançada'] };
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const ent = await client.query(
      `INSERT INTO entradas_estoque (fornecedor_id, nnf, chave, emitida_em, valor_total, status, criada_por)
       VALUES ($1,$2,$3,$4,$5,'lancada',$6) RETURNING *`,
      [fornecedor_id || null, nnf || null, chave || null, emitida_em || null, valor_total || null, null]);
    const entrada = ent.rows[0];
    for (const it of itens) {
      const fator = it.fator != null && it.fator !== '' ? Number(it.fator) : 1;
      const qcom = it.qcom != null ? Number(it.qcom) : 0;
      const vun = it.vun != null ? Number(it.vun) : 0;
      const qtdEstoque = qcom * fator;
      const custoUnit = fator > 0 ? vun / fator : vun;
      await client.query(
        `INSERT INTO entradas_estoque_itens (entrada_id, material_id, cprod, cean, xprod, ucom, qcom, vun, fator_aplicado, quantidade_estoque, custo_unit_estoque)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [entrada.id, it.material_id || null, it.cprod || null, it.cean || null, it.xprod || null, it.ucom || null,
         qcom, vun, fator, qtdEstoque, custoUnit]);
      if (it.material_id) {
        // custo médio ponderado + entrada de quantidade
        await client.query(
          `UPDATE materiais SET
             custo_medio = CASE WHEN (COALESCE(estoque_atual,0) + $2) > 0
                THEN (COALESCE(estoque_atual,0)*COALESCE(custo_medio,0) + $2*$3) / (COALESCE(estoque_atual,0) + $2)
                ELSE $3 END,
             estoque_atual = COALESCE(estoque_atual,0) + $2,
             updated_at = NOW()
           WHERE id = $1`,
          [it.material_id, qtdEstoque, custoUnit]);
      }
    }
    await client.query('COMMIT');
    return { entrada };
  } catch (e) {
    await client.query('ROLLBACK');
    return { erro: [e.message] };
  } finally {
    client.release();
  }
}
```

- [ ] **Step 3: Adicionar `estornar`, `listar`, `buscarPorId`**

```js
async function estornar(entradaId, { userId } = {}) {
  const e = await db.query('SELECT id, status FROM entradas_estoque WHERE id=$1', [entradaId]);
  if (!e.rows[0]) return { erro: ['Entrada não encontrada'] };
  if (e.rows[0].status === 'estornada') return { erro: ['Entrada já estornada'] };
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const itens = await client.query('SELECT material_id, quantidade_estoque FROM entradas_estoque_itens WHERE entrada_id=$1', [entradaId]);
    for (const it of itens.rows) {
      if (it.material_id) {
        await client.query('UPDATE materiais SET estoque_atual = COALESCE(estoque_atual,0) - $1, updated_at=NOW() WHERE id=$2',
          [it.quantidade_estoque, it.material_id]);
      }
    }
    await client.query(`UPDATE entradas_estoque SET status='estornada', estornada_em=NOW(), estornada_por=$1 WHERE id=$2`,
      [userId || null, entradaId]);
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK');
    return { erro: [err.message] };
  } finally {
    client.release();
  }
}

async function listar() {
  const r = await db.query(
    `SELECT e.*, f.nome AS fornecedor_nome
     FROM entradas_estoque e LEFT JOIN fornecedores f ON f.id = e.fornecedor_id
     ORDER BY e.criada_em DESC LIMIT 100`);
  return { entradas: r.rows };
}

async function buscarPorId(id) {
  const e = await db.query(
    `SELECT e.*, f.nome AS fornecedor_nome FROM entradas_estoque e
     LEFT JOIN fornecedores f ON f.id=e.fornecedor_id WHERE e.id=$1`, [id]);
  if (!e.rows[0]) return null;
  const itens = await db.query(
    `SELECT ei.*, m.nome AS material_nome FROM entradas_estoque_itens ei
     LEFT JOIN materiais m ON m.id=ei.material_id WHERE ei.entrada_id=$1`, [id]);
  return { ...e.rows[0], itens: itens.rows };
}
```

- [ ] **Step 4: Atualizar exports**

Trocar o `module.exports` por:
```js
module.exports = { parseNfeCompra, preview, confirmar, estornar, listar, buscarPorId };
```

- [ ] **Step 5: node --check + deploy + smoke**

```bash
node --check src/modules/entradas/service.js && echo OK
rsync -az src/modules/entradas/ root@2.25.147.243:/var/www/lkl-chatbot/src/modules/entradas/
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const s=require('./src/modules/entradas/service'); const db=require('./src/db');
(async()=>{
  // cria material de teste com EAN e fator
  const codBar='7899999000001';
  let m=(await db.query('SELECT id,estoque_atual,custo_medio FROM materiais WHERE codigo_barras=\$1',[codBar])).rows[0];
  if(!m){ m=(await db.query(\\\"INSERT INTO materiais (nome,unidade,codigo_barras,fator_entrada,estoque_atual,custo_medio) VALUES ('TESTE ENTRADA NF','folha',\$1,500,0,0) RETURNING id,estoque_atual,custo_medio\\\",[codBar])).rows[0]; }
  console.log('material antes estoque=',m.estoque_atual,'custo=',m.custo_medio);
  const xml='<?xml version=\\\"1.0\\\"?><nfeProc><NFe><infNFe Id=\\\"NFe99999999999999999999999999999999999999000099\\\"><ide><nNF>99</nNF><dhEmi>2026-06-24T10:00:00-03:00</dhEmi></ide><emit><CNPJ>14200166000187</CNPJ><xNome>FORNEC TESTE</xNome></emit><det><prod><cProd>X</cProd><cEAN>'+codBar+'</cEAN><xProd>TESTE</xProd><uCom>RESMA</uCom><qCom>2</qCom><vUnCom>500</vUnCom><vProd>1000</vProd></prod></det><total><ICMSTot><vNF>1000</vNF></ICMSTot></total></infNFe></NFe></nfeProc>';
  const pv=await s.preview(xml);
  console.log('preview item material_id=',pv.itens[0].material_id,'fator=',pv.itens[0].fator);
  const conf=await s.confirmar({ chave: pv.chave, nnf: pv.nnf, emitida_em: pv.emitida_em, valor_total: pv.valor_total, fornecedor_id: pv.fornecedor?pv.fornecedor.id:null, itens: pv.itens });
  if(conf.erro){console.log('ERRO',conf.erro);process.exit(1);}
  const m2=(await db.query('SELECT estoque_atual,custo_medio FROM materiais WHERE id=\$1',[m.id])).rows[0];
  console.log('depois estoque=',m2.estoque_atual,'(esperado +1000)','custo=',m2.custo_medio,'(esperado 1.0)');
  await s.estornar(conf.entrada.id,{});
  const m3=(await db.query('SELECT estoque_atual FROM materiais WHERE id=\$1',[m.id])).rows[0];
  console.log('depois estorno estoque=',m3.estoque_atual);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
\""
```
Expected: `preview item material_id=` preenchido, `fator= 500`; estoque sobe +1000 (2 resmas × 500), custo_medio = 1.0 (500/500); estorno volta o estoque.

- [ ] **Step 6: Commit**

```bash
git add src/modules/entradas/service.js
git commit -m "feat(estoque): preview/confirmar/estornar/listar de entradas de NF-e

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Router + registro

**Files:**
- Create: `src/modules/entradas/router.js`
- Modify: `src/modules/index.js`

- [ ] **Step 1: Criar o router**

Create `src/modules/entradas/router.js`:

```js
const express = require('express');
const multer = require('multer');
const { requireRole } = require('../../middleware/auth');
const service = require('./service');

const router = express.Router();
const uploadXml = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// POST /preview — recebe o XML (multipart campo "xml") e devolve a pré-visualização
router.post('/preview', requireRole('admin', 'gestor'), uploadXml.single('xml'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo XML não enviado' });
    const result = await service.preview(req.file.buffer.toString('utf8'));
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || 'XML inválido' });
  }
});

// POST / — confirma a entrada
router.post('/', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.confirmar({ ...req.body });
    if (result.erro) {
      const dup = result.erro.some(e => e.includes('já lançada'));
      return res.status(dup ? 409 : 400).json({ errors: result.erro });
    }
    res.status(201).json(result.entrada);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

// POST /:id/estornar
router.post('/:id/estornar', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const result = await service.estornar(req.params.id, { userId: req.user.id });
    if (result.erro) {
      const nf = result.erro.some(e => e.includes('não encontrada'));
      return res.status(nf ? 404 : 400).json({ errors: result.erro });
    }
    res.json(result);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/', requireRole('admin', 'gestor'), async (req, res) => {
  try { res.json(await service.listar()); }
  catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

router.get('/:id', requireRole('admin', 'gestor'), async (req, res) => {
  try {
    const e = await service.buscarPorId(req.params.id);
    if (!e) return res.status(404).json({ error: 'Entrada não encontrada' });
    res.json(e);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

module.exports = router;
```

- [ ] **Step 2: Registrar em index.js**

Em `src/modules/index.js`, após a linha do `materiais` (ou `maquinas`), adicionar:
```js
router.use('/entradas', requireAuthApi, require('./entradas/router'));
```

- [ ] **Step 3: node --check + deploy**

```bash
node --check src/modules/entradas/router.js && node --check src/modules/index.js && echo OK
rsync -az src/modules/entradas/router.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/entradas/router.js
rsync -az src/modules/index.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/index.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && echo restarted"
```
Expected: `OK` e `restarted`.

- [ ] **Step 4: Commit**

```bash
git add src/modules/entradas/router.js src/modules/index.js
git commit -m "feat(estoque): rotas /api/v2/entradas (preview/confirmar/estornar/histórico)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Dashboard — aba "Entrada NF-e" (importar → preview → confirmar → histórico)

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Investigar padrões reais**

```bash
grep -n "id: 'maquinas'\|id: 'materiais'\|page-materiais\|showPage\|loaders\|api(\|function api\|showToast\|escHtml\|modal-cadastro" public/dashboard.html | head -40
```
Confirmar: o array `NAV` (seção Cadastros), o mecanismo `showPage(id)` + dict `loaders`, e a assinatura de `api(path, opts)` — em especial COMO enviar multipart (FormData). Ler uma chamada `api(...)` existente para ver se ela seta `Content-Type` automaticamente; se `api()` força `application/json`, o upload do XML deve usar `fetch` direto com `FormData` + o header Authorization (ler como o token é guardado, ex.: `localStorage`/variável global).

- [ ] **Step 2: Adicionar nav + página**

No array `NAV` (seção Cadastros) adicionar:
```js
{ id: 'entradas', label: 'Entrada NF-e', icon: '📥', roles: ['admin','gestor'] },
```
Adicionar a página:
```html
<div class="page" id="page-entradas">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
    <h2 style="margin:0">Entrada de NF-e (compra)</h2>
    <label class="btn btn-primary" style="cursor:pointer">📥 Importar NF-e
      <input type="file" accept=".xml,text/xml" style="display:none" onchange="importarNfe(this)">
    </label>
  </div>
  <div id="list-entradas-main"><div style="text-align:center;padding:40px;color:#999">Carregando...</div></div>
</div>
```
No dict `loaders` dentro de `showPage`, adicionar:
```js
    entradas: () => loadEntradasMain(),
```

- [ ] **Step 3: Funções JS — importar/preview/confirmar**

Adicionar (perto das funções de Materiais). IMPORTANTE: para o upload use `fetch` com `FormData` (adapte a obtenção do token ao mecanismo real visto no Step 1):

```js
let _previewNfe = null;

async function importarNfe(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  const fd = new FormData();
  fd.append('xml', file);
  const token = localStorage.getItem('token'); // AJUSTAR ao mecanismo real de auth
  let resp;
  try {
    resp = await fetch('/api/v2/entradas/preview', { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: fd });
  } catch (e) { showToast('Falha ao enviar XML'); return; }
  const data = await resp.json();
  if (!resp.ok) { showToast('Erro: ' + (data.error || 'XML inválido')); return; }
  _previewNfe = data;
  abrirPreviewNfe(data);
}

async function _materiaisOptions(selectedId) {
  const r = await api('/api/v2/materiais?status=ativo&limit=500');
  const mats = r?.materiais || [];
  return '<option value="">— ignorar —</option>' +
    mats.map(m => `<option value="${m.id}" ${m.id===selectedId?'selected':''}>${escHtml(m.nome)}</option>`).join('');
}

async function abrirPreviewNfe(data) {
  const opts = await _materiaisOptions(null);
  const fornecedorTxt = data.fornecedor
    ? `Fornecedor: <b>${escHtml(data.fornecedor.nome)}</b>`
    : `Fornecedor não cadastrado: <b>${escHtml(data.fornecedor_nome||'—')}</b> (CNPJ ${escHtml(data.fornecedor_cnpj||'—')})`;
  const linhas = data.itens.map((it, i) => `
    <tr data-i="${i}">
      <td style="padding:4px 6px">${escHtml(it.xprod||it.cprod||'—')}</td>
      <td style="padding:4px 6px;text-align:right">${it.qcom}</td>
      <td style="padding:4px 6px">${escHtml(it.ucom||'')}</td>
      <td style="padding:4px 6px"><select id="nfe-mat-${i}" style="width:160px">${opts.replace('value="'+(it.material_id||'')+'"', 'value="'+(it.material_id||'')+'" selected')}</select></td>
      <td style="padding:4px 6px"><input id="nfe-fator-${i}" type="number" step="0.0001" value="${it.fator!=null?it.fator:1}" style="width:80px" oninput="_recalcNfe(${i})"></td>
      <td style="padding:4px 6px;text-align:right" id="nfe-qe-${i}">${(Number(it.qcom||0)*Number(it.fator||1)).toLocaleString('pt-BR',{maximumFractionDigits:3})}</td>
    </tr>`).join('');
  const html = `
    <div style="margin-bottom:10px;font-size:13px">${fornecedorTxt} · NF ${escHtml(data.nnf||'—')} · Total R$ ${Number(data.valor_total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="color:#777;text-align:left"><th style="padding:4px 6px">Produto (NF)</th><th>Qtd</th><th>Un</th><th>Material</th><th>Fator</th><th>Qtd estoque</th></tr></thead>
      <tbody>${linhas}</tbody>
    </table>
    <button class="btn btn-primary" style="margin-top:12px" onclick="confirmarNfe()">Confirmar entrada</button>`;
  showModal('Pré-visualização da NF-e', html, '760px');
  // garante o material casado pré-selecionado por item
  data.itens.forEach((it, i) => { const s = document.getElementById('nfe-mat-'+i); if (s && it.material_id) s.value = it.material_id; });
}

function _recalcNfe(i) {
  const it = _previewNfe.itens[i];
  const fator = parseFloat(document.getElementById('nfe-fator-'+i).value) || 0;
  document.getElementById('nfe-qe-'+i).textContent = (Number(it.qcom||0)*fator).toLocaleString('pt-BR',{maximumFractionDigits:3});
}

async function confirmarNfe() {
  const itens = _previewNfe.itens.map((it, i) => ({
    ...it,
    material_id: document.getElementById('nfe-mat-'+i).value || null,
    fator: parseFloat(document.getElementById('nfe-fator-'+i).value) || 1,
  }));
  const payload = {
    chave: _previewNfe.chave, nnf: _previewNfe.nnf, emitida_em: _previewNfe.emitida_em,
    valor_total: _previewNfe.valor_total,
    fornecedor_id: _previewNfe.fornecedor ? _previewNfe.fornecedor.id : null,
    itens,
  };
  const res = await api('/api/v2/entradas', { method: 'POST', body: JSON.stringify(payload) });
  if (res?.errors || res?.error) { showToast('Erro: ' + (res.errors?.[0] || res.error)); return; }
  closeModal();
  showToast('✅ Entrada lançada');
  loadEntradasMain();
}
```
(Adaptar `showModal`/`closeModal` aos nomes reais — em outras telas o projeto usa `#modal-cadastro`/`fecharModalCadastro`. Se for o caso, usar esse padrão e os ids reais.)

- [ ] **Step 4: Função do histórico**

```js
async function loadEntradasMain() {
  const box = document.getElementById('list-entradas-main');
  if (!box) return;
  const r = await api('/api/v2/entradas');
  const list = r?.entradas || [];
  if (!list.length) { box.innerHTML = '<p style="color:#999;padding:20px">Nenhuma entrada lançada</p>'; return; }
  box.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="color:#777;text-align:left"><th style="padding:6px 8px">NF</th><th>Fornecedor</th><th>Emissão</th><th style="text-align:right">Total</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(e => `<tr>
      <td style="padding:6px 8px">${escHtml(e.nnf||'—')}</td>
      <td style="padding:6px 8px">${escHtml(e.fornecedor_nome||'—')}</td>
      <td style="padding:6px 8px">${e.emitida_em ? new Date(e.emitida_em).toLocaleDateString('pt-BR') : '—'}</td>
      <td style="padding:6px 8px;text-align:right">R$ ${Number(e.valor_total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
      <td style="padding:6px 8px">${e.status==='estornada' ? '<span style="color:#c62828">estornada</span>' : '<span style="color:#2e7d32">lançada</span>'}</td>
      <td style="padding:6px 8px">${e.status==='lancada' ? `<button onclick="estornarNfe('${e.id}')" style="background:#ad1457;border:none;border-radius:6px;color:white;font-size:11px;padding:4px 8px;cursor:pointer">Estornar</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>`;
}

async function estornarNfe(id) {
  if (!confirm('Estornar esta entrada (devolver a quantidade ao estoque)?')) return;
  const res = await api(`/api/v2/entradas/${id}/estornar`, { method: 'POST' });
  if (res?.errors || res?.error) { showToast('Erro: ' + (res.errors?.[0] || res.error)); return; }
  showToast('↩ Entrada estornada');
  loadEntradasMain();
}
```

- [ ] **Step 5: Deploy**

```bash
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
```

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(estoque): aba Entrada NF-e (importar XML, preview, confirmar, histórico)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Atualizar memória do projeto

**Files:**
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Registrar como concluído**

Atualizar a fila pós-M12: marcar "Estoque-Entrada via NF-e de compra" como CONCLUÍDO — 2026-06-24, com resumo: módulo `/api/v2/entradas` (parse XML com fast-xml-parser; preview casa fornecedor por CNPJ e itens por EAN/código; confirmar dá entrada + custo médio ponderado; estornar reverte quantidade); tabelas `entradas_estoque`/`entradas_estoque_itens` (migration 038); `materiais.codigo_barras`/`fator_entrada`; aba "Entrada NF-e" no dashboard. Próxima migration livre: 039.

- [ ] **Step 2: Sem commit** (memória fora do git do projeto).

---

## Notas de verificação final

- Importar um XML real de NF-e de compra, conferir o preview (fornecedor + itens casados), ajustar fator se necessário, confirmar e verificar a subida do `estoque_atual` e recálculo de `custo_medio` na aba Materiais. Estornar e confirmar a reversão da quantidade.
- Reimportar a MESMA NF deve retornar 409 "NF já lançada".
- Item sem material casado (combo "ignorar") não deve alterar estoque.
