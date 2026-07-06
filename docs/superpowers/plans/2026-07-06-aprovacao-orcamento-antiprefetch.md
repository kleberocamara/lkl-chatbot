# Aprovação de orçamento à prova de prefetch + itens detalhados — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedir que preview/prefetch aprove orçamentos e dar ao cliente uma página de confirmação com itens detalhados; o link vira token-only, GET só renderiza, POST executa.

**Architecture:** O link enviado passa a apontar para `/resposta?token=xxx` (sem `&r=`). O `GET` vira somente-leitura (página com itens + botões Aprovar/Reprovar). O `POST /resposta` executa a ação via o `processarRespostaToken` existente. Crawlers fazem GET, nunca POST → não conseguem mudar estado.

**Tech Stack:** Node.js, Express (já com `express.urlencoded` global em src/app.js:37), PostgreSQL (pg), Jest.

**Referência:** `docs/superpowers/specs/2026-07-06-aprovacao-orcamento-antiprefetch-design.md`

**Fatos do código:**
- Router público montado em `/api/v2/orcamentos`; a rota é `router.get('/resposta', ...)` em `src/modules/orcamentos/router.js:19`.
- `processarRespostaToken(token, resposta)` (service.js:359) valida status `enviado` e chama `mudarStatus`; permanece inalterado (usado pelo POST).
- `buscarPorId(id)` (service.js) retorna `{...orcamento, itens, ...}`; itens = colunas de `orcamento_itens` (`descricao`, `produto`, `quantidade`, `valor_unitario`, `valor_total`, `codigo`).
- Sites que geram o link: `service.js:305-306` (WhatsApp), `email.js:71-72` (e-mail — já detalha itens via `itensHtml`), `pdf.js:180-181` (PDF).

---

### Task 1: Service — `buscarResumoPorToken(token)` (TDD)

**Files:**
- Modify: `src/modules/orcamentos/service.js`
- Test: `tests/orcamento-resumo-token.test.js` (criar)

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/orcamento-resumo-token.test.js`:

```javascript
const service = require('../src/modules/orcamentos/service');
const db = require('../src/db');

jest.mock('../src/db', () => ({ query: jest.fn() }));

describe('buscarResumoPorToken', () => {
  afterEach(() => jest.clearAllMocks());

  test('token inexistente → null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // SELECT id por token
    const r = await service.buscarResumoPorToken('tok-x');
    expect(r).toBeNull();
  });

  test('token válido → retorna orçamento com itens', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'orc-1' }] })         // SELECT id por token
      .mockResolvedValueOnce({ rows: [{ id: 'orc-1', numero: 5, status: 'enviado' }] }) // buscarPorId: orcamento
      .mockResolvedValueOnce({ rows: [{ descricao: 'BANNER', quantidade: 2, valor_total: 120 }] }) // itens
      .mockResolvedValueOnce({ rows: [] })                        // ordens_servico
      .mockResolvedValueOnce({ rows: [] });                       // boletos_parcelas
    const r = await service.buscarResumoPorToken('tok-1');
    expect(r).not.toBeNull();
    expect(r.numero).toBe(5);
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0].descricao).toBe('BANNER');
  });
});
```

> Nota: o segundo teste depende da sequência de queries de `buscarPorId`. Se `buscarPorId` fizer um número diferente de queries, ajuste a quantidade de `mockResolvedValueOnce` para casar exatamente (leia `buscarPorId` antes de rodar). O objetivo do teste é: resolve id por token e delega a `buscarPorId`.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/orcamento-resumo-token.test.js`
Expected: FAIL — `service.buscarResumoPorToken is not a function`.

- [ ] **Step 3: Implementar**

Em `src/modules/orcamentos/service.js`, adicionar a função (perto de `processarRespostaToken`):

```javascript
async function buscarResumoPorToken(token) {
  const { rows } = await db.query(
    'SELECT id FROM orcamentos WHERE token_aprovacao=$1', [token]
  );
  if (!rows[0]) return null;
  return buscarPorId(rows[0].id);
}
```

Adicionar `buscarResumoPorToken` ao `module.exports` (junto de `processarRespostaToken`).

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest tests/orcamento-resumo-token.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/orcamentos/service.js tests/orcamento-resumo-token.test.js
git commit -m "feat(orcamentos): buscarResumoPorToken (orçamento+itens por token de aprovação)"
```

---

### Task 2: Router — GET vira página de confirmação (read-only) + POST executa

**Files:**
- Modify: `src/modules/orcamentos/router.js:19-51` (bloco da rota `/resposta`)

- [ ] **Step 1: Substituir o handler GET e adicionar o POST**

Em `src/modules/orcamentos/router.js`, substituir TODO o bloco atual `router.get('/resposta', ...)` (linhas ~18-51) por:

```javascript
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function _escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _fmtBRL(v) {
  return `R$ ${parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
}
function _paginaSimples(titulo, cor) {
  return `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="font-family:Arial;text-align:center;padding:60px;background:#f5f5f5">
      <div style="max-width:480px;margin:0 auto;background:white;border-radius:12px;padding:40px;box-shadow:0 2px 12px rgba(0,0,0,.1)">
        <h2 style="color:${cor || '#1a237e'}">${titulo}</h2>
        <p style="color:#555">Gráfica LKL — obrigado!</p>
      </div>
    </body></html>`;
}

// GET /resposta?token=xxx — PÚBLICA, SOMENTE LEITURA: mostra a página de confirmação.
// Ignora qualquer &r= (links legados) — nunca muta estado no GET.
router.get('/resposta', async (req, res) => {
  const { token } = req.query;
  if (!token || !UUID_RE.test(token)) return res.status(400).send('Link inválido.');

  let orc;
  try {
    orc = await service.buscarResumoPorToken(token);
  } catch (e) {
    console.error('[ORC-RESPOSTA-GET]', e.message);
    return res.status(500).send(_paginaSimples('⚠️ Não foi possível carregar o orçamento agora.', '#c62828'));
  }
  if (!orc) return res.send(_paginaSimples('⚠️ Link inválido ou expirado.', '#c62828'));

  if (orc.status !== 'enviado') {
    return res.send(_paginaSimples(`Este orçamento já foi <b>${_escHtml(orc.status)}</b>.`, '#1a237e'));
  }

  const refPedido = orc.pedido_numero || orc.numero;
  const itensRows = (orc.itens || []).map(it => `
    <tr>
      <td style="padding:8px 6px;border-bottom:1px solid #eee">${_escHtml(it.descricao || it.produto || 'item')}</td>
      <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:center">${_escHtml(it.quantidade)}</td>
      <td style="padding:8px 6px;border-bottom:1px solid #eee;text-align:right">${_fmtBRL(it.valor_total)}</td>
    </tr>`).join('');

  res.send(`<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="font-family:Arial;background:#f5f5f5;margin:0;padding:24px">
      <div style="max-width:520px;margin:0 auto;background:white;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.1)">
        <h2 style="color:#1a237e;margin:0 0 4px">Gráfica LKL</h2>
        <p style="color:#555;margin:0 0 20px">Pedido #${_escHtml(refPedido)} — total <b>${_fmtBRL(orc.total)}</b></p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead><tr>
            <th style="text-align:left;padding:6px;border-bottom:2px solid #eee">Item</th>
            <th style="text-align:center;padding:6px;border-bottom:2px solid #eee">Qtd</th>
            <th style="text-align:right;padding:6px;border-bottom:2px solid #eee">Valor</th>
          </tr></thead>
          <tbody>${itensRows}</tbody>
        </table>
        <form method="POST" action="/api/v2/orcamentos/resposta" style="margin-top:24px;display:flex;gap:12px">
          <input type="hidden" name="token" value="${_escHtml(token)}">
          <button type="submit" name="r" value="aprovado" style="flex:1;background:#2e7d32;color:white;border:none;padding:14px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer">✅ Aprovar</button>
          <button type="submit" name="r" value="reprovado" style="flex:1;background:#c62828;color:white;border:none;padding:14px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer">❌ Reprovar</button>
        </form>
      </div>
    </body></html>`);
});

// POST /resposta — PÚBLICA: executa a aprovação/reprovação (só via ação deliberada).
router.post('/resposta', async (req, res) => {
  const { token, r } = req.body || {};
  if (!token || !UUID_RE.test(token) || !['aprovado', 'reprovado'].includes(r)) {
    return res.status(400).send('Requisição inválida.');
  }
  let result;
  try {
    result = await service.processarRespostaToken(token, r);
  } catch (e) {
    console.error('[ORC-RESPOSTA-POST]', e.message);
    return res.status(500).send(_paginaSimples('⚠️ Não foi possível processar sua resposta agora.', '#c62828'));
  }
  if (result.erro) return res.send(_paginaSimples(`⚠️ ${_escHtml(result.erro[0])}`, '#c62828'));

  const msg = r === 'aprovado'
    ? '✅ Orçamento aprovado! Nossa equipe entrará em contato em breve.'
    : '❌ Orçamento reprovado. Entre em contato conosco se desejar renegociar.';
  res.send(_paginaSimples(msg, r === 'aprovado' ? '#2e7d32' : '#c62828'));
});
```

> Se `UUID_RE` já existir em outro escopo do arquivo, evite redeclará-lo — reuse o existente. (Hoje ele é declarado dentro do handler; ao mover para o escopo do módulo, remova a declaração antiga de dentro do handler.)

- [ ] **Step 2: Checar sintaxe**

Run: `node -e "require('./src/modules/orcamentos/router.js'); console.log('parse OK')"`
Expected: `parse OK`.

- [ ] **Step 3: Commit**

```bash
git add src/modules/orcamentos/router.js
git commit -m "fix(orcamentos): link de aprovação vira página de confirmação (GET só-leitura, POST executa)"
```

---

### Task 3: Links token-only nos 3 sites + itens no texto do WhatsApp

**Files:**
- Modify: `src/modules/orcamentos/service.js` (`_dispararNotificacoesEnvio`, ~305-327)
- Modify: `src/services/email.js` (~71-72)
- Modify: `src/services/pdf.js` (~180-181)

- [ ] **Step 1: WhatsApp — link token-only + lista de itens**

Em `src/modules/orcamentos/service.js`, dentro de `_dispararNotificacoesEnvio`, substituir as duas URLs (linhas ~305-306):

```javascript
  const urlAprovar  = `${baseUrl}/api/v2/orcamentos/resposta?token=${orc.token_aprovacao}&r=aprovado`;
  const urlReprovar = `${baseUrl}/api/v2/orcamentos/resposta?token=${orc.token_aprovacao}&r=reprovado`;
```

por:

```javascript
  const urlConfirmar = `${baseUrl}/api/v2/orcamentos/resposta?token=${orc.token_aprovacao}`;
```

Depois, montar a lista de itens e incluí-la na mensagem. Substituir o bloco `const msg = ...` (WhatsApp, ~320-327) por:

```javascript
    const itensLista = (orc.itens || [])
      .map(it => `• ${it.descricao || it.produto || 'item'} — ${it.quantidade}un — R$ ${parseFloat(it.valor_total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`)
      .join('\n');
    const msg =
      `Olá, ${orc.cliente_nome || 'cliente'}! 🖨\n\n` +
      `A Gráfica LKL preparou seu *Pedido #${orc.pedido_numero || orc.numero}* no valor de *${totalFmt}*.\n\n` +
      (itensLista ? `*Itens:*\n${itensLista}\n\n` : '') +
      `Prazo de entrega: ${orc.prazo_entrega || 'a combinar'}\n` +
      `Validade: ${orc.validade_dias || 30} dias\n\n` +
      `Para aprovar, responda *SIM*.\n` +
      `Para reprovar, responda *NÃO*.\n\n` +
      `Ou clique para ver e responder ao orçamento: ${urlConfirmar}`;
```

> Verificar que `orc.itens` está disponível em `_dispararNotificacoesEnvio` (o `orc` vem de `buscarPorId`, que inclui `itens`). Se algum chamador passar um `orc` sem `itens`, o `(orc.itens || [])` já protege (omite a seção).

- [ ] **Step 2: E-mail — links token-only**

Em `src/services/email.js` (~71-72), substituir:

```javascript
  const urlAprovar  = `${baseUrl}/api/v2/orcamentos/resposta?token=${token}&r=aprovado`;
  const urlReprovar = `${baseUrl}/api/v2/orcamentos/resposta?token=${token}&r=reprovado`;
```

por:

```javascript
  const urlConfirmar = `${baseUrl}/api/v2/orcamentos/resposta?token=${token}`;
  const urlAprovar  = urlConfirmar;
  const urlReprovar = urlConfirmar;
```

(Mantém as variáveis `urlAprovar`/`urlReprovar` usadas no HTML do e-mail, mas ambas agora levam à página de confirmação — nenhum link aprova direto. O e-mail já detalha os itens via `itensHtml`, sem mudança.)

- [ ] **Step 3: PDF — links token-only**

Em `src/services/pdf.js` (~180-181), substituir:

```javascript
      const urlAprovar  = `${baseUrl}/api/v2/orcamentos/resposta?token=${orc.token_aprovacao}&r=aprovado`;
      const urlReprovar = `${baseUrl}/api/v2/orcamentos/resposta?token=${orc.token_aprovacao}&r=reprovado`;
```

por:

```javascript
      const urlConfirmar = `${baseUrl}/api/v2/orcamentos/resposta?token=${orc.token_aprovacao}`;
      const urlAprovar  = urlConfirmar;
      const urlReprovar = urlConfirmar;
```

(Mantém as variáveis usadas no rodapé do PDF; ambas apontam para a página de confirmação.)

- [ ] **Step 4: Checar sintaxe**

Run:
```bash
node -e "require('./src/modules/orcamentos/service.js'); require('./src/services/email.js'); require('./src/services/pdf.js'); console.log('parse OK')"
```
Expected: `parse OK`.

- [ ] **Step 5: Commit**

```bash
git add src/modules/orcamentos/service.js src/services/email.js src/services/pdf.js
git commit -m "fix(orcamentos): links de aprovação token-only + itens no texto do WhatsApp"
```

---

### Task 4: Deploy VPS + smoke + memória

**Contexto:** `root@2.25.147.243`, app `/var/www/lkl-chatbot`, DB `lkl_chatbot`, pm2 `lkl-chatbot`. **Confirmar com o usuário antes de deployar (produção).**

- [ ] **Step 1: Rsync dos arquivos alterados**

```bash
rsync -R -av \
  src/modules/orcamentos/service.js \
  src/modules/orcamentos/router.js \
  src/services/email.js \
  src/services/pdf.js \
  root@2.25.147.243:/var/www/lkl-chatbot/
```

- [ ] **Step 2: Restart**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```
Expected: `online`.

- [ ] **Step 3: Smoke — GET não muta**

Escolher um orçamento de teste em status `enviado` e seu `token_aprovacao` (via psql). Antes: conferir status. Rodar:
```bash
curl -s "https://chatbot.klebercamaraconsultoria.cloud/api/v2/orcamentos/resposta?token=<TOKEN>" | grep -o "Aprovar\|Reprovar" | head
```
Expected: aparecem os botões. Conferir no banco que o status **continua `enviado`** (GET não mutou).

- [ ] **Step 4: Smoke — GET legado com &r= também não muta**

```bash
curl -s "https://chatbot.klebercamaraconsultoria.cloud/api/v2/orcamentos/resposta?token=<TOKEN>&r=aprovado" >/dev/null
```
Conferir no banco: status **continua `enviado`** (o `&r=` é ignorado no GET).

- [ ] **Step 5: Smoke — POST muta**

```bash
curl -s -X POST "https://chatbot.klebercamaraconsultoria.cloud/api/v2/orcamentos/resposta" \
  -d "token=<TOKEN>&r=aprovado" | grep -o "aprovado"
```
Conferir no banco: status virou `aprovado`. **Restaurar** o orçamento de teste para `enviado` depois (UPDATE orcamentos + orders como no restore de 27/32).

- [ ] **Step 6: Memória**

Criar `reference_aprovacao_orcamento_prefetch.md` (fora do repo, em memory/): o link de aprovação era GET-com-efeito-colateral e o preview do WhatsApp/scanner de e-mail pré-buscava → auto-aprovava (orç 32/38 = pedidos 27/32). Fix: link token-only, GET só-leitura (página com itens+botões), POST executa; `&r=` legado ignorado no GET. Atualizar MEMORY.md com o pointer. Anexar entrada em project_sprint_status.md.

- [ ] **Step 7: Commit final (se houver ajuste do smoke)**

```bash
git add -A && git commit -m "chore(orcamentos): fix anti-prefetch deployado e validado no VPS" || echo "nada a commitar"
```

---

## Self-Review (checklist do autor)

**Spec coverage:**
- Comp.1 buscarResumoPorToken → Task 1 ✅
- Comp.2 GET página read-only → Task 2 ✅
- Comp.3 POST executa → Task 2 ✅
- Comp.4 links token-only (3 sites) → Task 3 ✅
- Comp.5 itens no WhatsApp → Task 3 ✅ (e-mail já detalha itens; PDF mantém)
- Testes unit + smoke → Task 1 + Task 4 ✅

**Consistência de nomes:** `buscarResumoPorToken`, `processarRespostaToken`, `urlConfirmar`, `_escHtml`, `_fmtBRL`, `_paginaSimples` — usados igual em todas as tasks. ✅

**Sem placeholders:** todo passo traz o código real. ✅
