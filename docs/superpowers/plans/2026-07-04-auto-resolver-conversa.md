# Auto-saída de `aguardando_humano` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tirar a conversa do chatbot de `aguardando_humano` automaticamente quando a equipe envia o orçamento, a arte ou o link de cobrança ao cliente, sem depender do clique no botão Resolver.

**Architecture:** Um único helper novo em `src/services/conversas.js` (`sairDeAguardandoHumano`) centraliza a regra: acha a conversa ativa pelo telefone e, **só se estiver em `aguardando_humano`**, transiciona para `orcamento_enviado` (envio de orçamento) ou `resolved` (arte/cobrança). As 3 ações de envio chamam esse helper no caminho de sucesso, em fire-and-forget para nunca derrubar o envio.

**Tech Stack:** Node.js, PostgreSQL (`pg`), Jest, Socket.IO.

**Spec:** `docs/superpowers/specs/2026-07-04-auto-resolver-conversa-design.md`

---

## File Structure

- `src/services/conversas.js` — adiciona `sairDeAguardandoHumano(celular, { para, motivo })` e exporta.
- `tests/conversas-auto-resolver.test.js` — testes unitários do helper (mock de `db`, `whatsapp`, `logger`).
- `src/modules/orcamentos/service.js` — chama o helper após envio do orçamento (`enviarParaCliente`) e da arte (`enviarArteItem`).
- `src/modules/orcamentos/router.js` — chama o helper após envio da cobrança (`POST /:id/cobrar`).

---

## Task 1: Helper `sairDeAguardandoHumano` em conversas.js

**Files:**
- Modify: `src/services/conversas.js` (adiciona função antes do `module.exports` na linha ~173; adiciona `require` do logger no topo)
- Test: `tests/conversas-auto-resolver.test.js`

- [ ] **Step 1: Write the failing test**

Crie `tests/conversas-auto-resolver.test.js`:

```javascript
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn(), sendImage: jest.fn(), sendInteractiveButtons: jest.fn() }));
jest.mock('../src/services/logger', () => ({ log: jest.fn() }));

const db = require('../src/db');
const conversas = require('../src/services/conversas');

beforeEach(() => { jest.clearAllMocks(); delete global.io; });

describe('sairDeAguardandoHumano', () => {
  test('conversa em aguardando_humano + para=resolved → UPDATE resolved + emite socket', async () => {
    const emit = jest.fn();
    global.io = { emit };
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7, name: 'KLEBER' }] })                       // acharContato
      .mockResolvedValueOnce({ rows: [{ id: 30, status: 'aguardando_humano' }] })          // conversa ativa
      .mockResolvedValueOnce({ rows: [] });                                                // UPDATE
    const r = await conversas.sairDeAguardandoHumano('5521988596449', { para: 'resolved', motivo: 'arte_enviada' });
    expect(r).toEqual({ conversationId: 30, de: 'aguardando_humano', para: 'resolved' });
    const upd = db.query.mock.calls[2];
    expect(upd[0]).toMatch(/UPDATE conversations/i);
    expect(upd[0]).toMatch(/status = \$2/);
    expect(upd[0]).toMatch(/resolved_at = NOW\(\)/);
    expect(upd[0]).toMatch(/alerta_humano_em = NULL/);
    expect(upd[1]).toEqual([30, 'resolved']);
    expect(emit).toHaveBeenCalledWith('conversation_updated', { id: 30, status: 'resolved' });
  });

  test('conversa em aguardando_humano + para=orcamento_enviado → UPDATE sem resolved_at', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })                                        // acharContato
      .mockResolvedValueOnce({ rows: [{ id: 30, status: 'aguardando_humano' }] })          // conversa ativa
      .mockResolvedValueOnce({ rows: [] });                                                // UPDATE
    const r = await conversas.sairDeAguardandoHumano('21988596449', { para: 'orcamento_enviado', motivo: 'orcamento_enviado' });
    expect(r).toEqual({ conversationId: 30, de: 'aguardando_humano', para: 'orcamento_enviado' });
    const upd = db.query.mock.calls[2];
    expect(upd[0]).not.toMatch(/resolved_at = NOW\(\)/);
    expect(upd[0]).toMatch(/alerta_humano_em = NULL/);
    expect(upd[1]).toEqual([30, 'orcamento_enviado']);
  });

  test('conversa em active → no-op (nenhum UPDATE), retorna null', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })                                        // acharContato
      .mockResolvedValueOnce({ rows: [{ id: 30, status: 'active' }] });                    // conversa ativa
    const r = await conversas.sairDeAguardandoHumano('21988596449', { para: 'resolved', motivo: 'x' });
    expect(r).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(2); // acharContato + busca conversa; sem UPDATE
  });

  test('conversa em orcamento_enviado → no-op, retorna null', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rows: [{ id: 30, status: 'orcamento_enviado' }] });
    const r = await conversas.sairDeAguardandoHumano('21988596449', { para: 'resolved', motivo: 'x' });
    expect(r).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('sem contato → no-op sem erro, retorna null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // acharContato: nada
    const r = await conversas.sairDeAguardandoHumano('21988596449', { para: 'resolved', motivo: 'x' });
    expect(r).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('contato sem conversa ativa → no-op, retorna null', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] }) // acharContato
      .mockResolvedValueOnce({ rows: [] });         // sem conversa
    const r = await conversas.sairDeAguardandoHumano('21988596449', { para: 'resolved', motivo: 'x' });
    expect(r).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('telefone vazio → retorna null sem tocar no banco', async () => {
    const r = await conversas.sairDeAguardandoHumano('', { para: 'resolved', motivo: 'x' });
    expect(r).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('casa por sufixo de 9 dígitos (telefone formatado diferente)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })                                        // acharContato
      .mockResolvedValueOnce({ rows: [{ id: 30, status: 'aguardando_humano' }] })          // conversa
      .mockResolvedValueOnce({ rows: [] });                                                // UPDATE
    await conversas.sairDeAguardandoHumano('+55 (21) 98859-6449', { para: 'resolved', motivo: 'x' });
    const acharCall = db.query.mock.calls[0];
    expect(acharCall[1]).toEqual(['%988596449', '5521988596449']); // sufixo 9 dígitos + dígitos completos
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/conversas-auto-resolver.test.js`
Expected: FAIL — `conversas.sairDeAguardandoHumano is not a function`.

- [ ] **Step 3: Add the logger require at the top of conversas.js**

Em `src/services/conversas.js`, logo abaixo da linha 2 (`const whatsapp = require('./whatsapp');`), adicione:

```javascript
const { log } = require('./logger');
```

- [ ] **Step 4: Implement the helper**

Em `src/services/conversas.js`, imediatamente antes do bloco `module.exports = {` (linha ~173), adicione:

```javascript
// Tira a conversa ativa do cliente de 'aguardando_humano' quando uma ação-chave é concluída.
// Só age se a conversa estiver em 'aguardando_humano' (idempotente). Nunca lança — no-op seguro.
// para: 'resolved' (arte/cobrança) ou 'orcamento_enviado' (envio de orçamento).
// Retorna { conversationId, de, para } quando agiu; null quando foi no-op.
async function sairDeAguardandoHumano(celular, { para, motivo } = {}) {
  try {
    const contato = await acharContatoPorTelefone(celular);
    if (!contato) return null;

    const r = await db.query(
      `SELECT id, status FROM conversations
       WHERE contact_id = $1 AND status IN ('active', 'aguardando_humano', 'orcamento_enviado')
       ORDER BY started_at DESC LIMIT 1`,
      [contato.id]
    );
    const conversa = r.rows[0];
    if (!conversa || conversa.status !== 'aguardando_humano') return null;

    const setResolvedAt = para === 'resolved' ? 'resolved_at = NOW(), ' : '';
    await db.query(
      `UPDATE conversations SET status = $2, ${setResolvedAt}alerta_humano_em = NULL, updated_at = NOW() WHERE id = $1`,
      [conversa.id, para]
    );

    try {
      await log('conversation_auto_resolved', `Conversa ${conversa.id} auto-resolvida (${motivo})`, {
        conversationId: conversa.id, metadata: { motivo, para },
      });
    } catch (e) { /* log é secundário */ }

    if (global.io) global.io.emit('conversation_updated', { id: conversa.id, status: para });

    return { conversationId: conversa.id, de: 'aguardando_humano', para };
  } catch (e) {
    console.warn('[AUTO-RESOLVE] Falha ao sair de aguardando_humano:', e.message);
    return null;
  }
}
```

E adicione `sairDeAguardandoHumano,` na lista de `module.exports` (junto com os demais, ex.: após `enviarClienteImagem,`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/conversas-auto-resolver.test.js`
Expected: PASS (8/8).

Nota: no teste de sufixo, `acharContatoPorTelefone` monta os params `['%988596449', '5521988596449']` (ver `conversas.js:13-17`). Se o teste falhar só nesse assert, ajuste o valor esperado ao que a função realmente passa — a lógica do helper não muda.

- [ ] **Step 6: Run the full conversas suite to ensure no regression**

Run: `npx jest tests/conversas.test.js tests/conversas-auto-resolver.test.js`
Expected: PASS (todos verdes).

- [ ] **Step 7: Commit**

```bash
git add src/services/conversas.js tests/conversas-auto-resolver.test.js
git commit -m "feat(conversas): sairDeAguardandoHumano — auto-resolve por telefone"
```

---

## Task 2: Ligar o helper nas 3 ações de envio

**Files:**
- Modify: `src/modules/orcamentos/service.js` (bloco WhatsApp de `enviarParaCliente` ~328; sucesso de `enviarArteItem` ~894-899)
- Modify: `src/modules/orcamentos/router.js` (após envio da cobrança ~375-377)

Nenhuma dessas 3 ações tem teste unitário (dependem de DB/rede real; validadas por smoke no VPS). Portanto: sem teste novo nesta task — apenas as edições. Confirme que `conversas` já está importado em cada arquivo (`service.js` usa `conversas.enviarClienteTexto` na linha ~328; `router.js` importa na linha 7).

- [ ] **Step 1: Envio do orçamento → orcamento_enviado**

Em `src/modules/orcamentos/service.js`, dentro de `enviarParaCliente`, logo APÓS a linha:

```javascript
    await conversas.enviarClienteTexto(orc.cliente_celular, msg, { nome: orc.cliente_nome });
```

adicione (antes do `// Registra pendência de confirmação WA`):

```javascript
    conversas.sairDeAguardandoHumano(orc.cliente_celular, { para: 'orcamento_enviado', motivo: 'orcamento_enviado' })
      .catch(e => console.warn('[AUTO-RESOLVE] orçamento:', e.message));
```

- [ ] **Step 2: Envio da arte → resolved**

Em `src/modules/orcamentos/service.js`, dentro de `enviarArteItem`, no bloco `if (envio.ok) {` (após o `UPDATE ... arte_status='enviada' ...` e antes do `return { ok: true, item_id: itemId, status: 'enviada' };`), adicione:

```javascript
    conversas.sairDeAguardandoHumano(item.cliente_celular, { para: 'resolved', motivo: 'arte_enviada' })
      .catch(e => console.warn('[AUTO-RESOLVE] arte:', e.message));
```

O bloco final fica:

```javascript
  if (envio.ok) {
    await db.query(
      `UPDATE orcamento_itens SET arte_status='enviada', arte_arquivo_url=$1, arte_enviada_em=NOW() WHERE id=$2`,
      [arquivo_url, itemId]
    );
    conversas.sairDeAguardandoHumano(item.cliente_celular, { para: 'resolved', motivo: 'arte_enviada' })
      .catch(e => console.warn('[AUTO-RESOLVE] arte:', e.message));
    return { ok: true, item_id: itemId, status: 'enviada' };
  }
```

- [ ] **Step 3: Envio da cobrança → resolved**

Em `src/modules/orcamentos/router.js`, no bloco fire-and-forget de `POST /:id/cobrar`, logo APÓS o `.catch` do `conversas.enviarClienteTexto` (linha ~375-377), adicione a chamada de auto-resolve. O trecho passa a ser:

```javascript
      conversas.enviarClienteTexto(orc.cliente_celular, msg, { nome: orc.cliente_nome }).catch(e =>
        console.warn('[WA-COBRAR] Falha:', e.message)
      );
      conversas.sairDeAguardandoHumano(orc.cliente_celular, { para: 'resolved', motivo: 'cobranca_enviada' })
        .catch(e => console.warn('[AUTO-RESOLVE] cobrança:', e.message));
```

- [ ] **Step 4: Sanity — o app carrega sem erro de sintaxe**

Run: `node -e "require('./src/modules/orcamentos/service.js'); require('./src/modules/orcamentos/router.js'); console.log('OK require')"`
Expected: imprime `OK require` (ou falha só por falta de env/DB — o que importa é NÃO haver `SyntaxError`). Se aparecer erro de conexão com DB, ignore; se aparecer `SyntaxError`, corrija.

- [ ] **Step 5: Rodar a suíte de testes que existe para os módulos tocados**

Run: `npx jest tests/conversas.test.js tests/conversas-auto-resolver.test.js`
Expected: PASS. (Os testes de integração de orçamentos já falham localmente por falta de DB — pré-existente; não introduza dependência neles.)

- [ ] **Step 6: Commit**

```bash
git add src/modules/orcamentos/service.js src/modules/orcamentos/router.js
git commit -m "feat(orcamentos): auto-resolve conversa ao enviar orçamento/arte/cobrança"
```

---

## Task 3: Deploy no VPS + smoke + memória

**Files:** nenhum no repo (deploy e verificação). Requer confirmação do usuário antes do deploy (produção).

- [ ] **Step 1: Confirmar deploy com o usuário**

Pergunte (AskUserQuestion) se pode fazer o deploy em produção. Só prosseguir com "sim".

- [ ] **Step 2: Backup dos arquivos no VPS**

```bash
ssh root@2.25.147.243 'cd /var/www/lkl-chatbot && for f in src/services/conversas.js src/modules/orcamentos/service.js src/modules/orcamentos/router.js; do cp "$f" "/tmp/$(basename $f).bak-$(date +%Y%m%d-%H%M%S)"; done && ls -la /tmp/*.bak-* | tail -3'
```

- [ ] **Step 3: Rsync dos 3 arquivos**

```bash
rsync -avz src/services/conversas.js root@2.25.147.243:/var/www/lkl-chatbot/src/services/conversas.js
rsync -avz src/modules/orcamentos/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/service.js
rsync -avz src/modules/orcamentos/router.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/router.js
```

- [ ] **Step 4: Restart do app e verificação de saúde**

```bash
ssh root@2.25.147.243 'pm2 restart lkl-chatbot && sleep 3 && pm2 status lkl-chatbot | tail -3 && pm2 logs lkl-chatbot --lines 15 --nostream | tail -15'
```
Expected: processo `online`, sem stacktrace de require/sintaxe nos logs.

- [ ] **Step 5: Smoke — auto-resolve por telefone contra uma conversa de teste**

Cria uma conversa de teste em `aguardando_humano`, chama o helper e confere que virou `resolved`, depois limpa:

```bash
ssh root@2.25.147.243 'cd /var/www/lkl-chatbot && node -r dotenv/config -e "
const db=require(\"./src/db\"); const conversas=require(\"./src/services/conversas\");
(async()=>{
  const ct=await db.query(\`SELECT id, phone FROM contacts ORDER BY last_contact DESC NULLS LAST LIMIT 1\`);
  const c=ct.rows[0];
  const conv=await db.query(\`INSERT INTO conversations (contact_id, status) VALUES (\$1, \x27aguardando_humano\x27) RETURNING id\`, [c.id]);
  const cid=conv.rows[0].id;
  const r=await conversas.sairDeAguardandoHumano(c.phone, { para:\"resolved\", motivo:\"smoke\" });
  const after=await db.query(\`SELECT status, resolved_at FROM conversations WHERE id=\$1\`, [cid]);
  console.log(\"retorno:\", JSON.stringify(r));
  console.log(\"status apos:\", JSON.stringify(after.rows[0]));
  await db.query(\`DELETE FROM conversations WHERE id=\$1\`, [cid]);
  console.log(\"conversa de teste removida\");
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
"'
```
Expected: `retorno` com `para: "resolved"`; `status apos` = `resolved` com `resolved_at` preenchido; conversa de teste removida.

- [ ] **Step 6: Validação real (pelo usuário)**

Peça ao usuário: numa conversa em `aguardando_humano`, enviar o orçamento (deve virar `orcamento_enviado`/sair da fila), ou enviar arte/cobrança (deve virar `resolved`) — e confirmar que a conversa some do "aguardando intervenção humana" sem clicar em Resolver.

- [ ] **Step 7: Atualizar memória**

Append em `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md` um parágrafo AUTO-RESOLVER-CONVERSA descrevendo: helper `conversas.sairDeAguardandoHumano(celular, {para, motivo})`; gatilhos (orçamento→orcamento_enviado, arte/cobrança→resolved); só age em aguardando_humano; sem migration; commits; smoke ok; validação pendente. Sem git (memória fica fora do repo).
```

---

## Self-Review

**1. Spec coverage:**
- Helper central `sairDeAguardandoHumano` → Task 1 ✓
- Idempotência / só age em aguardando_humano → Task 1 Steps 4, testes 3/4 ✓
- Alvo por ação (orçamento→orcamento_enviado; arte/cobrança→resolved) → Task 2 Steps 1-3 ✓
- Só no caminho de sucesso / fire-and-forget → Task 2 (posicionamento dentro de `if (envio.ok)` e após envio ok) ✓
- Sem migration → nenhuma task de migration ✓
- Não retroativo → nenhuma limpeza de conversas antigas ✓
- Testes unitários (5 cenários do spec) → Task 1 cobre os 5 + extras ✓
- Smoke no VPS → Task 3 ✓

**2. Placeholder scan:** nenhum "TBD/TODO"; todo passo com código ou comando concreto. ✓

**3. Type consistency:** `sairDeAguardandoHumano(celular, { para, motivo })` e retorno `{ conversationId, de, para }` idênticos em spec, helper, testes e call sites. Status usados (`aguardando_humano`, `resolved`, `orcamento_enviado`) idênticos ao código existente. ✓
