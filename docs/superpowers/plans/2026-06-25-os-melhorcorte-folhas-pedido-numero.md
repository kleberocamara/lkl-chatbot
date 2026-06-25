# Geração de OS: Melhor corte + Folhas editáveis + Nº do Pedido em telas e comunicações — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir o "Melhor corte" (resultado some em aba escondida), liberar edição de Folhas a cortar/total, e expor o número do PEDIDO nas telas de Orçamento/OS e em todas as comunicações ao cliente.

**Architecture:** Pontos 1–2 só em `public/dashboard.html`. Ponto 3 (nº do pedido) expõe `pedido_numero` nas queries de orçamento e OS (`orcamentos/service.js`, `os/service.js`), exibe nas telas (`dashboard.html`), e padroniza as mensagens ao cliente para "Pedido #N" (`orcamentos/service.js`, `orcamentos/router.js`, `os/service.js`, `services/email.js`). Notificações internas (FCM ao vendedor) ficam como estão.

**Tech Stack:** Node/Express + PostgreSQL, vanilla-JS.

**Decisões do usuário (2026-06-25):** comunicações ao cliente usam **só "Pedido #N"** (substituindo ORC#/OS#); telas internas mostram **"Pedido #N" em destaque + nº interno (orçamento/OS) ao lado**.

**Fatos verificados:**
- `orders.numero_os` é o número do PEDIDO (ex.: #26). Link: `orders.orcamento_id = orcamentos.id`. `orders` tem `created_at`.
- Melhor corte: botão em `dashboard.html:1566` (aba Produção, `#osd-producao`); `abrirMelhorCorte` (1485) escreve em `#of-vias-area`, que está dentro de `#osd-materiais` (1592, aba Materiais, oculta). `osDetalheTab(secao)` (1600) alterna abas. `escolherCorte` (1511) aplica e chama `renderViasOS`.
- Folhas: inputs `via-folhas-${idx}` (1406) e `via-total-${idx}` (1410) são `readonly` com fundo cinza; `_osMateriais[idx]` guarda `folhas_a_cortar`/`folhas_total`; `npRecalcVia` (1426) recalcula.
- Orçamento `buscarPorId` SELECT em `orcamentos/service.js:89`; `listar` SELECT em `:473`. OS `buscarPorId` SELECT em `os/service.js:126`; `listar` SELECT em `:101`.
- Dashboard: cards de orçamento em `renderOrcamentoCards` (1091); cabeçalho do detalhe da OS em `dashboard.html:1585` e título do modal em `:1594`.
- Comunicações ao CLIENTE: `orcamentos/service.js` envio WhatsApp (`:323`), confirmação WA (`:397`,`:412`,`:423`, query em `:382`); `services/email.js` assunto (`:159`, função `enviarOrcamentoCliente` em `:69`); `orcamentos/router.js` boleto/PIX (`:343`,`:350`, usa `service.buscarPorId`); `os/service.js` arte (`:36`, query em `:12`) e impressão (`:79`, query em `:47`). FCM ao vendedor (`orcamentos/service.js:49-50`, `os/service.js:74-75`) — NÃO mudam.
- Deploy backend: rsync dos arquivos + `pm2 restart lkl-chatbot --update-env`. Painel: rsync do dashboard.html. Smoke: `ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e '<js>'"`.
- Commits terminam com `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**File Structure:**
- Modify: `public/dashboard.html` (melhor corte, folhas, exibição do nº do pedido).
- Modify: `src/modules/orcamentos/service.js` (pedido_numero + msgs cliente).
- Modify: `src/modules/os/service.js` (numero_pedido + msgs cliente).
- Modify: `src/modules/orcamentos/router.js` (msgs boleto/PIX).
- Modify: `src/services/email.js` (assunto + param numeroPedido).

---

### Task 1: Melhor corte aparece na aba certa

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Trocar para a aba Materiais ao calcular**

Em `abrirMelhorCorte`, logo após `if (!area) return;` (linha ~1490) e ANTES de `area.innerHTML = '<p ...Calculando...'`, inserir:
```js
  if (typeof osDetalheTab === 'function') osDetalheTab('materiais');
```
Isso garante que a área (`#of-vias-area`, dentro de `#osd-materiais`) esteja visível quando o resultado renderizar.

- [ ] **Step 2: Voltar para Produção ao aplicar o corte**

Em `escolherCorte`, na última linha antes do fechamento `}` (após `renderViasOS();`, linha ~1522), acrescentar:
```js
  if (typeof osDetalheTab === 'function') osDetalheTab('producao');
```
(Após escolher o corte, os campos preenchidos — formato/corte — estão na ficha de Produção; volta para lá para o usuário ver o resultado.)

- [ ] **Step 3: Sanidade + commit**

```bash
cd /Users/klebercamara/LKL
grep -c "osDetalheTab('materiais')\|osDetalheTab('producao')" public/dashboard.html
git add public/dashboard.html
git commit -m "fix(ui): Melhor corte abre na aba Materiais e volta à Produção ao aplicar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected: grep ≥ 2 (além de chamadas pré-existentes).

---

### Task 2: Folhas a cortar / Folhas total editáveis

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Tornar "Folhas a cortar" editável**

Em `renderViasOS`, substituir o input `via-folhas-${idx}`:
```js
      <input id="via-folhas-${idx}" value="${m.folhas_a_cortar!=null?m.folhas_a_cortar:''}" type="number" readonly placeholder="auto" title="Calculado: ⌈qtd ÷ imagens/folha⌉ × (1+perda%)"
        style="${_viaInp};background:#f8f9fa;color:#555">
```
Por:
```js
      <input id="via-folhas-${idx}" value="${m.folhas_a_cortar!=null?m.folhas_a_cortar:''}" type="number" min="0" placeholder="auto" title="Cálculo automático — edite se necessário"
        oninput="_osMateriais[${idx}].folhas_a_cortar=this.value" style="${_viaInp}">
```

- [ ] **Step 2: Tornar "Folhas total" editável**

Substituir o input `via-total-${idx}`:
```js
      <input id="via-total-${idx}" value="${m.folhas_total!=null?m.folhas_total:''}" type="number" readonly placeholder="Total" title="Folhas a cortar × formato"
        style="${_viaInp};background:#f8f9fa;color:#555">
```
Por:
```js
      <input id="via-total-${idx}" value="${m.folhas_total!=null?m.folhas_total:''}" type="number" min="0" placeholder="Total" title="Cálculo automático — edite se necessário"
        oninput="_osMateriais[${idx}].folhas_total=this.value" style="${_viaInp}">
```
(O cálculo automático `npRecalcVia` continua preenchendo ambos ao mudar qtd/perda/formato; o operador pode sobrescrever.)

- [ ] **Step 3: Sanidade + commit**

```bash
cd /Users/klebercamara/LKL
grep -c "_osMateriais\[\${idx}\].folhas_a_cortar=this.value\|_osMateriais\[\${idx}\].folhas_total=this.value" public/dashboard.html
git add public/dashboard.html
git commit -m "feat(ui): liberar edição de Folhas a cortar/total na ficha de materiais

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected: grep = 2.

---

### Task 3: Backend expõe o número do pedido

**Files:**
- Modify: `src/modules/orcamentos/service.js`
- Modify: `src/modules/os/service.js`

- [ ] **Step 1: `pedido_numero` no `buscarPorId` do orçamento**

Em `orcamentos/service.js`, no SELECT do `buscarPorId` (linha ~89), trocar:
```js
            u.name    AS vendedor_nome
     FROM orcamentos o
```
Por:
```js
            u.name    AS vendedor_nome,
            (SELECT numero_os FROM orders WHERE orcamento_id = o.id ORDER BY created_at LIMIT 1) AS pedido_numero
     FROM orcamentos o
```

- [ ] **Step 2: `pedido_numero` no `listar` do orçamento**

No SELECT do `listar` (linha ~473), trocar:
```js
      `SELECT o.*, c.nome AS cliente_nome, u.name AS vendedor_nome,
```
Por:
```js
      `SELECT o.*, c.nome AS cliente_nome, u.name AS vendedor_nome,
              (SELECT numero_os FROM orders WHERE orcamento_id = o.id ORDER BY created_at LIMIT 1) AS pedido_numero,
```

- [ ] **Step 3: `numero_pedido` no `buscarPorId` da OS**

Em `os/service.js`, no SELECT do `buscarPorId` (linha ~126), trocar:
```js
            o.numero AS numero_orcamento,
```
Por:
```js
            o.numero AS numero_orcamento,
            (SELECT numero_os FROM orders WHERE orcamento_id = os.orcamento_id ORDER BY created_at LIMIT 1) AS numero_pedido,
```

- [ ] **Step 4: `numero_pedido` no `listar` da OS**

No SELECT do `listar` (linha ~101), trocar:
```js
      `SELECT os.id, os.numero_os, os.status, os.tipo_servico, os.tipo_produto,
```
Por:
```js
      `SELECT os.id, os.numero_os, os.status, os.tipo_servico, os.tipo_produto,
              (SELECT numero_os FROM orders WHERE orcamento_id = os.orcamento_id ORDER BY created_at LIMIT 1) AS numero_pedido,
```

- [ ] **Step 5: Sintaxe + commit**

```bash
node --check src/modules/orcamentos/service.js && node --check src/modules/os/service.js
git add src/modules/orcamentos/service.js src/modules/os/service.js
git commit -m "feat(api): expor numero do pedido em orçamentos e OS (buscarPorId + listar)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected: dois `node --check` sem saída.

---

### Task 4: Exibir "Pedido #N" nas telas (orçamento + OS)

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Cabeçalho do detalhe da OS**

Em `abrirDetalheOS`, trocar a linha do cabeçalho (≈1585):
```js
      OS #${os.numero_os||'—'} · <b>${os.tipo_servico==='offset'?'Offset':(os.tipo_servico==='comunicacao_visual'?'Com. Visual':'—')}</b> · ${escHtml(os.cliente_nome||'(multi-cliente)')} · status: ${os.status}
```
Por:
```js
      <b style="color:#1a237e">Pedido #${os.numero_pedido||'—'}</b> · OS #${os.numero_os||'—'} · <b>${os.tipo_servico==='offset'?'Offset':(os.tipo_servico==='comunicacao_visual'?'Com. Visual':'—')}</b> · ${escHtml(os.cliente_nome||'(multi-cliente)')} · status: ${os.status}
```

- [ ] **Step 2: Título do modal da OS**

Trocar (≈1594):
```js
  showModal(`Detalhe da OS #${os.numero_os||''}`, html, '860px');
```
Por:
```js
  showModal(`Pedido #${os.numero_pedido||'—'} · OS #${os.numero_os||''}`, html, '860px');
```

- [ ] **Step 3: Cards de orçamento**

Em `renderOrcamentoCards`, localizar onde o número do orçamento é exibido no card (o trecho que renderiza `#${o.numero}` no topo do card) e acrescentar o número do pedido em destaque ANTES dele. Ler o entorno:
```bash
sed -n '1091,1146p' public/dashboard.html
```
No HTML de cada card, onde aparece `#${o.numero}` (o título do card), inserir imediatamente antes um selo:
```js
<span style="background:#1a237e;color:#fff;padding:1px 7px;border-radius:8px;font-size:12px;font-weight:700;margin-right:6px">Pedido #${o.pedido_numero||'—'}</span>
```
Mantendo o `#${o.numero}` do orçamento ao lado (nº interno). Se o card usa um template literal, inserir o selo dentro dele sem quebrar as crases.

- [ ] **Step 4: Sanidade + commit**

```bash
cd /Users/klebercamara/LKL
grep -c "Pedido #\${os.numero_pedido\|Pedido #\${o.pedido_numero" public/dashboard.html
git add public/dashboard.html
git commit -m "feat(ui): exibir Pedido #N no detalhe da OS e nos cards de orçamento

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected: grep ≥ 2.

---

### Task 5: Padronizar comunicações ao cliente para "Pedido #N"

**Files:**
- Modify: `src/modules/orcamentos/service.js`
- Modify: `src/services/email.js`
- Modify: `src/modules/orcamentos/router.js`
- Modify: `src/modules/os/service.js`

- [ ] **Step 1: WhatsApp de envio do orçamento (orcamentos/service.js)**

Em `_dispararNotificacoesEnvio`, trocar (≈323):
```js
      `A Gráfica LKL preparou seu *Orçamento #${orc.numero}* no valor de *${totalFmt}*.\n\n` +
```
Por:
```js
      `A Gráfica LKL preparou seu *Pedido #${orc.pedido_numero || orc.numero}* no valor de *${totalFmt}*.\n\n` +
```

- [ ] **Step 2: Passar numeroPedido para o e-mail (orcamentos/service.js)**

Localizar a chamada `enviarOrcamentoCliente({ ... })` dentro de `_dispararNotificacoesEnvio`:
```bash
grep -n "enviarOrcamentoCliente(" src/modules/orcamentos/service.js
```
Nessa chamada, acrescentar a propriedade `numeroPedido: orc.pedido_numero` ao objeto passado (ao lado de `numero: orc.numero`).

- [ ] **Step 3: Assunto do e-mail (services/email.js)**

Na assinatura de `enviarOrcamentoCliente` (≈69), acrescentar `numeroPedido` aos parâmetros desestruturados:
```js
async function enviarOrcamentoCliente({ clienteNome, clienteEmail, numero, total, validade_dias, prazo_entrega, itens, token, pdfBuffer }) {
```
→
```js
async function enviarOrcamentoCliente({ clienteNome, clienteEmail, numero, numeroPedido, total, validade_dias, prazo_entrega, itens, token, pdfBuffer }) {
```
E trocar o assunto (≈159):
```js
    subject: `Orçamento Gráfica LKL #${numero} — aguardando sua aprovação`,
```
Por:
```js
    subject: `Pedido Gráfica LKL #${numeroPedido || numero} — aguardando sua aprovação`,
```

- [ ] **Step 4: Confirmação de aprovação via WhatsApp (orcamentos/service.js)**

No SELECT da função de confirmação (≈382), trocar:
```js
            o.numero, o.total, o.status
     FROM orcamento_confirmacao_wa oc
```
Por:
```js
            o.numero, o.total, o.status,
            (SELECT numero_os FROM orders WHERE orcamento_id = o.id ORDER BY created_at LIMIT 1) AS pedido_numero
     FROM orcamento_confirmacao_wa oc
```
Na desestruturação (≈392), trocar:
```js
  const { orcamento_id, aguardando_confirmacao, ultima_intencao, numero, total, status } = rows[0];
```
Por:
```js
  const { orcamento_id, aguardando_confirmacao, ultima_intencao, numero, total, status, pedido_numero } = rows[0];
  const refPedido = pedido_numero || numero;
```
E trocar as três mensagens:
- (≈397) `O Orçamento #${numero} já está` → `O Pedido #${refPedido} já está`
- (≈412) `deseja *${verbo}* o Orçamento *#${numero}*` → `deseja *${verbo}* o Pedido *#${refPedido}*`
- (≈423) `✅ Orçamento #${numero} *${verboPassado}*` → `✅ Pedido #${refPedido} *${verboPassado}*`

- [ ] **Step 5: Boleto/PIX ao cliente (orcamentos/router.js)**

Trocar (≈343):
```js
        msg = `Olá! Segue o boleto referente ao *ORC #${orc.numero}* — Gráfica LKL.\n\n` +
```
Por:
```js
        msg = `Olá! Segue o boleto referente ao *Pedido #${orc.pedido_numero || orc.numero}* — Gráfica LKL.\n\n` +
```
E (≈350):
```js
        msg = `Olá! Segue a cobrança PIX referente ao *ORC #${orc.numero}* — Gráfica LKL.\n\n` +
```
Por:
```js
        msg = `Olá! Segue a cobrança PIX referente ao *Pedido #${orc.pedido_numero || orc.numero}* — Gráfica LKL.\n\n` +
```

- [ ] **Step 6: Arte para aprovação (os/service.js)**

No SELECT de envio de arte (≈12), trocar:
```js
            o.numero AS numero_orcamento
     FROM ordens_servico os
```
Por:
```js
            o.numero AS numero_orcamento,
            (SELECT numero_os FROM orders WHERE orcamento_id = os.orcamento_id ORDER BY created_at LIMIT 1) AS numero_pedido
     FROM ordens_servico os
```
E trocar a mensagem (≈36):
```js
  const msg = `Olá! Segue a arte para aprovação do pedido *ORC #${os.numero_orcamento}* (OS #${os.numero_os}).\n\nResponda *APROVADO* para confirmar ou envie suas alterações.`;
```
Por:
```js
  const msg = `Olá! Segue a arte para aprovação do *Pedido #${os.numero_pedido || os.numero_orcamento}*.\n\nResponda *APROVADO* para confirmar ou envie suas alterações.`;
```

- [ ] **Step 7: Impressão liberada (os/service.js)**

No SELECT de `processarRespostaArte` (≈47), trocar:
```js
    `SELECT os.id, os.numero_os, os.orcamento_id, o.numero AS numero_orcamento
     FROM ordens_servico os
```
Por:
```js
    `SELECT os.id, os.numero_os, os.orcamento_id, o.numero AS numero_orcamento,
            (SELECT numero_os FROM orders WHERE orcamento_id = os.orcamento_id ORDER BY created_at LIMIT 1) AS numero_pedido
     FROM ordens_servico os
```
E trocar a mensagem (≈79):
```js
    return { aprovado: true, os_id: os.id, numero_os: os.numero_os, resposta: `Arte aprovada! ✅ Seu pedido OS #${os.numero_os} seguiu para impressão. Entraremos em contato quando estiver pronto. 🖨️` };
```
Por:
```js
    return { aprovado: true, os_id: os.id, numero_os: os.numero_os, resposta: `Arte aprovada! ✅ Seu *Pedido #${os.numero_pedido || os.numero_os}* seguiu para impressão. Entraremos em contato quando estiver pronto. 🖨️` };
```

- [ ] **Step 8: Sintaxe + commit**

```bash
node --check src/modules/orcamentos/service.js && node --check src/services/email.js && node --check src/modules/orcamentos/router.js && node --check src/modules/os/service.js
git add src/modules/orcamentos/service.js src/services/email.js src/modules/orcamentos/router.js src/modules/os/service.js
git commit -m "feat(comms): comunicações ao cliente referenciam Pedido #N (não ORC/OS)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
Expected: todos os `node --check` sem saída.

---

### Task 6: Deploy + smoke E2E + memória

**Files:**
- Deploy: `public/dashboard.html`, `src/modules/orcamentos/service.js`, `src/modules/os/service.js`, `src/modules/orcamentos/router.js`, `src/services/email.js`
- Modify: `/Users/klebercamara/.claude/projects/-Users-klebercamara-LKL/memory/project_sprint_status.md`

- [ ] **Step 1: Deploy**

```bash
cd /Users/klebercamara/LKL
rsync -az public/dashboard.html root@2.25.147.243:/var/www/lkl-chatbot/public/dashboard.html
rsync -az src/modules/orcamentos/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/service.js
rsync -az src/modules/orcamentos/router.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/orcamentos/router.js
rsync -az src/modules/os/service.js root@2.25.147.243:/var/www/lkl-chatbot/src/modules/os/service.js
rsync -az src/services/email.js root@2.25.147.243:/var/www/lkl-chatbot/src/services/email.js
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1 && sleep 2 && pm2 jlist | node -e 'let d=\"\";process.stdin.on(\"data\",c=>d+=c).on(\"end\",()=>{const a=JSON.parse(d);const p=a.find(x=>x.name===\"lkl-chatbot\");console.log(\"status:\",p?.pm2_env?.status)})'"
```
Expected: `status: online`.

- [ ] **Step 2: Smoke — pedido_numero presente no orçamento #31 e na OS #24**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node -r dotenv/config -e '
const orc = require(\"./src/modules/orcamentos/service\");
const os  = require(\"./src/modules/os/service\");
(async () => {
  const o = await orc.buscarPorId((await require(\"./src/db/index\").query(\"SELECT id FROM orcamentos WHERE numero=31\")).rows[0].id);
  console.log(\"ORC #31 pedido_numero =\", o.pedido_numero);
  const lista = await os.listar({ limit: 5 });
  console.log(\"OS lista numero_pedido amostra =\", (lista.data||lista.rows||lista).slice(0,3).map(x=>({os:x.numero_os, pedido:x.numero_pedido})));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
'"
```
Expected: imprime `ORC #31 pedido_numero = 26` (ou o nº real do pedido vinculado) e a amostra de OS com `pedido` preenchido.

- [ ] **Step 3: Conferência visual**

No painel:
- Detalhe da OS #24 → cabeçalho mostra **Pedido #26 · OS #24 · ...** e título do modal idem.
- Lista de Orçamentos → cada card mostra o selo **Pedido #N** ao lado do #orçamento.
- Ficha da OS (Produção) → clicar **🔍 Melhor corte** abre a lista na aba Materiais; escolher um corte volta para Produção com os campos preenchidos.
- Aba Materiais → **Folhas a cortar** e **Folhas total** agora editáveis (sem fundo cinza), com cálculo automático ainda preenchendo.
Reportar cada item.

- [ ] **Step 4: Atualizar memória**

Em `project_sprint_status.md`, registrar:
"OS geração — Melhor corte (abre aba Materiais; volta p/ Produção ao aplicar), Folhas a cortar/total editáveis, e Nº do Pedido (orders.numero_os) exposto: orcamentos/os service buscarPorId+listar trazem pedido_numero/numero_pedido (subselect orders WHERE orcamento_id); dashboard mostra 'Pedido #N' em destaque no detalhe da OS e nos cards de orçamento (nº interno ao lado). Comunicações ao cliente padronizadas para 'Pedido #N' (envio WA, e-mail assunto, confirmação WA, boleto/PIX, arte e impressão); FCM interno ao vendedor mantém ORC/OS. CONCLUÍDO 2026-06-25."

- [ ] **Step 5: Sem commit de memória** (fora do git).

---

## Notas de verificação final

- O subselect `(SELECT numero_os FROM orders WHERE orcamento_id = <alias>.id/orcamento_id ORDER BY created_at LIMIT 1)` é a única fonte do nº do pedido — usar `pedido_numero/numero_pedido || numero` como fallback em toda mensagem, para orçamentos antigos sem pedido vinculado.
- Notificações FCM internas ao vendedor (`orcamentos/service.js:49-50`, `os/service.js:74-75`, `:251-252`, `:297-298`) permanecem com ORC/OS — são internas, não cliente.
- Melhor corte: depende de `osDetalheTab` existir no escopo (existe). Se o usuário fechar a aba antes do fetch, `osDetalheTab` apenas alterna abas vazias — sem erro.
- Reverter: `git revert` do commit correspondente; nenhuma migração/dado é alterado.
