# OCR de NF-e — Fornecedor, Parcelas e Trava de Auto-Referência Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir a baixa taxa de acerto do OCR de nota fiscal via WhatsApp: distinguir emitente (fornecedor) de destinatário (a própria LKL), suportar múltiplas parcelas por nota, e travar contra criar um "fornecedor" que é a própria empresa.

**Architecture:** `ocr.js` reescreve o prompt do GPT-4o e passa a extrair um array de `parcelas` + `data_entrega` (em vez de 1 valor/vencimento). `fornecedor-matcher.js` ganha uma checagem de auto-referência via CNPJ. `whatsapp.js` monta a confirmação a partir das parcelas e, ao confirmar, usa `criarOuReconciliarContaPagar` (1 parcela, preserva dedução contra DDA) ou `criarParcelado` (2+ parcelas, já existe). `criarOuReconciliarContaPagar` ganha suporte a `competencia`.

**Tech Stack:** Node.js/Express, PostgreSQL, OpenAI GPT-4o vision, Jest.

---

### Task 1: Migration 054 — `despesas_pendentes_confirmacao` vira parcelas + data_entrega

**Files:**
- Create: `sql/migrations/054_ocr_parcelas.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- sql/migrations/054_ocr_parcelas.sql
BEGIN;

ALTER TABLE despesas_pendentes_confirmacao DROP COLUMN valor;
ALTER TABLE despesas_pendentes_confirmacao DROP COLUMN vencimento;
ALTER TABLE despesas_pendentes_confirmacao ADD COLUMN parcelas JSONB NOT NULL DEFAULT '[]';
ALTER TABLE despesas_pendentes_confirmacao ADD COLUMN data_entrega DATE;

COMMIT;
```

Seguro dropar sem backfill: a tabela só guarda pendências de confirmação de até 30 minutos (ver `JANELA_CONFIRMACAO_MINUTOS` em `src/modules/contas-pagar/whatsapp.js`), sem valor histórico — qualquer linha presente nesse momento já terá expirado antes do deploy chegar em produção de qualquer forma.

- [ ] **Step 2: Aplicar no VPS** (só no Task 6 — Deploy; aqui só cria o arquivo local)

- [ ] **Step 3: Commit**

```bash
git add sql/migrations/054_ocr_parcelas.sql
git commit -m "feat(contas-pagar): migration 054 - despesas_pendentes_confirmacao usa parcelas JSONB + data_entrega"
```

---

### Task 2: `ocr.js` — prompt com emitente/destinatário + parcelas + `data_entrega`

**Files:**
- Modify: `src/modules/contas-pagar/ocr.js`
- Test: `tests/contas-pagar-ocr.test.js` (reescrita completa)

- [ ] **Step 1: Reescrever os testes primeiro (vão falhar)**

Substitua todo o conteúdo de `tests/contas-pagar-ocr.test.js`:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockCreate } },
})));

const { extrairDadosComprovante, _validarDadosExtraidos } = require('../src/modules/contas-pagar/ocr');

describe('extrairDadosComprovante', () => {
  let tmpFile;
  beforeAll(() => {
    tmpFile = path.join(os.tmpdir(), 'comprovante-teste.jpg');
    fs.writeFileSync(tmpFile, Buffer.from([0xff, 0xd8, 0xff])); // bytes mínimos, conteúdo não importa (mock)
  });
  afterAll(() => { fs.unlinkSync(tmpFile); });
  afterEach(() => jest.clearAllMocks());

  test('resposta válida com 1 parcela → retorna objeto normalizado', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","cnpj":"12345678000199","data_entrega":"2026-08-01","descricao":"Compra de papel","parcelas":[{"valor":150.5,"vencimento":"2026-08-10"}]}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toEqual({
      fornecedor: 'Papelaria X', cnpj: '12345678000199', data_entrega: '2026-08-01',
      descricao: 'Compra de papel', parcelas: [{ valor: 150.5, vencimento: '2026-08-10' }],
    });
  });

  test('resposta válida com 2 parcelas → array com as 2', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Konita Brasil","cnpj":"05624693000107","data_entrega":"2026-05-15","descricao":null,"parcelas":[{"valor":817.85,"vencimento":"2026-06-15"},{"valor":817.84,"vencimento":"2026-06-29"}]}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r.parcelas).toEqual([
      { valor: 817.85, vencimento: '2026-06-15' },
      { valor: 817.84, vencimento: '2026-06-29' },
    ]);
  });

  test('sem fornecedor → null', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"parcelas":[{"valor":100,"vencimento":"2026-08-10"}]}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toBeNull();
  });

  test('sem parcelas (array vazio ou ausente) → null', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","parcelas":[]}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toBeNull();
  });

  test('parcela sem valor ou vencimento → null (toda a extração é descartada)', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","parcelas":[{"valor":100,"vencimento":"2026-08-10"},{"valor":null,"vencimento":"2026-09-10"}]}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toBeNull();
  });

  test('sem data_entrega → usa a data de hoje como fallback', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","parcelas":[{"valor":100,"vencimento":"2026-08-10"}]}' } }],
    });
    const { format } = require('date-fns');
    const hoje = format(new Date(), 'yyyy-MM-dd');
    const r = await extrairDadosComprovante(tmpFile);
    expect(r.data_entrega).toBe(hoje);
  });

  test('resposta sem JSON válido → null', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'não consegui ler' } }] });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toBeNull();
  });

  test('o prompt enviado ao modelo menciona emitente/destinatário e os CNPJs próprios', async () => {
    process.env.EMPRESA_CNPJS = '19.296.723/0001-08,44.448.899/0001-85';
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"X","parcelas":[{"valor":1,"vencimento":"2026-08-10"}]}' } }],
    });
    await extrairDadosComprovante(tmpFile);
    const promptEnviado = mockCreate.mock.calls[0][0].messages[0].content;
    expect(promptEnviado).toMatch(/EMITENTE/);
    expect(promptEnviado).toMatch(/DESTINATÁRIO/);
    expect(promptEnviado).toMatch(/19\.296\.723\/0001-08/);
    expect(promptEnviado).toMatch(/44\.448\.899\/0001-85/);
  });
});

describe('_validarDadosExtraidos', () => {
  test('normaliza valores numéricos das parcelas (strings viram number)', () => {
    const r = _validarDadosExtraidos({ fornecedor: 'X', parcelas: [{ valor: '150.50', vencimento: '2026-08-10' }] });
    expect(r.parcelas[0].valor).toBe(150.5);
  });
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npx jest tests/contas-pagar-ocr.test.js --verbose`
Expected: FAIL — `ocr.js` atual não exporta `_validarDadosExtraidos`, o prompt atual não menciona EMITENTE/DESTINATÁRIO/CNPJs, e o schema retornado ainda é `{valor, vencimento}` únicos, não `{data_entrega, parcelas}`.

- [ ] **Step 3: Reescrever `src/modules/contas-pagar/ocr.js`**

```js
const fs = require('fs');
const path = require('path');
const { format } = require('date-fns');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function _dataUri(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  const b64 = fs.readFileSync(absPath).toString('base64');
  return `data:${mime};base64,${b64}`;
}

function _cnpjsProprios() {
  return String(process.env.EMPRESA_CNPJS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function _prompt() {
  const cnpjs = _cnpjsProprios();
  const cnpj1 = cnpjs[0] || '(não configurado)';
  const cnpj2 = cnpjs[1] || '(não configurado)';
  return `Você recebe a foto ou PDF de um boleto ou nota fiscal de compra de uma gráfica (DANFE/NF-e).

IMPORTANTE — identificação do fornecedor:
- O FORNECEDOR é sempre o EMITENTE/REMETENTE da nota (quem vendeu/prestou o serviço) — geralmente no topo do documento, perto do CNPJ do emitente.
- O DESTINATÁRIO (para quem a nota foi emitida) NUNCA é o fornecedor — é o cliente que recebeu a mercadoria.
- Os CNPJs ${cnpj1} e ${cnpj2} são da nossa própria empresa (destinatária). Se o CNPJ que você está prestes a extrair como "fornecedor" for um desses, você pegou o bloco errado — procure o CNPJ do emitente, não o do destinatário.

IMPORTANTE — parcelas:
- Se a nota mostrar mais de um vencimento/boleto (ex: "PARCELADO", "BOL=001", "BOL=002", duplicatas), extraia CADA parcela separadamente no array "parcelas" — nunca escolha só uma.
- Se só houver 1 vencimento, "parcelas" ainda é um array, só que com 1 item.
- A soma dos valores das parcelas deve bater com o valor total da nota, se ele aparecer.

Extraia os dados e responda SOMENTE com um JSON no formato:
{"fornecedor": string ou null, "cnpj": string (somente dígitos) ou null, "data_entrega": "YYYY-MM-DD" ou null, "descricao": string ou null, "parcelas": [{"valor": number, "vencimento": "YYYY-MM-DD"}, ...] ou null}

"data_entrega" é a data de emissão ou de entrada/saída da nota (não confundir com vencimento de boleto).
Se não conseguir identificar um campo com confiança, use null nele. Não escreva nada fora do JSON.`;
}

function _validarDadosExtraidos(dados) {
  if (!dados || !dados.fornecedor) return null;
  if (!Array.isArray(dados.parcelas) || dados.parcelas.length === 0) return null;
  const parcelas = [];
  for (const p of dados.parcelas) {
    if (!p || p.valor == null || !p.vencimento) return null;
    parcelas.push({ valor: Number(p.valor), vencimento: p.vencimento });
  }
  return {
    fornecedor: dados.fornecedor,
    cnpj: dados.cnpj || null,
    data_entrega: dados.data_entrega || format(new Date(), 'yyyy-MM-dd'),
    descricao: dados.descricao || dados.fornecedor,
    parcelas,
  };
}

async function extrairDadosComprovante(absPath) {
  const dataUri = _dataUri(absPath);
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [
      { role: 'system', content: _prompt() },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] },
    ],
    temperature: 0,
    max_tokens: 500,
  });
  const texto = response.choices[0]?.message?.content || '';
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let dados;
  try {
    dados = JSON.parse(match[0]);
  } catch {
    return null;
  }
  return _validarDadosExtraidos(dados);
}

module.exports = { extrairDadosComprovante, _validarDadosExtraidos, _cnpjsProprios };
```

Note: `max_tokens` sobe de 300 pra 500 pra caber o array de parcelas em notas com várias.

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx jest tests/contas-pagar-ocr.test.js --verbose`
Expected: PASS (9 testes).

- [ ] **Step 5: Commit**

```bash
git add src/modules/contas-pagar/ocr.js tests/contas-pagar-ocr.test.js
git commit -m "feat(contas-pagar): ocr.js distingue emitente/destinatario e extrai parcelas + data_entrega"
```

---

### Task 3: `fornecedor-matcher.js` — trava de auto-referência

**Files:**
- Modify: `src/modules/contas-pagar/fornecedor-matcher.js`
- Test: `tests/contas-pagar-fornecedor-matcher.test.js`

- [ ] **Step 1: Escrever os testes primeiro (vão falhar)**

Adicione ao final de `tests/contas-pagar-fornecedor-matcher.test.js` (não mexa nos testes já existentes):

```js
describe('ehCnpjProprio', () => {
  const { ehCnpjProprio } = require('../src/modules/contas-pagar/fornecedor-matcher');
  const ORIGINAL_ENV = process.env.EMPRESA_CNPJS;
  afterEach(() => { process.env.EMPRESA_CNPJS = ORIGINAL_ENV; });

  test('CNPJ com máscara bate um dos CNPJs próprios (com máscara na env)', () => {
    process.env.EMPRESA_CNPJS = '19.296.723/0001-08,44.448.899/0001-85';
    expect(ehCnpjProprio('19296723000108')).toBe(true);
    expect(ehCnpjProprio('19.296.723/0001-08')).toBe(true);
  });

  test('CNPJ com máscara bate um dos CNPJs próprios (sem máscara na env)', () => {
    process.env.EMPRESA_CNPJS = '19296723000108,44448899000185';
    expect(ehCnpjProprio('19.296.723/0001-08')).toBe(true);
  });

  test('CNPJ de terceiro não bate', () => {
    process.env.EMPRESA_CNPJS = '19.296.723/0001-08,44.448.899/0001-85';
    expect(ehCnpjProprio('05.624.693/0001-07')).toBe(false);
  });

  test('EMPRESA_CNPJS vazio/ausente não quebra, retorna false', () => {
    delete process.env.EMPRESA_CNPJS;
    expect(ehCnpjProprio('19.296.723/0001-08')).toBe(false);
  });

  test('cnpj nulo/vazio → false', () => {
    process.env.EMPRESA_CNPJS = '19.296.723/0001-08';
    expect(ehCnpjProprio(null)).toBe(false);
    expect(ehCnpjProprio('')).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npx jest tests/contas-pagar-fornecedor-matcher.test.js --verbose`
Expected: FAIL — `ehCnpjProprio` não existe ainda.

- [ ] **Step 3: Implementar `ehCnpjProprio` em `src/modules/contas-pagar/fornecedor-matcher.js`**

Adicione a função (logo após `soDigitos`, antes de `buscarPorCnpj`):

```js
function ehCnpjProprio(cnpj) {
  const digitos = soDigitos(cnpj);
  if (!digitos) return false;
  const proprios = String(process.env.EMPRESA_CNPJS || '').split(',').map(soDigitos).filter(Boolean);
  return proprios.includes(digitos);
}
```

Atualize o `module.exports` no fim do arquivo:

```js
module.exports = {
  normalizarNome,
  soDigitos,
  ehCnpjProprio,
  buscarPorCnpj,
  buscarPorNome,
  criarFornecedor,
  encontrarOuCriarFornecedor,
};
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx jest tests/contas-pagar-fornecedor-matcher.test.js --verbose`
Expected: PASS (todos os testes do arquivo, os já existentes + os 5 novos).

- [ ] **Step 5: Commit**

```bash
git add src/modules/contas-pagar/fornecedor-matcher.js tests/contas-pagar-fornecedor-matcher.test.js
git commit -m "feat(contas-pagar): ehCnpjProprio - trava contra auto-referencia no OCR de NF"
```

---

### Task 4: `service.js` — `criarOuReconciliarContaPagar` grava `competencia`

**Files:**
- Modify: `src/modules/contas-pagar/service.js`
- Test: `tests/contas-pagar-service.test.js`

- [ ] **Step 1: Escrever os testes primeiro (vão falhar)**

Adicione ao final do `describe('criarOuReconciliarContaPagar', ...)` existente em `tests/contas-pagar-service.test.js` (não mexa nos testes já existentes):

```js
  test('com competencia e zero correspondências → INSERT inclui a coluna competencia', async () => {
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        expect(sql).toContain('competencia');
        expect(params).toContain('2026-05-27');
        return Promise.resolve({ rows: [{ id: 50 }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-5', fornecedorNome: 'Konita', descricao: 'NF Konita',
      valor: 817.84, vencimento: '2026-06-29', tipoDespesaId: 2, tipoEntrada: 'whatsapp_ocr',
      competencia: '2026-05-27',
    });

    expect(r.id).toBe(50);
  });

  test('com competencia e 1 correspondência (match) → UPDATE inclui a coluna competencia', async () => {
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) {
        return Promise.resolve({ rows: [{ id: 60, tipo_despesa_id: 2 }] });
      }
      if (sql.startsWith('UPDATE contas_pagar')) {
        expect(sql).toContain('competencia');
        expect(params).toContain('2026-05-27');
        return Promise.resolve({ rows: [{ id: 60 }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-6', valor: 817.84, vencimento: '2026-06-29',
      tipoDespesaId: 2, tipoEntrada: 'whatsapp_ocr', competencia: '2026-05-27',
    });

    expect(r.id).toBe(60);
  });

  test('sem competencia → INSERT não inclui a coluna (banco usa DEFAULT)', async () => {
    const client = mockClient((sql, params) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('INSERT INTO contas_pagar')) {
        expect(sql).not.toContain('competencia');
        return Promise.resolve({ rows: [{ id: 70 }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-7', valor: 100, vencimento: '2026-08-01',
      tipoDespesaId: 1, tipoEntrada: 'manual',
    });
  });
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

Run: `npx jest tests/contas-pagar-service.test.js -t "criarOuReconciliarContaPagar" --verbose`
Expected: FAIL — a função atual não aceita/usa `competencia` em nenhum dos dois branches (UPDATE nem INSERT).

- [ ] **Step 3: Modificar `criarOuReconciliarContaPagar` em `src/modules/contas-pagar/service.js`**

Adicione `competencia` à desestruturação dos parâmetros (linha 538) e ajuste os dois branches (match/sem match). Substitua a função inteira (linhas 538-599 antes desta mudança):

```js
async function criarOuReconciliarContaPagar({ fornecedorId, fornecedorNome, valor, vencimento, descricao, tipoDespesaId, tipoEntrada, linhaDigitavel, tipo, competencia }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let match = null;
    if (fornecedorId && valor != null) {
      const params = [fornecedorId, valor];
      let cond = `fornecedor_id = $1 AND valor = $2 AND linha_digitavel IS NULL AND status IN ('pendente','pendente_classificacao')`;
      if (vencimento) {
        params.push(vencimento);
        cond += ` AND vencimento BETWEEN $3::date - INTERVAL '10 days' AND $3::date + INTERVAL '10 days'`;
      }
      // FOR UPDATE trava as linhas candidatas até o commit — evita que duas chamadas
      // concorrentes (ex: entrada de estoque + WhatsApp ao mesmo tempo) dupliquem a
      // mesma dívida por não enxergarem uma à outra antes de decidir criar/mesclar.
      const r = await client.query(`SELECT * FROM contas_pagar WHERE ${cond} FOR UPDATE`, params);
      if (r.rows.length === 1) match = r.rows[0];
    }

    let tipoFinal = tipoDespesaId || null;
    if (!tipoFinal) {
      const sugestao = await classificador.classificarDespesa({ fornecedorId, nomeFornecedor: fornecedorNome, descricao });
      tipoFinal = sugestao.tipo_despesa_id;
    }

    let conta;
    if (match) {
      const sets = ['updated_at = NOW()'];
      const params = [];
      if (linhaDigitavel) { params.push(linhaDigitavel); sets.push(`linha_digitavel = $${params.length}`); }
      if (vencimento)     { params.push(vencimento);     sets.push(`vencimento = $${params.length}`); }
      if (tipo)           { params.push(tipo);           sets.push(`tipo = $${params.length}`); }
      if (competencia)    { params.push(competencia);    sets.push(`competencia = $${params.length}`); }
      if (!match.tipo_despesa_id && tipoFinal) {
        params.push(tipoFinal); sets.push(`tipo_despesa_id = $${params.length}`);
        sets.push(`status = 'pendente'`);
      }
      params.push(match.id);
      const r = await client.query(`UPDATE contas_pagar SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
      conta = r.rows[0];
    } else {
      const status = tipoFinal ? 'pendente' : 'pendente_classificacao';
      const colunas = ['descricao','fornecedor','fornecedor_id','tipo_despesa_id','valor','vencimento','tipo','linha_digitavel','tipo_entrada','status'];
      const valores = [descricao, fornecedorNome || null, fornecedorId || null, tipoFinal, valor,
                        vencimento, tipo || 'boleto', linhaDigitavel || null, tipoEntrada, status];
      if (competencia) { colunas.push('competencia'); valores.push(competencia); }
      const placeholders = valores.map((_, i) => `$${i + 1}`).join(',');
      const r = await client.query(
        `INSERT INTO contas_pagar (${colunas.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        valores
      );
      conta = r.rows[0];
    }
    await client.query('COMMIT');
    return conta;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `npx jest tests/contas-pagar-service.test.js --verbose`
Expected: PASS (todos os testes do arquivo).

- [ ] **Step 5: Commit**

```bash
git add src/modules/contas-pagar/service.js tests/contas-pagar-service.test.js
git commit -m "feat(contas-pagar): criarOuReconciliarContaPagar aceita e grava competencia"
```

---

### Task 5: `whatsapp.js` — parcelas na confirmação e no lançamento + `.env.example`

**Files:**
- Modify: `src/modules/contas-pagar/whatsapp.js`
- Modify: `.env.example`

Este projeto não tem teste automatizado pra `whatsapp.js` hoje (o arquivo inteiro depende de `ocr`/`classificador`/`service`/`db` reais e não é mockado em nenhum teste existente — mesmo padrão de outros módulos de integração deste projeto). A verificação aqui é por leitura cuidadosa comparando com o spec + smoke manual mandando a mesma nota da Konita depois do deploy (Task 6).

- [ ] **Step 1: Reescrever `handleComprovanteDespesa`**

Em `src/modules/contas-pagar/whatsapp.js`, substitua a função inteira (linhas 29-74 antes desta mudança):

```js
async function handleComprovanteDespesa(phone, mediaType, localUrl) {
  if (!['image', 'document'].includes(mediaType)) {
    await sendMessage(phone, 'Só consigo ler imagem ou PDF de comprovante. Lance manualmente no painel.');
    return;
  }
  const filename = path.basename(localUrl);
  const absPath = path.join(UPLOADS_DIR, filename);

  let dados;
  try {
    dados = await ocr.extrairDadosComprovante(absPath);
  } catch (err) {
    console.error('[CONTAS-PAGAR-WA] erro no OCR:', err.message);
    dados = null;
  }
  if (!dados) {
    await sendMessage(phone, 'Não consegui ler os dados dessa imagem, lance manualmente no painel.');
    return;
  }

  if (fornecedorMatcher.ehCnpjProprio(dados.cnpj)) {
    await sendMessage(phone, 'Não consegui identificar o fornecedor corretamente (os dados encontrados parecem ser da nossa própria empresa, não do fornecedor). Lance manualmente no painel financeiro.');
    return;
  }

  try {
    const fornecedor = await fornecedorMatcher.encontrarOuCriarFornecedor({ nome: dados.fornecedor, cnpj: dados.cnpj });
    const sugestao = await classificador.classificarDespesa({
      fornecedorId: fornecedor?.id || null,
      nomeFornecedor: dados.fornecedor,
      descricao: dados.descricao,
    });

    await db.query('DELETE FROM despesas_pendentes_confirmacao WHERE telefone = $1', [phone]);
    await db.query(
      `INSERT INTO despesas_pendentes_confirmacao (telefone, fornecedor_id, parcelas, data_entrega, descricao, tipo_despesa_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [phone, fornecedor?.id || null, JSON.stringify(dados.parcelas), dados.data_entrega, dados.descricao, sugestao.tipo_despesa_id]
    );

    const nomeTipo = await _tipoDespesaNome(sugestao.tipo_despesa_id);
    const dataEntregaFmt = format(new Date(`${dados.data_entrega}T00:00:00`), 'dd/MM/yyyy');
    const fmtValor = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

    let linhasParcelas;
    if (dados.parcelas.length === 1) {
      const p = dados.parcelas[0];
      const vencFmt = format(new Date(`${p.vencimento}T00:00:00`), 'dd/MM/yyyy');
      linhasParcelas = `*Valor:* ${fmtValor(p.valor)}\n*Vencimento:* ${vencFmt}`;
    } else {
      linhasParcelas = dados.parcelas.map((p, i) => {
        const vencFmt = format(new Date(`${p.vencimento}T00:00:00`), 'dd/MM/yyyy');
        return `${i + 1}ª parcela: ${fmtValor(p.valor)} — vence ${vencFmt}`;
      }).join('\n');
    }

    await sendMessage(phone,
      `📄 *Fornecedor:* ${dados.fornecedor}\n*Data de entrega:* ${dataEntregaFmt}\n*Categoria sugerida:* ${nomeTipo}\n\n${linhasParcelas}\n\nConfirma? Responda *sim* ou *não*.`
    );
  } catch (err) {
    console.error('[CONTAS-PAGAR-WA] erro ao classificar/gravar pendência:', err.message);
    await sendMessage(phone, 'Tive um problema ao processar esse comprovante. Tente de novo ou lance manualmente no painel.');
  }
}
```

- [ ] **Step 2: Reescrever `processarRespostaDespesaWA`**

Substitua a função inteira (linhas 76-114 antes desta mudança):

```js
async function processarRespostaDespesaWA(phone, texto) {
  const norm = String(texto || '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  const isSim = norm === 'SIM';
  const isNao = norm === 'NAO';
  if (!isSim && !isNao) return null;

  const r = await db.query(
    `SELECT * FROM despesas_pendentes_confirmacao WHERE telefone = $1 AND criado_em > NOW() - ($2 || ' minutes')::interval`,
    [phone, JANELA_CONFIRMACAO_MINUTOS]
  );
  if (!r.rows.length) return null;
  const pendente = r.rows[0];

  await db.query('DELETE FROM despesas_pendentes_confirmacao WHERE id = $1', [pendente.id]);

  if (isNao) {
    return { mensagem: 'Ok, não lancei. Você pode cadastrar manualmente no painel financeiro.' };
  }

  let fornecedorNome = null;
  if (pendente.fornecedor_id) {
    const f = await db.query('SELECT nome FROM fornecedores WHERE id=$1', [pendente.fornecedor_id]);
    fornecedorNome = f.rows[0]?.nome || null;
  }

  const parcelas = pendente.parcelas;
  if (parcelas.length === 1) {
    await service.criarOuReconciliarContaPagar({
      fornecedorId: pendente.fornecedor_id,
      fornecedorNome,
      descricao: pendente.descricao,
      valor: parcelas[0].valor,
      vencimento: parcelas[0].vencimento,
      competencia: pendente.data_entrega,
      tipoDespesaId: pendente.tipo_despesa_id,
      tipoEntrada: 'whatsapp_ocr',
      tipo: 'boleto',
    });
  } else {
    await service.criarParcelado({
      descricao: pendente.descricao,
      fornecedor: fornecedorNome,
      fornecedor_id: pendente.fornecedor_id,
      tipo_despesa_id: pendente.tipo_despesa_id,
      competencia: pendente.data_entrega,
      tipo: 'boleto',
      parcelas,
    });
  }

  return { mensagem: '✅ Lançado.' };
}
```

- [ ] **Step 3: Adicionar `format` de `date-fns` ao require do topo do arquivo**

O arquivo já importa `{ format }` de `date-fns` na linha 2 (`const { format } = require('date-fns');`) — confirme que segue lá, nenhuma mudança necessária nesse require.

- [ ] **Step 4: Checar sintaxe**

Run: `node --check src/modules/contas-pagar/whatsapp.js`
Expected: sem saída.

- [ ] **Step 5: Adicionar `EMPRESA_CNPJS` ao `.env.example`**

Adicione perto de `CONTAS_PAGAR_WHATSAPP_NUMEROS` (mesma seção de contas a pagar):

```
# CNPJs da própria empresa (separados por vírgula, com ou sem máscara) — usado pra travar
# o OCR de nota fiscal contra criar um "fornecedor" que é a própria gráfica (erro de
# emitente/destinatário confundidos pelo modelo de visão).
EMPRESA_CNPJS=19.296.723/0001-08,44.448.899/0001-85
```

- [ ] **Step 6: Commit**

```bash
git add src/modules/contas-pagar/whatsapp.js .env.example
git commit -m "feat(contas-pagar): whatsapp.js confirma e lanca parcelas (criarParcelado quando 2+), trava auto-referencia"
```

---

### Task 6: Deploy no VPS

**Files:** nenhum (só deploy)

- [ ] **Step 1: Rodar a suíte local**

Run: `npx jest tests/contas-pagar-ocr.test.js tests/contas-pagar-fornecedor-matcher.test.js tests/contas-pagar-service.test.js tests/contas-pagar-parcelado.test.js --verbose`
Expected: todos PASS.

Run: `npx jest 2>&1 | tail -10`
Expected: mesma baseline de falhas pré-existentes (suítes de integração dependentes de Postgres real).

- [ ] **Step 2: Adicionar `EMPRESA_CNPJS` ao `.env` real do VPS**

```bash
ssh root@2.25.147.243 "grep -q '^EMPRESA_CNPJS=' /var/www/lkl-chatbot/.env || echo 'EMPRESA_CNPJS=19.296.723/0001-08,44.448.899/0001-85' >> /var/www/lkl-chatbot/.env"
```

- [ ] **Step 3: Aplicar a migration 054 no VPS**

Lembrete de infraestrutura já conhecido deste projeto: `contas_pagar`/tabelas relacionadas podem ser de propriedade do role `postgres`, não do role de runtime `lkl_user` — se a migration falhar com "must be owner of table", rode via `sudo -u postgres psql`.

```bash
scp sql/migrations/054_ocr_parcelas.sql root@2.25.147.243:/var/www/lkl-chatbot/sql/migrations/
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && sudo -u postgres psql -d lkl_chatbot -f sql/migrations/054_ocr_parcelas.sql"
```

Depois, verificar que `lkl_user` tem privilégio nas colunas novas antes de reiniciar o app:

```bash
ssh root@2.25.147.243 "sudo -u postgres psql -d lkl_chatbot -c \"SELECT has_column_privilege('lkl_user', 'despesas_pendentes_confirmacao', 'parcelas', 'SELECT, INSERT, UPDATE') AS ok_parcelas, has_column_privilege('lkl_user', 'despesas_pendentes_confirmacao', 'data_entrega', 'SELECT, INSERT, UPDATE') AS ok_data_entrega;\""
```
Expected: ambas colunas `t` (true). Se `f`, rodar `GRANT` explícito antes de prosseguir.

- [ ] **Step 4: Pedir confirmação do usuário antes de deployar o código**

Esse deploy toca produção — confirmar com o usuário (AskUserQuestion) antes do rsync/pm2 restart.

- [ ] **Step 5: Deploy**

```bash
rsync -R -av src/modules/contas-pagar/ocr.js src/modules/contas-pagar/fornecedor-matcher.js src/modules/contas-pagar/service.js src/modules/contas-pagar/whatsapp.js root@2.25.147.243:/var/www/lkl-chatbot/
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```

- [ ] **Step 6: Smoke test em produção**

```bash
ssh root@2.25.147.243 "pm2 logs lkl-chatbot --lines 30 --nostream"
```
Expected: processo online, sem erro no restart.

Depois, testar manualmente mandando a mesma nota da Konita (ou outra nota parcelada real) pro número do WhatsApp financeiro e conferindo:
1. Fornecedor extraído é o emitente (Konita), não a LKL.
2. Confirmação mostra as 2 parcelas separadamente com valores/datas corretos.
3. Ao responder "sim", checar no painel (`Contas a Pagar`) que foram criadas 2 linhas com o mesmo `parcela_grupo_id` e a `competencia` = data de emissão da nota (15/05/2026).
4. Testar também uma nota à vista (1 parcela só) pra confirmar que o caminho de `criarOuReconciliarContaPagar` continua funcionando (dedução contra DDA preservada).

---

## Fora de escopo (reafirmado do spec)

- Suporte a PDF na visão do GPT-4o (time vai padronizar scanner pra PNG).
- Fila de revisão humana pra extrações de baixa confiança.
- Pré-processamento de imagem (crop, rotação, upscale) antes de mandar pro GPT-4o.
