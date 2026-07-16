# Evitar pedido duplicado quando conversa é sobre pedido existente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedir que o bot crie um pedido novo quando o cliente está, na verdade, falando sobre um pedido já em andamento — corrigindo o caso real do cliente Wendell (pedido #44 duplicado como #46).

**Architecture:** Três mudanças independentes, todas em código já existente: (1) parar de fechar a conversa automaticamente ao enviar a arte final; (2) fechar conversas automaticamente só por inatividade real (job diário); (3) antes da IA criar um pedido, consultar pedidos abertos do cliente e, se houver, forçar uma pergunta de confirmação antes de deixar `registrar_pedido` executar.

**Tech Stack:** Node.js/Express, PostgreSQL (`pg`), `node-cron`, Jest, OpenAI SDK (mockado nos testes).

**Spec:** `docs/superpowers/specs/2026-07-16-conversa-pedido-existente-vs-novo-design.md`

---

### Task 1: Remover fechamento automático da conversa ao enviar a arte

**Files:**
- Modify: `src/modules/orcamentos/service.js:981-982`
- Test: `tests/modules/arte-envio.test.js`

- [ ] **Step 1: Adicionar asserção de regressão no teste existente antes de mexer no código**

Abra `tests/modules/arte-envio.test.js` e localize o primeiro teste (linha 20), `'envio OK → envia imagem sem botões, depois texto com link, e marca arte_status=enviada'`. Adicione a asserção abaixo logo antes do `});` final desse teste (depois da linha `expect(r).toEqual({ ok: true, item_id: 5, status: 'enviada' });`):

```js
  expect(conversas.sairDeAguardandoHumano).not.toHaveBeenCalled();
});
```

O arquivo já mocka `sairDeAguardandoHumano` (linha 5), então este teste hoje passa mesmo com a chamada real existindo — a asserção nova é o que vai forçar a remoção do código.

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx jest tests/modules/arte-envio.test.js -t "envio OK" --silent`
Expected: FAIL — `expect(jest.fn()).not.toHaveBeenCalled() // Expected number of calls: 0, Received number of calls: 1`

- [ ] **Step 3: Remover a chamada de auto-resolve em `enviarArteItem`**

Em `src/modules/orcamentos/service.js`, localize (por volta da linha 977-983):

```js
  await db.query(
    `UPDATE orcamento_itens SET arte_status='enviada', arte_arquivo_url=$1, arte_enviada_em=NOW() WHERE id=$2`,
    [arquivo_url, itemId]
  );
  conversas.sairDeAguardandoHumano(item.cliente_celular, { para: 'resolved', motivo: 'arte_enviada' })
    .catch(e => console.warn('[AUTO-RESOLVE] arte:', e.message));
  return { ok: true, item_id: itemId, status: 'enviada' };
```

Substitua por (remove só as duas linhas do `sairDeAguardandoHumano`):

```js
  await db.query(
    `UPDATE orcamento_itens SET arte_status='enviada', arte_arquivo_url=$1, arte_enviada_em=NOW() WHERE id=$2`,
    [arquivo_url, itemId]
  );
  return { ok: true, item_id: itemId, status: 'enviada' };
```

- [ ] **Step 4: Rodar os testes do arquivo e confirmar que passam**

Run: `npx jest tests/modules/arte-envio.test.js --silent`
Expected: PASS (todos os testes do arquivo, incluindo o novo `expect(...).not.toHaveBeenCalled()`)

- [ ] **Step 5: Rodar a suíte completa de testes que roda localmente (sem depender de Postgres) para checar regressão**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: mesma baseline conhecida do projeto — 5 suites falham só por falta de Postgres local (`tests/modules/nfe.test.js`, `pagamentos.test.js`, `notifications.test.js`, `os.test.js`, `orcamentos.test.js`), as demais (incluindo `arte-envio.test.js`) passam.

- [ ] **Step 6: Commit**

```bash
git add src/modules/orcamentos/service.js tests/modules/arte-envio.test.js
git commit -m "fix(orcamentos): nao fecha conversa automaticamente ao enviar arte final"
```

---

### Task 2: Job de fechamento automático por inatividade (3 dias)

**Files:**
- Create: `src/jobs/conversas-inativas.js`
- Modify: `src/app.js:20`
- Test: `tests/jobs/conversas-inativas.test.js`

- [ ] **Step 1: Escrever o teste (falhando) para o job**

Crie `tests/jobs/conversas-inativas.test.js`:

```js
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../src/db', () => ({ query: jest.fn() }));

const cron = require('node-cron');
const db = require('../../src/db');

describe('job conversas-inativas', () => {
  beforeEach(() => {
    jest.resetModules();
    cron.schedule.mockReset();
    db.query.mockReset();
  });

  function carregarJobECapturarCallback() {
    require('../../src/jobs/conversas-inativas');
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    const [expressao, callback, opcoes] = cron.schedule.mock.calls[0];
    return { expressao, callback, opcoes };
  }

  test('agenda o cron às 03h00 no fuso America/Sao_Paulo', () => {
    const { expressao, opcoes } = carregarJobECapturarCallback();
    expect(expressao).toBe('0 3 * * *');
    expect(opcoes).toEqual({ timezone: 'America/Sao_Paulo' });
  });

  test('callback fecha conversas ativas sem mensagem há 3+ dias', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 2, rows: [{ id: 1 }, { id: 2 }] });
    const { callback } = carregarJobECapturarCallback();

    await callback();

    expect(db.query).toHaveBeenCalledTimes(1);
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE conversations SET status = 'resolved'/);
    expect(sql).toMatch(/status IN \('active', 'aguardando_humano', 'orcamento_enviado'\)/);
    expect(sql).toMatch(/INTERVAL '3 days'/);
  });

  test('callback não lança se a query falhar — só loga', async () => {
    db.query.mockRejectedValueOnce(new Error('conexão perdida'));
    const { callback } = carregarJobECapturarCallback();
    const warnSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await expect(callback()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/ERRO/));
    warnSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx jest tests/jobs/conversas-inativas.test.js --silent`
Expected: FAIL — `Cannot find module '../../src/jobs/conversas-inativas'`

- [ ] **Step 3: Criar o job**

Crie `src/jobs/conversas-inativas.js`:

```js
const cron = require('node-cron');
const db = require('../db');

function log(msg) { console.log(`[CRON-CONVERSAS] ${new Date().toISOString()} ${msg}`); }

// 03h00 — Fecha conversas sem nenhuma mensagem há 3+ dias
cron.schedule('0 3 * * *', async () => {
  try {
    const r = await db.query(`
      UPDATE conversations SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
      WHERE status IN ('active', 'aguardando_humano', 'orcamento_enviado')
        AND id NOT IN (
          SELECT DISTINCT conversation_id FROM messages
          WHERE created_at > NOW() - INTERVAL '3 days'
        )
        AND updated_at < NOW() - INTERVAL '3 days'
      RETURNING id`);
    log(`${r.rowCount} conversa(s) fechada(s) por inatividade`);
  } catch (err) {
    log(`ERRO: ${err.message}`);
  }
}, { timezone: 'America/Sao_Paulo' });
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx jest tests/jobs/conversas-inativas.test.js --silent`
Expected: PASS (3 testes)

- [ ] **Step 5: Registrar o job em `src/app.js`**

Em `src/app.js`, localize a linha 20:

```js
require('./jobs/contas-pagar');
```

Substitua por:

```js
require('./jobs/contas-pagar');
require('./jobs/conversas-inativas');
```

- [ ] **Step 6: Checar sintaxe do `app.js`**

Run: `node --check src/app.js`
Expected: sem saída (sucesso)

- [ ] **Step 7: Rodar a suíte completa de testes locais**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: mesma baseline conhecida (5 suites falhando só por falta de Postgres local); `tests/jobs/conversas-inativas.test.js` passa.

- [ ] **Step 8: Commit**

```bash
git add src/jobs/conversas-inativas.js src/app.js tests/jobs/conversas-inativas.test.js
git commit -m "feat(conversas): fecha conversas automaticamente apos 3 dias de inatividade"
```

---

### Task 3: Checar pedido aberto antes de `registrar_pedido` na IA

**Files:**
- Modify: `src/ai/agent.js`
- Test: `tests/agent-pedido-existente.test.js`

- [ ] **Step 1: Adicionar o campo `pedido_novo_confirmado` ao schema da tool `registrar_pedido`**

Em `src/ai/agent.js`, localize (por volta da linha 216):

```js
          cliente_existente_confirmado: { type: 'boolean', description: 'true se o cliente confirmou ser o cadastro encontrado pelo telefone; false se negou' },
        },
        required: ['mensagem_encerramento', 'tipo_servico', 'quantidade'],
```

Substitua por:

```js
          cliente_existente_confirmado: { type: 'boolean', description: 'true se o cliente confirmou ser o cadastro encontrado pelo telefone; false se negou' },
          pedido_novo_confirmado: { type: 'boolean', description: 'Preencha true SOMENTE se havia pedido(s) em aberto do cliente e ele confirmou explicitamente que este é um pedido NOVO e diferente. Deixe ausente/false se não havia pedido em aberto ou se o cliente não confirmou.' },
        },
        required: ['mensagem_encerramento', 'tipo_servico', 'quantidade'],
```

- [ ] **Step 2: Adicionar a regra 18 ao `SYSTEM_PROMPT`**

No mesmo arquivo, localize o final do `SYSTEM_PROMPT` (regra 16, que termina em `.` seguido de crase fechando a template string, por volta da linha 172):

```js
   - Ao chamar registrar_pedido, preencha "impressao" ("4/0" ou "4/4") e "dobras" (0 para folheto/flyer; 1–3 para folder) no item.`;
```

Substitua por:

```js
   - Ao chamar registrar_pedido, preencha "impressao" ("4/0" ou "4/4") e "dobras" (0 para folheto/flyer; 1–3 para folder) no item.
18. PEDIDO EM ABERTO — leia com atenção se o contexto trouxer "[PEDIDOS EM ABERTO]":
   - Antes de chamar registrar_pedido, verifique se a mensagem do cliente parece estar relacionada a um dos pedidos já em aberto listados (dúvida sobre arte, instalação, prazo, revisão, acompanhamento). Se sim, NÃO chame registrar_pedido — responda a dúvida normalmente, ou inclua [FALAR_HUMANO] se precisar de alguém da equipe.
   - Só chame registrar_pedido quando o cliente confirmar EXPLICITAMENTE que é um pedido novo e diferente dos listados. Se não tiver certeza, pergunte antes: "Isso é sobre o pedido [número] que você já tem com a gente, ou é um pedido novo?" Nesse caso, ao chamar registrar_pedido, preencha "pedido_novo_confirmado": true.`;
```

- [ ] **Step 3: Adicionar o lookup de pedidos abertos e injetar no `clienteNota`**

No mesmo arquivo, dentro de `processMessage()`, localize o bloco (por volta das linhas 248-270):

```js
  // Pré-busca: o telefone do contato está cadastrado? (injeta nota de contexto)
  let clienteNota = '';
  try {
    const cinfo = await db.query(
      `SELECT ct.phone FROM conversations c LEFT JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
      [conversationId]);
    const phone = cinfo.rows[0]?.phone;
    if (phone) {
      const cands = await buscarClientesPorTelefone(phone);
      if (cands.length === 0) {
        clienteNota = `\n\n[CLIENTE NOVO] Telefone não cadastrado. Faça o cadastro mínimo: peça o nome e o e-mail do cliente.`;
      } else if (cands.length === 1) {
        const nm = cands[0].nome, em = cands[0].email;
        clienteNota = em
          ? `\n\n[CLIENTE NA BASE] Telefone cadastrado como "${nm}", e-mail "${em}". Confirme a identidade pelo nome e confirme se esse e-mail está correto (atualize se o cliente corrigir).`
          : `\n\n[CLIENTE NA BASE] Telefone cadastrado como "${nm}", sem e-mail. Confirme a identidade pelo nome e peça o e-mail.`;
      } else {
        const lista = cands.slice(0, 5)
          .map((c, i) => `${i + 1}) ${c.nome} (${c.tipo_pessoa === 'PJ' ? 'PJ' : 'PF'})`).join('\n');
        const extra = cands.length > 5 ? '\n(entre outros — confirme o nome/empresa)' : '';
        clienteNota = `\n\n[CLIENTES NA BASE] O telefone está ligado a mais de um cadastro:\n${lista}${extra}\nPergunte para QUAL desses cadastros é este pedido, ou se é um cadastro novo. NÃO escolha por conta própria. Ao registrar, use em "nome_cliente" exatamente o nome do cadastro escolhido.`;
      }
    }
  } catch (e) { console.warn('[CHATBOT-CLIENTE] lookup falhou:', e.message); }
  const promptFinal = systemPrompt + clienteNota;
```

Substitua por (adiciona o lookup de pedidos abertos e declara `pedidosAbertos` no escopo da função, usado depois no Step 4):

```js
  // Pré-busca: o telefone do contato está cadastrado? (injeta nota de contexto)
  let clienteNota = '';
  let pedidosAbertos = [];
  try {
    const cinfo = await db.query(
      `SELECT ct.phone FROM conversations c LEFT JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
      [conversationId]);
    const phone = cinfo.rows[0]?.phone;
    if (phone) {
      const cands = await buscarClientesPorTelefone(phone);
      if (cands.length === 0) {
        clienteNota = `\n\n[CLIENTE NOVO] Telefone não cadastrado. Faça o cadastro mínimo: peça o nome e o e-mail do cliente.`;
      } else if (cands.length === 1) {
        const nm = cands[0].nome, em = cands[0].email;
        clienteNota = em
          ? `\n\n[CLIENTE NA BASE] Telefone cadastrado como "${nm}", e-mail "${em}". Confirme a identidade pelo nome e confirme se esse e-mail está correto (atualize se o cliente corrigir).`
          : `\n\n[CLIENTE NA BASE] Telefone cadastrado como "${nm}", sem e-mail. Confirme a identidade pelo nome e peça o e-mail.`;
      } else {
        const lista = cands.slice(0, 5)
          .map((c, i) => `${i + 1}) ${c.nome} (${c.tipo_pessoa === 'PJ' ? 'PJ' : 'PF'})`).join('\n');
        const extra = cands.length > 5 ? '\n(entre outros — confirme o nome/empresa)' : '';
        clienteNota = `\n\n[CLIENTES NA BASE] O telefone está ligado a mais de um cadastro:\n${lista}${extra}\nPergunte para QUAL desses cadastros é este pedido, ou se é um cadastro novo. NÃO escolha por conta própria. Ao registrar, use em "nome_cliente" exatamente o nome do cadastro escolhido.`;
      }

      if (cands.length) {
        const ids = cands.map(c => c.id);
        const rPedidos = await db.query(
          `SELECT numero_os, status, produto FROM orders
           WHERE cliente_id = ANY($1) AND status NOT IN ('concluido','entregue','cancelado')
           ORDER BY created_at DESC`,
          [ids]);
        pedidosAbertos = rPedidos.rows;
        if (pedidosAbertos.length) {
          const listaPedidos = pedidosAbertos
            .map(p => `#${p.numero_os} (${p.produto || 'produto não especificado'}, status: ${p.status})`)
            .join(', ');
          clienteNota += `\n\n[PEDIDOS EM ABERTO] Este cliente já tem pedido(s) em andamento: ${listaPedidos}. Se a mensagem do cliente parecer estar relacionada a um desses pedidos (dúvida sobre arte, instalação, prazo, revisão, etc.), NÃO chame registrar_pedido — responda a dúvida normalmente ou use [FALAR_HUMANO] se precisar de alguém da equipe. Só chame registrar_pedido se o cliente confirmar explicitamente que é um pedido NOVO e diferente desses. Nesse caso, preencha "pedido_novo_confirmado": true no registrar_pedido.`;
        }
      }
    }
  } catch (e) { console.warn('[CHATBOT-CLIENTE] lookup falhou:', e.message); }
  const promptFinal = systemPrompt + clienteNota;
```

- [ ] **Step 4: Adicionar a trava no handler de `registrar_pedido`**

No mesmo arquivo, localize o início do handler da tool call (por volta da linha 294-299):

```js
    if (toolCall.function.name === 'registrar_pedido') {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        orderDetails = args;
        isComplete = true;

        // Resolve o cliente (find/create por celular) — entrada única no Pedido
```

Substitua por:

```js
    if (toolCall.function.name === 'registrar_pedido') {
      try {
        const args = JSON.parse(toolCall.function.arguments);

        if (pedidosAbertos.length && args.pedido_novo_confirmado !== true) {
          const numeros = pedidosAbertos.map(p => `#${p.numero_os}`).join(', ');
          cleanResponse = `Só pra confirmar: isso é sobre o pedido ${numeros} que você já tem com a gente, ou é um pedido novo? 😊`;
          history.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Aguardando confirmação: pedido existente ou novo.' });
          await saveContext(conversationId, history);
          return { response: cleanResponse, isComplete: false, orderDetails: null };
        }

        orderDetails = args;
        isComplete = true;

        // Resolve o cliente (find/create por celular) — entrada única no Pedido
```

*(O `return` antecipado aqui é intencional: evita duplicar o `await saveContext(...)` e o `return` finais do fim da função — o fluxo de confirmação pendente termina a função imediatamente, sem passar pelo restante do `try` que cria o pedido.)*

- [ ] **Step 5: Checar sintaxe do arquivo**

Run: `node --check src/ai/agent.js`
Expected: sem saída (sucesso)

- [ ] **Step 6: Escrever os testes do novo comportamento**

Crie `tests/agent-pedido-existente.test.js`:

```js
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/modules/orders/service', () => ({ criarOrder: jest.fn() }));
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } },
  }));
});

const db = require('../src/db');
const ordersService = require('../src/modules/orders/service');
const OpenAI = require('openai');
const agent = require('../src/ai/agent');
const openaiInstance = OpenAI.mock.results[0].value;

const CLIENTE = { id: 'cliente-1', nome: 'WENDELL', tipo_pessoa: 'PF', celular: '21993367766', telefone: null, email: 'wendell@example.com', cpf_cnpj: null, updated_at: new Date(), created_at: new Date() };
const PEDIDO_ABERTO = { numero_os: 44, status: 'em_producao', produto: 'ADESIVO' };

function mockDb({ pedidosAbertos = [] } = {}) {
  db.query.mockImplementation((sql, params) => {
    if (sql.startsWith('SELECT ai_context')) return Promise.resolve({ rows: [{ ai_context: [] }] });
    if (sql.startsWith('SELECT value FROM settings')) return Promise.resolve({ rows: [] });
    if (sql.includes('SELECT ct.phone FROM conversations')) return Promise.resolve({ rows: [{ phone: '21993367766' }] });
    if (sql.includes('FROM clientes_lkl')) return Promise.resolve({ rows: [CLIENTE] });
    if (sql.includes('FROM orders') && sql.includes('cliente_id = ANY')) return Promise.resolve({ rows: pedidosAbertos });
    if (sql.includes('SELECT c.contact_id, ct.phone')) return Promise.resolve({ rows: [{ contact_id: 'contato-1', phone: '21993367766', contact_name: 'WENDELL' }] });
    if (sql.startsWith('UPDATE clientes_lkl')) return Promise.resolve({ rows: [] });
    if (sql.startsWith('UPDATE conversations SET needs_details')) return Promise.resolve({ rows: [] });
    if (sql.startsWith('UPDATE contacts SET name')) return Promise.resolve({ rows: [] });
    if (sql.startsWith('UPDATE conversations SET ai_context')) return Promise.resolve({ rows: [] });
    throw new Error('query inesperada: ' + sql);
  });
}

function mockToolCall(args) {
  openaiInstance.chat.completions.create.mockResolvedValueOnce({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          function: { name: 'registrar_pedido', arguments: JSON.stringify(args) },
        }],
      },
    }],
  });
}

const ARGS_BASE = {
  mensagem_encerramento: 'Pedido registrado! Número: {NUMERO_PEDIDO}',
  tipo_servico: 'Adesivo', produto: 'ADESIVO', quantidade: 1,
  nome_cliente: 'WENDELL', email: 'wendell@example.com',
  cliente_existente_confirmado: true,
};

describe('processMessage — pedido em aberto do cliente', () => {
  beforeEach(() => {
    db.query.mockReset();
    openaiInstance.chat.completions.create.mockReset();
    ordersService.criarOrder.mockReset();
  });

  test('sem pedido em aberto → cria o pedido normalmente', async () => {
    mockDb({ pedidosAbertos: [] });
    mockToolCall(ARGS_BASE);
    ordersService.criarOrder.mockResolvedValueOnce({ order: { numero_os: 50 } });

    const r = await agent.processMessage(1, 'Quero um adesivo novo, pode confirmar');

    expect(ordersService.criarOrder).toHaveBeenCalledTimes(1);
    expect(r.isComplete).toBe(true);
    expect(r.response).toMatch(/#50/);
  });

  test('com pedido em aberto e SEM pedido_novo_confirmado → não cria pedido, pergunta antes', async () => {
    mockDb({ pedidosAbertos: [PEDIDO_ABERTO] });
    mockToolCall(ARGS_BASE); // sem pedido_novo_confirmado

    const r = await agent.processMessage(1, 'Preciso de orientação de instalação');

    expect(ordersService.criarOrder).not.toHaveBeenCalled();
    expect(r.isComplete).toBe(false);
    expect(r.orderDetails).toBeNull();
    expect(r.response).toMatch(/#44/);
    expect(r.response).toMatch(/pedido novo/i);
  });

  test('com pedido em aberto e pedido_novo_confirmado=true → cria o pedido normalmente', async () => {
    mockDb({ pedidosAbertos: [PEDIDO_ABERTO] });
    mockToolCall({ ...ARGS_BASE, pedido_novo_confirmado: true });
    ordersService.criarOrder.mockResolvedValueOnce({ order: { numero_os: 51 } });

    const r = await agent.processMessage(1, 'Sim, é um pedido novo mesmo, confirmo');

    expect(ordersService.criarOrder).toHaveBeenCalledTimes(1);
    expect(r.isComplete).toBe(true);
    expect(r.response).toMatch(/#51/);
  });
});
```

- [ ] **Step 7: Rodar os testes novos e confirmar que passam**

Run: `npx jest tests/agent-pedido-existente.test.js --silent`
Expected: PASS (3 testes)

- [ ] **Step 8: Rodar a suíte completa de testes locais, incluindo os testes já existentes de `agent.js`, para checar regressão**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: mesma baseline conhecida (5 suites falhando só por falta de Postgres local — nenhuma delas relacionada a `agent.js`); `tests/agent-falar-humano.test.js`, `tests/agent-prompt.test.js` e `tests/agent-pedido-existente.test.js` passam.

- [ ] **Step 9: Commit**

```bash
git add src/ai/agent.js tests/agent-pedido-existente.test.js
git commit -m "feat(chatbot): pergunta antes de criar pedido novo quando cliente tem pedido em aberto"
```

---

### Task 4: Deploy no VPS

**Files:** nenhum arquivo novo — apenas deploy dos três arquivos alterados.

- [ ] **Step 1: Rodar a suíte completa uma última vez antes do deploy**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: mesma baseline conhecida (5 suites falhando só por Postgres local ausente).

- [ ] **Step 2: Sincronizar os arquivos alterados para o VPS**

Run:
```bash
rsync -av /Users/klebercamara/LKL/src/modules/orcamentos/service.js lkl:/var/www/lkl-chatbot/src/modules/orcamentos/service.js
rsync -av /Users/klebercamara/LKL/src/jobs/conversas-inativas.js lkl:/var/www/lkl-chatbot/src/jobs/conversas-inativas.js
rsync -av /Users/klebercamara/LKL/src/app.js lkl:/var/www/lkl-chatbot/src/app.js
rsync -av /Users/klebercamara/LKL/src/ai/agent.js lkl:/var/www/lkl-chatbot/src/ai/agent.js
```

- [ ] **Step 3: Verificar md5 local vs remoto dos 4 arquivos**

Run:
```bash
md5sum /Users/klebercamara/LKL/src/modules/orcamentos/service.js /Users/klebercamara/LKL/src/jobs/conversas-inativas.js /Users/klebercamara/LKL/src/app.js /Users/klebercamara/LKL/src/ai/agent.js
ssh lkl "md5sum /var/www/lkl-chatbot/src/modules/orcamentos/service.js /var/www/lkl-chatbot/src/jobs/conversas-inativas.js /var/www/lkl-chatbot/src/app.js /var/www/lkl-chatbot/src/ai/agent.js"
```
Expected: os 4 hashes batem entre local e remoto.

- [ ] **Step 4: Reiniciar o processo no VPS (padrão que evita o bug de cache de env do PM2)**

Run: `ssh lkl "cd /var/www/lkl-chatbot && set -a && source .env && set +a && pm2 restart lkl-chatbot --update-env && pm2 save"`
Expected: `[PM2] [lkl-chatbot](0) ✓` e status `online`; o warning `.env: line 45: Assistente: command not found` é conhecido e inofensivo.

- [ ] **Step 5: Checar os logs de startup**

Run: `ssh lkl "pm2 logs lkl-chatbot --lines 20 --nostream --err"`
Expected: `✅ PostgreSQL conectado`, `🚀 LKL Chatbot rodando na porta 3000`, nenhuma linha de erro relacionada a `conversas-inativas` ou `agent.js`.

---

## Cobertura do spec

- Componente 1 (remover auto-resolve) → Task 1.
- Componente 2 (fechamento por inatividade, 3 dias) → Task 2.
- Componente 3a/3b/3c/3d (lookup, trava no código, tool schema, regra no prompt) → Task 3, Steps 1-4.
- Testes descritos no spec → Task 1 Step 1, Task 2 Step 1, Task 3 Step 6 (cobre os 3 cenários: sem pedido aberto / com pedido aberto sem confirmação / com confirmação).
- Deploy → Task 4.
