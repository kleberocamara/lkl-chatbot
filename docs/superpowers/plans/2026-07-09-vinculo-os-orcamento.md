# Vínculo OS↔Orçamento por Dois Caminhos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir 5 pontos do backend que hoje só reconhecem o vínculo entre uma OS e seu orçamento via `ordens_servico.orcamento_id` (coluna que fica `NULL` pra toda OS offset/revenda, já que essas OS podem cobrir itens de vários orçamentos), fazendo-os considerar também o vínculo indireto via `os_itens → orcamento_itens.orcamento_id` — eliminando receita subestimada na DRE e sintomas relacionados (detalhe de orçamento sem OS, flag de NF-e errada, eventos de conclusão de serviço nunca disparando pra OS offset/revenda).

**Architecture:** Todo ponto corrigido passa a considerar os dois caminhos de vínculo — direto (`ordens_servico.orcamento_id`) e indireto (`os_itens`/`orcamento_itens`) — replicando o padrão que já existe e funciona em `orcamentosAfetadosPorOS()`/`statusOSsDoOrcamento()` (`src/modules/os/service.js:656-683`). A `dre()` também passa a excluir OS canceladas da contagem de "orçamento totalmente entregue".

**Tech Stack:** Node.js/Express, PostgreSQL, Jest.

---

### Task 1: `dre()` — receita considera os dois caminhos de vínculo + ignora OS cancelada

**Files:**
- Modify: `src/modules/analises/service.js:22-46` (a query `recR` dentro de `dre()`)
- Test: `tests/analises-dre.test.js`

- [ ] **Step 1: Escrever os testes que falham primeiro**

Adicione ao `describe('dre — cascata completa', ...)` existente em `tests/analises-dre.test.js` (não mexa nos testes já existentes no arquivo):

```js
test('SQL da receita considera vínculo indireto via os_itens/orcamento_itens (OS offset/revenda)', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [{ receita: 0 }] })
    .mockResolvedValueOnce({ rows: [] });

  await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

  const receitaSql = db.query.mock.calls[0][0];
  expect(receitaSql).toMatch(/os_itens/);
  expect(receitaSql).toMatch(/orcamento_itens/);
});

test('SQL da receita exclui OS canceladas da contagem de "totalmente entregue"', async () => {
  db.query
    .mockResolvedValueOnce({ rows: [{ receita: 0 }] })
    .mockResolvedValueOnce({ rows: [] });

  await dre({ inicio: '2026-08-01', fim: '2026-08-31' });

  const receitaSql = db.query.mock.calls[0][0];
  expect(receitaSql).toMatch(/status != 'cancelado'/);
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npx jest tests/analises-dre.test.js -t "vínculo indireto|OS canceladas" --verbose`
Expected: FAIL — a SQL atual de `dre()` não menciona `os_itens`, `orcamento_itens`, nem `status != 'cancelado'` na query de receita.

- [ ] **Step 3: Reescrever a query `recR` dentro de `dre()`**

Em `src/modules/analises/service.js`, substitua o bloco da query `recR` (linhas 27-45 antes desta mudança):

```js
  // Receita por competência: um orçamento só conta no mês em que TODAS as suas
  // OSs não-canceladas foram entregues (última entrega define o mês), não quando
  // o cliente pagou. Considera os dois caminhos de vínculo OS→orçamento: direto
  // (ordens_servico.orcamento_id, usado por OS de Comunicação Visual) e indireto
  // (os_itens → orcamento_itens.orcamento_id, único caminho pra OS offset/revenda,
  // que podem cobrir itens de vários orçamentos e por isso não gravam orcamento_id).
  const recR = await db.query(
    `WITH os_do_orcamento AS (
       SELECT DISTINCT orcamento_id, os_id FROM (
         SELECT os.orcamento_id, os.id AS os_id
         FROM ordens_servico os
         WHERE os.orcamento_id IS NOT NULL AND os.status != 'cancelado'
         UNION
         SELECT oi.orcamento_id, os.id AS os_id
         FROM os_itens oit
         JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
         JOIN ordens_servico os ON os.id = oit.os_id
         WHERE os.status != 'cancelado'
       ) t
     ),
     entregas AS (
       SELECT p.orcamento_id,
              COUNT(*) AS total_os,
              COUNT(*) FILTER (WHERE os.status = 'entregue') AS os_entregues,
              MAX(h.em) AS ultima_entrega
       FROM os_do_orcamento p
       JOIN ordens_servico os ON os.id = p.os_id
       LEFT JOIN LATERAL (
         SELECT em FROM os_historico hh WHERE hh.os_id = os.id AND hh.para_status = 'entregue' ORDER BY hh.em DESC LIMIT 1
       ) h ON true
       GROUP BY p.orcamento_id
     )
     SELECT COALESCE(SUM(o.total),0) AS receita
     FROM orcamentos o
     JOIN entregas e ON e.orcamento_id = o.id
     WHERE e.total_os = e.os_entregues AND e.ultima_entrega::date BETWEEN $1 AND $2`,
    [inicio, fim]);
  const receita_bruta = Number(recR.rows[0].receita);
```

O resto de `dre()` (despesas, cascata, `CASCATA_DEDUCOES`, `bucketPorId`, etc.) não muda.

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx jest tests/analises-dre.test.js --verbose`
Expected: PASS (9 testes: os 7 já existentes + os 2 novos deste task).

- [ ] **Step 5: Commit**

```bash
git add src/modules/analises/service.js tests/analises-dre.test.js
git commit -m "fix(analises): dre() reconhece receita de OS offset/revenda (vinculo via os_itens) e ignora OS cancelada"
```

---

### Task 2: `orcamentos/service.js` — `buscarPorId()` e `listar()` consideram os dois caminhos

**Files:**
- Modify: `src/modules/orcamentos/service.js:110-113` (`buscarPorId`) e `:489` (`listar`)
- Test: `tests/orcamentos-vinculo-os.test.js` (novo arquivo)

- [ ] **Step 1: Escrever os testes que falham primeiro**

Crie `tests/orcamentos-vinculo-os.test.js`:

```js
const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { buscarPorId, listar } = require('../src/modules/orcamentos/service');

describe('buscarPorId — OS vinculada via os_itens (offset/revenda)', () => {
  afterEach(() => jest.clearAllMocks());

  test('a query de OS considera vínculo indireto via os_itens/orcamento_itens', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'orc-1' }] }) // SELECT o.*, ...
      .mockResolvedValueOnce({ rows: [] }) // itens
      .mockResolvedValueOnce({ rows: [] }) // ordens_servico
      .mockResolvedValueOnce({ rows: [] }); // boletos

    await buscarPorId('orc-1');

    const osSql = db.query.mock.calls[2][0];
    expect(osSql).toMatch(/os_itens/);
    expect(osSql).toMatch(/orcamento_itens/);
  });
});

describe('listar — tem_os_entregue considera vínculo indireto via os_itens/orcamento_itens', () => {
  afterEach(() => jest.clearAllMocks());

  test('a subquery tem_os_entregue considera vínculo indireto', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // rows
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // count

    await listar({});

    const listSql = db.query.mock.calls[0][0];
    expect(listSql).toMatch(/tem_os_entregue/);
    expect(listSql).toMatch(/os_itens/);
    expect(listSql).toMatch(/orcamento_itens/);
  });
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npx jest tests/orcamentos-vinculo-os.test.js --verbose`
Expected: FAIL — nenhuma das duas queries hoje menciona `os_itens`/`orcamento_itens`.

- [ ] **Step 3: Corrigir `buscarPorId()`**

Em `src/modules/orcamentos/service.js`, substitua (linhas 110-113 antes desta mudança):

```js
  const osR = await db.query(
    'SELECT * FROM ordens_servico WHERE orcamento_id = $1 ORDER BY numero_os',
    [id]
  );
```

Por:

```js
  const osR = await db.query(
    `SELECT os.* FROM ordens_servico os
     WHERE os.orcamento_id = $1
        OR os.id IN (SELECT oit.os_id FROM os_itens oit JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id WHERE oi.orcamento_id = $1)
     ORDER BY os.numero_os`,
    [id]
  );
```

- [ ] **Step 4: Corrigir `listar()`**

Na mesma função `listar()`, substitua a linha da subquery `tem_os_entregue` (linha 489 antes desta mudança):

```js
              EXISTS(SELECT 1 FROM ordens_servico os WHERE os.orcamento_id = o.id AND os.status = 'entregue') AS tem_os_entregue,
```

Por:

```js
              EXISTS(
                SELECT 1 FROM ordens_servico os WHERE os.status = 'entregue' AND (
                  os.orcamento_id = o.id
                  OR os.id IN (SELECT oit.os_id FROM os_itens oit JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id WHERE oi.orcamento_id = o.id)
                )
              ) AS tem_os_entregue,
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `npx jest tests/orcamentos-vinculo-os.test.js --verbose`
Expected: PASS (2 testes).

- [ ] **Step 6: Commit**

```bash
git add src/modules/orcamentos/service.js tests/orcamentos-vinculo-os.test.js
git commit -m "fix(orcamentos): buscarPorId e listar reconhecem OS offset/revenda vinculada via os_itens"
```

---

### Task 3: `os/service.js` `listar()` — filtro `?orcamento_id=` considera os dois caminhos

**Files:**
- Modify: `src/modules/os/service.js:199`
- Test: `tests/os-vinculo-orcamento.test.js` (novo arquivo — este task só cria o teste de `listar()`; Task 4 adiciona mais testes no mesmo arquivo)

- [ ] **Step 1: Escrever o teste que falha primeiro**

Crie `tests/os-vinculo-orcamento.test.js`:

```js
const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/fcm', () => ({ sendToUser: jest.fn() }));

const { listar } = require('../src/modules/os/service');

describe('listar — filtro ?orcamento_id= considera vínculo indireto via os_itens', () => {
  afterEach(() => jest.clearAllMocks());

  test('a query filtrada por orcamento_id inclui OS vinculada só via os_itens', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // rows
      .mockResolvedValueOnce({ rows: [{ count: '0' }] }); // count

    await listar({ orcamento_id: 'orc-1' });

    const listSql = db.query.mock.calls[0][0];
    expect(listSql).toMatch(/os\.orcamento_id = \$1/);
    expect(listSql).toMatch(/os_itens/);
    expect(listSql).toMatch(/orcamento_itens/);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx jest tests/os-vinculo-orcamento.test.js --verbose`
Expected: FAIL — a query atual de `listar({orcamento_id})` só faz `AND os.orcamento_id = $1`, sem `os_itens`.

- [ ] **Step 3: Corrigir o filtro**

Em `src/modules/os/service.js`, dentro de `listar()`, substitua a linha (linha 199 antes desta mudança):

```js
  if (orcamento_id) { params.push(orcamento_id); where += ` AND os.orcamento_id = $${params.length}`; }
```

Por:

```js
  if (orcamento_id) {
    params.push(orcamento_id);
    where += ` AND (os.orcamento_id = $${params.length} OR os.id IN (
      SELECT oit.os_id FROM os_itens oit JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id WHERE oi.orcamento_id = $${params.length}
    ))`;
  }
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx jest tests/os-vinculo-orcamento.test.js --verbose`
Expected: PASS (1 teste).

- [ ] **Step 5: Commit**

```bash
git add src/modules/os/service.js tests/os-vinculo-orcamento.test.js
git commit -m "fix(os): listar() filtro por orcamento_id considera OS vinculada via os_itens"
```

---

### Task 4: `os/service.js` — `avancarFase`, `atualizarStatus`, `entregar` usam `orcamentosAfetadosPorOS`/`statusOSsDoOrcamento`

**Files:**
- Modify: `src/modules/os/service.js` (funções `avancarFase` ~linhas 100-179, `atualizarStatus` ~linhas 300-376, `entregar` ~linhas 378-428)

Este projeto **não** tem hoje nenhum teste automatizado pra `os/service.js` (arquivo inteiro sem suíte). As três funções deste task já eram inteiramente fire-and-forget (`.then()`/sem `await` nos efeitos colaterais de notificação) mesmo antes desta mudança, o que torna testes automatizados de timing frágeis e desproporcionais ao risco real — o núcleo financeiro (reconhecimento de receita) já foi coberto por teste rigoroso no Task 1. A verificação aqui é por leitura cuidadosa comparando com o código-fonte real + smoke manual pós-deploy (ver Task 5), seguindo o mesmo padrão já usado neste projeto pra UI sem infraestrutura de teste.

- [ ] **Step 1: Corrigir `avancarFase`**

Em `src/modules/os/service.js`, dentro de `avancarFase` (função inteira nas linhas 100-179 antes desta mudança), substitua o bloco desde a declaração de `fcmLabels` (originalmente linha 153) até o fim do bloco de FCM (originalmente linha 172) — ou seja, substitua estas três partes:

```js
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
```

Por:

```js
  const fcmLabels = {
    corte:     'Em corte ✂️',
    impressao: 'Em impressão 🖨️',
    acabamento:'Em acabamento ✂️',
    entrega:   'Pronto para entrega 📦',
    entregue:  'Entregue 🎉',
  };
  const label = fcmLabels[proximo];
  if (proximo === 'entregue' || label) {
    orcamentosAfetadosPorOS(osId).then(async (orcIds) => {
      for (const orcId of orcIds) {
        if (proximo === 'entregue') {
          const statuses = await statusOSsDoOrcamento(orcId);
          if (statuses.length && statuses.every(s => s === 'entregue') && global.io) {
            global.io.emit('servico_concluido', { orcamento_id: orcId });
          }
        }
        if (label) {
          const orcR = await db.query('SELECT vendedor_id, numero FROM orcamentos WHERE id=$1', [orcId]);
          if (orcR.rows[0]?.vendedor_id) {
            fcm.sendToUser(orcR.rows[0].vendedor_id, {
              title: `ORC #${orcR.rows[0].numero} — ${label}`,
              body: `OS #${updatedOs.numero_os} atualizada`,
              data: { os_id: osId, orcamento_id: orcId, status: proximo },
            }).catch(() => {});
          }
        }
      }
    }).catch(() => {});
  }
```

Note que `orcamentosAfetadosPorOS`/`statusOSsDoOrcamento` são funções já definidas mais abaixo no mesmo arquivo (`os/service.js:656-683`) — como são `function` declarations (não `const arrow`), o hoisting do JavaScript já permite chamá-las de `avancarFase`, que vem antes no arquivo. Não precisa mover nada.

- [ ] **Step 2: Corrigir `atualizarStatus`**

Dentro de `atualizarStatus` (linhas 300-376 antes desta mudança), substitua o bloco desde o comentário `// If entregue, check if all OSs for this orcamento are done` até o fim do bloco de FCM (originalmente linhas 336-366):

```js
  // If entregue, check if all OSs for this orcamento are done
  if (novoStatus === 'entregue') {
    const pendingR = await db.query(
      `SELECT COUNT(*) FROM ordens_servico WHERE orcamento_id=$1 AND status NOT IN ('entregue','cancelado')`,
      [os.orcamento_id]
    );
    if (parseInt(pendingR.rows[0].count) === 0 && global.io) {
      global.io.emit('servico_concluido', { orcamento_id: os.orcamento_id });
    }
  }

  // Send FCM push to vendedor
  const labels = {
    corte:     'Em corte ✂️',
    impressao: 'Em impressão 🖨️',
    acabamento:'Em acabamento ✂️',
    entrega:   'Pronto para entrega 📦',
    entregue:  'Entregue 🎉',
  };
  const label = labels[novoStatus];
  if (label) {
    const orcR = await db.query('SELECT vendedor_id, numero FROM orcamentos WHERE id=$1', [os.orcamento_id]);
    if (orcR.rows[0]) {
      const { vendedor_id, numero } = orcR.rows[0];
      fcm.sendToUser(vendedor_id, {
        title: `ORC #${numero} — ${label}`,
        body: `OS #${updatedOs.numero_os} atualizada`,
        data: { os_id: id, orcamento_id: os.orcamento_id, status: novoStatus },
      }).catch(() => {});
    }
  }
```

Por:

```js
  // Se entregue, checa se todas as OS não-canceladas do(s) orçamento(s) afetados
  // (pelos dois caminhos de vínculo) estão concluídas; envia FCM ao(s) vendedor(es).
  const labels = {
    corte:     'Em corte ✂️',
    impressao: 'Em impressão 🖨️',
    acabamento:'Em acabamento ✂️',
    entrega:   'Pronto para entrega 📦',
    entregue:  'Entregue 🎉',
  };
  const label = labels[novoStatus];
  if (novoStatus === 'entregue' || label) {
    const orcIds = await orcamentosAfetadosPorOS(id);
    for (const orcId of orcIds) {
      if (novoStatus === 'entregue') {
        const statuses = await statusOSsDoOrcamento(orcId);
        if (statuses.length && statuses.every(s => s === 'entregue') && global.io) {
          global.io.emit('servico_concluido', { orcamento_id: orcId });
        }
      }
      if (label) {
        const orcR = await db.query('SELECT vendedor_id, numero FROM orcamentos WHERE id=$1', [orcId]);
        if (orcR.rows[0]?.vendedor_id) {
          fcm.sendToUser(orcR.rows[0].vendedor_id, {
            title: `ORC #${orcR.rows[0].numero} — ${label}`,
            body: `OS #${updatedOs.numero_os} atualizada`,
            data: { os_id: id, orcamento_id: orcId, status: novoStatus },
          }).catch(() => {});
        }
      }
    }
  }
```

- [ ] **Step 3: Corrigir `entregar`**

Dentro de `entregar` (linhas 378-428 antes desta mudança), substitua o bloco desde o comentário `// Check if all OSs of this orcamento are done` até (mas não incluindo) a linha `sincronizarPedidoPorOS(id)...`:

```js
  // Check if all OSs of this orcamento are done
  const pendentes = await db.query(
    `SELECT COUNT(*) FROM ordens_servico
     WHERE orcamento_id=$1 AND status NOT IN ('entregue','cancelado')`,
    [os.orcamento_id]
  );
  if (parseInt(pendentes.rows[0].count) === 0 && global.io) {
    global.io.emit('servico_concluido', { orcamento_id: os.orcamento_id });
  }

  // FCM push to vendedor
  const orc = await db.query(
    'SELECT vendedor_id, numero FROM orcamentos WHERE id=$1',
    [os.orcamento_id]
  );
  if (orc.rows[0]?.vendedor_id) {
    fcm.sendToUser(orc.rows[0].vendedor_id, {
      title: `ORC #${orc.rows[0].numero} — Entregue 🎉`,
      body: `OS #${os.numero_os} entregue para ${nome_recebedor.trim()}`,
      data: { os_id: id, orcamento_id: os.orcamento_id, status: 'entregue' },
    }).catch(() => {});
  }
```

Por:

```js
  // Checa se todas as OS não-canceladas do(s) orçamento(s) afetados (pelos dois
  // caminhos de vínculo) estão concluídas; envia FCM ao(s) vendedor(es).
  const orcIds = await orcamentosAfetadosPorOS(id);
  for (const orcId of orcIds) {
    const statuses = await statusOSsDoOrcamento(orcId);
    if (statuses.length && statuses.every(s => s === 'entregue') && global.io) {
      global.io.emit('servico_concluido', { orcamento_id: orcId });
    }
    const orcR = await db.query('SELECT vendedor_id, numero FROM orcamentos WHERE id=$1', [orcId]);
    if (orcR.rows[0]?.vendedor_id) {
      fcm.sendToUser(orcR.rows[0].vendedor_id, {
        title: `ORC #${orcR.rows[0].numero} — Entregue 🎉`,
        body: `OS #${os.numero_os} entregue para ${nome_recebedor.trim()}`,
        data: { os_id: id, orcamento_id: orcId, status: 'entregue' },
      }).catch(() => {});
    }
  }
```

- [ ] **Step 4: Checar sintaxe do arquivo**

Run: `node -e "require('/Users/klebercamara/LKL/src/modules/os/service.js')"`
Expected: sem erro (o `require` vai falhar se `db`/`fcm`/`whatsapp` não existirem no ambiente local sem `.env`, mas qualquer erro de sintaxe JS aparece antes de qualquer erro de conexão — se a mensagem de erro for sobre conexão de banco/env, a sintaxe está OK; se for `SyntaxError`, tem problema no código). Alternativa mais segura: `node --check src/modules/os/service.js` (só valida sintaxe, não executa).

- [ ] **Step 5: Commit**

```bash
git add src/modules/os/service.js
git commit -m "fix(os): avancarFase/atualizarStatus/entregar usam orcamentosAfetadosPorOS (elimina falso-positivo servico_concluido pra OS offset/revenda)"
```

---

### Task 5: Deploy no VPS

**Files:** nenhum (só deploy)

- [ ] **Step 1: Rodar a suíte local**

Run: `npx jest tests/analises-dre.test.js tests/orcamentos-vinculo-os.test.js tests/os-vinculo-orcamento.test.js --verbose`
Expected: todos PASS (9 + 2 + 1 = 12 testes).

Run: `npx jest 2>&1 | tail -10`
Expected: mesma baseline de falhas pré-existentes (suítes de integração que dependem de Postgres real — incluindo `tests/modules/orcamentos.test.js`, que também roda contra as funções tocadas neste plano mas já falha na baseline por falta de banco real neste ambiente; não é possível confirmar aqui que ela passa contra Postgres real, então isso deve ser verificado no smoke manual pós-deploy). Confirmar que a contagem de falhas não aumentou.

- [ ] **Step 2: Pedir confirmação do usuário antes de deployar**

Esse deploy toca produção — confirmar com o usuário (AskUserQuestion) antes do rsync/pm2 restart, seguindo o padrão já estabelecido no projeto.

- [ ] **Step 3: Deploy**

```bash
rsync -R -av src/modules/analises/service.js src/modules/orcamentos/service.js src/modules/os/service.js root@2.25.147.243:/var/www/lkl-chatbot/
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```

- [ ] **Step 4: Smoke test em produção**

```bash
ssh root@2.25.147.243 "pm2 logs lkl-chatbot --lines 30 --nostream"
```
Expected: processo online, sem erro no restart.

Depois, verificar manualmente (usando o caso real já identificado — orçamento #31, R$1.500,00):
1. `GET /api/v2/analises/dre?inicio=2026-07-01&fim=2026-07-31` (ou pela tela DRE do dashboard) — receita bruta de julho deve subir de R$1.693,00 pra R$3.193,00 (1.693 + 1.500 do orçamento 31).
2. Tela de detalhe do orçamento #31 no dashboard deve mostrar a OS #24 (hoje mostra zero OS).
3. Avançar uma OS offset de teste pra "entregue" (se houver uma disponível em ambiente de teste/produção com dados de teste) e confirmar no log do pm2 que não há erro nas queries novas de `orcamentosAfetadosPorOS`/`statusOSsDoOrcamento`.

- [ ] **Step 5: Reportar ao usuário o resultado da verificação do orçamento #31**

Confirmar explicitamente que a receita de julho subiu para refletir o orçamento #31, fechando o loop da investigação que originou este plano.

---

## Fora de escopo (reafirmado do spec)

- Fazer `criarOSOffset()`/o `INSERT` de revenda gravarem `orcamento_id` diretamente — impossível corretamente, já que uma OS offset pode cobrir vários orçamentos.
- Backfill de dados históricos — não há OS órfã (toda OS `orcamento_id=NULL` tem `os_itens` recuperável), então não há nada pra corrigir na tabela, só na lógica de leitura.
- Detalhamento clicável na linha "Receita Bruta de Vendas" da DRE (pedido original do usuário, spec/plano à parte, depois desta correção).
