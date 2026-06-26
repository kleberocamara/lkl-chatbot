# Board de Produção Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the linear status list in producao.html with a Kanban board (Corte→Impressão→Acabamento→Entrega) driven by a new `avancarFase()` service function and a `os_historico` audit table, with matching boards in dashboard.html and the motorista.html delivery fix.

**Architecture:** New constant file `src/constants/fluxoProducao.js` is the single source of truth for the phase state machine. The service gains `avancarFase()` and `historico()` functions; a Migration 042 creates `os_historico` and remaps legacy statuses. Existing `atualizarStatus()` (admin-only) is kept but updated to the new status set. Three frontend files are updated: producao.html becomes a board, dashboard.html replaces its placeholder, and motorista.html queries `status=entrega` instead of `status=pronto`.

**Tech Stack:** Node.js/Express, PostgreSQL (db module = `src/db`), Jest (test runner), vanilla JS (PWA frontend pages), `global.io` for socket events, FCM via `src/services/fcm`.

---

## File Map

| Action | File |
|--------|------|
| **Create** | `src/constants/fluxoProducao.js` |
| **Create** | `sql/migrations/042_board_producao.sql` |
| **Create** | `tests/fluxoProducao.test.js` |
| **Modify** | `src/modules/os/service.js` |
| **Modify** | `src/modules/os/router.js` |
| **Modify** | `public/pwa/producao.html` |
| **Modify** | `public/dashboard.html` |
| **Modify** | `public/pwa/motorista.html` |

---

### Task 1: `src/constants/fluxoProducao.js` — state machine + unit tests

**Files:**
- Create: `src/constants/fluxoProducao.js`
- Create: `tests/fluxoProducao.test.js`

- [ ] **Step 1: Write the failing tests**

`tests/fluxoProducao.test.js`:
```js
const { FLUXO, FASE_LABEL, proximaFase } = require('../src/constants/fluxoProducao');

describe('FLUXO', () => {
  test('offset tem 4 fases', () => {
    expect(FLUXO.offset).toEqual(['corte','impressao','acabamento','entrega']);
  });
  test('comunicacao_visual tem 3 fases', () => {
    expect(FLUXO.comunicacao_visual).toEqual(['impressao','acabamento','entrega']);
  });
});

describe('FASE_LABEL', () => {
  test('corte label', () => { expect(FASE_LABEL.corte).toBe('Corte'); });
  test('entregue label', () => { expect(FASE_LABEL.entregue).toBe('Entregue'); });
});

describe('proximaFase', () => {
  // offset path
  test('offset: corte → impressao', () => {
    expect(proximaFase('offset','corte')).toBe('impressao');
  });
  test('offset: impressao → acabamento', () => {
    expect(proximaFase('offset','impressao')).toBe('acabamento');
  });
  test('offset: acabamento → entrega', () => {
    expect(proximaFase('offset','acabamento')).toBe('entrega');
  });
  test('offset: entrega → entregue (terminal gate)', () => {
    expect(proximaFase('offset','entrega')).toBe('entregue');
  });
  // cv path
  test('cv: impressao → acabamento', () => {
    expect(proximaFase('comunicacao_visual','impressao')).toBe('acabamento');
  });
  test('cv: acabamento → entrega', () => {
    expect(proximaFase('comunicacao_visual','acabamento')).toBe('entrega');
  });
  test('cv: entrega → entregue', () => {
    expect(proximaFase('comunicacao_visual','entrega')).toBe('entregue');
  });
  // terminals
  test('entregue → null', () => {
    expect(proximaFase('offset','entregue')).toBeNull();
  });
  test('cancelado → null', () => {
    expect(proximaFase('offset','cancelado')).toBeNull();
  });
  test('status desconhecido → null', () => {
    expect(proximaFase('offset','aguardando')).toBeNull();
  });
  test('tipo desconhecido → null', () => {
    expect(proximaFase('desconhecido','corte')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/klebercamara/LKL && npx jest tests/fluxoProducao.test.js --no-coverage
```

Expected: FAIL — "Cannot find module '../src/constants/fluxoProducao'"

- [ ] **Step 3: Create `src/constants/fluxoProducao.js`**

```js
const FLUXO = {
  offset:             ['corte', 'impressao', 'acabamento', 'entrega'],
  comunicacao_visual: ['impressao', 'acabamento', 'entrega'],
};

const FASE_LABEL = {
  corte:     'Corte',
  impressao: 'Impressão',
  acabamento:'Acabamento',
  entrega:   'Entrega',
  entregue:  'Entregue',
};

function proximaFase(tipo_servico, statusAtual) {
  const fases = FLUXO[tipo_servico];
  if (!fases) return null;
  if (statusAtual === 'entrega') return 'entregue';
  const idx = fases.indexOf(statusAtual);
  if (idx === -1 || idx === fases.length - 1) return null;
  return fases[idx + 1];
}

module.exports = { FLUXO, FASE_LABEL, proximaFase };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/klebercamara/LKL && npx jest tests/fluxoProducao.test.js --no-coverage
```

Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/constants/fluxoProducao.js tests/fluxoProducao.test.js
git commit -m "feat(producao): fluxoProducao state machine + unit tests"
```

---

### Task 2: Migration 042 — os_historico + status remap

**Files:**
- Create: `sql/migrations/042_board_producao.sql`

- [ ] **Step 1: Create the migration file**

`sql/migrations/042_board_producao.sql`:
```sql
-- Table: os_historico (append-only audit log)
CREATE TABLE IF NOT EXISTS os_historico (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  os_id       UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  de_status   TEXT,
  para_status TEXT NOT NULL,
  usuario_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  em          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_os_historico_os_id ON os_historico(os_id);

-- Remap legacy statuses on existing OS rows
UPDATE ordens_servico
SET status = CASE
  WHEN status IN ('embalagem', 'pronto') THEN 'entrega'
  WHEN status IN ('arte_final', 'aguardando_aprovacao_arte', 'aguardando')
    THEN CASE tipo_servico
           WHEN 'comunicacao_visual' THEN 'impressao'
           ELSE 'corte'
         END
  ELSE status
END
WHERE status IN ('embalagem','pronto','arte_final','aguardando_aprovacao_arte','aguardando');
```

- [ ] **Step 2: Run migration on VPS**

```bash
ssh root@vps "sudo -u postgres psql -d lkl_prod -f /tmp/042_board_producao.sql"
```

To copy the file first:
```bash
scp /Users/klebercamara/LKL/sql/migrations/042_board_producao.sql root@vps:/tmp/
```

Expected: no errors; rows updated.

Verify remap:
```bash
ssh root@vps "sudo -u postgres psql -d lkl_prod -c \"SELECT status, COUNT(*) FROM ordens_servico GROUP BY status ORDER BY status;\""
```

Expected: no rows with status in `(aguardando, arte_final, aguardando_aprovacao_arte, embalagem, pronto)`.

- [ ] **Step 3: Commit migration file**

```bash
git add sql/migrations/042_board_producao.sql
git commit -m "feat(producao): migration 042 — os_historico + status remap"
```

---

### Task 3: `os/service.js` — avancarFase, historico, updated STATUS_VALIDOS, updated entregar/criarOS

**Files:**
- Modify: `src/modules/os/service.js`

**Context:** This is the largest change. We add two new exported functions (`avancarFase`, `historico`), update `STATUS_VALIDOS`, update `entregar()` to accept `entrega` instead of `pronto`, update `criarOSOffset` and `criarOSComunicacaoVisual` to use new status initials, and update `atualizarStatus` FCM labels + data_inicio trigger. We do NOT remove `enviarArte`/`processarRespostaArte` (they're unused but safe to keep for now). We DO NOT rewrite the entire file — apply targeted edits.

- [ ] **Step 1: Update `STATUS_VALIDOS` (line 5)**

Replace:
```js
const STATUS_VALIDOS = ['aguardando', 'arte_final', 'aguardando_aprovacao_arte', 'impressao', 'acabamento', 'embalagem', 'pronto', 'entregue', 'cancelado'];
```

With:
```js
const STATUS_VALIDOS = ['corte', 'impressao', 'acabamento', 'entrega', 'entregue', 'cancelado'];
```

- [ ] **Step 2: Add `require` for fluxoProducao at the top (after existing requires)**

After line 3 (`const whatsapp = ...`), add:
```js
const { proximaFase } = require('../../constants/fluxoProducao');
```

- [ ] **Step 3: Add `avancarFase(osId, userId)` function**

Add the following function after the `processarRespostaArte` function (around line 97), before `listar`:

```js
async function avancarFase(osId, userId) {
  const osR = await db.query(
    'SELECT id, numero_os, status, tipo_servico, orcamento_id, data_inicio FROM ordens_servico WHERE id=$1',
    [osId]
  );
  if (!osR.rows[0]) return { erro: ['OS não encontrada'] };
  const os = osR.rows[0];

  const proximo = proximaFase(os.tipo_servico, os.status);
  if (!proximo) {
    return { erro: [`OS já está em fase terminal (${os.status}) ou tipo de serviço desconhecido`] };
  }

  const updates = ['status=$1', 'updated_at=NOW()'];
  const params = [proximo];

  // Set data_inicio on first production phase
  const firstPhases = new Set(['corte', 'impressao']);
  if (firstPhases.has(proximo) && !os.data_inicio) {
    updates.push('data_inicio=NOW()');
  }
  // Set data_conclusao when reaching entregue
  if (proximo === 'entregue') {
    updates.push('data_conclusao=NOW()');
  }

  params.push(osId);
  const r = await db.query(
    `UPDATE ordens_servico SET ${updates.join(', ')} WHERE id=$${params.length} RETURNING *`,
    params
  );
  const updatedOs = r.rows[0];

  // Write history
  db.query(
    `INSERT INTO os_historico (os_id, de_status, para_status, usuario_id) VALUES ($1,$2,$3,$4)`,
    [osId, os.status, proximo, userId || null]
  ).catch(e => console.warn('[OS-HIST]', e.message));

  // OS-3C: baixa automática de materiais ao entrar em impressão
  if (proximo === 'impressao' && os.status !== 'impressao') {
    baixarMateriais(osId, { userId }).catch(e =>
      console.warn('[OS-3C avancarFase]', e.message)
    );
  }

  // Check all OSs done when entregue
  if (proximo === 'entregue' && os.orcamento_id) {
    db.query(
      `SELECT COUNT(*) FROM ordens_servico WHERE orcamento_id=$1 AND status NOT IN ('entregue','cancelado')`,
      [os.orcamento_id]
    ).then(pendingR => {
      if (parseInt(pendingR.rows[0].count) === 0 && global.io) {
        global.io.emit('servico_concluido', { orcamento_id: os.orcamento_id });
      }
    }).catch(() => {});
  }

  // FCM push
  const fcmLabels = {
    corte:     'Em corte ✂️',
    impressao: 'Em impressão 🖨️',
    acabamento:'Em acabamento ✂️',
    entrega:   'Pronto para entrega 📦',
    entregue:  'Entregue 🎉',
  };
  const label = fcmLabels[proximo];
  if (label && os.orcamento_id) {
    db.query('SELECT vendedor_id, numero FROM orcamentos WHERE id=$1', [os.orcamento_id])
      .then(orcR => {
        if (orcR.rows[0]?.vendedor_id) {
          fcm.sendToUser(orcR.rows[0].vendedor_id, {
            title: `ORC #${orcR.rows[0].numero} — ${label}`,
            body: `OS #${updatedOs.numero_os} atualizada`,
            data: { os_id: osId, orcamento_id: os.orcamento_id, status: proximo },
          }).catch(() => {});
        }
      }).catch(() => {});
  }

  if (global.io) global.io.emit('os_status', { os_id: osId, status: proximo });

  return { os: updatedOs };
}
```

- [ ] **Step 4: Add `historico(osId)` helper function**

Add right after `avancarFase`:
```js
async function historico(osId) {
  const r = await db.query(
    `SELECT h.id, h.de_status, h.para_status, h.em, u.name AS usuario_nome
     FROM os_historico h
     LEFT JOIN users u ON u.id = h.usuario_id
     WHERE h.os_id = $1
     ORDER BY h.em ASC`,
    [osId]
  );
  return r.rows;
}
```

- [ ] **Step 5: Update `entregar()` — accept `status='entrega'` instead of `'pronto'`**

Find the UPDATE query inside `entregar()` (around line 283):
```js
    `UPDATE ordens_servico
     SET status='entregue', entrega_nome_recebedor=$1, entrega_foto_url=$2,
         data_conclusao=NOW(), updated_at=NOW()
     WHERE id=$3 AND status='pronto'
     RETURNING *`,
```

Replace `AND status='pronto'` with `AND status='entrega'`:
```js
    `UPDATE ordens_servico
     SET status='entregue', entrega_nome_recebedor=$1, entrega_foto_url=$2,
         data_conclusao=NOW(), updated_at=NOW()
     WHERE id=$3 AND status='entrega'
     RETURNING *`,
```

Also update the error message right below (line ~291):
```js
  if (!r.rows[0])
    return { erro: ['OS não encontrada ou não está no status "entrega"'] };
```

And the topbar description (in `pwa/motorista.html` this is in the HTML, not here). Also add history write inside `entregar()` after the UPDATE succeeds (after `const os = r.rows[0];`, around line 294):
```js
  const os = r.rows[0];

  // Write history
  db.query(
    `INSERT INTO os_historico (os_id, de_status, para_status, usuario_id) VALUES ($1,$2,$3,$4)`,
    [id, 'entrega', 'entregue', null]
  ).catch(e => console.warn('[OS-HIST entregar]', e.message));
```

- [ ] **Step 6: Update `criarOSOffset` initial status (line ~394)**

Find:
```js
    `INSERT INTO ordens_servico
       (status, tipo_servico, tipo_produto, cliente_id, quantidade, previsao_entrega, observacao_interna, responsavel_id)
     VALUES ('aguardando','offset',$1,$2,$3,$4,$5,$6) RETURNING id, numero_os`,
```

Replace `'aguardando'` with `'corte'`:
```js
    `INSERT INTO ordens_servico
       (status, tipo_servico, tipo_produto, cliente_id, quantidade, previsao_entrega, observacao_interna, responsavel_id)
     VALUES ('corte','offset',$1,$2,$3,$4,$5,$6) RETURNING id, numero_os`,
```

Add history write after `const osId = osR.rows[0].id;` (right after the INSERT):
```js
  const osId = osR.rows[0].id;

  db.query(
    `INSERT INTO os_historico (os_id, de_status, para_status, usuario_id) VALUES ($1,$2,$3,$4)`,
    [osId, null, 'corte', userId || null]
  ).catch(() => {});
```

- [ ] **Step 7: Update `criarOSComunicacaoVisual` initial status (line ~342)**

Find:
```js
  const osR = await db.query(
    `INSERT INTO ordens_servico (orcamento_id, status, tipo_servico, cliente_id, quantidade)
     VALUES ($1, 'aguardando', 'comunicacao_visual', $2, $3) RETURNING id, numero_os`,
```

Replace `'aguardando'` with `'impressao'`:
```js
  const osR = await db.query(
    `INSERT INTO ordens_servico (orcamento_id, status, tipo_servico, cliente_id, quantidade)
     VALUES ($1, 'impressao', 'comunicacao_visual', $2, $3) RETURNING id, numero_os`,
```

Add history write after `const osId = osR.rows[0].id;`:
```js
  const osId = osR.rows[0].id;

  db.query(
    `INSERT INTO os_historico (os_id, de_status, para_status, usuario_id) VALUES ($1,$2,$3,$4)`,
    [osId, null, 'impressao', null]
  ).catch(() => {});
```

- [ ] **Step 8: Update `atualizarStatus` — data_inicio trigger + FCM labels**

Find in `atualizarStatus` (around line 214):
```js
  if (novoStatus === 'arte_final' || novoStatus === 'impressao') {
    updates.push('data_inicio = COALESCE(data_inicio, NOW())');
  }
```

Replace with (triggers on any first-phase entry):
```js
  if (['corte', 'impressao'].includes(novoStatus)) {
    updates.push('data_inicio = COALESCE(data_inicio, NOW())');
  }
```

Find the FCM `labels` object (around line 254):
```js
  const labels = {
    impressao: 'Em impressão 🖨️',
    acabamento: 'Em acabamento ✂️',
    embalagem: 'Em embalagem 📦',
    pronto: 'Pronto ✅',
    entregue: 'Entregue 🎉',
  };
```

Replace with:
```js
  const labels = {
    corte:     'Em corte ✂️',
    impressao: 'Em impressão 🖨️',
    acabamento:'Em acabamento ✂️',
    entrega:   'Pronto para entrega 📦',
    entregue:  'Entregue 🎉',
  };
```

Also add history write at the end of `atualizarStatus`, before `return { os: updatedOs }`:
```js
  // Write history (best-effort)
  db.query(
    `INSERT INTO os_historico (os_id, de_status, para_status, usuario_id) VALUES ($1,$2,$3,$4)`,
    [id, os.status, novoStatus, responsavel_id || null]
  ).catch(e => console.warn('[OS-HIST atualizarStatus]', e.message));

  return { os: updatedOs };
```

- [ ] **Step 9: Export the new functions**

Find `module.exports` at the bottom of the file:
```js
module.exports = { listar, buscarPorId, atualizarStatus, entregar, enviarArte, processarRespostaArte, criarOSComunicacaoVisual, itensOffsetDisponiveis, criarOSOffset, atualizarFichaProducao, baixarMateriais, estornarRequisicao };
```

Replace with:
```js
module.exports = { listar, buscarPorId, atualizarStatus, avancarFase, historico, entregar, enviarArte, processarRespostaArte, criarOSComunicacaoVisual, itensOffsetDisponiveis, criarOSOffset, atualizarFichaProducao, baixarMateriais, estornarRequisicao };
```

- [ ] **Step 10: Commit**

```bash
git add src/modules/os/service.js
git commit -m "feat(producao): avancarFase + historico + status remap nos services"
```

---

### Task 4: `os/router.js` — new endpoints PATCH /:id/avancar and GET /:id/historico

**Files:**
- Modify: `src/modules/os/router.js`

- [ ] **Step 1: Add PATCH /:id/avancar endpoint**

Add the following route after the `PATCH /:id/status` block (after line 101), before `PATCH /:id/enviar-arte`:

```js
// PATCH /:id/avancar — avança a OS para a próxima fase (board de produção)
router.patch('/:id/avancar', requireRole('admin', 'operador', 'gestor', 'atendente', 'analista'), async (req, res) => {
  try {
    const result = await service.avancarFase(req.params.id, req.user.id);
    if (result.erro) {
      const isNotFound = result.erro.some(e => e.includes('não encontrada'));
      return res.status(isNotFound ? 404 : 400).json(isNotFound ? { error: result.erro[0] } : { errors: result.erro });
    }
    res.json(result);
  } catch (err) {
    console.error('[OS-AVANCAR]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});
```

- [ ] **Step 2: Add GET /:id/historico endpoint**

Add after the new `PATCH /:id/avancar` route:

```js
// GET /:id/historico — histórico de fases da OS
router.get('/:id/historico', async (req, res) => {
  try {
    const rows = await service.historico(req.params.id);
    res.json(rows);
  } catch (err) {
    console.error('[OS-HIST]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/os/router.js
git commit -m "feat(producao): endpoints PATCH /:id/avancar + GET /:id/historico"
```

---

### Task 5: `public/pwa/producao.html` — board de produção

**Files:**
- Modify: `public/pwa/producao.html`

This is a full rewrite of the script section and partial HTML rewrite. Replace the entire file content with the following:

- [ ] **Step 1: Rewrite producao.html**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Produção — Gráfica LKL</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; min-height: 100vh; }
.topbar { background: #1a237e; color: #fff; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; }
.topbar h1 { font-size: 18px; font-weight: 600; }
.btn-sair { background: rgba(255,255,255,0.2); color: #fff; border: none; padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 14px; }
.btn-sair:hover { background: rgba(255,255,255,0.3); }
.tabs { display: flex; background: #fff; border-bottom: 2px solid #e0e0e0; }
.tab { flex: 1; padding: 12px; text-align: center; cursor: pointer; font-size: 14px; font-weight: 500; color: #666; border-bottom: 3px solid transparent; margin-bottom: -2px; transition: all 0.2s; }
.tab.active { color: #1a237e; border-bottom-color: #1a237e; }

/* Board layout */
.board { display: flex; gap: 12px; padding: 16px; overflow-x: auto; min-height: calc(100vh - 120px); align-items: flex-start; }
.column { flex: 0 0 260px; background: #e9ebf0; border-radius: 12px; padding: 10px; }
.column-header { font-size: 13px; font-weight: 700; color: #444; padding: 6px 4px 10px; display: flex; align-items: center; justify-content: space-between; }
.column-count { background: #1a237e; color: #fff; border-radius: 12px; padding: 1px 8px; font-size: 11px; }
.card { background: #fff; border-radius: 10px; padding: 12px; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.card-os { font-weight: 700; font-size: 14px; color: #1a237e; }
.card-orc { font-size: 12px; color: #888; }
.card-tipo { font-size: 11px; background: #e3f2fd; color: #0277bd; border-radius: 4px; padding: 2px 6px; display: inline-block; margin: 4px 0; }
.card-desc { font-size: 13px; font-weight: 600; color: #212121; margin: 4px 0 8px; }
.card-meta { font-size: 12px; color: #666; margin-bottom: 8px; }
.btn-advance { width: 100%; padding: 10px; background: #1a237e; color: #fff; border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
.btn-advance:hover { background: #283593; }
.btn-advance:disabled { background: #9e9e9e; cursor: not-allowed; }
.btn-entrega { background: #2e7d32; }
.btn-entrega:hover { background: #1b5e20; }

/* Concluídas list */
.content { padding: 16px; }
.done-card { background: #fff; border-radius: 10px; padding: 14px; margin-bottom: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.done-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.done-os { font-weight: 700; font-size: 14px; color: #1a237e; }
.done-badge { background: #1a237e; color: #fff; border-radius: 20px; padding: 2px 10px; font-size: 11px; }
.timeline { margin-top: 10px; border-top: 1px solid #eee; padding-top: 10px; }
.tl-item { display: flex; gap: 8px; margin-bottom: 6px; font-size: 12px; color: #555; }
.tl-dot { width: 8px; height: 8px; border-radius: 50%; background: #1a237e; margin-top: 3px; flex-shrink: 0; }
.empty { text-align: center; padding: 40px; color: #999; font-size: 14px; }
.loading { text-align: center; padding: 40px; color: #999; font-size: 14px; }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #323232; color: #fff; padding: 12px 24px; border-radius: 8px; font-size: 14px; z-index: 300; opacity: 0; transition: opacity 0.3s; pointer-events: none; text-align: center; max-width: 90vw; }
.toast.show { opacity: 1; }
</style>
</head>
<body>

<div class="topbar">
  <h1>🖨️ Produção LKL</h1>
  <button class="btn-sair" onclick="logout()">Sair</button>
</div>

<div class="tabs">
  <div class="tab active" id="tab-andamento" onclick="switchTab('andamento')">Em Andamento</div>
  <div class="tab" id="tab-concluidas" onclick="switchTab('concluidas')">Concluídas</div>
</div>

<div id="main-content">
  <div class="loading">Carregando...</div>
</div>

<div class="toast" id="toast"></div>

<script type="module">
import { requireAuth, api, logout, getUser } from '/pwa/app.js';
window.logout = logout;

const FLUXO = {
  offset:             ['corte','impressao','acabamento','entrega'],
  comunicacao_visual: ['impressao','acabamento','entrega'],
};
const FASE_LABEL = { corte:'Corte', impressao:'Impressão', acabamento:'Acabamento', entrega:'Entrega', entregue:'Entregue' };
const ALL_PHASES = ['corte','impressao','acabamento','entrega'];
const IN_PROGRESS = new Set(['corte','impressao','acabamento','entrega']);
const TIPO_LABEL = { offset:'Offset', comunicacao_visual:'CV' };

let allOS = [];
let activeTab = 'andamento';

function showToast(msg, duration = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

function proximaFase(tipo_servico, statusAtual) {
  const fases = FLUXO[tipo_servico];
  if (!fases) return null;
  if (statusAtual === 'entrega') return 'entregue';
  const idx = fases.indexOf(statusAtual);
  if (idx === -1 || idx === fases.length - 1) return null;
  return fases[idx + 1];
}

async function loadOS() {
  try {
    const res = await api('/api/v2/os?limit=200');
    allOS = res.data || [];
    render();
  } catch (e) {
    document.getElementById('main-content').innerHTML = '<div class="empty">Erro ao carregar OSs.</div>';
  }
}

function render() {
  if (activeTab === 'andamento') renderBoard();
  else renderConcluidas();
}

function renderBoard() {
  const inProgress = allOS.filter(os => IN_PROGRESS.has(os.status));

  const columnsHtml = ALL_PHASES.map(fase => {
    const cards = inProgress.filter(os => os.status === fase);
    const cardsHtml = cards.length === 0
      ? '<div style="font-size:12px;color:#aaa;text-align:center;padding:8px">Vazio</div>'
      : cards.map(os => buildCard(os)).join('');
    return `
      <div class="column">
        <div class="column-header">
          ${FASE_LABEL[fase]}
          <span class="column-count">${cards.length}</span>
        </div>
        ${cardsHtml}
      </div>`;
  }).join('');

  const total = inProgress.length;
  document.getElementById('main-content').innerHTML = total === 0
    ? '<div class="empty">Nenhuma OS em andamento.</div>'
    : `<div class="board">${columnsHtml}</div>`;
}

function buildCard(os) {
  const tipo = os.tipo_servico || '';
  const tipoLabel = TIPO_LABEL[tipo] || tipo;
  const proximo = proximaFase(tipo, os.status);
  const isEntrega = os.status === 'entrega';

  const btnLabel = isEntrega ? '✅ Confirmar Entrega' : `✓ Concluir ${FASE_LABEL[os.status] || os.status}`;
  const btnClass = isEntrega ? 'btn-advance btn-entrega' : 'btn-advance';
  const btnHtml = proximo
    ? `<button class="${btnClass}" data-os-id="${os.id}" onclick="avancar('${os.id}', this)">${btnLabel}</button>`
    : '';

  return `
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <span class="card-os">OS #${os.numero_os}</span>
      <span class="card-orc">ORC #${os.numero_orcamento || '—'}</span>
    </div>
    <span class="card-tipo">${tipoLabel}</span>
    <div class="card-desc">${escHtml(os.item_descricao || '—')}</div>
    ${os.cliente_nome ? `<div class="card-meta">${escHtml(os.cliente_nome)}</div>` : ''}
    ${btnHtml}
  </div>`;
}

async function renderConcluidas() {
  const done = allOS.filter(os => os.status === 'entregue');
  const container = document.getElementById('main-content');
  if (done.length === 0) {
    container.innerHTML = '<div class="empty">Nenhuma OS concluída.</div>';
    return;
  }
  container.innerHTML = '<div class="content"><div class="loading">Carregando histórico...</div></div>';
  const cards = await Promise.all(done.map(async os => {
    let timeline = '';
    try {
      const hist = await api(`/api/v2/os/${os.id}/historico`);
      timeline = hist.map(h => {
        const de = h.de_status ? `${FASE_LABEL[h.de_status] || h.de_status} →` : '';
        const para = FASE_LABEL[h.para_status] || h.para_status;
        const em = new Date(h.em).toLocaleString('pt-BR', { day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit' });
        return `<div class="tl-item"><div class="tl-dot"></div><span>${de} ${para} — ${em}${h.usuario_nome ? ' · ' + escHtml(h.usuario_nome) : ''}</span></div>`;
      }).join('');
    } catch (e) {}
    return `
    <div class="done-card">
      <div class="done-card-header">
        <span class="done-os">OS #${os.numero_os}</span>
        <span class="done-badge">Entregue</span>
      </div>
      <div style="font-size:13px;font-weight:600;color:#212121;margin-bottom:4px">${escHtml(os.item_descricao || '—')}</div>
      ${os.cliente_nome ? `<div style="font-size:12px;color:#666">${escHtml(os.cliente_nome)}</div>` : ''}
      ${timeline ? `<div class="timeline">${timeline}</div>` : ''}
    </div>`;
  }));
  container.innerHTML = `<div class="content">${cards.join('')}</div>`;
}

window.switchTab = function(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  render();
};

window.avancar = async function(id, btn) {
  btn.disabled = true;
  try {
    await api(`/api/v2/os/${id}/avancar`, { method: 'PATCH' });
    showToast('Fase avançada!');
    await loadOS();
  } catch (e) {
    showToast('Erro ao avançar fase.');
    btn.disabled = false;
  }
};

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function init() {
  await requireAuth();
  const user = getUser();
  if (!user || !['admin','operador','atendente','gestor','analista'].includes(user.role)) {
    window.location.href = '/pwa/login.html';
    return;
  }
  await loadOS();
  setInterval(loadOS, 30000);
}

init();
</script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/pwa/producao.html
git commit -m "feat(producao): board de produção com 4 colunas e timeline de concluídas"
```

---

### Task 6: `public/dashboard.html` — substituir placeholder page-producao por board

**Files:**
- Modify: `public/dashboard.html`

The current `page-producao` (lines ~484–490) is a placeholder with a link to the mobile version. We replace it with a working board that calls the same API endpoints.

- [ ] **Step 1: Replace the page-producao div content**

Find the exact block:
```html
  <!-- PRODUÇÃO (mobile) -->
  <div class="page" id="page-producao">
    <div class="placeholder-page">
      <div class="icon">🏭</div>
      <p>Módulo de Produção disponível via tablet</p>
      <a href="/pwa/producao.html" target="_blank" class="btn btn-primary" style="margin-top:8px">Abrir versão mobile</a>
    </div>
  </div>
```

Replace with:
```html
  <!-- PRODUÇÃO — board de produção -->
  <div class="page" id="page-producao">
    <div class="page-header">
      <h1>🏭 Produção</h1>
      <span style="font-size:13px;color:#888">Board de fases: Corte → Impressão → Acabamento → Entrega</span>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:16px">
      <button class="btn btn-primary" id="prod-tab-andamento" onclick="prodSwitchTab('andamento')">Em Andamento</button>
      <button class="btn btn-outline" id="prod-tab-concluidas" onclick="prodSwitchTab('concluidas')">Concluídas</button>
    </div>
    <div id="prod-board-content" style="min-height:200px">Carregando...</div>
  </div>
```

- [ ] **Step 2: Add the JS for the production board**

In `dashboard.html`, find a suitable place to add the production board JS — look for the area where page-specific JS functions are defined (e.g., around the `loadArtes` function or near the end of the large `<script>` block).

Find the line that contains `async function loadArtes` or a similar page-load dispatch, and add the following JS block near other page-specific functions:

```js
// ===================== PROD BOARD =====================
const PROD_FLUXO = {
  offset: ['corte','impressao','acabamento','entrega'],
  comunicacao_visual: ['impressao','acabamento','entrega'],
};
const PROD_FASE_LABEL = { corte:'Corte', impressao:'Impressão', acabamento:'Acabamento', entrega:'Entrega', entregue:'Entregue' };
const PROD_ALL_PHASES = ['corte','impressao','acabamento','entrega'];
const PROD_TIPO_LABEL = { offset:'Offset', comunicacao_visual:'CV' };
let prodAllOS = [];
let prodActiveTab = 'andamento';

function prodProximaFase(tipo, status) {
  const fases = PROD_FLUXO[tipo];
  if (!fases) return null;
  if (status === 'entrega') return 'entregue';
  const idx = fases.indexOf(status);
  if (idx === -1 || idx === fases.length - 1) return null;
  return fases[idx + 1];
}

async function loadProdBoard() {
  try {
    const res = await apiFetch('/api/v2/os?limit=200');
    prodAllOS = res.data || [];
    prodRender();
  } catch (e) {
    document.getElementById('prod-board-content').innerHTML = '<p style="color:red">Erro ao carregar OSs.</p>';
  }
}

function prodSwitchTab(tab) {
  prodActiveTab = tab;
  document.getElementById('prod-tab-andamento').className = 'btn ' + (tab === 'andamento' ? 'btn-primary' : 'btn-outline');
  document.getElementById('prod-tab-concluidas').className = 'btn ' + (tab === 'concluidas' ? 'btn-primary' : 'btn-outline');
  prodRender();
}

function prodRender() {
  if (prodActiveTab === 'andamento') prodRenderBoard();
  else prodRenderConcluidas();
}

function prodEsc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function prodRenderBoard() {
  const inProg = prodAllOS.filter(os => ['corte','impressao','acabamento','entrega'].includes(os.status));
  const container = document.getElementById('prod-board-content');
  if (inProg.length === 0) { container.innerHTML = '<p style="color:#999;padding:24px">Nenhuma OS em andamento.</p>'; return; }

  const cols = PROD_ALL_PHASES.map(fase => {
    const cards = inProg.filter(os => os.status === fase);
    const cardsHtml = cards.length === 0
      ? '<p style="font-size:12px;color:#aaa;text-align:center;padding:8px">Vazio</p>'
      : cards.map(os => {
          const proximo = prodProximaFase(os.tipo_servico, os.status);
          const isEntrega = os.status === 'entrega';
          const btnLabel = isEntrega ? '✅ Confirmar Entrega' : `✓ Concluir ${PROD_FASE_LABEL[os.status]}`;
          const btnColor = isEntrega ? '#2e7d32' : '#1a237e';
          const btn = proximo
            ? `<button onclick="prodAvancar('${os.id}',this)" style="width:100%;padding:8px;background:${btnColor};color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;margin-top:6px">${btnLabel}</button>`
            : '';
          return `<div style="background:#fff;border-radius:8px;padding:10px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
            <div style="display:flex;justify-content:space-between"><strong style="font-size:13px;color:#1a237e">OS #${os.numero_os}</strong><span style="font-size:11px;color:#888">ORC #${os.numero_orcamento||'—'}</span></div>
            <span style="font-size:10px;background:#e3f2fd;color:#0277bd;border-radius:4px;padding:1px 5px;display:inline-block;margin:3px 0">${PROD_TIPO_LABEL[os.tipo_servico]||os.tipo_servico||''}</span>
            <div style="font-size:12px;font-weight:600;margin:2px 0">${prodEsc(os.item_descricao||'—')}</div>
            ${os.cliente_nome?`<div style="font-size:11px;color:#666">${prodEsc(os.cliente_nome)}</div>`:''}
            ${btn}
          </div>`;
        }).join('');
    return `<div style="flex:0 0 220px;background:#e9ebf0;border-radius:10px;padding:8px">
      <div style="font-size:12px;font-weight:700;color:#444;padding:4px 4px 8px;display:flex;justify-content:space-between">
        ${PROD_FASE_LABEL[fase]}<span style="background:#1a237e;color:#fff;border-radius:12px;padding:1px 7px;font-size:11px">${cards.length}</span>
      </div>
      ${cardsHtml}
    </div>`;
  }).join('');

  container.innerHTML = `<div style="display:flex;gap:10px;overflow-x:auto;align-items:flex-start;padding-bottom:8px">${cols}</div>`;
}

async function prodRenderConcluidas() {
  const done = prodAllOS.filter(os => os.status === 'entregue');
  const container = document.getElementById('prod-board-content');
  if (done.length === 0) { container.innerHTML = '<p style="color:#999;padding:24px">Nenhuma OS concluída.</p>'; return; }
  container.innerHTML = '<p style="color:#999;padding:8px">Carregando histórico...</p>';

  const cards = await Promise.all(done.map(async os => {
    let tl = '';
    try {
      const hist = await apiFetch(`/api/v2/os/${os.id}/historico`);
      tl = hist.map(h => {
        const de = h.de_status ? `${PROD_FASE_LABEL[h.de_status]||h.de_status} →` : '';
        const para = PROD_FASE_LABEL[h.para_status]||h.para_status;
        const em = new Date(h.em).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
        return `<div style="display:flex;gap:6px;margin-bottom:4px;font-size:11px;color:#555"><div style="width:6px;height:6px;border-radius:50%;background:#1a237e;margin-top:3px;flex-shrink:0"></div><span>${de} ${para} — ${em}</span></div>`;
      }).join('');
    } catch(e) {}
    return `<div style="background:#fff;border-radius:10px;padding:12px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px">
        <strong style="color:#1a237e">OS #${os.numero_os}</strong>
        <span style="background:#1a237e;color:#fff;border-radius:20px;padding:1px 8px;font-size:11px">Entregue</span>
      </div>
      <div style="font-size:12px;font-weight:600;margin-bottom:4px">${prodEsc(os.item_descricao||'—')}</div>
      ${os.cliente_nome?`<div style="font-size:11px;color:#666">${prodEsc(os.cliente_nome)}</div>`:''}
      ${tl?`<div style="margin-top:8px;border-top:1px solid #eee;padding-top:8px">${tl}</div>`:''}
    </div>`;
  }));
  container.innerHTML = cards.join('');
}

async function prodAvancar(osId, btn) {
  btn.disabled = true;
  try {
    await apiFetch(`/api/v2/os/${osId}/avancar`, { method: 'PATCH' });
    await loadProdBoard();
  } catch(e) {
    alert('Erro ao avançar fase: ' + (e.message||e));
    btn.disabled = false;
  }
}
// ===================== END PROD BOARD =====================
```

- [ ] **Step 3: Hook `loadProdBoard` into the page-switch logic**

Find the `showPage` function in `dashboard.html` (around line 950). It likely looks like:
```js
function showPage(page, el) {
  document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
  ...
```

Find the part that loads page-specific data on page switch. Look for a pattern like:
```js
  if (page === 'artes') loadArtes();
```

Add alongside it:
```js
  if (page === 'producao') loadProdBoard();
```

Also check if `apiFetch` is the correct function name in dashboard.html — it may be `callApi` or `api`. Do a quick grep: find the function name used for authenticated API calls in dashboard.html and use that in the board JS above.

```bash
grep -n "async function apiFetch\|async function callApi\|async function api\b" /Users/klebercamara/LKL/public/dashboard.html | head -5
```

If the function is named differently (e.g., `callApi`), replace all occurrences of `apiFetch` in the JS block above with the correct name.

- [ ] **Step 4: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(producao): board de produção no dashboard com colunas e concluídas"
```

---

### Task 7: `public/pwa/motorista.html` — filtrar por `status=entrega`

**Files:**
- Modify: `public/pwa/motorista.html`

The motorista currently fetches `?status=pronto`. The new status for "ready for delivery" is `entrega`.

- [ ] **Step 1: Update the fetch URL**

Find (around line 126):
```js
        const resp = await fetch('/api/v2/os?status=pronto&limit=100', {
```

Replace with:
```js
        const resp = await fetch('/api/v2/os?status=entrega&limit=100', {
```

- [ ] **Step 2: Update the topbar description**

Find:
```html
      <p>OSs prontas para entrega</p>
```

This is fine as-is — no change needed.

- [ ] **Step 3: Commit**

```bash
git add public/pwa/motorista.html
git commit -m "fix(motorista): filtrar OSs por status='entrega' (era 'pronto')"
```

---

### Task 8: Smoke tests + Deploy VPS

**Files:** (no file changes — remote verification only)

- [ ] **Step 1: Deploy to VPS**

```bash
rsync -avz --exclude='.git' --exclude='node_modules' --exclude='backups' \
  /Users/klebercamara/LKL/ root@vps:/var/www/lkl-chatbot/
ssh root@vps "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```

- [ ] **Step 2: Apply migration if not already done**

```bash
scp /Users/klebercamara/LKL/sql/migrations/042_board_producao.sql root@vps:/tmp/
ssh root@vps "sudo -u postgres psql -d lkl_prod -f /tmp/042_board_producao.sql"
```

Verify:
```bash
ssh root@vps "sudo -u postgres psql -d lkl_prod -c \"SELECT status, COUNT(*) FROM ordens_servico GROUP BY status ORDER BY status;\""
```

Expected: no rows with `aguardando`, `arte_final`, `aguardando_aprovacao_arte`, `embalagem`, `pronto`.

- [ ] **Step 3: Smoke — fluxoProducao constants**

```bash
cd /Users/klebercamara/LKL && npx jest tests/fluxoProducao.test.js --no-coverage
```

Expected: 13 tests pass.

- [ ] **Step 4: Smoke — avancar endpoint**

Get a valid OS id in status `corte` or `impressao`:
```bash
ssh root@vps "sudo -u postgres psql -d lkl_prod -c \"SELECT id, numero_os, status, tipo_servico FROM ordens_servico WHERE status IN ('corte','impressao') LIMIT 1;\""
```

Test the avancar endpoint (replace TOKEN and OS_ID):
```bash
curl -s -X PATCH https://app.graficalkl.com.br/api/v2/os/OS_ID/avancar \
  -H "Authorization: Bearer TOKEN" | jq .
```

Expected: `{ "os": { "status": "<next_phase>", ... } }`

- [ ] **Step 5: Smoke — historico endpoint**

```bash
curl -s https://app.graficalkl.com.br/api/v2/os/OS_ID/historico \
  -H "Authorization: Bearer TOKEN" | jq .
```

Expected: JSON array with at least one entry `{ de_status, para_status, em }`.

- [ ] **Step 6: Smoke — motorista endpoint**

```bash
curl -s "https://app.graficalkl.com.br/api/v2/os?status=entrega&limit=10" \
  -H "Authorization: Bearer TOKEN" | jq '.data | length'
```

Expected: number (0 or more), no error.

- [ ] **Step 7: Smoke — entregar com status=entrega**

Get an OS in `status=entrega` (or avancar one to entrega first), then:
```bash
curl -s -X PATCH https://app.graficalkl.com.br/api/v2/os/OS_ID/entregar \
  -H "Authorization: Bearer TOKEN" \
  -F "nome_recebedor=Teste Smoke" \
  -F "foto_documento=@/tmp/test.jpg" | jq .
```

Expected: `{ "os": { "status": "entregue", ... } }` — not `"OS não está no status pronto"`.

- [ ] **Step 8: Commit smoke pass note**

```bash
git commit --allow-empty -m "chore: smoke board-producao PASS"
```

---

## Self-Review

### Spec Coverage

| Spec requirement | Task |
|-----------------|------|
| FLUXO = {offset: 4 fases, cv: 3 fases} | Task 1 |
| FASE_LABEL + proximaFase() | Task 1 |
| Migration 042: os_historico table | Task 2 |
| Remap status: embalagem/pronto→entrega | Task 2 |
| Remap status: arte_final/aguardando→first phase by tipo | Task 2 |
| STATUS_VALIDOS updated | Task 3 |
| avancarFase() with history write | Task 3 |
| historico() helper | Task 3 |
| entregar() accepts status='entrega' | Task 3 |
| criarOSOffset starts 'corte' | Task 3 |
| criarOSComunicacaoVisual starts 'impressao' | Task 3 |
| baixarMateriais triggered at impressao (via avancarFase) | Task 3 |
| data_inicio on first phase | Task 3 |
| data_conclusao on entregue | Task 3 |
| FCM notifications on phase advance | Task 3 |
| PATCH /:id/avancar endpoint | Task 4 |
| GET /:id/historico endpoint | Task 4 |
| producao.html board 4 columns | Task 5 |
| CV OS not shown in Corte column | Task 5 (filter: cards = inProgress.filter where os.status===fase; CV OS won't have status='corte') |
| Concluídas with timeline | Task 5 |
| dashboard.html page-producao board | Task 6 |
| motorista.html accept status='entrega' | Task 7 |
| atualizarStatus also writes history | Task 3 |
| Smoke: full phase advance + historico | Task 8 |

### Type Consistency Check

- `avancarFase(osId, userId)` → called from router as `service.avancarFase(req.params.id, req.user.id)` ✅
- `historico(osId)` → called from router as `service.historico(req.params.id)` ✅  
- `proximaFase(tipo_servico, statusAtual)` → identical signature in frontend JS copies ✅
- `FLUXO` keys: `'offset'`, `'comunicacao_visual'` — match `tipo_servico` values in DB ✅
- `entregar()` updated SQL: `AND status='entrega'` — motorista fetches `status=entrega` ✅
- `baixarMateriais` called inside `avancarFase` without `await` (fire-and-forget with `.catch`) ✅ (consistent with existing atualizarStatus pattern)

### Edge Cases Covered

- CV OS created at `impressao`, never touches `corte` column → board filter shows it correctly
- `avancarFase` on `entregue` or `cancelado` → returns error (proximaFase returns null)
- History write failures are best-effort (`.catch(console.warn)`) — won't break phase advance
- `entregar()` with motorista (foto+nome) still works on `status='entrega'` OSs
- Board `avancar` button for `entrega` advances directly to `entregue` (bypasses motorista foto)
- Both paths (avancar + entregar) write to `os_historico`
