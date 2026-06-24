# Chatbot — Multi-item, E-mail e Identificação de Cliente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Melhorar a coleta do chatbot: múltiplos itens por pedido, tratar e-mail (pedir do novo, confirmar do existente) e identificar/cadastrar o cliente pelo telefone.

**Architecture:** Tudo em `src/ai/agent.js`: (1) regras no `SYSTEM_PROMPT` + `itens[]` no schema da tool; (2) pré-busca do cliente em `processMessage` injetando uma nota de contexto, e mapeamento multi-item + resolução de cliente no bloco de registro. Sem migration.

**Tech Stack:** Node.js. Sem postgres local — `node --check` + smoke E2E no VPS.

**Convenções/Fatos verificados:**
- `settings.agent_prompt` está VAZIO → `customPrompt || SYSTEM_PROMPT` usa o `SYSTEM_PROMPT` do código. Editar no código tem efeito.
- `processMessage` monta `systemPrompt` (linha ~122) e usa em `messages: [{role:'system', content: systemPrompt}, ...history]` (linha ~128).
- Bloco de registro (try do `registrar_pedido`, linhas ~146–222): resolve cliente por telefone, monta `dados` (hoje 1 item), chama `ordersService.criarOrder(dados, null)`.
- `criarOrder(dados)` aceita `itens:[{produto,quantidade,especificacao,tem_arte}]`, `cliente_id`, `email` (atualiza cadastro), `observacoes`. Retorna `{ order }` (order.numero_os).
- `clientes_lkl(nome NOT NULL, celular, email, canal_origem, tipo_pessoa NOT NULL)`.
- VPS: root@2.25.147.243, /var/www/lkl-chatbot. Deploy `rsync -az src/ai/agent.js ...`; restart `pm2 restart lkl-chatbot --update-env`; node `node -r dotenv/config -e '<js>'`.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:** todas as mudanças em `src/ai/agent.js`.

---

### Task 1: SYSTEM_PROMPT (regras) + schema da tool (`itens[]`)

**Files:**
- Modify: `src/ai/agent.js`

- [ ] **Step 1: Acrescentar regras ao SYSTEM_PROMPT**

No `SYSTEM_PROMPT`, antes do fechamento de crase do template, acrescentar (texto novo):
```
11. IDENTIFICAÇÃO DO CLIENTE E E-MAIL — siga a nota de contexto:
   - Se houver uma marcação "[CLIENTE NA BASE]" no contexto, confirme a identidade pelo nome informado ali ("Vi que você já é cliente como <NOME>. É isso mesmo? 😊"). Se o cliente confirmar, prossiga; se NEGAR (não é essa pessoa/empresa), trate como cliente novo e pergunte o nome.
   - E-mail: se a nota indicar "[CLIENTE NOVO]" ou "[CLIENTE NA BASE] ... sem e-mail", PEÇA o e-mail do cliente. Se a nota trouxer um e-mail cadastrado, CONFIRME se está correto ("Seu e-mail cadastrado é <EMAIL>, está certo? 😊") e atualize se o cliente corrigir. Nunca registre o pedido sem ter tratado o e-mail.
   - Ao chamar registrar_pedido, preencha "email" com o e-mail final e "cliente_existente_confirmado" (true se confirmou o cadastro encontrado, false se negou).
12. MÚLTIPLOS PRODUTOS — quando o cliente pedir mais de um produto, trate CADA produto como um item separado, com suas próprias dimensões, quantidade, material e arte. No resumo, liste cada item. Ao chamar registrar_pedido, preencha o array "itens" com um objeto por produto. NUNCA junte produtos diferentes num único item.
```

- [ ] **Step 2: Adicionar `itens`, `cliente_existente_confirmado` ao schema da tool**

No objeto `TOOLS[0].function.parameters.properties`, adicionar (mantendo os campos achatados existentes como fallback):
```js
          itens: {
            type: 'array',
            description: 'Um objeto por produto pedido. Use SEMPRE que houver itens; um item por produto.',
            items: {
              type: 'object',
              properties: {
                produto:    { type: 'string' },
                dimensoes:  { type: 'string' },
                quantidade: { type: 'number' },
                material:   { type: 'string' },
                tem_arte:   { type: 'boolean' },
              },
              required: ['produto', 'quantidade'],
            },
          },
          cliente_existente_confirmado: { type: 'boolean', description: 'true se o cliente confirmou ser o cadastro encontrado pelo telefone; false se negou' },
```
(O campo `email` já existe no schema — manter.)

- [ ] **Step 3: node --check**

```bash
node --check src/ai/agent.js && echo OK
```
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add src/ai/agent.js
git commit -m "feat(chatbot): regras de identificação/e-mail/multi-item no prompt + itens[] na tool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `agent.js` — pré-busca/injeção de contexto + mapeamento multi-item + resolução de cliente

**Files:**
- Modify: `src/ai/agent.js`

- [ ] **Step 1: Pré-busca do cliente e injeção de nota no prompt**

Em `processMessage`, LOGO APÓS `const systemPrompt = customPrompt || SYSTEM_PROMPT;` e ANTES de `history.push({ role: 'user', ... })`, inserir:
```js
  // Pré-busca: o telefone do contato está cadastrado? (injeta nota de contexto)
  let clienteNota = '';
  try {
    const cinfo = await db.query(
      `SELECT ct.phone FROM conversations c LEFT JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
      [conversationId]);
    const phone = cinfo.rows[0]?.phone;
    if (phone) {
      const cel = phone.replace(/\D/g, '');
      const cli = await db.query(
        `SELECT nome, email FROM clientes_lkl WHERE celular LIKE $1 LIMIT 1`, [`%${cel.slice(-9)}`]);
      if (cli.rows[0]) {
        const nm = cli.rows[0].nome, em = cli.rows[0].email;
        clienteNota = em
          ? `\n\n[CLIENTE NA BASE] Telefone cadastrado como "${nm}", e-mail "${em}". Confirme a identidade pelo nome e confirme se esse e-mail está correto (atualize se o cliente corrigir).`
          : `\n\n[CLIENTE NA BASE] Telefone cadastrado como "${nm}", sem e-mail. Confirme a identidade pelo nome e peça o e-mail.`;
      } else {
        clienteNota = `\n\n[CLIENTE NOVO] Telefone não cadastrado. Faça o cadastro mínimo: peça o nome e o e-mail do cliente.`;
      }
    }
  } catch (e) { console.warn('[CHATBOT-CLIENTE] lookup falhou:', e.message); }
  const promptFinal = systemPrompt + clienteNota;
```
E na chamada do modelo, trocar `content: systemPrompt` por `content: promptFinal`:
```js
    messages: [{ role: 'system', content: promptFinal }, ...history],
```

- [ ] **Step 2: Mapear múltiplos itens no bloco de registro**

No bloco do `registrar_pedido`, SUBSTITUIR o trecho que monta `especificacao`/`dados.itens` (hoje 1 item — linhas que começam em `const especificacao = [args.dimensoes, ...]` e o `itens: [{...}]` dentro de `dados`) por:
```js
        // Múltiplos itens (um por produto); fallback para os campos achatados
        let itensBrutos = Array.isArray(args.itens) ? args.itens.filter(it => it && it.produto) : [];
        if (!itensBrutos.length) {
          itensBrutos = [{ produto: args.produto || args.tipo_servico, dimensoes: args.dimensoes, quantidade: args.quantidade, material: args.material, tem_arte: args.tem_arte }];
        }
        const itensDados = itensBrutos.map(it => ({
          produto: (it.produto || args.tipo_servico || 'Pedido via chatbot'),
          quantidade: parseInt(it.quantidade) || 1,
          especificacao: [it.dimensoes, it.material].filter(Boolean).join(' · ') || null,
          tem_arte: !!it.tem_arte,
        }));
```
E no objeto `dados`, trocar `itens: [{...}]` por `itens: itensDados,` e adicionar `email: args.email || null,`:
```js
        const dados = {
          origin_channel: 'chatbot',
          cliente_id: clienteId,
          email: args.email || null,
          itens: itensDados,
          observacoes: [
            args.entrega === 'entrega' ? `Entrega: ${args.endereco_entrega || ''}` : 'Retirada na loja',
            args.observacoes || '',
          ].filter(Boolean).join(' | ') || null,
        };
```

- [ ] **Step 3: Resolução do cliente com confirmação + e-mail**

SUBSTITUIR o bloco de resolução de cliente (o `if (row?.phone) { ... }` que hoje só faz find-or-create) por:
```js
        let clienteId = null;
        if (row?.phone) {
          const celular = row.phone.replace(/\D/g, '');
          const existing = await db.query(
            `SELECT id, email FROM clientes_lkl WHERE celular LIKE $1 LIMIT 1`, [`%${celular.slice(-9)}`]);
          const matched = existing.rows[0];
          const confirmado = args.cliente_existente_confirmado !== false; // ausente/true => usa o existente
          if (matched && confirmado) {
            clienteId = matched.id;
            if (!matched.email && args.email) {
              await db.query('UPDATE clientes_lkl SET email = $1 WHERE id = $2', [args.email, clienteId]);
            }
          } else {
            const nomeCliente = args.nome_cliente || row.contact_name || row.phone;
            const ins = await db.query(
              `INSERT INTO clientes_lkl (nome, celular, email, canal_origem, tipo_pessoa)
               VALUES ($1, $2, $3, 'chatbot', 'PF') RETURNING id`,
              [nomeCliente, celular, args.email || null]);
            clienteId = ins.rows[0].id;
          }
        }
```
(Manter a query `const conv = ...` / `const row = ...` que vem antes — ela já existe no bloco.)

- [ ] **Step 4: node --check**

```bash
node --check src/ai/agent.js && echo OK
```
Expected: `OK`.

- [ ] **Step 5: Deploy + smoke (2 itens via criarOrder)**

```bash
rsync -az src/ai/agent.js root@2.25.147.243:/var/www/lkl-chatbot/src/ai/agent.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const os=require('./src/modules/orders/service'); const db=require('./src/db');
(async()=>{
  const cel='21999990001';
  let c=(await db.query('SELECT id FROM clientes_lkl WHERE celular=\$1',[cel])).rows[0];
  if(!c){ c=(await db.query(\\\"INSERT INTO clientes_lkl (nome,celular,email,canal_origem,tipo_pessoa) VALUES ('TESTE MULTIITEM',\$1,'t@t.com','chatbot','PF') RETURNING id\\\",[cel])).rows[0]; }
  const r=await os.criarOrder({origin_channel:'chatbot', cliente_id:c.id, email:'t@t.com', itens:[
    {produto:'CARTAZ', quantidade:1000, especificacao:'40x30 cm', tem_arte:true},
    {produto:'BANNER', quantidade:1, especificacao:'1,8 x 2 m', tem_arte:true}
  ], observacoes:'Entrega: rua x'}, null);
  if(r.erro){console.log('ERRO',r.erro);process.exit(1);}
  const its=(await db.query('SELECT produto,quantidade FROM order_items WHERE order_id=\$1 ORDER BY produto',[r.order.id])).rows;
  console.log('PEDIDO', r.order.numero_os, '| itens:', JSON.stringify(its));
  const oits=(await db.query('SELECT produto FROM orcamento_itens WHERE orcamento_id=\$1',[r.order.orcamento_id])).rows;
  console.log('orcamento_itens:', oits.length);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
\""
```
Expected: `PEDIDO <n> | itens: [{BANNER,1},{CARTAZ,1000}]` (2 itens) e `orcamento_itens: 2`. (Deixa um pedido de teste — limpo na Task 3.)

- [ ] **Step 6: Commit**

```bash
git add src/ai/agent.js
git commit -m "feat(chatbot): multi-item + identificação/confirmação de cliente + e-mail no registro

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Limpeza do teste + memória

**Files:**
- (sem código)

- [ ] **Step 1: Remover o pedido de teste multi-item (celular 21999990001)**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e \"
const db=require('./src/db');
(async()=>{
  const c=(await db.query(\\\"SELECT id FROM clientes_lkl WHERE celular='21999990001'\\\")).rows[0];
  if(!c){console.log('nada a limpar');process.exit(0);}
  const ords=(await db.query('SELECT id,orcamento_id FROM orders WHERE cliente_id=\$1',[c.id])).rows;
  for(const o of ords){ if(o.orcamento_id){await db.query('DELETE FROM orcamento_itens WHERE orcamento_id=\$1',[o.orcamento_id]);await db.query('DELETE FROM orcamentos WHERE id=\$1',[o.orcamento_id]);} await db.query('DELETE FROM order_items WHERE order_id=\$1',[o.id]); await db.query('DELETE FROM orders WHERE id=\$1',[o.id]); }
  await db.query('DELETE FROM clientes_lkl WHERE id=\$1',[c.id]);
  console.log('limpo:', ords.length, 'pedidos'); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
\""
```
Expected: "limpo: N pedidos".

- [ ] **Step 2: Atualizar memória**

Em `project_sprint_status.md`, registrar: "Chatbot — multi-item + e-mail + identificação de cliente: CONCLUÍDO — 2026-06-24. Tool registrar_pedido ganhou array itens[] + cliente_existente_confirmado; agent.js mapeia cada item (fallback p/ campos achatados). processMessage faz pré-busca do cliente por telefone e injeta nota no prompt ([CLIENTE NA BASE] nome/email ou [CLIENTE NOVO]). Prompt: confirma identidade do cliente existente, pede e-mail do novo / confirma e-mail do existente. Resolução: telefone casa + cliente_existente_confirmado!==false → usa existente (grava email se faltava); senão cadastro mínimo (nome+celular+email+tipo_pessoa PF). email passado ao criarOrder. Pendência separada: parsing de dimensões pela IA."

- [ ] **Step 3: Sem commit** (memória fora do git).

---

## Notas de verificação final

- O teste de verdade é uma conversa no WhatsApp: (a) cliente novo com 2 produtos → 2 itens no pedido + e-mail pedido/gravado; (b) cliente existente → bot confirma identidade e e-mail.
- A nota de contexto é por mensagem (query leve). Se o lookup falhar, o fluxo segue sem a nota (degrada com elegância).
