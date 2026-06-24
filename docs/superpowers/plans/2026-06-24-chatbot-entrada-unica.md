# Chatbot como canal da entrada única — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o chatbot registrar o pedido pela mesma porta do painel (`criarOrder`, canal `chatbot`), corrigindo o bug de cliente novo e eliminando o orçamento "rascunho" solto.

**Architecture:** Substituir, em `src/ai/agent.js`, o bloco que gera `pedido_seq` e cria orçamento rascunho por uma chamada a `ordersService.criarOrder({origin_channel:'chatbot', ...})`. O pedido então segue o fluxo único (Pedidos → auto-orçamento `em_orcamento`). Sem migration.

**Tech Stack:** Node.js. Sem postgres local — `node --check` + smoke E2E no VPS.

**Convenções/Fatos verificados:**
- `src/modules/orders/service.js` → `criarOrder(dados, userId)` retorna `{ order }`; `order` tem `numero_os` (SERIAL), `id`, `orcamento_id`, `status` (vira `em_orcamento`). Cria `orders` + `order_items` + `orcamentos`('em_orcamento') + `orcamento_itens`.
- `dados`: `origin_channel` (CANAIS_VALIDOS inclui `'chatbot'`), `cliente_id`, `itens:[{produto,quantidade,especificacao,tem_arte}]`, `observacoes`, `material`, `prazo`, `celular`, `email`.
- `clientes_lkl.tipo_pessoa` NOT NULL sem default → INSERT do chatbot precisa de `tipo_pessoa`.
- `src/ai/agent.js`: bloco a substituir = linhas ~150–235 (gera `pedido_seq`, atualiza `conversations`, cria orçamento `[ORC-V2]`). `agent.js` já faz `const db = require('../db')`.
- VPS: root@2.25.147.243, /var/www/lkl-chatbot, DB `lkl_chatbot`. Deploy rsync; restart `pm2 restart lkl-chatbot --update-env`; node `node -r dotenv/config -e '<js>'`.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:**
- Modify: `src/ai/agent.js` — refactor do bloco de registro de pedido.

---

### Task 1: Refatorar o registro de pedido do chatbot para `criarOrder`

**Files:**
- Modify: `src/ai/agent.js`

- [ ] **Step 1: Adicionar o import do orders service**

No topo de `src/ai/agent.js`, junto aos outros `require`, adicionar:
```js
const ordersService = require('../modules/orders/service');
```

- [ ] **Step 2: Substituir o bloco de registro (linhas ~150–235)**

Localizar o trecho que começa em `// Gera número do pedido` (`const seqResult = await db.query("SELECT nextval('pedido_seq')...`) e vai até a linha `console.log(\`=== PEDIDO #${pedidoNumero} REGISTRADO ===\`, ...)` (imediatamente antes do `} catch (e) {` do bloco externo). Substituir TODO esse trecho por:

```js
        // Resolve o cliente (find/create por celular) — entrada única no Pedido
        const conv = await db.query(
          `SELECT c.contact_id, ct.phone, ct.name AS contact_name
           FROM conversations c LEFT JOIN contacts ct ON ct.id = c.contact_id
           WHERE c.id = $1`, [conversationId]);
        const row = conv.rows[0];
        let clienteId = null;
        if (row?.phone) {
          const celular = row.phone.replace(/\D/g, '');
          const existing = await db.query(
            `SELECT id FROM clientes_lkl WHERE celular LIKE $1 LIMIT 1`, [`%${celular.slice(-9)}`]);
          if (existing.rows.length > 0) {
            clienteId = existing.rows[0].id;
          } else {
            const nomeCliente = args.nome_cliente || row.contact_name || row.phone;
            const ins = await db.query(
              `INSERT INTO clientes_lkl (nome, celular, canal_origem, tipo_pessoa)
               VALUES ($1, $2, 'chatbot', 'PF') RETURNING id`,
              [nomeCliente, celular]);
            clienteId = ins.rows[0].id;
          }
        }

        // Cria o PEDIDO pela mesma porta do painel (canal chatbot) → auto-orçamento em_orcamento
        const especificacao = [args.dimensoes, args.material].filter(Boolean).join(' · ') || null;
        const dados = {
          origin_channel: 'chatbot',
          cliente_id: clienteId,
          itens: [{
            produto: args.produto || args.tipo_servico || 'Pedido via chatbot',
            quantidade: parseInt(args.quantidade) || 1,
            especificacao,
            tem_arte: !!args.tem_arte,
          }],
          observacoes: [
            args.entrega === 'entrega' ? `Entrega: ${args.endereco_entrega || ''}` : 'Retirada na loja',
            args.observacoes || '',
          ].filter(Boolean).join(' | ') || null,
        };

        const result = await ordersService.criarOrder(dados, null);
        if (result?.erro) {
          console.error('[CHATBOT-PEDIDO] Falha ao criar pedido:', result.erro.join('; '));
          cleanResponse = 'Recebi seus dados, mas tive um problema ao registrar o pedido agora. Nossa equipe da Gráfica LKL foi avisada e vai concluir o registro. 😊';
          history.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Falha ao registrar pedido (equipe avisada).' });
        } else {
          const pedidoNumero = result.order.numero_os;
          orderDetails.pedido_numero = pedidoNumero;

          const msgTemplate = args.mensagem_encerramento ||
            'Pedido registrado com sucesso! Seu número de acompanhamento é {NUMERO_PEDIDO}. Nossa equipe da Gráfica LKL entrará em contato em breve com o orçamento. Obrigado! 😊';
          cleanResponse = msgTemplate.replace('{NUMERO_PEDIDO}', `*#${pedidoNumero}*`);
          if (!cleanResponse.includes(`#${pedidoNumero}`)) {
            cleanResponse += `\n\n📋 *Número do seu pedido: #${pedidoNumero}*\nGuarde este número para consultar o status com nossa equipe!`;
          }

          await db.query(
            `UPDATE conversations
             SET needs_details = $1, service_type = $2, status = 'aguardando_humano',
                 pedido_numero = $3, pedido_status = 'em_orcamento', updated_at = NOW()
             WHERE id = $4`,
            [JSON.stringify(orderDetails), orderDetails.tipo_servico, pedidoNumero, conversationId]);

          if (orderDetails.nome_cliente) {
            await db.query(
              "UPDATE contacts SET name = $1 WHERE id = (SELECT contact_id FROM conversations WHERE id = $2)",
              [orderDetails.nome_cliente, conversationId]);
          }

          history.push({ role: 'tool', tool_call_id: toolCall.id, content: `Pedido #${pedidoNumero} registrado.` });
          console.log(`=== PEDIDO #${pedidoNumero} (chatbot) REGISTRADO ===`, JSON.stringify(orderDetails));
        }
```
NOTA: garantir que o `args`, `orderDetails`, `cleanResponse`, `history`, `toolCall`, `conversationId` continuam no escopo (eram usados no bloco antigo). O bloco antigo de "Salva nome real do cliente" foi incorporado acima (dentro do else). NÃO deixar referências a `pedidoNumero`/`seqResult`/`orcIns` fora deste novo bloco.

- [ ] **Step 3: node --check**

```bash
node --check src/ai/agent.js && echo OK
```
Expected: `OK`.

- [ ] **Step 4: Deploy + smoke (cria pedido via canal chatbot)**

```bash
rsync -az src/ai/agent.js root@2.25.147.243:/var/www/lkl-chatbot/src/ai/agent.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && node -r dotenv/config -e \"
const os=require('./src/modules/orders/service'); const db=require('./src/db');
(async()=>{
  // cliente novo: testa o INSERT com tipo_pessoa
  const cel='21999990000';
  let c=(await db.query('SELECT id FROM clientes_lkl WHERE celular=\$1',[cel])).rows[0];
  if(!c){ c=(await db.query(\\\"INSERT INTO clientes_lkl (nome,celular,canal_origem,tipo_pessoa) VALUES ('CLIENTE TESTE CHATBOT',\$1,'chatbot','PF') RETURNING id\\\",[cel])).rows[0]; }
  const r=await os.criarOrder({origin_channel:'chatbot', cliente_id:c.id, itens:[{produto:'ADESIVO VINILICO', quantidade:1, especificacao:'2,09 x 1,18 m · vinil', tem_arte:false}], observacoes:'Retirada na loja'}, null);
  if(r.erro){console.log('ERRO',r.erro);process.exit(1);}
  console.log('PEDIDO numero_os=', r.order.numero_os, '| status=', r.order.status, '| canal=', r.order.origin_channel, '| orcamento_id=', r.order.orcamento_id);
  const orc=(await db.query('SELECT numero,status,canal FROM orcamentos WHERE id=\$1',[r.order.orcamento_id])).rows[0];
  console.log('ORCAMENTO', JSON.stringify(orc));
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
\""
```
Expected: imprime `PEDIDO numero_os=<n> | status= em_orcamento | canal= chatbot | orcamento_id=<uuid>` e `ORCAMENTO {numero, status:"em_orcamento", ...}`. Confirma que o cliente novo entrou sem erro de `tipo_pessoa` e que o fluxo único funciona.

- [ ] **Step 5: Commit**

```bash
git add src/ai/agent.js
git commit -m "fix(chatbot): registrar pedido via criarOrder (canal chatbot) + tipo_pessoa; remove orçamento rascunho

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Limpar o orçamento órfão legado + memória

**Files:**
- (sem arquivos de código)

- [ ] **Step 1: Remover o orçamento rascunho órfão #26 (CAIO)**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e \"
const db=require('./src/db');
(async()=>{
  const r=await db.query(\\\"SELECT id,numero FROM orcamentos WHERE status='rascunho' AND canal='chatbot'\\\");
  for(const o of r.rows){
    await db.query('DELETE FROM orcamento_itens WHERE orcamento_id=\$1',[o.id]);
    await db.query('DELETE FROM orcamentos WHERE id=\$1',[o.id]);
    console.log('removido orçamento rascunho #', o.numero);
  }
  console.log('total removidos:', r.rows.length);
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
\""
```
Expected: remove o(s) orçamento(s) rascunho de chatbot (ex.: "#26"); "total removidos: N".

- [ ] **Step 2: Limpar a máquina de teste e pedido de teste do smoke (opcional)**

Se o smoke da Task 1 criou um pedido de teste (CLIENTE TESTE CHATBOT), removê-lo para não poluir o painel:
```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e \"
const db=require('./src/db');
(async()=>{
  const c=(await db.query(\\\"SELECT id FROM clientes_lkl WHERE celular='21999990000'\\\")).rows[0];
  if(c){
    const ords=(await db.query('SELECT id, orcamento_id FROM orders WHERE cliente_id=\$1',[c.id])).rows;
    for(const o of ords){
      if(o.orcamento_id){ await db.query('DELETE FROM orcamento_itens WHERE orcamento_id=\$1',[o.orcamento_id]); await db.query('DELETE FROM orcamentos WHERE id=\$1',[o.orcamento_id]); }
      await db.query('DELETE FROM order_items WHERE order_id=\$1',[o.id]);
      await db.query('DELETE FROM orders WHERE id=\$1',[o.id]);
    }
    await db.query('DELETE FROM clientes_lkl WHERE id=\$1',[c.id]);
    console.log('limpeza do teste ok:', ords.length, 'pedidos');
  } else { console.log('nada a limpar'); }
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});
\""
```
Expected: remove o cliente/pedido/orçamento de teste.

- [ ] **Step 3: Atualizar memória do projeto**

Em `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`, registrar: "Chatbot — entrada única no Pedido: CONCLUÍDO — 2026-06-24. src/ai/agent.js passou a registrar o pedido via ordersService.criarOrder({origin_channel:'chatbot', cliente_id, itens, observacoes}) — mesma porta do painel; o pedido cai na aba Pedidos (Canal=chatbot) e auto-cria orçamento 'em_orcamento'. Corrigido bug: INSERT em clientes_lkl agora inclui tipo_pessoa='PF' (era NOT NULL sem default e quebrava clientes novos — pedido #1020 se perdeu assim). Removido o INSERT de orçamento 'rascunho' solto (legado) e o uso de pedido_seq. Número informado ao cliente = order.numero_os. Órfão #26 (CAIO rascunho) removido. Pendência separada: qualidade do parsing de dimensões pela IA (ex.: '118,5 m')."

- [ ] **Step 4: Sem commit** (memória fora do git).

---

## Notas de verificação final

- Confirmar no painel (após a correção): um pedido de teste real pelo WhatsApp aparece na aba Pedidos com Canal=chatbot e na aba Orçamentos como "Em orçamento".
- A robustez: se `criarOrder` falhar, o bot NÃO afirma "registrado com sucesso" (mensagem de fallback + log).
