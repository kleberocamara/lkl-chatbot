# Auto-inclusão de Arte/Entrega no orçamento do chatbot — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ao montar o orçamento pelo chatbot, incluir automaticamente serviço de Arte Final (R$30 por item sem arte) e Entrega (R$15 quando entrega).

**Architecture:** Função pura `linhasServicoAuto(itens, entrega)` gera as linhas de serviço; `criarOrder` as insere no orçamento auto-criado, apenas quando `origin_channel === 'chatbot'`; o chatbot passa a informar `entrega`.

**Tech Stack:** Node.js, PostgreSQL (pg), Jest.

**Referência:** `docs/superpowers/specs/2026-07-06-servicos-auto-arte-entrega-design.md`

**Fatos do código:**
- `criarOrder(dados, userId)` (`src/modules/orders/service.js`) auto-cria o orçamento e insere cada item de produto em `orcamento_itens` num loop (~linhas 141-177), depois `UPDATE orcamentos SET total = SUM(...)` (~179-182). A var local `codigo` numera os itens; `orcamentoId` é o id do orçamento; `itens` é o array de itens normalizados (cada um com `.tem_arte`).
- Colunas de `orcamento_itens`: `orcamento_id, codigo, produto, especificacao, descricao, quantidade, valor_unitario, valor_total, tem_arte, tipo_producao, largura_cm, altura_cm, material_id, preco_origem, preco_memoria, revenda_produto_id`.
- Itens SERVICO (`tipo_producao='SERVICO'`, `tem_arte=false`) não geram OS.
- O chatbot (`src/ai/agent.js`, ~346-355) monta `dados` e chama `ordersService.criarOrder(dados, null)`; `args.entrega` (`"retirada"|"entrega"`) existe mas não é passado.

---

### Task 1: Função pura `linhasServicoAuto` (TDD)

**Files:**
- Modify: `src/modules/orders/service.js`
- Test: `tests/servicos-auto.test.js` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/servicos-auto.test.js`:

```javascript
const { linhasServicoAuto } = require('../src/modules/orders/service');

describe('linhasServicoAuto', () => {
  test('2 itens sem arte + 1 com arte → linha Arte qtd 2, R$ 60', () => {
    const itens = [{ tem_arte: false }, { tem_arte: false }, { tem_arte: true }];
    const linhas = linhasServicoAuto(itens, false);
    const arte = linhas.find(l => l.produto === 'Arte Final');
    expect(arte).toEqual({ produto: 'Arte Final', quantidade: 2, valor_unitario: 30, valor_total: 60 });
    expect(linhas.find(l => l.produto === 'Entrega')).toBeUndefined();
  });

  test('todos com arte → sem linha de arte', () => {
    const linhas = linhasServicoAuto([{ tem_arte: true }, { tem_arte: true }], false);
    expect(linhas.find(l => l.produto === 'Arte Final')).toBeUndefined();
  });

  test('entrega=true → linha Entrega R$ 15', () => {
    const linhas = linhasServicoAuto([{ tem_arte: true }], true);
    expect(linhas.find(l => l.produto === 'Entrega')).toEqual(
      { produto: 'Entrega', quantidade: 1, valor_unitario: 15, valor_total: 15 });
  });

  test('entrega=false → sem entrega', () => {
    const linhas = linhasServicoAuto([{ tem_arte: false }], false);
    expect(linhas.find(l => l.produto === 'Entrega')).toBeUndefined();
  });

  test('nenhum sem arte + retirada → array vazio', () => {
    expect(linhasServicoAuto([{ tem_arte: true }], false)).toEqual([]);
  });

  test('1 item sem arte + entrega → Arte 30 e Entrega 15', () => {
    const linhas = linhasServicoAuto([{ tem_arte: false }], true);
    expect(linhas).toEqual([
      { produto: 'Arte Final', quantidade: 1, valor_unitario: 30, valor_total: 30 },
      { produto: 'Entrega', quantidade: 1, valor_unitario: 15, valor_total: 15 },
    ]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/servicos-auto.test.js`
Expected: FAIL — `linhasServicoAuto is not a function`.

- [ ] **Step 3: Implementar**

Em `src/modules/orders/service.js`, perto do topo (após os `require`/constantes existentes), adicionar:

```javascript
const SERVICO_ARTE_VALOR = 30;
const SERVICO_ENTREGA_VALOR = 15;

// Linhas de serviço automáticas para orçamento do chatbot:
// Arte Final (R$30 por item sem arte) e Entrega (R$15 quando entrega).
function linhasServicoAuto(itens, entrega) {
  const linhas = [];
  const semArte = (itens || []).filter(it => !it.tem_arte).length;
  if (semArte > 0) {
    linhas.push({ produto: 'Arte Final', quantidade: semArte,
      valor_unitario: SERVICO_ARTE_VALOR, valor_total: SERVICO_ARTE_VALOR * semArte });
  }
  if (entrega) {
    linhas.push({ produto: 'Entrega', quantidade: 1,
      valor_unitario: SERVICO_ENTREGA_VALOR, valor_total: SERVICO_ENTREGA_VALOR });
  }
  return linhas;
}
```

Adicionar `linhasServicoAuto` ao `module.exports` do arquivo (que hoje é `module.exports = { criarOrder, buscarPorId, atualizarStatus, atualizarPedido, vincularOrcamento, listar, STATUS_VALIDOS, STATUS_VENDEDOR };` — acrescentar o nome).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest tests/servicos-auto.test.js`
Expected: PASS (6 testes).

- [ ] **Step 5: Commit**

```bash
git add src/modules/orders/service.js tests/servicos-auto.test.js
git commit -m "feat(orcamentos): linhasServicoAuto (Arte/Entrega automáticos)"
```

---

### Task 2: Inserir as linhas de serviço no `criarOrder` (gated a chatbot)

**Files:**
- Modify: `src/modules/orders/service.js` (no `criarOrder`, após o loop de itens de produto, antes do `UPDATE orcamentos SET total`)

- [ ] **Step 1: Inserir o bloco**

Em `criarOrder`, localizar o fim do loop `for (const it of itens) { ... INSERT INTO orcamento_itens ... }` que insere as linhas de produto (o loop termina antes do `await db.query(\`UPDATE orcamentos SET total = ...\`)`). Imediatamente APÓS o fechamento desse `for` e ANTES do `UPDATE orcamentos SET total`, inserir:

```javascript
    // Serviços automáticos (só chatbot): Arte Final por item sem arte + Entrega.
    if (dados.origin_channel === 'chatbot') {
      for (const s of linhasServicoAuto(itens, dados.entrega)) {
        await db.query(
          `INSERT INTO orcamento_itens (orcamento_id, codigo, produto, especificacao, descricao, quantidade, valor_unitario, valor_total, tem_arte, tipo_producao, largura_cm, altura_cm, material_id, preco_origem, preco_memoria, revenda_produto_id)
           VALUES ($1, $2, $3, NULL, $3, $4, $5, $6, false, 'SERVICO', NULL, NULL, NULL, 'auto', 'Serviço fixo', NULL)`,
          [orcamentoId, codigo++, s.produto, s.quantidade, s.valor_unitario, s.valor_total]
        );
      }
    }
```

(Usa a mesma var `codigo` e `orcamentoId` do loop anterior — ambas estão no escopo. O `UPDATE orcamentos SET total` seguinte soma as novas linhas.)

- [ ] **Step 2: Checar sintaxe**

Run: `node -e "require('./src/modules/orders/service.js'); console.log('parse OK')"`
Expected: `parse OK`.

- [ ] **Step 3: Commit**

```bash
git add src/modules/orders/service.js
git commit -m "feat(orcamentos): criarOrder insere serviços auto Arte/Entrega (chatbot)"
```

---

### Task 3: Chatbot passa o sinal de `entrega`

**Files:**
- Modify: `src/ai/agent.js` (objeto `dados` passado a `criarOrder`, ~346-355)

- [ ] **Step 1: Acrescentar `entrega` ao `dados`**

Em `src/ai/agent.js`, localizar o objeto `const dados = { origin_channel: 'chatbot', cliente_id: clienteId, email: ..., itens: itensDados, observacoes: [...] };`. Acrescentar a chave `entrega`:

```javascript
        const dados = {
          origin_channel: 'chatbot',
          cliente_id: clienteId,
          email: args.email || null,
          itens: itensDados,
          entrega: args.entrega === 'entrega',
          observacoes: [
            args.entrega === 'entrega' ? `Entrega: ${args.endereco_entrega || ''}` : 'Retirada na loja',
            args.observacoes || '',
          ].filter(Boolean).join(' | ') || null,
        };
```

(Só acrescenta a linha `entrega: args.entrega === 'entrega',` — o resto do objeto permanece igual ao atual. Confirme lendo o objeto real antes de editar; mantenha os demais campos como estão.)

- [ ] **Step 2: Checar sintaxe**

Run: `node -e "require('./src/ai/agent.js'); console.log('parse OK')"`
Expected: `parse OK`. (Se `agent.js` exigir env/config no require e falhar por isso — não por sintaxe — validar via `node --check src/ai/agent.js`.)

- [ ] **Step 3: Commit**

```bash
git add src/ai/agent.js
git commit -m "feat(chatbot): passa flag de entrega ao criar pedido (para serviço de Entrega)"
```

---

### Task 4: Deploy VPS + smoke + memória

**Contexto:** `root@2.25.147.243`, app `/var/www/lkl-chatbot`, DB `lkl_chatbot`, pm2 `lkl-chatbot`. **Confirmar com o usuário antes de deployar (produção).**

- [ ] **Step 1: Rsync**

```bash
rsync -R -av src/modules/orders/service.js src/ai/agent.js root@2.25.147.243:/var/www/lkl-chatbot/
```

- [ ] **Step 2: Restart**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```
Expected: `online`.

- [ ] **Step 3: Smoke via node no VPS (sem passar pelo fluxo de IA)**

Rodar um script pontual no VPS que chama `criarOrder` com origin_channel='chatbot', um item sem arte e entrega=true, e confere as linhas de serviço:

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e \"
const s=require('./src/modules/orders/service');
(async()=>{
  const r=await s.criarOrder({origin_channel:'chatbot', itens:[{produto:'BANNERS', quantidade:1, tem_arte:false}], entrega:true}, null);
  if(r.erro){console.error('ERRO', r.erro); process.exit(1);}
  const db=require('./src/db');
  const q=await db.query('SELECT produto, tipo_producao, quantidade, valor_total FROM orcamento_itens WHERE orcamento_id=\$1 ORDER BY codigo', [r.order.orcamento_id]);
  console.table(q.rows);
  // limpeza do pedido/orçamento de teste
  await db.query('DELETE FROM orcamento_itens WHERE orcamento_id=\$1',[r.order.orcamento_id]);
  await db.query('DELETE FROM orcamentos WHERE id=\$1',[r.order.orcamento_id]);
  await db.query('DELETE FROM order_items WHERE order_id=\$1',[r.order.id]);
  await db.query('DELETE FROM orders WHERE id=\$1',[r.order.id]);
  console.log('teste limpo'); process.exit(0);
})();
\""
```
Expected: a tabela mostra a linha `BANNERS` (produto), `Arte Final` SERVICO qtd 1 valor 30, e `Entrega` SERVICO qtd 1 valor 15; depois "teste limpo". (Se a limpeza falhar por FK — ex.: OS criada — remover primeiro os dependentes; mas SERVICO/ produto sem arte não gera OS.)

- [ ] **Step 4: Memória**

Anexar entrada em `project_sprint_status.md` (memory/, fora do repo) resumindo o sprint (Arte R$30/item sem arte + Entrega R$15, só chatbot, gated origin_channel, função pura linhasServicoAuto, sem migration). Registrar que o sub-projeto de precificação interna de banner/lona ficou para design dedicado (regras_preco vazia; larguras 1,60/2,20/3,20 embutidas nos nomes dos materiais; criarOrder não chama o motor interno).

- [ ] **Step 5: Commit final (se necessário)**

```bash
git add -A && git commit -m "chore(orcamentos): serviços auto Arte/Entrega deployado e validado" || echo "nada a commitar"
```

---

## Self-Review (checklist do autor)

**Spec coverage:**
- Comp.1 `linhasServicoAuto` → Task 1 ✅
- Comp.2 inserção gated a chatbot no criarOrder → Task 2 ✅
- Comp.3 chatbot passa `entrega` → Task 3 ✅
- Testes unit + smoke → Task 1 + Task 4 ✅

**Consistência de nomes:** `linhasServicoAuto`, `SERVICO_ARTE_VALOR`, `SERVICO_ENTREGA_VALOR`, `dados.entrega`, `dados.origin_channel` — usados igual em todas as tasks. ✅

**Sem placeholders:** todo passo traz o código real. ✅
