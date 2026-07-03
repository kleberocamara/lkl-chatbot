# Identificação de cliente no chatbot + limpeza de duplicados — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar a identificação de cliente do chatbot robusta (busca por celular+telefone normalizados, dedup, lista quando há vários, resolução correta) e limpar duplicados idênticos na base com um script seguro.

**Architecture:** Funções puras em `src/ai/agent.js` (`normalizarTelefone`, `normalizarNome`, `dedupClientes`) usadas pela busca revisada `buscarClientesPorTelefone`, pela nota de contexto injetada no prompt (0/1/N matches) e pela resolução no `registrar_pedido`. Um script `scripts/dedup-clientes.js` reusa essas funções para fazer merge conservador dos duplicados (dry-run → apply), repontando as 4 tabelas que referenciam `clientes_lkl`.

**Tech Stack:** Node.js + PostgreSQL (pg), OpenAI, Jest.

**Design de referência:** `docs/superpowers/specs/2026-07-03-identificacao-cliente-chatbot-design.md`

**Convenções:** sem Postgres local (funções puras testadas com Jest; integração via smoke no VPS). Sem migration (nenhuma mudança de schema). DB de produção: **lkl_chatbot**. Deploy: rsync + `pm2 restart lkl-chatbot --update-env` no VPS `2.25.147.243` (`/var/www/lkl-chatbot`). `clientes_lkl` é referenciado por `orders`, `orcamentos`, `ordens_servico`, `revenda_compras` (`cliente_id`).

---

## File Structure

- **Modify:** `src/ai/agent.js` — funções puras + `buscarClientesPorTelefone` + nota de contexto (0/1/N) + regra de prompt + resolução no `registrar_pedido` + exports.
- **Create:** `tests/identificacao-cliente.test.js` — testes das funções puras.
- **Create:** `scripts/dedup-clientes.js` — merge conservador (dry-run/apply).

---

## Task 1: Funções puras de normalização e dedup

**Files:**
- Modify: `src/ai/agent.js` (adicionar funções + export)
- Test: `tests/identificacao-cliente.test.js`

- [ ] **Step 1: Escrever os testes (falham)**

Create `tests/identificacao-cliente.test.js`:
```js
const { normalizarTelefone, normalizarNome, dedupClientes } = require('../src/ai/agent');

describe('normalizarTelefone', () => {
  test('remove 55 e formatação, últimos 9', () => {
    expect(normalizarTelefone('5521988596449')).toBe('988596449');
    expect(normalizarTelefone('21988596449')).toBe('988596449');
    expect(normalizarTelefone('(21) 98859-6449')).toBe('988596449');
  });
  test('vazio/nulo', () => {
    expect(normalizarTelefone('')).toBe('');
    expect(normalizarTelefone(null)).toBe('');
  });
});

describe('normalizarNome', () => {
  test('uppercase, sem acento, espaços', () => {
    expect(normalizarNome('Kleber de Oliveira Câmara')).toBe('KLEBER DE OLIVEIRA CAMARA');
    expect(normalizarNome('  a   nossa  ')).toBe('A NOSSA');
  });
});

describe('dedupClientes', () => {
  const kleber = (id, cel) => ({ id, nome: 'KLEBER DE OLIVEIRA CAMARA', tipo_pessoa: 'PF', celular: cel, telefone: null, email: 'k@x.com', cpf_cnpj: null, updated_at: '2026-01-01' });
  test('junta os 3 Kleber com mesmo telefone', () => {
    const r = dedupClientes([kleber(1,'21988596449'), kleber(2,'21988596449'), kleber(3,'21988596449')]);
    expect(r.length).toBe(1);
  });
  test('NÃO junta Kleber com telefone diferente', () => {
    const r = dedupClientes([kleber(1,'21988596449'), kleber(2,'5521967625358')]);
    expect(r.length).toBe(2);
  });
  test('NÃO junta empresa de email igual e nome diferente', () => {
    const drogaria = { id: 9, nome: 'A NOSSA DROGARIA', tipo_pessoa: 'PJ', celular: '21967625358', telefone: null, email: 'k@x.com', cpf_cnpj: null, updated_at: '2026-01-01' };
    const r = dedupClientes([kleber(1,'21988596449'), drogaria]);
    expect(r.length).toBe(2);
  });
  test('junta por CPF/CNPJ igual mesmo com nome diferente', () => {
    const a = { id: 1, nome: 'EMPRESA X LTDA', tipo_pessoa: 'PJ', celular: '111', telefone: null, email: null, cpf_cnpj: '02629511000100', updated_at: '2026-01-01' };
    const b = { id: 2, nome: 'EMPRESA X', tipo_pessoa: 'PJ', celular: '222', telefone: null, email: null, cpf_cnpj: '02.629.511/0001-00', updated_at: '2026-02-01' };
    const r = dedupClientes([a, b]);
    expect(r.length).toBe(1);
    expect(r[0].id).toBe(2); // canônico = mais recente
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/identificacao-cliente.test.js`
Expected: FAIL — funções não exportadas.

- [ ] **Step 3: Implementar as funções puras em `agent.js`**

In `src/ai/agent.js`, add these functions near the top (after the `const PRODUTO_ENUM = ...` line, before `const SYSTEM_PROMPT`):
```js
function normalizarTelefone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  return d.slice(-9);
}

function normalizarNome(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

// Agrupa cadastros idênticos e retorna 1 canônico por grupo.
// Chave: cpf_cnpj (só dígitos) quando preenchido; senão nome normalizado + telefone normalizado.
function dedupClientes(rows) {
  const grupos = new Map();
  for (const r of rows) {
    const cpf = String(r.cpf_cnpj || '').replace(/\D/g, '');
    const tel = normalizarTelefone(r.celular || r.telefone);
    const chave = cpf ? `cpf:${cpf}` : `nt:${normalizarNome(r.nome)}|${tel}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(r);
  }
  const melhor = (g) => g.slice().sort((a, b) => {
    const ca = String(a.cpf_cnpj || '').replace(/\D/g, '') ? 1 : 0;
    const cb = String(b.cpf_cnpj || '').replace(/\D/g, '') ? 1 : 0;
    if (ca !== cb) return cb - ca; // quem tem cpf/cnpj primeiro
    const da = new Date(a.updated_at || a.created_at || 0).getTime();
    const db = new Date(b.updated_at || b.created_at || 0).getTime();
    if (da !== db) return db - da; // mais recente
    return String(a.id).localeCompare(String(b.id)); // menor id
  })[0];
  return [...grupos.values()].map(melhor);
}
```

- [ ] **Step 4: Exportar as funções**

In `src/ai/agent.js`, change the export line from:
```js
module.exports = { processMessage, SYSTEM_PROMPT };
```
to:
```js
module.exports = { processMessage, SYSTEM_PROMPT, normalizarTelefone, normalizarNome, dedupClientes };
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx jest tests/identificacao-cliente.test.js`
Expected: PASS (todos).

- [ ] **Step 6: Commit**

```bash
git add src/ai/agent.js tests/identificacao-cliente.test.js
git commit -m "feat(chatbot): funções puras normalizarTelefone/normalizarNome/dedupClientes + testes"
```

---

## Task 2: Busca revisada + nota de contexto + resolução no registrar_pedido

**Files:**
- Modify: `src/ai/agent.js` (bloco da nota de cliente em `processMessage` ~linhas 150-171; regra 11 do `SYSTEM_PROMPT` ~linha 72-75; bloco de resolução do cliente no `registrar_pedido` ~linhas 200-226)

- [ ] **Step 1: Adicionar `buscarClientesPorTelefone`**

In `src/ai/agent.js`, add this function right after `dedupClientes` (from Task 1):
```js
// Busca todos os cadastros ligados ao telefone (celular OU telefone, normalizados) e deduplica.
async function buscarClientesPorTelefone(phone) {
  const tel = normalizarTelefone(phone);
  if (tel.length < 8) return []; // muito curto → não arrisca match
  const r = await db.query(
    `SELECT id, nome, tipo_pessoa, celular, telefone, email, cpf_cnpj, updated_at, created_at
     FROM clientes_lkl
     WHERE regexp_replace(COALESCE(celular,''),  '\\D','','g') LIKE $1
        OR regexp_replace(COALESCE(telefone,''), '\\D','','g') LIKE $1`,
    [`%${tel}`]
  );
  return dedupClientes(r.rows);
}
```

- [ ] **Step 2: Substituir o bloco da nota de contexto no `processMessage`**

In `src/ai/agent.js`, replace the current client-lookup block. The current block is:
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
```
Replace it with:
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
```

- [ ] **Step 3: Estender a regra 11 do `SYSTEM_PROMPT`**

In `src/ai/agent.js`, the `SYSTEM_PROMPT` rule 11 currently begins with `11. IDENTIFICAÇÃO DO CLIENTE E E-MAIL — siga a nota de contexto:` and has bullet lines. Find this exact bullet line inside rule 11:
```
   - Se houver uma marcação "[CLIENTE NA BASE]" no contexto, confirme a identidade pelo nome informado ali ("Vi que você já é cliente como <NOME>. É isso mesmo? 😊"). Se o cliente confirmar, prossiga; se NEGAR (não é essa pessoa/empresa), trate como cliente novo e pergunte o nome.
```
Replace it with:
```
   - Se houver uma marcação "[CLIENTE NA BASE]" no contexto, confirme a identidade pelo nome informado ali ("Vi que você já é cliente como <NOME>. É isso mesmo? 😊"). Se o cliente confirmar, prossiga; se NEGAR (não é essa pessoa/empresa), trate como cliente novo e pergunte o nome.
   - Se houver "[CLIENTES NA BASE]" (VÁRIOS cadastros), LISTE os cadastros para o cliente e pergunte para qual deles é este pedido, ou se é um cadastro novo. NUNCA escolha sozinho. Quando o cliente escolher um existente, use em "nome_cliente" exatamente o nome desse cadastro. Se ele disser que nenhum é (ou é novo), trate como cadastro novo e peça nome + e-mail.
```

- [ ] **Step 4: Refatorar a resolução do cliente no `registrar_pedido`**

In `src/ai/agent.js`, inside the `registrar_pedido` handling, replace the current resolution block:
```js
        const row = conv.rows[0];
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
with:
```js
        const row = conv.rows[0];
        let clienteId = null;
        if (row?.phone) {
          const celular = row.phone.replace(/\D/g, '');
          const cands = await buscarClientesPorTelefone(row.phone);
          const confirmado = args.cliente_existente_confirmado !== false; // ausente/true => usa existente
          let matched = null;
          if (confirmado && cands.length) {
            const alvo = normalizarNome(args.nome_cliente);
            matched = (alvo && cands.find(c => normalizarNome(c.nome) === alvo))
              || (cands.length === 1 ? cands[0] : null);
          }
          if (matched) {
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

- [ ] **Step 5: Verificar carga do módulo e testes**

Run: `OPENAI_API_KEY=x node -e "require('./src/ai/agent'); console.log('ok')"`
Expected: `ok`.

Run: `npx jest tests/identificacao-cliente.test.js tests/agent-prompt.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ai/agent.js
git commit -m "feat(chatbot): busca por celular+telefone com dedup, lista múltiplos cadastros, resolução por nome"
```

---

## Task 3: Script de limpeza de duplicados

**Files:**
- Create: `scripts/dedup-clientes.js`

- [ ] **Step 1: Escrever o script**

Create `scripts/dedup-clientes.js`:
```js
// Merge conservador de clientes_lkl duplicados. Uso:
//   node scripts/dedup-clientes.js            (dry-run: só relata)
//   node scripts/dedup-clientes.js --apply    (executa o merge)
const db = require('../src/db');
const { normalizarTelefone, normalizarNome } = require('../src/ai/agent');

const REF_TABLES = ['orders', 'orcamentos', 'ordens_servico', 'revenda_compras'];

function chaveGrupo(r) {
  const cpf = String(r.cpf_cnpj || '').replace(/\D/g, '');
  if (cpf) return `cpf:${cpf}`;
  return `nt:${normalizarNome(r.nome)}|${normalizarTelefone(r.celular || r.telefone)}`;
}

function escolherCanonico(g) {
  return g.slice().sort((a, b) => {
    const ca = String(a.cpf_cnpj || '').replace(/\D/g, '') ? 1 : 0;
    const cb = String(b.cpf_cnpj || '').replace(/\D/g, '') ? 1 : 0;
    if (ca !== cb) return cb - ca;
    const da = new Date(a.updated_at || a.created_at || 0).getTime();
    const dbt = new Date(b.updated_at || b.created_at || 0).getTime();
    if (da !== dbt) return dbt - da;
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { rows } = await db.query(
    `SELECT id, nome, tipo_pessoa, celular, telefone, email, cpf_cnpj, updated_at, created_at FROM clientes_lkl`);
  const grupos = new Map();
  for (const r of rows) {
    const k = chaveGrupo(r);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(r);
  }
  const dups = [...grupos.values()].filter(g => g.length > 1);
  console.log(`Total de clientes: ${rows.length} | Grupos duplicados: ${dups.length}`);

  let removidos = 0;
  const refCount = Object.fromEntries(REF_TABLES.map(t => [t, 0]));

  const client = await db.pool.connect();
  try {
    if (apply) await client.query('BEGIN');
    for (const g of dups) {
      const canon = escolherCanonico(g);
      const outros = g.filter(r => r.id !== canon.id);
      console.log(`\nGrupo (${g.length}) canônico=${canon.nome} [${canon.id}]`);
      for (const d of outros) {
        for (const t of REF_TABLES) {
          const q = `UPDATE ${t} SET cliente_id = $1 WHERE cliente_id = $2`;
          if (apply) {
            const res = await client.query(q, [canon.id, d.id]);
            refCount[t] += res.rowCount;
          } else {
            const res = await db.query(`SELECT COUNT(*) FROM ${t} WHERE cliente_id = $1`, [d.id]);
            refCount[t] += parseInt(res.rows[0].count);
          }
        }
        if (apply) {
          await client.query(
            `UPDATE clientes_lkl SET
               email = COALESCE(NULLIF(email,''), $2),
               telefone = COALESCE(NULLIF(telefone,''), $3),
               celular = COALESCE(NULLIF(celular,''), $4),
               cpf_cnpj = COALESCE(NULLIF(cpf_cnpj,''), $5)
             WHERE id = $1`,
            [canon.id, d.email, d.telefone, d.celular, d.cpf_cnpj]);
          await client.query(`DELETE FROM clientes_lkl WHERE id = $1`, [d.id]);
        }
        removidos++;
        console.log(`   - remove ${d.nome} [${d.id}]`);
      }
    }
    if (apply) await client.query('COMMIT');
  } catch (e) {
    if (apply) await client.query('ROLLBACK');
    console.error('ERRO — rollback:', e.message);
    throw e;
  } finally {
    client.release();
  }

  console.log(`\n${apply ? 'APLICADO' : 'DRY-RUN'} — duplicados ${apply ? 'removidos' : 'a remover'}: ${removidos}`);
  console.log('Referências repontadas por tabela:', refCount);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verificar sintaxe (carrega sem executar main até o pool)**

Run: `node -e "require('fs').accessSync('scripts/dedup-clientes.js'); const s=require('fs').readFileSync('scripts/dedup-clientes.js','utf8'); if(!/--apply/.test(s)||!/REF_TABLES/.test(s)) throw new Error('conteúdo faltando'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add scripts/dedup-clientes.js
git commit -m "feat(chatbot): script dedup-clientes (merge conservador dry-run/apply)"
```

---

## Task 4: Deploy + dedup no VPS + smoke + memória

**Files:** nenhum código novo — deploy e verificação.

- [ ] **Step 1: Rsync do código**

```bash
rsync -avz src/ai/agent.js root@2.25.147.243:/var/www/lkl-chatbot/src/ai/agent.js
rsync -avz scripts/dedup-clientes.js root@2.25.147.243:/var/www/lkl-chatbot/scripts/dedup-clientes.js
```
Expected: transferências sem erro.

- [ ] **Step 2: Restart do app**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env >/dev/null 2>&1; sleep 2; pm2 list | grep lkl-chatbot"
ssh root@2.25.147.243 "pm2 logs lkl-chatbot --lines 5 --nostream 2>/dev/null | grep -iE 'error|throw' || echo '(sem erros no boot)'"
```
Expected: `online`, sem erros.

- [ ] **Step 3: Dry-run do dedup (revisar antes de aplicar)**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node scripts/dedup-clientes.js"
```
Expected: relatório dos grupos. **Conferir**: os 3 "KLEBER DE OLIVEIRA CAMARA" com celular `21988596449` formam UM grupo (canônico + 2 a remover); o Kleber de `5521967625358` e "A NOSSA DROGARIA" ficam em grupos SEPARADOS (não aparecem juntos). Se algo parecer errado, PARAR e reportar.

- [ ] **Step 4: Aplicar o dedup**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && node scripts/dedup-clientes.js --apply"
```
Expected: `APLICADO — duplicados removidos: N` + referências repontadas.

- [ ] **Step 5: Verificar o resultado**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"SELECT nome, celular, telefone, email FROM clientes_lkl WHERE nome ILIKE '%kleber%' ORDER BY nome;\""
```
Expected: os "KLEBER DE OLIVEIRA CAMARA" de celular `21988596449` reduzidos a **1**; o de `5521967625358` permanece (2 cadastros Kleber no total). Nenhum órfão de FK.

- [ ] **Step 6: Smoke da identificação (SQL espelhando a busca)**

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"SELECT id, nome, tipo_pessoa FROM clientes_lkl WHERE regexp_replace(COALESCE(celular,''),'\\D','','g') LIKE '%988596449' OR regexp_replace(COALESCE(telefone,''),'\\D','','g') LIKE '%988596449';\""
```
Expected: agora retorna **1** cadastro para o telefone `988596449` (após o dedup) → o bot dará `[CLIENTE NA BASE]` correto. (Para um número com múltiplos cadastros legítimos, daria `[CLIENTES NA BASE]`.)

- [ ] **Step 7: Atualizar a memória do projeto**

Registrar em `project_sprint_status.md`: identificação de cliente no chatbot revisada — funções puras normalizarTelefone/normalizarNome/dedupClientes em src/ai/agent.js (exportadas, testadas); buscarClientesPorTelefone busca por celular+telefone normalizados (regexp_replace, sem 55/traços) e deduplica; nota de contexto 0→[CLIENTE NOVO], 1→[CLIENTE NA BASE], >1→[CLIENTES NA BASE] (lista até 5, bot pergunta qual/novo); regra 11 do prompt estendida; resolução no registrar_pedido casa nome_cliente escolhido contra candidatos (sem LIMIT 1 aleatório). Script scripts/dedup-clientes.js (dry-run/apply) faz merge conservador (chave cpf_cnpj OU nome+telefone normalizados; canônico prefere cpf_cnpj/mais recente; repontar orders/orcamentos/ordens_servico/revenda_compras; completa campos vazios; deleta dup). Rodado no VPS (dry-run→apply). Sem migration. Commits <SHAs>.

- [ ] **Step 8: Encerrar a branch**

Usar `superpowers:finishing-a-development-branch`.

---

## Self-Review

**1. Spec coverage:**
- `normalizarTelefone`/`normalizarNome`/`dedupClientes` puras + testes → Task 1. ✓
- `buscarClientesPorTelefone` (celular+telefone normalizados, dedup, guarda <8 dígitos) → Task 2 Step 1. ✓
- Nota 0/1/N matches (lista até 5) → Task 2 Step 2. ✓
- Regra 11 do prompt estendida ([CLIENTES NA BASE]) → Task 2 Step 3. ✓
- Resolução no registrar_pedido por nome escolhido → Task 2 Step 4. ✓
- Script dedup conservador (chave, canônico, repontar 4 tabelas, completar vazios, deletar, dry-run/apply, transação) → Task 3. ✓
- Deploy + dry-run + apply + verificação + smoke → Task 4. ✓
- Fora de escopo (merge por email; unir telefones diferentes) respeitado (chave conservadora). ✓

**2. Placeholder scan:** sem TBD/TODO; todo passo de código traz o código completo. (No Step 7, `<SHAs>` é um marcador a preencher no momento do commit da memória, não código.) ✓

**3. Type consistency:** `normalizarTelefone`/`normalizarNome`/`dedupClientes` definidas na Task 1 e reusadas na Task 2 (`buscarClientesPorTelefone`, resolução) e na Task 3 (script). Chave de grupo idêntica entre `dedupClientes` (Task 1) e `chaveGrupo` (Task 3). Tabelas de FK (`orders`, `orcamentos`, `ordens_servico`, `revenda_compras`) consistentes. ✓
