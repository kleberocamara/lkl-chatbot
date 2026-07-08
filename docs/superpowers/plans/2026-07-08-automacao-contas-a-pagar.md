# Automação de Contas a Pagar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o enum de 18 tipos de despesa por uma taxonomia de 38 categorias (com categoria DRE e natureza), classificar automaticamente boletos/NFs/comprovantes por fornecedor cadastrado, reconciliar entrada de estoque com o boleto DDA correspondente sem duplicar, e permitir lançar despesas fotografando o comprovante e mandando pelo WhatsApp para um número dedicado do financeiro.

**Architecture:** Uma tabela `tipos_despesa` (lookup, 38 linhas) substitui o `ENUM`. A tabela `fornecedores` (já existente) ganha uma coluna `tipo_despesa_padrao_id` que funciona como "memória" de classificação — sem tabela paralela. Um motor central `criarOuReconciliarContaPagar()` em `contas-pagar/service.js` é o único ponto de entrada para gravar uma nova dívida a partir de DDA, entrada de estoque ou WhatsApp — ele decide se mescla com uma conta pendente existente (mesmo fornecedor+valor) ou cria uma nova. O fluxo de WhatsApp roda por um número dedicado (não Cloud API própria — é só um remetente autorizado enviando para o número do chatbot já existente), reaproveitando o webhook e o cliente OpenAI (`gpt-4o`, visão) já usados no agente.

**Tech Stack:** Node.js/Express, PostgreSQL, `openai` (já instalado), `date-fns`, Jest.

---

## Mapa de arquivos

```
sql/migrations/051_tipos_despesa.sql                    [CREATE]
sql/migrations/052_whatsapp_ocr_despesas.sql             [CREATE]
src/modules/contas-pagar/fornecedor-matcher.js           [CREATE]
src/modules/contas-pagar/classificador.js                [CREATE]
src/modules/contas-pagar/ocr.js                          [CREATE]
src/modules/contas-pagar/whatsapp.js                     [CREATE]
src/modules/contas-pagar/service.js                      [MODIFY]
src/modules/contas-pagar/router.js                       [MODIFY]
src/modules/entradas/service.js                          [MODIFY]
src/modules/revenda-compras/service.js                   [MODIFY]
src/modules/analises/service.js                          [MODIFY]
src/webhook/routes.js                                    [MODIFY]
src/jobs/contas-pagar.js                                 [MODIFY]
public/pwa/financeiro.html                                [MODIFY]
.env.example                                              [MODIFY]
tests/contas-pagar-fornecedor-matcher.test.js             [CREATE]
tests/contas-pagar-classificador.test.js                  [CREATE]
tests/contas-pagar-ocr.test.js                             [CREATE]
tests/contas-pagar-service.test.js                         [CREATE]
tests/contas-pagar-whatsapp.test.js                        [CREATE]
```

---

### Task 1: Migration 051 — tabela `tipos_despesa` + `fornecedores.tipo_despesa_padrao_id` + `contas_pagar.fornecedor_id`/`tipo_despesa_id`

**Files:**
- Create: `sql/migrations/051_tipos_despesa.sql`

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- sql/migrations/051_tipos_despesa.sql
-- Substitui o ENUM tipo_despesa_enum (18 valores antigos) por uma tabela com 38
-- categorias, categoria DRE e natureza do gasto. Liga contas_pagar e fornecedores
-- ao cadastro real de fornecedores (fornecedores.id é UUID).

BEGIN;

CREATE TABLE tipos_despesa (
  id            SERIAL PRIMARY KEY,
  codigo        VARCHAR(2) UNIQUE NOT NULL,
  nome          TEXT NOT NULL,
  categoria_dre TEXT NOT NULL,
  natureza      TEXT NOT NULL,
  ativo         BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO tipos_despesa (codigo, nome, categoria_dre, natureza) VALUES
('01','PAPEL E SUBSTRATOS','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('02','TINTAS E QUÍMICOS','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('03','FORNECEDOR (Outros insumos)','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('04','EMBALAGEM','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('05','TERCEIRIZAÇÃO DE IMPRESSÃO','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('06','TERCEIRIZAÇÃO DE ACABAMENTO','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('07','FRETE (Entrega de pedidos)','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('08','COMISSÕES','DEDUÇÕES E DESPESAS COMERCIAIS','VARIÁVEL (VENDAS)'),
('09','PUBLICIDADE','DEDUÇÕES E DESPESAS COMERCIAIS','VARIÁVEL (VENDAS)'),
('10','IMPOSTOS (Sobre o Faturamento)','DEDUÇÕES DE VENDAS','VARIÁVEL (FISCAL)'),
('11','SALÁRIOS DA PRODUÇÃO + ENCARGOS','MÃO DE OBRA DIRETA (MOD)','FIXO OPERACIONAL'),
('12','BENEFÍCIOS (Vale Transporte | Refeição)','MÃO DE OBRA DIRETA (MOD)','FIXO OPERACIONAL'),
('13','MANUTENÇÃO DE MAQUINÁRIO','CUSTOS OPERACIONAIS DA FÁBRICA','FIXO OPERACIONAL'),
('14','DEPRECIAÇÃO (Máquinas e Equipamentos)','CUSTOS OPERACIONAIS DA FÁBRICA','FIXO OPERACIONAL'),
('15','ALUGUEL','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('16','AGUA','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('17','LUZ','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('18','TELEFONIA | INTERNET','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('19','MATERIAL DE LIMPEZA','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('20','MATERIAL DE ESCRITORIO','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('21','MANUTENÇAO (Predial)','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('22','IPTU | TAXAS E ALVARÁS','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('23','SALARIO SOCIOS (Pró-Labore)','PESSOAL E ADMINISTRAÇÃO','FIXO ADMINISTRATIVO'),
('24','CONTADOR | FOLHA PAGAMENTO','SERVIÇOS PROFISSIONAIS','FIXO ADMINISTRATIVO'),
('25','SERVIÇO TERCEIRIZADO (ADM)','SERVIÇOS PROFISSIONAIS','FIXO ADMINISTRATIVO'),
('26','ADVOGADO','SERVIÇOS PROFISSIONAIS','FIXO ADMINISTRATIVO'),
('27','SOFTWARE E ASSINATURAS (Sistema | Hospedagem)','SERVIÇOS PROFISSIONAIS','FIXO ADMINISTRATIVO'),
('28','SEGUROS (Equipamento | Predial | Veicular)','SEGUROS','FIXO ADMINISTRATIVO'),
('29','COMBUSTIVEL','LOGÍSTICA E DESLOCAMENTO','FIXO ADMINISTRATIVO'),
('30','PEDAGIO','LOGÍSTICA E DESLOCAMENTO','FIXO ADMINISTRATIVO'),
('31','IPVA | LICENCIAMENTO VEÍCULO','LOGÍSTICA E DESLOCAMENTO','FIXO ADMINISTRATIVO'),
('32','DESPESA DE VIAGEM','VIAGENS E REPRESENTAÇÃO','FIXO ADMINISTRATIVO'),
('33','ESTADIA HOTEL','VIAGENS E REPRESENTAÇÃO','FIXO ADMINISTRATIVO'),
('34','ALIMENTAÇAO EM VIAGEM','VIAGENS E REPRESENTAÇÃO','FIXO ADMINISTRATIVO'),
('35','TARIFA BANCO','DESPESAS FINANCEIRAS','RESULTADO FINANCEIRO'),
('36','EMPRESTIMO | FINANCIAMENTO (Juros)','DESPESAS FINANCEIRAS','RESULTADO FINANCEIRO'),
('37','MULTAS E PENALIDADES','OUTROS','NÃO OPERACIONAL'),
('38','OUTRAS DESPESAS','OUTROS','NÃO OPERACIONAL');

-- Novo status 'pendente_classificacao' precisa existir antes do CHECK que o referencia.
-- Nome real da constraint confirmado com: psql "$DATABASE_URL" -c "\d contas_pagar"
ALTER TABLE contas_pagar DROP CONSTRAINT contas_pagar_status_check;
ALTER TABLE contas_pagar ADD CONSTRAINT contas_pagar_status_check
  CHECK (status IN ('pendente','pendente_classificacao','agendado','pago','vencido','cancelado'));

-- fornecedor_id: fornecedores.id é UUID (ver sql/migrations/001_sprint1_foundation.sql)
ALTER TABLE contas_pagar ADD COLUMN fornecedor_id UUID REFERENCES fornecedores(id);
CREATE INDEX idx_contas_pagar_fornecedor_id ON contas_pagar(fornecedor_id);

-- Memória de classificação: 1 fornecedor = 1 categoria padrão
ALTER TABLE fornecedores ADD COLUMN tipo_despesa_padrao_id INTEGER REFERENCES tipos_despesa(id);

-- tipo_despesa_id nasce nullable: contas sem classificação automática (status='pendente_classificacao')
-- ficam sem tipo até classificação manual; todas as outras são obrigadas a ter um tipo.
ALTER TABLE contas_pagar ADD COLUMN tipo_despesa_id INTEGER REFERENCES tipos_despesa(id);

-- Migra os dados existentes do enum antigo para o código novo mais próximo
UPDATE contas_pagar cp SET tipo_despesa_id = td.id FROM tipos_despesa td WHERE
  (cp.tipo_despesa = 'ALUGUEL' AND td.codigo = '15') OR
  (cp.tipo_despesa = 'AGUA' AND td.codigo = '16') OR
  (cp.tipo_despesa = 'TARIFA_BANCO' AND td.codigo = '35') OR
  (cp.tipo_despesa = 'FRETE' AND td.codigo = '07') OR
  (cp.tipo_despesa = 'COMBUSTIVEL' AND td.codigo = '29') OR
  (cp.tipo_despesa = 'TELEFONIA_INTERNET' AND td.codigo = '18') OR
  (cp.tipo_despesa = 'MATERIAL_LIMPEZA' AND td.codigo = '19') OR
  (cp.tipo_despesa = 'MATERIAL_ESCRITORIO' AND td.codigo = '20') OR
  (cp.tipo_despesa = 'DESPESA_VIAGEM' AND td.codigo = '32') OR
  (cp.tipo_despesa = 'LUZ' AND td.codigo = '17') OR
  (cp.tipo_despesa = 'IMPOSTOS' AND td.codigo = '10') OR
  (cp.tipo_despesa = 'MANUTENCAO' AND td.codigo = '13') OR
  (cp.tipo_despesa = 'COMISSOES' AND td.codigo = '08') OR
  (cp.tipo_despesa = 'FORNECEDOR' AND td.codigo = '03') OR
  (cp.tipo_despesa = 'SERVICO_TERCEIRIZADO' AND td.codigo = '25') OR
  (cp.tipo_despesa = 'EMPRESTIMO_FINANCIAMENTO' AND td.codigo = '36') OR
  (cp.tipo_despesa = 'CONTADOR_FOLHA_PAGAMENTO' AND td.codigo = '24') OR
  (cp.tipo_despesa = 'OUTRAS_DESPESAS' AND td.codigo = '38');

-- Toda conta pré-existente já tem tipo_despesa_id preenchido nesse ponto (nenhuma tinha
-- status='pendente_classificacao' até agora).
ALTER TABLE contas_pagar ADD CONSTRAINT chk_tipo_despesa_classificado
  CHECK (tipo_despesa_id IS NOT NULL OR status = 'pendente_classificacao');

ALTER TABLE contas_pagar DROP COLUMN tipo_despesa;
DROP TYPE tipo_despesa_enum;

CREATE INDEX idx_contas_pagar_tipo_despesa_id ON contas_pagar(tipo_despesa_id);

COMMIT;
```

- [ ] **Step 2: Confirmar o nome real da constraint de status antes de aplicar**

```bash
psql "$DATABASE_URL" -c "\d contas_pagar" | grep -i check
```

Se o nome mostrado for diferente de `contas_pagar_status_check`, edite o `DROP CONSTRAINT` no arquivo da Step 1 com o nome correto antes de continuar.

- [ ] **Step 3: Aplicar a migration no banco local/dev**

```bash
psql "$DATABASE_URL" -f sql/migrations/051_tipos_despesa.sql
```

Expected: `COMMIT` sem erros.

- [ ] **Step 4: Verificar**

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM tipos_despesa;"
psql "$DATABASE_URL" -c "\d contas_pagar" | grep -E "tipo_despesa_id|fornecedor_id"
psql "$DATABASE_URL" -c "\d fornecedores" | grep tipo_despesa_padrao_id
psql "$DATABASE_URL" -c "SELECT id, tipo_despesa_id, status FROM contas_pagar LIMIT 5;"
```

Expected: `COUNT` = 38; as três colunas aparecem nas respectivas tabelas; contas antigas (se houver) com `tipo_despesa_id` preenchido.

- [ ] **Step 5: Commit**

```bash
git add sql/migrations/051_tipos_despesa.sql
git commit -m "feat(contas-pagar): migration 051 — tabela tipos_despesa (38 categorias) substitui o enum"
```

---

### Task 2: Migration 052 — `despesas_pendentes_confirmacao` + `entradas_estoque.conta_pagar_id` + `tipo_entrada` novo valor

**Files:**
- Create: `sql/migrations/052_whatsapp_ocr_despesas.sql`

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- sql/migrations/052_whatsapp_ocr_despesas.sql
BEGIN;

CREATE TABLE despesas_pendentes_confirmacao (
  id              SERIAL PRIMARY KEY,
  telefone        TEXT NOT NULL,
  fornecedor_id   UUID REFERENCES fornecedores(id),
  valor           NUMERIC(10,2),
  vencimento      DATE,
  descricao       TEXT,
  tipo_despesa_id INTEGER REFERENCES tipos_despesa(id),
  criado_em       TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_despesas_pendentes_telefone ON despesas_pendentes_confirmacao(telefone);

-- Liga a entrada de estoque (NF de compra) à conta a pagar gerada por ela,
-- mesmo padrão já usado em revenda_compras.conta_pagar_id (migration 048).
ALTER TABLE entradas_estoque ADD COLUMN conta_pagar_id INTEGER REFERENCES contas_pagar(id) ON DELETE SET NULL;

ALTER TABLE contas_pagar DROP CONSTRAINT contas_pagar_tipo_entrada_check;
ALTER TABLE contas_pagar ADD CONSTRAINT contas_pagar_tipo_entrada_check
  CHECK (tipo_entrada IN ('manual','dda','importacao_oc','whatsapp_ocr','entrada_estoque'));

COMMIT;
```

- [ ] **Step 2: Confirmar o nome real da constraint de tipo_entrada antes de aplicar**

```bash
psql "$DATABASE_URL" -c "\d contas_pagar" | grep -i tipo_entrada
```

Ajuste o nome no `DROP CONSTRAINT` se necessário (mesma ressalva da Task 1).

- [ ] **Step 3: Aplicar a migration**

```bash
psql "$DATABASE_URL" -f sql/migrations/052_whatsapp_ocr_despesas.sql
```

Expected: `COMMIT` sem erros.

- [ ] **Step 4: Verificar**

```bash
psql "$DATABASE_URL" -c "\d despesas_pendentes_confirmacao"
psql "$DATABASE_URL" -c "\d entradas_estoque" | grep conta_pagar_id
```

- [ ] **Step 5: Commit**

```bash
git add sql/migrations/052_whatsapp_ocr_despesas.sql
git commit -m "feat(contas-pagar): migration 052 — despesas_pendentes_confirmacao + entradas_estoque.conta_pagar_id"
```

---

### Task 3: `fornecedor-matcher.js` — casar/criar fornecedor por CNPJ ou nome

**Files:**
- Create: `src/modules/contas-pagar/fornecedor-matcher.js`
- Test: `tests/contas-pagar-fornecedor-matcher.test.js`

- [ ] **Step 1: Escrever os testes (mock do db)**

```js
// tests/contas-pagar-fornecedor-matcher.test.js
const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { normalizarNome, soDigitos, encontrarOuCriarFornecedor } = require('../src/modules/contas-pagar/fornecedor-matcher');

describe('normalizarNome', () => {
  test('maiusculas, sem acento, sem pontuação', () => {
    expect(normalizarNome('Gráfica São João Ltda.')).toBe('GRAFICA SAO JOAO LTDA');
  });
  test('vazio', () => { expect(normalizarNome('')).toBe(''); });
  test('nulo', () => { expect(normalizarNome(null)).toBe(''); });
});

describe('soDigitos', () => {
  test('remove tudo que não é dígito', () => { expect(soDigitos('12.345.678/0001-99')).toBe('12345678000199'); });
  test('vazio/nulo', () => { expect(soDigitos('')).toBe(''); expect(soDigitos(null)).toBe(''); });
});

describe('encontrarOuCriarFornecedor', () => {
  afterEach(() => jest.clearAllMocks());

  test('acha por CNPJ', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-1', nome: 'Fornecedor X' }] }); // busca por CNPJ
    const f = await encontrarOuCriarFornecedor({ nome: 'Fornecedor X Ltda', cnpj: '12.345.678/0001-99' });
    expect(f.id).toBe('uuid-1');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('sem CNPJ, acha por nome normalizado', async () => {
    const f2 = await encontrarOuCriarFornecedor.__proto__; // no-op, mantém lint feliz
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-2', nome: 'Papelaria Central' }] }); // busca por nome
    const f = await encontrarOuCriarFornecedor({ nome: 'Papelaria Central' });
    expect(f.id).toBe('uuid-2');
  });

  test('sem match nenhum, cria fornecedor novo', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // busca por CNPJ
      .mockResolvedValueOnce({ rows: [] }) // busca por nome
      .mockResolvedValueOnce({ rows: [{ id: 'uuid-3', nome: 'Novo Fornecedor', cnpj: '11222333000144' }] }); // insert
    const f = await encontrarOuCriarFornecedor({ nome: 'Novo Fornecedor', cnpj: '11.222.333/0001-44' });
    expect(f.id).toBe('uuid-3');
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  test('sem nome e sem cnpj → null', async () => {
    const f = await encontrarOuCriarFornecedor({});
    expect(f).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar os testes e confirmar que falham**

```bash
npx jest tests/contas-pagar-fornecedor-matcher.test.js
```

Expected: FAIL — `Cannot find module '../src/modules/contas-pagar/fornecedor-matcher'`.

- [ ] **Step 3: Remover o teste inútil que ficou no rascunho (linha `__proto__`)**

Edite `tests/contas-pagar-fornecedor-matcher.test.js` e apague a linha:
```js
    const f2 = await encontrarOuCriarFornecedor.__proto__; // no-op, mantém lint feliz
```
(Ela não faz parte do teste — era um resíduo de digitação; o teste `'sem CNPJ, acha por nome normalizado'` deve ficar assim:)

```js
  test('sem CNPJ, acha por nome normalizado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'uuid-2', nome: 'Papelaria Central' }] }); // busca por nome
    const f = await encontrarOuCriarFornecedor({ nome: 'Papelaria Central' });
    expect(f.id).toBe('uuid-2');
  });
```

- [ ] **Step 4: Implementar `fornecedor-matcher.js`**

```js
// src/modules/contas-pagar/fornecedor-matcher.js
const db = require('../../db');

function normalizarNome(nome) {
  return String(nome || '').toUpperCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, '').trim();
}

function soDigitos(s) { return String(s || '').replace(/\D/g, ''); }

async function buscarPorCnpj(cnpj) {
  const digitos = soDigitos(cnpj);
  if (!digitos) return null;
  const r = await db.query(
    `SELECT * FROM fornecedores WHERE regexp_replace(COALESCE(cnpj,''), '\\D', '', 'g') = $1 LIMIT 1`,
    [digitos]
  );
  return r.rows[0] || null;
}

async function buscarPorNome(nome) {
  const norm = normalizarNome(nome);
  if (!norm) return null;
  const r = await db.query(
    `SELECT * FROM fornecedores WHERE regexp_replace(UPPER(nome), '[^A-Z0-9 ]', '', 'g') = $1 LIMIT 1`,
    [norm]
  );
  return r.rows[0] || null;
}

async function criarFornecedor({ nome, cnpj }) {
  const r = await db.query(
    `INSERT INTO fornecedores (nome, cnpj, status) VALUES ($1,$2,'ativo') RETURNING *`,
    [nome, cnpj || null]
  );
  return r.rows[0];
}

// Casa por CNPJ (se informado), depois por nome; sem match nenhum, cadastra um fornecedor mínimo.
async function encontrarOuCriarFornecedor({ nome, cnpj }) {
  if (!nome && !cnpj) return null;
  if (cnpj) {
    const porCnpj = await buscarPorCnpj(cnpj);
    if (porCnpj) return porCnpj;
  }
  if (nome) {
    const porNome = await buscarPorNome(nome);
    if (porNome) return porNome;
  }
  return criarFornecedor({ nome: nome || 'Fornecedor não identificado', cnpj });
}

module.exports = { normalizarNome, soDigitos, buscarPorCnpj, buscarPorNome, criarFornecedor, encontrarOuCriarFornecedor };
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

```bash
npx jest tests/contas-pagar-fornecedor-matcher.test.js
```

Expected: PASS — 7 testes.

- [ ] **Step 6: Commit**

```bash
git add src/modules/contas-pagar/fornecedor-matcher.js tests/contas-pagar-fornecedor-matcher.test.js
git commit -m "feat(contas-pagar): fornecedor-matcher — casar/criar fornecedor por CNPJ ou nome"
```

---

### Task 4: `classificador.js` — memória do fornecedor + fallback por palavra-chave

**Files:**
- Create: `src/modules/contas-pagar/classificador.js`
- Test: `tests/contas-pagar-classificador.test.js`

- [ ] **Step 1: Escrever os testes**

```js
// tests/contas-pagar-classificador.test.js
const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));

const { classificarPorPalavraChave, classificarDespesa } = require('../src/modules/contas-pagar/classificador');

describe('classificarPorPalavraChave', () => {
  test('papel/substrato → 01', () => { expect(classificarPorPalavraChave('Compra de Papel Couché 90g')).toBe('01'); });
  test('posto de combustível → 29', () => { expect(classificarPorPalavraChave('Posto Ipiranga - combustível')).toBe('29'); });
  test('Enel → 17 (luz)', () => { expect(classificarPorPalavraChave('ENEL DISTRIBUICAO')).toBe('17'); });
  test('sem termo conhecido → null', () => { expect(classificarPorPalavraChave('xyz aleatorio')).toBeNull(); });
});

describe('classificarDespesa', () => {
  afterEach(() => jest.clearAllMocks());

  test('fornecedor já tem tipo_despesa_padrao_id → usa a memória', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ tipo_despesa_padrao_id: 7 }] });
    const r = await classificarDespesa({ fornecedorId: 'uuid-1', nomeFornecedor: 'Qualquer', descricao: null });
    expect(r).toEqual({ tipo_despesa_id: 7, origem: 'fornecedor' });
  });

  test('sem memória, mas bate por palavra-chave → busca o id do código', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ tipo_despesa_padrao_id: null }] }) // fornecedor sem memória
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });                       // SELECT id FROM tipos_despesa WHERE codigo='01'
    const r = await classificarDespesa({ fornecedorId: 'uuid-2', nomeFornecedor: 'Distribuidora de Papel', descricao: null });
    expect(r).toEqual({ tipo_despesa_id: 1, origem: 'keyword' });
  });

  test('sem fornecedorId, sem keyword → nenhum', async () => {
    const r = await classificarDespesa({ fornecedorId: null, nomeFornecedor: 'xyz', descricao: null });
    expect(r).toEqual({ tipo_despesa_id: null, origem: 'nenhum' });
    expect(db.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

```bash
npx jest tests/contas-pagar-classificador.test.js
```

Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `classificador.js`**

```js
// src/modules/contas-pagar/classificador.js
const db = require('../../db');

// Fallback por palavra-chave — só usado quando o fornecedor é novo/sem memória.
// Tipos sem termo léxico natural (Pró-Labore, Depreciação etc.) ficam de fora —
// só a memória de fornecedor ou a classificação manual resolvem esses.
const KEYWORDS = {
  '01': ['PAPEL', 'SUBSTRATO', 'COUCHE', 'COUCHÊ', 'OFFSET'],
  '02': ['TINTA', 'QUIMICO', 'QUÍMICO', 'TONER'],
  '13': ['MANUTENCAO', 'MANUTENÇÃO', 'CONSERTO', 'PECA', 'PEÇA', 'MAQUINA', 'MÁQUINA'],
  '16': ['SABESP', 'COPASA', 'AGUA', 'ÁGUA'],
  '17': ['ENEL', 'CEMIG', 'LUZ', 'ENERGIA'],
  '18': ['VIVO', 'CLARO', 'TIM', 'INTERNET', 'TELEFONIA'],
  '27': ['HOSPEDAGEM', 'DOMINIO', 'DOMÍNIO', 'SAAS', 'ASSINATURA', 'SOFTWARE'],
  '29': ['POSTO', 'COMBUSTIVEL', 'COMBUSTÍVEL', 'GASOLINA', 'ETANOL'],
  '30': ['PEDAGIO', 'PEDÁGIO', 'SEM PARAR', 'CONECTCAR'],
};

function _normTexto(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function classificarPorPalavraChave(texto) {
  const norm = _normTexto(texto);
  for (const [codigo, palavras] of Object.entries(KEYWORDS)) {
    if (palavras.some(p => norm.includes(_normTexto(p)))) return codigo;
  }
  return null;
}

async function _tipoDespesaIdPorCodigo(codigo) {
  const r = await db.query('SELECT id FROM tipos_despesa WHERE codigo = $1', [codigo]);
  return r.rows[0]?.id || null;
}

// Função pública, usada por DDA / manual / entrada de estoque / WhatsApp.
async function classificarDespesa({ fornecedorId, nomeFornecedor, descricao }) {
  if (fornecedorId) {
    const f = await db.query('SELECT tipo_despesa_padrao_id FROM fornecedores WHERE id = $1', [fornecedorId]);
    if (f.rows[0]?.tipo_despesa_padrao_id) {
      return { tipo_despesa_id: f.rows[0].tipo_despesa_padrao_id, origem: 'fornecedor' };
    }
  }
  const codigo = classificarPorPalavraChave(`${nomeFornecedor || ''} ${descricao || ''}`);
  if (codigo) {
    const id = await _tipoDespesaIdPorCodigo(codigo);
    if (id) return { tipo_despesa_id: id, origem: 'keyword' };
  }
  return { tipo_despesa_id: null, origem: 'nenhum' };
}

module.exports = { classificarPorPalavraChave, classificarDespesa };
```

- [ ] **Step 4: Rodar e confirmar sucesso**

```bash
npx jest tests/contas-pagar-classificador.test.js
```

Expected: PASS — 7 testes.

- [ ] **Step 5: Commit**

```bash
git add src/modules/contas-pagar/classificador.js tests/contas-pagar-classificador.test.js
git commit -m "feat(contas-pagar): classificador — memória do fornecedor + fallback por palavra-chave"
```

---

### Task 5: `service.js` — `criarOuReconciliarContaPagar`, `sincronizarDDA` sem duplicar, CRUD com `fornecedor_id`/`tipo_despesa_id`

**Files:**
- Modify: `src/modules/contas-pagar/service.js`
- Test: `tests/contas-pagar-service.test.js`

- [ ] **Step 1: Escrever os testes do novo comportamento**

```js
// tests/contas-pagar-service.test.js
const db = require('../src/db');
jest.mock('../src/db', () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));
jest.mock('../src/services/c6bank', () => ({ consultarDDA: jest.fn() }));

const c6bank = require('../src/services/c6bank');
const service = require('../src/modules/contas-pagar/service');

function mockClient(queryImpl) {
  return { query: jest.fn(queryImpl), release: jest.fn() };
}

describe('criarOuReconciliarContaPagar', () => {
  afterEach(() => jest.clearAllMocks());

  test('acha 1 correspondência (entrada de estoque pendente) → mescla, não duplica', async () => {
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) {
        return Promise.resolve({ rows: [{ id: 10, tipo_despesa_id: 5 }] });
      }
      if (sql.startsWith('UPDATE contas_pagar')) {
        return Promise.resolve({ rows: [{ id: 10, linha_digitavel: '123', status: 'pendente' }] });
      }
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-1', fornecedorNome: 'Papelaria X', descricao: 'NF 123',
      valor: 500, vencimento: '2026-08-10', tipoDespesaId: 5, tipoEntrada: 'dda', linhaDigitavel: '123',
    });

    expect(r.id).toBe(10);
    expect(client.query.mock.calls.some(c => c[0].startsWith('INSERT INTO contas_pagar'))).toBe(false);
  });

  test('zero correspondências → insere nova', async () => {
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) return Promise.resolve({ rows: [] });
      if (sql.startsWith('INSERT INTO contas_pagar')) return Promise.resolve({ rows: [{ id: 20 }] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-2', fornecedorNome: 'Fornecedor Novo', descricao: 'Boleto DDA',
      valor: 300, vencimento: '2026-08-15', tipoDespesaId: 3, tipoEntrada: 'dda', linhaDigitavel: '456',
    });

    expect(r.id).toBe(20);
  });

  test('duas ou mais correspondências → insere nova (evita mesclar errado)', async () => {
    const client = mockClient((sql) => {
      if (sql.startsWith('BEGIN')) return Promise.resolve();
      if (sql.startsWith('SELECT * FROM contas_pagar')) {
        return Promise.resolve({ rows: [{ id: 30 }, { id: 31 }] });
      }
      if (sql.startsWith('INSERT INTO contas_pagar')) return Promise.resolve({ rows: [{ id: 40 }] });
      if (sql.startsWith('COMMIT')) return Promise.resolve();
      throw new Error('query inesperada: ' + sql);
    });
    db.pool.connect.mockResolvedValueOnce(client);

    const r = await service.criarOuReconciliarContaPagar({
      fornecedorId: 'uuid-3', fornecedorNome: 'Ambíguo', descricao: 'x',
      valor: 100, vencimento: '2026-08-01', tipoDespesaId: 3, tipoEntrada: 'manual',
    });

    expect(r.id).toBe(40);
  });
});

describe('sincronizarDDA', () => {
  afterEach(() => jest.clearAllMocks());

  test('boleto com linha_digitavel já importada → ignora, não reprocessa', async () => {
    c6bank.consultarDDA.mockResolvedValueOnce([{ content: 'LD-1', beneficiary_name: 'X', amount: 10, due_date: '2026-08-01' }]);
    db.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // já existe conta com essa linha_digitavel

    const r = await service.sincronizarDDA();
    expect(r).toEqual({ total: 1, importados: 0, ignorados: 1 });
  });

  test('boleto sem content → ignora', async () => {
    c6bank.consultarDDA.mockResolvedValueOnce([{ beneficiary_name: 'Y', amount: 10, due_date: '2026-08-01' }]);
    const r = await service.sincronizarDDA();
    expect(r).toEqual({ total: 1, importados: 0, ignorados: 1 });
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

```bash
npx jest tests/contas-pagar-service.test.js
```

Expected: FAIL — `criarOuReconciliarContaPagar is not a function`.

- [ ] **Step 3: Implementar as mudanças em `service.js`**

No topo do arquivo, adicionar os requires novos:

```js
const { query, pool } = require('../../db');
const c6bank = require('../../services/c6bank');
const { format, subDays } = require('date-fns');
const fornecedorMatcher = require('./fornecedor-matcher');
const classificador = require('./classificador');
```

Substituir `listar` para trazer o nome/código do tipo de despesa (JOIN) e filtrar por `tipo_despesa_id`:

```js
async function listar({ status, tipo_despesa_id, vencimento_de, vencimento_ate, dias } = {}) {
  const conds = [];
  const params = [];

  if (status) { params.push(status); conds.push(`cp.status = $${params.length}`); }
  if (tipo_despesa_id) { params.push(tipo_despesa_id); conds.push(`cp.tipo_despesa_id = $${params.length}`); }
  if (vencimento_de) { params.push(vencimento_de); conds.push(`cp.vencimento >= $${params.length}`); }
  if (vencimento_ate) { params.push(vencimento_ate); conds.push(`cp.vencimento <= $${params.length}`); }
  if (dias !== undefined) {
    const hoje = format(new Date(), 'yyyy-MM-dd');
    const ate = format(new Date(Date.now() + dias * 86400000), 'yyyy-MM-dd');
    params.push(hoje); conds.push(`cp.vencimento >= $${params.length}`);
    params.push(ate);  conds.push(`cp.vencimento <= $${params.length}`);
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await query(
    `SELECT cp.*, td.nome AS tipo_despesa_nome, td.codigo AS tipo_despesa_codigo
     FROM contas_pagar cp
     LEFT JOIN tipos_despesa td ON td.id = cp.tipo_despesa_id
     ${where} ORDER BY cp.vencimento ASC, cp.id ASC`,
    params
  );
  return r.rows;
}
```

Substituir `criar`:

```js
async function criar({ descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo, linha_digitavel, pix_content, tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao }) {
  if (!descricao || !tipo_despesa_id || !valor || !vencimento) {
    return { erro: ['descricao, tipo_despesa_id, valor e vencimento são obrigatórios'] };
  }
  const r = await query(
    `INSERT INTO contas_pagar
       (descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo, linha_digitavel, pix_content,
        tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [descricao, fornecedor || null, fornecedor_id || null, tipo_despesa_id, valor, vencimento,
     tipo || 'outro', linha_digitavel || null, pix_content || null,
     tipo_entrada || 'manual', recorrente || false, recorrencia_dia || null,
     recorrencia_valor_fixo !== false, observacao || null]
  );
  if (fornecedor_id) await gravarMemoriaFornecedor(fornecedor_id, tipo_despesa_id);
  return r.rows[0];
}
```

Substituir `editar` (permite editar também quando `pendente_classificacao`, e volta o status para `pendente` ao classificar):

```js
async function editar(id, campos) {
  const conta = await buscarPorId(id);
  if (!conta) return { erro: ['Conta não encontrada'] };
  if (!['pendente', 'pendente_classificacao'].includes(conta.status)) {
    return { erro: ['Só é possível editar contas com status pendente'] };
  }

  const permitidos = ['descricao','fornecedor','fornecedor_id','tipo_despesa_id','valor','vencimento','tipo',
                      'linha_digitavel','pix_content','recorrente','recorrencia_dia',
                      'recorrencia_valor_fixo','observacao'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(campos)) {
    if (permitidos.includes(k)) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (!sets.length) return { erro: ['Nenhum campo válido para atualizar'] };
  if (campos.tipo_despesa_id && conta.status === 'pendente_classificacao') {
    sets.push(`status = 'pendente'`);
  }
  params.push(id);
  const r = await query(
    `UPDATE contas_pagar SET ${sets.join(', ')}, updated_at=NOW() WHERE id = $${params.length} RETURNING *`,
    params
  );
  const atualizada = r.rows[0];
  if (atualizada.fornecedor_id && campos.tipo_despesa_id) {
    await gravarMemoriaFornecedor(atualizada.fornecedor_id, campos.tipo_despesa_id);
  }
  return atualizada;
}
```

Substituir `criarRecorrente` (troca `tipo_despesa` por `tipo_despesa_id`/`fornecedor_id`, grava memória uma vez):

```js
async function criarRecorrente({ descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, tipo, linha_digitavel, pix_content, recorrencia_dia, recorrencia_valor_fixo, observacao }) {
  if (!descricao || !tipo_despesa_id || !valor || !recorrencia_dia) {
    return { erro: ['descricao, tipo_despesa_id, valor e recorrencia_dia são obrigatórios'] };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const criadas = [];
    const hoje = new Date();
    for (let m = 0; m < 12; m++) {
      const data = new Date(hoje.getFullYear(), hoje.getMonth() + m, recorrencia_dia);
      const valorInst = recorrencia_valor_fixo !== false ? valor : 0;
      const r = await client.query(
        `INSERT INTO contas_pagar
           (descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo, linha_digitavel, pix_content,
            tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',true,$10,$11,$12) RETURNING *`,
        [descricao, fornecedor || null, fornecedor_id || null, tipo_despesa_id, valorInst,
         format(data, 'yyyy-MM-dd'), tipo || 'outro',
         linha_digitavel || null, pix_content || null,
         recorrencia_dia, recorrencia_valor_fixo !== false, observacao || null]
      );
      criadas.push(r.rows[0]);
    }
    await client.query('COMMIT');
    if (fornecedor_id) await gravarMemoriaFornecedor(fornecedor_id, tipo_despesa_id);
    return { criadas };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

Substituir `sincronizarDDA`:

```js
async function sincronizarDDA() {
  const boletos = await c6bank.consultarDDA();
  let importados = 0;
  let ignorados = 0;
  for (const b of boletos) {
    if (!b.content) { ignorados++; continue; }
    try {
      const jaImportado = await query(
        `SELECT id FROM contas_pagar WHERE linha_digitavel = $1 AND status != 'cancelado'`,
        [b.content]
      );
      if (jaImportado.rows.length) { ignorados++; continue; }

      const fornecedor = await fornecedorMatcher.encontrarOuCriarFornecedor({ nome: b.beneficiary_name });
      await criarOuReconciliarContaPagar({
        fornecedorId: fornecedor?.id || null,
        fornecedorNome: fornecedor?.nome || b.beneficiary_name || 'Boleto DDA',
        descricao: fornecedor?.nome || b.beneficiary_name || 'Boleto DDA',
        valor: b.amount,
        vencimento: b.due_date,
        linhaDigitavel: b.content,
        tipo: 'boleto',
        tipoEntrada: 'dda',
      });
      importados++;
    } catch (err) { console.error('[CONTAS-PAGAR] sincronizarDDA erro ao inserir boleto:', err.message); ignorados++; }
  }
  return { total: boletos.length, importados, ignorados };
}
```

Substituir `gerarRecorrentesProximoMes` (troca as colunas antigas):

```js
async function gerarRecorrentesProximoMes() {
  const r = await query(
    `SELECT DISTINCT ON (descricao, recorrencia_dia) * FROM contas_pagar
     WHERE recorrente=true AND status != 'cancelado'
     ORDER BY descricao, recorrencia_dia, created_at DESC`
  );
  const proximo = new Date();
  proximo.setMonth(proximo.getMonth() + 1);
  let geradas = 0;
  for (const c of r.rows) {
    const venc = new Date(proximo.getFullYear(), proximo.getMonth(), c.recorrencia_dia);
    const existe = await query(
      `SELECT 1 FROM contas_pagar WHERE descricao=$1 AND vencimento=$2 AND recorrente=true`,
      [c.descricao, format(venc, 'yyyy-MM-dd')]
    );
    if (existe.rowCount) continue;
    await query(
      `INSERT INTO contas_pagar (descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo,
        linha_digitavel, pix_content, tipo_entrada, recorrente, recorrencia_dia, recorrencia_valor_fixo, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',true,$10,$11,$12)`,
      [c.descricao, c.fornecedor, c.fornecedor_id, c.tipo_despesa_id,
       c.recorrencia_valor_fixo ? c.valor : 0,
       format(venc, 'yyyy-MM-dd'), c.tipo,
       c.linha_digitavel, c.pix_content, c.recorrencia_dia, c.recorrencia_valor_fixo, c.observacao]
    );
    geradas++;
  }
  return { geradas };
}
```

Adicionar as funções novas (antes do `module.exports`, na seção de escrita):

```js
// ─── CLASSIFICAÇÃO E RECONCILIAÇÃO ─────────────────────────────────────────

async function listarTiposDespesa() {
  const r = await query('SELECT id, codigo, nome, categoria_dre, natureza FROM tipos_despesa WHERE ativo = true ORDER BY codigo');
  return r.rows;
}

async function sugerirTipoDespesa({ fornecedor_id, fornecedor, descricao }) {
  return classificador.classificarDespesa({ fornecedorId: fornecedor_id || null, nomeFornecedor: fornecedor, descricao });
}

async function gravarMemoriaFornecedor(fornecedorId, tipoDespesaId) {
  if (!fornecedorId || !tipoDespesaId) return;
  await query('UPDATE fornecedores SET tipo_despesa_padrao_id = $1, updated_at = NOW() WHERE id = $2', [tipoDespesaId, fornecedorId]);
}

// Ponto único de entrada para gravar uma nova dívida a partir de DDA, entrada de estoque
// ou WhatsApp. Evita duplicar a mesma dívida (ex: NF lançada na entrada de estoque +
// boleto do mesmo fornecedor/valor chegando depois via DDA): se achar exatamente uma
// conta pendente do mesmo fornecedor com o mesmo valor (sem linha digitável ainda),
// mescla nela em vez de criar uma nova. Zero ou 2+ candidatas → cria nova (mais seguro
// que arriscar mesclar errado).
async function criarOuReconciliarContaPagar({ fornecedorId, fornecedorNome, valor, vencimento, descricao, tipoDespesaId, tipoEntrada, linhaDigitavel, tipo, origemId }) {
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
      const r = await client.query(`SELECT * FROM contas_pagar WHERE ${cond}`, params);
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
      if (!match.tipo_despesa_id && tipoFinal) {
        params.push(tipoFinal); sets.push(`tipo_despesa_id = $${params.length}`);
        sets.push(`status = 'pendente'`);
      }
      params.push(match.id);
      const r = await client.query(`UPDATE contas_pagar SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
      conta = r.rows[0];
    } else {
      const status = tipoFinal ? 'pendente' : 'pendente_classificacao';
      const r = await client.query(
        `INSERT INTO contas_pagar
           (descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo,
            linha_digitavel, tipo_entrada, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [descricao, fornecedorNome || null, fornecedorId || null, tipoFinal, valor,
         vencimento, tipo || 'boleto', linhaDigitavel || null, tipoEntrada, status]
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

Atualizar o `module.exports` final:

```js
module.exports = {
  listar, buscarPorId, kpis,
  criar, editar, cancelar, pagarManual,
  criarRecorrente,
  sincronizarDDA,
  listarLotes, criarLoteC6, consultarLoteC6, removerItemLoteC6, submeterLoteC6,
  reconciliar,
  marcarVencidas, contasVencendoEm, atualizarStatusLotesSubmetidos, gerarRecorrentesProximoMes,
  listarTiposDespesa, sugerirTipoDespesa, gravarMemoriaFornecedor, criarOuReconciliarContaPagar,
};
```

- [ ] **Step 4: Rodar os testes**

```bash
npx jest tests/contas-pagar-service.test.js
```

Expected: PASS — 5 testes.

- [ ] **Step 5: Rodar a suíte inteira pra checar regressão**

```bash
npm test
```

Expected: todos os testes passam (nenhum teste antigo referenciava `tipo_despesa`, conforme checado antes de escrever este plano).

- [ ] **Step 6: Commit**

```bash
git add src/modules/contas-pagar/service.js tests/contas-pagar-service.test.js
git commit -m "feat(contas-pagar): criarOuReconciliarContaPagar + sincronizarDDA sem duplicar + CRUD com fornecedor_id/tipo_despesa_id"
```

---

### Task 6: `router.js` — endpoints `tipos-despesa` e `sugerir-tipo`

**Files:**
- Modify: `src/modules/contas-pagar/router.js`

- [ ] **Step 1: Adicionar as duas rotas novas** (logo após a rota `GET /kpis`)

```js
// Tipos de despesa (taxonomia)
router.get('/tipos-despesa', admin, async (req, res) => {
  try { res.json(await service.listarTiposDespesa()); }
  catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});

// Sugestão de classificação automática
router.get('/sugerir-tipo', admin, async (req, res) => {
  try {
    const { fornecedor_id, fornecedor, descricao } = req.query;
    res.json(await service.sugerirTipoDespesa({ fornecedor_id, fornecedor, descricao }));
  } catch (err) { console.error('[CONTAS-PAGAR]', err); res.status(500).json({ error: 'Erro interno' }); }
});
```

- [ ] **Step 2: Ajustar a rota `GET /` para o novo nome do parâmetro de filtro**

Trocar:
```js
    const { status, tipo_despesa, vencimento_de, vencimento_ate, dias } = req.query;
    res.json(await service.listar({
      status, tipo_despesa, vencimento_de, vencimento_ate,
      dias: dias !== undefined ? parseInt(dias) : undefined,
    }));
```
por:
```js
    const { status, tipo_despesa_id, vencimento_de, vencimento_ate, dias } = req.query;
    res.json(await service.listar({
      status, tipo_despesa_id, vencimento_de, vencimento_ate,
      dias: dias !== undefined ? parseInt(dias) : undefined,
    }));
```

- [ ] **Step 3: Verificar manualmente (servidor local)**

```bash
npm run dev
```

Em outro terminal (substitua `$TOKEN` por um token admin válido):
```bash
curl -s http://localhost:3000/api/v2/contas-pagar/tipos-despesa -H "Authorization: Bearer $TOKEN" | head -c 300
```

Expected: JSON com 38 itens (`codigo`, `nome`, `categoria_dre`, `natureza`).

- [ ] **Step 4: Commit**

```bash
git add src/modules/contas-pagar/router.js
git commit -m "feat(contas-pagar): endpoints GET /tipos-despesa e GET /sugerir-tipo"
```

---

### Task 7: Corrigir `revenda-compras/service.js` e `analises/service.js` (dependiam da coluna antiga)

**Files:**
- Modify: `src/modules/revenda-compras/service.js:60-70`
- Modify: `src/modules/analises/service.js:24-28`

Esses dois arquivos inserem/consultam `contas_pagar.tipo_despesa` diretamente — a Task 1 removeu essa coluna, então eles quebram sem este ajuste.

- [ ] **Step 1: Corrigir o INSERT em `revenda-compras/service.js`**

Local: dentro de `criarCompra`, onde hoje diz:
```js
    const contaR = await client.query(
      `INSERT INTO contas_pagar
         (descricao, fornecedor, tipo_despesa, valor, vencimento, tipo, tipo_entrada, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [`Compra revenda #${numero} — pedido Graficonauta ${pedido_graficonauta || 's/nº'}`,
       'Graficonauta', 'SERVICO_TERCEIRIZADO', valor_compra, vencimento,
       'boleto', 'manual', `Gerada automaticamente da compra revenda #${numero}`]
    );
```
Trocar por (usa o código `05` — Terceirização de Impressão, categoria de produção — mais preciso que "Serviço Terceirizado (ADM)" pra uma compra de produto pronto de fornecedor):
```js
    const tipoDespesaR = await client.query(`SELECT id FROM tipos_despesa WHERE codigo = '05'`);
    const contaR = await client.query(
      `INSERT INTO contas_pagar
         (descricao, fornecedor, tipo_despesa_id, valor, vencimento, tipo, tipo_entrada, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [`Compra revenda #${numero} — pedido Graficonauta ${pedido_graficonauta || 's/nº'}`,
       'Graficonauta', tipoDespesaR.rows[0].id, valor_compra, vencimento,
       'boleto', 'manual', `Gerada automaticamente da compra revenda #${numero}`]
    );
```

- [ ] **Step 2: Corrigir a consulta de DRE em `analises/service.js`**

Local: dentro de `dre()`, onde hoje diz:
```js
  const despR = await db.query(
    `SELECT tipo_despesa AS categoria, COALESCE(SUM(valor),0) AS valor
     FROM contas_pagar WHERE status = 'pago' AND pago_em::date BETWEEN $1 AND $2
     GROUP BY tipo_despesa ORDER BY valor DESC`,
    [inicio, fim]);
```
Trocar por (agrupa pela categoria DRE de verdade, não pelo tipo individual — o objetivo de ter `categoria_dre` na taxonomia é justamente alimentar esse relatório):
```js
  const despR = await db.query(
    `SELECT td.categoria_dre AS categoria, COALESCE(SUM(cp.valor),0) AS valor
     FROM contas_pagar cp
     JOIN tipos_despesa td ON td.id = cp.tipo_despesa_id
     WHERE cp.status = 'pago' AND cp.pago_em::date BETWEEN $1 AND $2
     GROUP BY td.categoria_dre ORDER BY valor DESC`,
    [inicio, fim]);
```

- [ ] **Step 3: Verificar manualmente**

```bash
psql "$DATABASE_URL" -c "SELECT id FROM tipos_despesa WHERE codigo='05';"
```
Expected: retorna 1 linha (confirma que o código existe antes de rodar `criarCompra` em produção).

```bash
npm test
```
Expected: nenhuma regressão (não há testes automatizados para esses dois arquivos hoje).

- [ ] **Step 4: Commit**

```bash
git add src/modules/revenda-compras/service.js src/modules/analises/service.js
git commit -m "fix: atualizar revenda-compras e analises (DRE) pra usar tipo_despesa_id em vez da coluna removida"
```

---

### Task 8: `entradas/service.js` — gerar conta a pagar ao confirmar NF de compra

**Files:**
- Modify: `src/modules/entradas/service.js`

- [ ] **Step 1: Adicionar os requires no topo do arquivo**

Trocar:
```js
const db = require('../../db');
const { XMLParser } = require('fast-xml-parser');
```
por:
```js
const db = require('../../db');
const { XMLParser } = require('fast-xml-parser');
const { format, addDays } = require('date-fns');
const contasPagarService = require('../contas-pagar/service');
```

- [ ] **Step 2: Adicionar a chamada ao final de `confirmar()`**

Local: logo depois de `await client.query('COMMIT');` e antes de `return { entrada };` na função `confirmar`. Hoje o final da função é:
```js
    await client.query('COMMIT');
    return { entrada };
  } catch (e) {
```
Trocar por:
```js
    await client.query('COMMIT');

    if (fornecedor_id && valor_total) {
      try {
        const fornecedorR = await db.query('SELECT nome FROM fornecedores WHERE id=$1', [fornecedor_id]);
        const vencimentoProvisorio = emitida_em
          ? format(addDays(new Date(`${emitida_em}T00:00:00`), 30), 'yyyy-MM-dd')
          : format(addDays(new Date(), 30), 'yyyy-MM-dd');
        const conta = await contasPagarService.criarOuReconciliarContaPagar({
          fornecedorId: fornecedor_id,
          fornecedorNome: fornecedorR.rows[0]?.nome || null,
          descricao: `NF ${nnf || 's/nº'} — entrada de estoque`,
          valor: valor_total,
          vencimento: vencimentoProvisorio,
          tipoEntrada: 'entrada_estoque',
        });
        await db.query('UPDATE entradas_estoque SET conta_pagar_id=$1 WHERE id=$2', [conta.id, entrada.id]);
      } catch (e) {
        console.error('[ENTRADAS] Erro ao gerar conta a pagar da NF:', e.message);
      }
    }

    return { entrada };
  } catch (e) {
```

Note que a geração da conta a pagar roda **depois** do commit da entrada e num `try/catch` próprio — uma falha aqui não desfaz a entrada de estoque (o material já deu entrada de qualquer forma); só fica registrado no log pra conferência manual.

- [ ] **Step 3: Verificar manualmente**

```bash
npm run dev
```
Em outro terminal, confirme uma entrada de teste com `fornecedor_id` e `valor_total` preenchidos via `POST /api/v2/entradas` (use um fornecedor e itens já existentes no seu banco de dev) e depois:
```bash
psql "$DATABASE_URL" -c "SELECT id, conta_pagar_id FROM entradas_estoque ORDER BY criada_em DESC LIMIT 1;"
psql "$DATABASE_URL" -c "SELECT id, descricao, tipo_entrada, status, vencimento FROM contas_pagar ORDER BY id DESC LIMIT 1;"
```
Expected: a entrada tem `conta_pagar_id` preenchido; a conta a pagar tem `tipo_entrada='entrada_estoque'` e `vencimento` = data de emissão + 30 dias.

- [ ] **Step 4: Commit**

```bash
git add src/modules/entradas/service.js
git commit -m "feat(entradas): gerar conta a pagar automaticamente ao confirmar NF de compra"
```

---

### Task 9: `ocr.js` — extrair dados do comprovante via GPT-4o (visão)

**Files:**
- Create: `src/modules/contas-pagar/ocr.js`
- Test: `tests/contas-pagar-ocr.test.js`

- [ ] **Step 1: Escrever os testes (mock do `openai`)**

```js
// tests/contas-pagar-ocr.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockCreate } },
})));

const { extrairDadosComprovante } = require('../src/modules/contas-pagar/ocr');

describe('extrairDadosComprovante', () => {
  let tmpFile;
  beforeAll(() => {
    tmpFile = path.join(os.tmpdir(), 'comprovante-teste.jpg');
    fs.writeFileSync(tmpFile, Buffer.from([0xff, 0xd8, 0xff])); // bytes mínimos, conteúdo não importa (mock)
  });
  afterAll(() => { fs.unlinkSync(tmpFile); });
  afterEach(() => jest.clearAllMocks());

  test('resposta válida do modelo → retorna objeto normalizado', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","cnpj":"12345678000199","valor":150.5,"vencimento":"2026-08-10","descricao":"Compra de papel"}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toEqual({
      fornecedor: 'Papelaria X', cnpj: '12345678000199', valor: 150.5,
      vencimento: '2026-08-10', descricao: 'Compra de papel',
    });
  });

  test('resposta sem campos obrigatórios (valor ausente) → null', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: '{"fornecedor":"Papelaria X","vencimento":"2026-08-10"}' } }],
    });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toBeNull();
  });

  test('resposta sem JSON válido → null', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'não consegui ler' } }] });
    const r = await extrairDadosComprovante(tmpFile);
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

```bash
npx jest tests/contas-pagar-ocr.test.js
```

Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `ocr.js`**

```js
// src/modules/contas-pagar/ocr.js
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };

function _dataUri(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  const b64 = fs.readFileSync(absPath).toString('base64');
  return `data:${mime};base64,${b64}`;
}

const PROMPT = `Você recebe a foto ou PDF de um boleto ou nota fiscal de compra de uma gráfica.
Extraia os dados e responda SOMENTE com um JSON no formato:
{"fornecedor": string ou null, "cnpj": string (somente dígitos) ou null, "valor": number ou null, "vencimento": "YYYY-MM-DD" ou null, "descricao": string ou null}
Se não conseguir identificar um campo com confiança, use null nele. Não escreva nada fora do JSON.`;

async function extrairDadosComprovante(absPath) {
  const dataUri = _dataUri(absPath);
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] },
    ],
    temperature: 0,
    max_tokens: 300,
  });
  const texto = response.choices[0]?.message?.content || '';
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let dados;
  try { dados = JSON.parse(match[0]); } catch { return null; }
  if (!dados.fornecedor || !dados.valor || !dados.vencimento) return null;
  return {
    fornecedor: dados.fornecedor,
    cnpj: dados.cnpj || null,
    valor: Number(dados.valor),
    vencimento: dados.vencimento,
    descricao: dados.descricao || dados.fornecedor,
  };
}

module.exports = { extrairDadosComprovante };
```

- [ ] **Step 4: Rodar e confirmar sucesso**

```bash
npx jest tests/contas-pagar-ocr.test.js
```

Expected: PASS — 3 testes.

- [ ] **Step 5: Commit**

```bash
git add src/modules/contas-pagar/ocr.js tests/contas-pagar-ocr.test.js
git commit -m "feat(contas-pagar): ocr — extrair fornecedor/valor/vencimento de comprovante via GPT-4o visão"
```

---

### Task 10: `whatsapp.js` — número autorizado, confirmação por foto, resposta SIM/NÃO

**Files:**
- Create: `src/modules/contas-pagar/whatsapp.js`
- Test: `tests/contas-pagar-whatsapp.test.js`

- [ ] **Step 1: Escrever os testes**

```js
// tests/contas-pagar-whatsapp.test.js
const db = require('../src/db');
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn() }));
jest.mock('../src/modules/contas-pagar/ocr', () => ({ extrairDadosComprovante: jest.fn() }));
jest.mock('../src/modules/contas-pagar/fornecedor-matcher', () => ({ encontrarOuCriarFornecedor: jest.fn() }));
jest.mock('../src/modules/contas-pagar/classificador', () => ({ classificarDespesa: jest.fn() }));
jest.mock('../src/modules/contas-pagar/service', () => ({ criarOuReconciliarContaPagar: jest.fn() }));

const { sendMessage } = require('../src/services/whatsapp');
const ocr = require('../src/modules/contas-pagar/ocr');
const fornecedorMatcher = require('../src/modules/contas-pagar/fornecedor-matcher');
const classificador = require('../src/modules/contas-pagar/classificador');
const service = require('../src/modules/contas-pagar/service');

const wa = require('../src/modules/contas-pagar/whatsapp');

describe('isNumeroAutorizado', () => {
  const OLD = process.env.CONTAS_PAGAR_WHATSAPP_NUMEROS;
  afterEach(() => { process.env.CONTAS_PAGAR_WHATSAPP_NUMEROS = OLD; });

  test('número na lista → true', () => {
    process.env.CONTAS_PAGAR_WHATSAPP_NUMEROS = '5521984023229,5521999999999';
    expect(wa.isNumeroAutorizado('5521984023229')).toBe(true);
  });
  test('número fora da lista → false', () => {
    process.env.CONTAS_PAGAR_WHATSAPP_NUMEROS = '5521984023229';
    expect(wa.isNumeroAutorizado('5511900000000')).toBe(false);
  });
  test('variável vazia → false', () => {
    process.env.CONTAS_PAGAR_WHATSAPP_NUMEROS = '';
    expect(wa.isNumeroAutorizado('5521984023229')).toBe(false);
  });
});

describe('handleComprovanteDespesa', () => {
  afterEach(() => jest.clearAllMocks());

  test('OCR não retorna dados → avisa e não grava nada', async () => {
    ocr.extrairDadosComprovante.mockResolvedValueOnce(null);
    await wa.handleComprovanteDespesa('5521984023229', 'image', '/api/file/abc.jpg');
    expect(sendMessage).toHaveBeenCalledWith('5521984023229', expect.stringMatching(/Não consegui ler/));
    expect(db.query).not.toHaveBeenCalled();
  });

  test('OCR retorna dados → grava pendente e manda resumo pra confirmar', async () => {
    ocr.extrairDadosComprovante.mockResolvedValueOnce({
      fornecedor: 'Papelaria X', cnpj: '12345678000199', valor: 200, vencimento: '2026-08-20', descricao: 'Compra papel',
    });
    fornecedorMatcher.encontrarOuCriarFornecedor.mockResolvedValueOnce({ id: 'uuid-1', nome: 'Papelaria X' });
    classificador.classificarDespesa.mockResolvedValueOnce({ tipo_despesa_id: 1, origem: 'keyword' });
    db.query
      .mockResolvedValueOnce({ rowCount: 0 }) // DELETE pendente antigo
      .mockResolvedValueOnce({ rows: [] })    // INSERT pendente
      .mockResolvedValueOnce({ rows: [{ nome: 'PAPEL E SUBSTRATOS' }] }); // nome do tipo pra mensagem

    await wa.handleComprovanteDespesa('5521984023229', 'image', '/api/file/abc.jpg');

    expect(sendMessage).toHaveBeenCalledWith('5521984023229', expect.stringMatching(/Papelaria X/));
    expect(sendMessage).toHaveBeenCalledWith('5521984023229', expect.stringMatching(/confirma/i));
  });
});

describe('processarRespostaDespesaWA', () => {
  afterEach(() => jest.clearAllMocks());

  test('texto não é sim/não → retorna null (não intercepta)', async () => {
    const r = await wa.processarRespostaDespesaWA('5521984023229', 'oi, tudo bem?');
    expect(r).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('sim/não sem pendente → retorna null', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const r = await wa.processarRespostaDespesaWA('5521984023229', 'sim');
    expect(r).toBeNull();
  });

  test('responde não → descarta o pendente', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 5, fornecedor_id: null, valor: 100, vencimento: '2026-08-01', descricao: 'x', tipo_despesa_id: null }] })
      .mockResolvedValueOnce({ rowCount: 1 }); // DELETE
    const r = await wa.processarRespostaDespesaWA('5521984023229', 'não');
    expect(r.mensagem).toMatch(/não lancei/i);
    expect(service.criarOuReconciliarContaPagar).not.toHaveBeenCalled();
  });

  test('responde sim → grava a conta e confirma', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 5, fornecedor_id: 'uuid-1', valor: 100, vencimento: '2026-08-01', descricao: 'x', tipo_despesa_id: 3 }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // DELETE
      .mockResolvedValueOnce({ rows: [{ nome: 'Fornecedor X' }] }); // nome do fornecedor
    service.criarOuReconciliarContaPagar.mockResolvedValueOnce({ id: 99 });

    const r = await wa.processarRespostaDespesaWA('5521984023229', 'SIM');
    expect(r.mensagem).toMatch(/Lançado/);
    expect(service.criarOuReconciliarContaPagar).toHaveBeenCalledWith(expect.objectContaining({
      fornecedorId: 'uuid-1', valor: 100, tipoDespesaId: 3, tipoEntrada: 'whatsapp_ocr',
    }));
  });
});
```

- [ ] **Step 2: Rodar e confirmar falha**

```bash
npx jest tests/contas-pagar-whatsapp.test.js
```

Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar `whatsapp.js`**

```js
// src/modules/contas-pagar/whatsapp.js
const path = require('path');
const { format } = require('date-fns');
const db = require('../../db');
const { sendMessage } = require('../../services/whatsapp');
const fornecedorMatcher = require('./fornecedor-matcher');
const classificador = require('./classificador');
const ocr = require('./ocr');
const service = require('./service');

const UPLOADS_DIR = path.join(__dirname, '../../../public/uploads');

function _numerosAutorizados() {
  return String(process.env.CONTAS_PAGAR_WHATSAPP_NUMEROS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function isNumeroAutorizado(phone) {
  return _numerosAutorizados().includes(phone);
}

async function _tipoDespesaNome(id) {
  if (!id) return 'não identificada — classifique no painel';
  const r = await db.query('SELECT nome FROM tipos_despesa WHERE id = $1', [id]);
  return r.rows[0]?.nome || 'não identificada — classifique no painel';
}

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

  const fornecedor = await fornecedorMatcher.encontrarOuCriarFornecedor({ nome: dados.fornecedor, cnpj: dados.cnpj });
  const sugestao = await classificador.classificarDespesa({
    fornecedorId: fornecedor?.id || null,
    nomeFornecedor: dados.fornecedor,
    descricao: dados.descricao,
  });

  await db.query('DELETE FROM despesas_pendentes_confirmacao WHERE telefone = $1', [phone]);
  await db.query(
    `INSERT INTO despesas_pendentes_confirmacao (telefone, fornecedor_id, valor, vencimento, descricao, tipo_despesa_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [phone, fornecedor?.id || null, dados.valor, dados.vencimento, dados.descricao, sugestao.tipo_despesa_id]
  );

  const nomeTipo = await _tipoDespesaNome(sugestao.tipo_despesa_id);
  const valorFmt = 'R$ ' + Number(dados.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const vencFmt = format(new Date(`${dados.vencimento}T00:00:00`), 'dd/MM/yyyy');
  await sendMessage(phone,
    `📄 *Fornecedor:* ${dados.fornecedor}\n*Valor:* ${valorFmt}\n*Vencimento:* ${vencFmt}\n*Categoria sugerida:* ${nomeTipo}\n\nConfirma? Responda *sim* ou *não*.`
  );
}

async function processarRespostaDespesaWA(phone, texto) {
  const norm = String(texto || '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  const isSim = norm === 'SIM';
  const isNao = norm === 'NAO';
  if (!isSim && !isNao) return null;

  const r = await db.query(
    `SELECT * FROM despesas_pendentes_confirmacao WHERE telefone = $1 AND criado_em > NOW() - INTERVAL '30 minutes'`,
    [phone]
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

  await service.criarOuReconciliarContaPagar({
    fornecedorId: pendente.fornecedor_id,
    fornecedorNome,
    descricao: pendente.descricao,
    valor: pendente.valor,
    vencimento: pendente.vencimento,
    tipoDespesaId: pendente.tipo_despesa_id,
    tipoEntrada: 'whatsapp_ocr',
    tipo: 'boleto',
  });

  return { mensagem: '✅ Lançado.' };
}

async function limparPendentesExpirados() {
  const r = await db.query(`DELETE FROM despesas_pendentes_confirmacao WHERE criado_em < NOW() - INTERVAL '30 minutes' RETURNING id`);
  return { removidos: r.rowCount };
}

module.exports = { isNumeroAutorizado, handleComprovanteDespesa, processarRespostaDespesaWA, limparPendentesExpirados };
```

- [ ] **Step 4: Rodar e confirmar sucesso**

```bash
npx jest tests/contas-pagar-whatsapp.test.js
```

Expected: PASS — 8 testes.

- [ ] **Step 5: Commit**

```bash
git add src/modules/contas-pagar/whatsapp.js tests/contas-pagar-whatsapp.test.js
git commit -m "feat(contas-pagar): fluxo WhatsApp — número autorizado, confirmação por foto, resposta SIM/NÃO"
```

---

### Task 11: Conectar o webhook — desviar mídia/texto do número autorizado

**Files:**
- Modify: `src/webhook/routes.js`

- [ ] **Step 1: Adicionar o require e importar `downloadMedia`**

Trocar:
```js
const { handleInboundMessage, handleInboundMedia } = require('./handler');
const { markAsRead, sendMessage } = require('../services/whatsapp');
const { handleC6Webhook } = require('./c6bank');
const { handleMercadoPagoWebhook } = require('./mercadopago');
const orcamentoService = require('../modules/orcamentos/service');
```
por:
```js
const { handleInboundMessage, handleInboundMedia } = require('./handler');
const { markAsRead, sendMessage, downloadMedia } = require('../services/whatsapp');
const { handleC6Webhook } = require('./c6bank');
const { handleMercadoPagoWebhook } = require('./mercadopago');
const orcamentoService = require('../modules/orcamentos/service');
const contasPagarWhatsapp = require('../modules/contas-pagar/whatsapp');
```

- [ ] **Step 2: Desviar mensagens de mídia do número autorizado antes do fluxo do chatbot**

Local: dentro do `router.post('/', ...)`, onde hoje diz:
```js
          const MEDIA_TYPES = ['image', 'document', 'video', 'audio', 'sticker'];

          if (MEDIA_TYPES.includes(msg.type)) {
            const mediaObj = msg[msg.type];
            await handleInboundMedia(phone, profileName, msg.type, mediaObj, msg.id);
            continue;
          }
```
Trocar por:
```js
          const MEDIA_TYPES = ['image', 'document', 'video', 'audio', 'sticker'];

          if (MEDIA_TYPES.includes(msg.type) && contasPagarWhatsapp.isNumeroAutorizado(phone) && ['image', 'document'].includes(msg.type)) {
            const mediaObj = msg[msg.type];
            let localPath = null;
            if (mediaObj?.id) {
              try { localPath = await downloadMedia(mediaObj.id, mediaObj.filename || ''); }
              catch (e) { console.error('[CONTAS-PAGAR-WA] erro ao baixar mídia:', e.message); }
            }
            if (localPath) await contasPagarWhatsapp.handleComprovanteDespesa(phone, msg.type, localPath);
            continue;
          }

          if (MEDIA_TYPES.includes(msg.type)) {
            const mediaObj = msg[msg.type];
            await handleInboundMedia(phone, profileName, msg.type, mediaObj, msg.id);
            continue;
          }
```

- [ ] **Step 3: Desviar respostas de texto SIM/NÃO do número autorizado**

Local: onde hoje diz:
```js
          const text = msg.text?.body || '';

          // Intercepta SIM/NÃO para fluxo de aprovação de orçamento
          const respostaOrc = await orcamentoService.processarRespostaWA(phone, text);
          if (respostaOrc) {
            await sendMessage(phone, respostaOrc.mensagem);
            continue;
          }

          await handleInboundMessage(phone, profileName, text, msg.id);
```
Trocar por:
```js
          const text = msg.text?.body || '';

          // Intercepta SIM/NÃO para fluxo de confirmação de despesa (WhatsApp do financeiro)
          if (contasPagarWhatsapp.isNumeroAutorizado(phone)) {
            const respostaDespesa = await contasPagarWhatsapp.processarRespostaDespesaWA(phone, text);
            if (respostaDespesa) {
              await sendMessage(phone, respostaDespesa.mensagem);
              continue;
            }
          }

          // Intercepta SIM/NÃO para fluxo de aprovação de orçamento
          const respostaOrc = await orcamentoService.processarRespostaWA(phone, text);
          if (respostaOrc) {
            await sendMessage(phone, respostaOrc.mensagem);
            continue;
          }

          await handleInboundMessage(phone, profileName, text, msg.id);
```

- [ ] **Step 4: Verificar que o arquivo carrega sem erro de sintaxe**

```bash
node -e "require('./src/webhook/routes.js'); console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add src/webhook/routes.js
git commit -m "feat(webhook): desviar mídia/texto do número autorizado do financeiro para o fluxo de despesas"
```

---

### Task 12: Cron de limpeza de pendências expiradas

**Files:**
- Modify: `src/jobs/contas-pagar.js`

- [ ] **Step 1: Adicionar o require no topo do arquivo**

Trocar:
```js
const cron = require('node-cron');
const service = require('../modules/contas-pagar/service');
const whatsapp = require('../services/whatsapp');
```
por:
```js
const cron = require('node-cron');
const service = require('../modules/contas-pagar/service');
const whatsapp = require('../services/whatsapp');
const contasPagarWhatsapp = require('../modules/contas-pagar/whatsapp');
```

- [ ] **Step 2: Adicionar o cron job novo** (após o job "Dia 25 às 09h", antes do `log('Cron jobs...')` final)

```js
// A cada 30 min — limpar pendências de confirmação de despesa via WhatsApp expiradas
cron.schedule('*/30 * * * *', async () => {
  try {
    const r = await contasPagarWhatsapp.limparPendentesExpirados();
    if (r.removidos) log(`limpar_pendentes_wa: ${r.removidos} pendências expiradas removidas`);
  } catch (err) { log(`ERRO limpar_pendentes_wa: ${err.message}`); }
}, { timezone: 'America/Sao_Paulo' });
```

- [ ] **Step 3: Verificar que o arquivo carrega sem erro de sintaxe**

```bash
node -e "require('./src/jobs/contas-pagar.js'); console.log('OK')"
```

Expected: `OK` (e os logs `Cron jobs de contas a pagar inicializados` no console).

- [ ] **Step 4: Commit**

```bash
git add src/jobs/contas-pagar.js
git commit -m "feat(contas-pagar): cron de limpeza das pendências de confirmação WhatsApp expiradas"
```

---

### Task 13: `financeiro.html` — select dinâmico, fornecedor com sugestão automática, badges novos

**Files:**
- Modify: `public/pwa/financeiro.html`

- [ ] **Step 1: Trocar o `<select id="f-tipo-despesa">` hardcoded por um vazio (populado via JS)**

Trocar (linhas 234–254):
```html
        <select id="f-tipo-despesa">
          <option value="">Selecione...</option>
          <option value="ALUGUEL">Aluguel</option>
          <option value="AGUA">Água</option>
          <option value="LUZ">Luz</option>
          <option value="TELEFONIA_INTERNET">Telefonia / Internet</option>
          <option value="TARIFA_BANCO">Tarifa Bancária</option>
          <option value="FRETE">Frete</option>
          <option value="COMBUSTIVEL">Combustível</option>
          <option value="MATERIAL_LIMPEZA">Material de Limpeza</option>
          <option value="MATERIAL_ESCRITORIO">Material de Escritório</option>
          <option value="DESPESA_VIAGEM">Despesa de Viagem</option>
          <option value="IMPOSTOS">Impostos</option>
          <option value="MANUTENCAO">Manutenção</option>
          <option value="COMISSOES">Comissões</option>
          <option value="FORNECEDOR">Fornecedor</option>
          <option value="SERVICO_TERCEIRIZADO">Serviço Terceirizado</option>
          <option value="EMPRESTIMO_FINANCIAMENTO">Empréstimo / Financiamento</option>
          <option value="CONTADOR_FOLHA_PAGAMENTO">Contador / Folha Pagamento</option>
          <option value="OUTRAS_DESPESAS">Outras Despesas</option>
        </select>
```
por:
```html
        <select id="f-tipo-despesa">
          <option value="">Selecione...</option>
        </select>
```

- [ ] **Step 2: Adicionar um campo hidden pra `fornecedor_id` logo abaixo do input de fornecedor**

Trocar (linhas 226–229):
```html
      <div class="form-group">
        <label>Fornecedor/Credor</label>
        <input type="text" id="f-fornecedor" placeholder="Ex: Light S.A.">
      </div>
```
por:
```html
      <div class="form-group">
        <label>Fornecedor/Credor</label>
        <input type="text" id="f-fornecedor" placeholder="Ex: Light S.A." onblur="onFornecedorBlur()">
        <input type="hidden" id="f-fornecedor-id">
      </div>
```

- [ ] **Step 3: Carregar os tipos de despesa no início do script**

Local: logo depois da declaração de `filtroAtivo` (no topo do `<script>`):
```js
  let filtroAtivo = { dias: undefined, status: undefined };
```
Adicionar depois:
```js
  let tiposDespesa = [];

  async function carregarTiposDespesa() {
    const tipos = await api('GET', '/contas-pagar/tipos-despesa');
    if (!tipos) return;
    tiposDespesa = tipos;
    const select = document.getElementById('f-tipo-despesa');
    select.innerHTML = '<option value="">Selecione...</option>' +
      tipos.map(t => `<option value="${t.id}">${t.codigo} — ${t.nome}</option>`).join('');
  }

  async function onFornecedorBlur() {
    const nome = document.getElementById('f-fornecedor').value.trim();
    document.getElementById('f-fornecedor-id').value = '';
    if (!nome) return;
    const r = await api('GET', `/fornecedores?busca=${encodeURIComponent(nome)}&limit=1`);
    const fornecedorId = r?.fornecedores?.[0]?.id || null;
    if (fornecedorId) document.getElementById('f-fornecedor-id').value = fornecedorId;
    const sugestao = await api('GET', `/contas-pagar/sugerir-tipo?${fornecedorId ? 'fornecedor_id=' + fornecedorId : ''}&fornecedor=${encodeURIComponent(nome)}`);
    if (sugestao?.tipo_despesa_id && !document.getElementById('f-tipo-despesa').value) {
      document.getElementById('f-tipo-despesa').value = sugestao.tipo_despesa_id;
    }
  }
```

- [ ] **Step 4: Chamar `carregarTiposDespesa()` na inicialização da página**

Encontre a chamada de inicialização existente (`carregarKPIs()` e `carregarContas()` chamadas no carregamento da página — geralmente perto do final do `<script>`, num bloco tipo `carregarKPIs(); carregarContas();` fora de qualquer função). Adicione `carregarTiposDespesa();` junto:
```js
  carregarTiposDespesa();
  carregarKPIs();
  carregarContas();
```

- [ ] **Step 5: Atualizar a renderização da tabela — nome do tipo, badge de pendente_classificacao, novas origens**

Trocar:
```js
  function badgeOrigem(t) {
    const m = { manual: '✏️', dda: '🏦', importacao_oc: '📦' };
    return m[t] || '—';
  }
```
por:
```js
  function badgeOrigem(t) {
    const m = { manual: '✏️', dda: '🏦', importacao_oc: '📦', whatsapp_ocr: '📷', entrada_estoque: '📥' };
    return m[t] || '—';
  }
```

Trocar:
```js
  function badgeStatus(s) {
    const m = { pendente: 'badge-cinza', agendado: 'badge-azul', pago: 'badge-verde', vencido: 'badge-vermelho', cancelado: 'badge-cinza' };
    return `<span class="badge ${m[s] || 'badge-cinza'}">${s}</span>`;
  }
```
por:
```js
  function badgeStatus(s) {
    const m = { pendente: 'badge-cinza', pendente_classificacao: 'badge-amarelo', agendado: 'badge-azul', pago: 'badge-verde', vencido: 'badge-vermelho', cancelado: 'badge-cinza' };
    const label = s === 'pendente_classificacao' ? 'Classificar' : s;
    return `<span class="badge ${m[s] || 'badge-cinza'}">${label}</span>`;
  }
```

Trocar (dentro de `renderTabela`):
```js
        <td style="font-size:11px">${c.tipo_despesa.replace(/_/g,' ')}</td>
```
por:
```js
        <td style="font-size:11px">${c.tipo_despesa_nome || '—'}</td>
```

E trocar a condição que decide se mostra o botão de editar (hoje só `pendente`, precisa incluir `pendente_classificacao`):
```js
          ${c.status === 'pendente' ? `<button class="btn btn-secondary" style="padding:4px 10px;font-size:11px" onclick="abrirModalEditar(${c.id})">✏️</button>` : ''}
```
por:
```js
          ${['pendente','pendente_classificacao'].includes(c.status) ? `<button class="btn btn-secondary" style="padding:4px 10px;font-size:11px" onclick="abrirModalEditar(${c.id})">✏️</button>` : ''}
```

- [ ] **Step 6: Atualizar `abrirModalEditar` e `salvarConta` pra usar `fornecedor_id`/`tipo_despesa_id`**

Trocar (dentro de `abrirModalEditar`):
```js
  async function abrirModalEditar(id) {
    const c = await api('GET', `/contas-pagar?status=pendente`);
    if (!c) return;
    const conta = c.find(x => x.id === id);
    if (!conta) { showToast('❌ Conta não encontrada'); return; }
    editandoId = id;
    document.querySelector('#modal-nova h2').textContent = 'Editar Conta';
    document.querySelector('#modal-nova .btn-primary[onclick="salvarConta()"]').textContent = 'Salvar Alterações';
    document.getElementById('f-descricao').value = conta.descricao || '';
    document.getElementById('f-fornecedor').value = conta.fornecedor || '';
    document.getElementById('f-tipo-despesa').value = conta.tipo_despesa || '';
```
por:
```js
  async function abrirModalEditar(id) {
    const pendentes = await api('GET', `/contas-pagar?status=pendente`);
    const pendentesClassificar = await api('GET', `/contas-pagar?status=pendente_classificacao`);
    const c = [...(pendentes || []), ...(pendentesClassificar || [])];
    const conta = c.find(x => x.id === id);
    if (!conta) { showToast('❌ Conta não encontrada'); return; }
    editandoId = id;
    document.querySelector('#modal-nova h2').textContent = 'Editar Conta';
    document.querySelector('#modal-nova .btn-primary[onclick="salvarConta()"]').textContent = 'Salvar Alterações';
    document.getElementById('f-descricao').value = conta.descricao || '';
    document.getElementById('f-fornecedor').value = conta.fornecedor || '';
    document.getElementById('f-fornecedor-id').value = conta.fornecedor_id || '';
    document.getElementById('f-tipo-despesa').value = conta.tipo_despesa_id || '';
```

Trocar (dentro de `salvarConta`):
```js
    const body = {
      descricao: document.getElementById('f-descricao').value.trim(),
      fornecedor: document.getElementById('f-fornecedor').value.trim() || null,
      tipo_despesa: document.getElementById('f-tipo-despesa').value,
      valor: parseFloat(document.getElementById('f-valor').value),
```
por:
```js
    const body = {
      descricao: document.getElementById('f-descricao').value.trim(),
      fornecedor: document.getElementById('f-fornecedor').value.trim() || null,
      fornecedor_id: document.getElementById('f-fornecedor-id').value || null,
      tipo_despesa_id: parseInt(document.getElementById('f-tipo-despesa').value) || null,
      valor: parseFloat(document.getElementById('f-valor').value),
```

- [ ] **Step 7: Verificar manualmente no navegador**

```bash
npm run dev
```
Abra `http://localhost:3000/pwa/financeiro.html`, logue como admin e confira:
1. O select "Tipo de Despesa" carrega as 38 opções (`01 — PAPEL E SUBSTRATOS`, etc.).
2. Digitar um nome de fornecedor já cadastrado e sair do campo (blur) pré-seleciona uma categoria, se o fornecedor já tiver uma memória ou baterem palavras-chave.
3. Criar uma conta nova salva corretamente e aparece na tabela com o nome do tipo (não mais o código do enum).

- [ ] **Step 8: Commit**

```bash
git add public/pwa/financeiro.html
git commit -m "feat(financeiro.html): select dinâmico de tipos de despesa, sugestão automática por fornecedor, badges novos"
```

---

### Task 14: `.env.example` — variável do número autorizado

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Adicionar a variável na seção do WhatsApp Cloud API**

Trocar:
```
WHATSAPP_BUSINESS_ACCOUNT_ID=      # ID da conta WhatsApp Business
```
por:
```
WHATSAPP_BUSINESS_ACCOUNT_ID=      # ID da conta WhatsApp Business
CONTAS_PAGAR_WHATSAPP_NUMEROS=     # Números autorizados a mandar comprovante de despesa (linha dedicada do financeiro, NÃO celular pessoal). Formato: 5521984023229, separados por vírgula se houver mais de um
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): documentar CONTAS_PAGAR_WHATSAPP_NUMEROS"
```

---

### Task 15: Deploy no VPS

**Files:** nenhum (operação de deploy)

- [ ] **Step 1: Rodar a suíte completa localmente antes do deploy**

```bash
npm test
```

Expected: todos os testes passam.

- [ ] **Step 2: Enviar os arquivos alterados/criados pro VPS e aplicar as migrations**

```bash
rsync -R -av \
  sql/migrations/051_tipos_despesa.sql \
  sql/migrations/052_whatsapp_ocr_despesas.sql \
  src/modules/contas-pagar/fornecedor-matcher.js \
  src/modules/contas-pagar/classificador.js \
  src/modules/contas-pagar/ocr.js \
  src/modules/contas-pagar/whatsapp.js \
  src/modules/contas-pagar/service.js \
  src/modules/contas-pagar/router.js \
  src/modules/entradas/service.js \
  src/modules/revenda-compras/service.js \
  src/modules/analises/service.js \
  src/webhook/routes.js \
  src/jobs/contas-pagar.js \
  public/pwa/financeiro.html \
  .env.example \
  root@2.25.147.243:/var/www/lkl-chatbot/
```

Em seguida, aplicar as migrations no banco do VPS:

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && psql \"\$DATABASE_URL\" -f sql/migrations/051_tipos_despesa.sql && psql \"\$DATABASE_URL\" -f sql/migrations/052_whatsapp_ocr_despesas.sql"
```

Se o VPS não usa `$DATABASE_URL` (confira as variáveis `DB_HOST`/`DB_NAME`/`DB_USER` no `.env` do servidor), monte a string de conexão manualmente:
```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && PGPASSWORD=\$DB_PASSWORD psql -h \$DB_HOST -U \$DB_USER -d \$DB_NAME -f sql/migrations/051_tipos_despesa.sql"
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && PGPASSWORD=\$DB_PASSWORD psql -h \$DB_HOST -U \$DB_USER -d \$DB_NAME -f sql/migrations/052_whatsapp_ocr_despesas.sql"
```

- [ ] **Step 3: Adicionar `CONTAS_PAGAR_WHATSAPP_NUMEROS` ao `.env` real do VPS**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && echo 'CONTAS_PAGAR_WHATSAPP_NUMEROS=5521984023229' >> .env"
```

(Ajuste o número para o formato internacional exato que a Meta envia no campo `from` do webhook — confirme comparando com o log de uma mensagem de teste antes de travar o valor final, ver Step 5.)

- [ ] **Step 4: Reiniciar o processo**

```bash
ssh root@2.25.147.243 "cd /var/www/lkl-chatbot && pm2 restart lkl-chatbot --update-env"
```

- [ ] **Step 5: Smoke test end-to-end**

1. No painel `financeiro.html` de produção, confirme que o select de tipo de despesa carrega as 38 opções.
2. Do número **(21) 98402-3229**, mande uma foto de um boleto real para o número do chatbot.
3. Confirme que chega a mensagem de resumo (`📄 Fornecedor: ... confirma?`). **Se não chegar nada**, verifique nos logs (`pm2 logs lkl-chatbot`) se o valor de `phone` recebido no webhook bate exatamente com o que foi colocado em `CONTAS_PAGAR_WHATSAPP_NUMEROS` — o formato pode incluir ou não o `55` inicial dependendo de como a Meta manda; ajuste a variável e reinicie se necessário.
4. Responda `sim` e confirme no painel financeiro que a conta apareceu.
5. Rode a sincronização DDA manual (botão no painel ou `GET /api/v2/contas-pagar/dda/sync`) e confirme que boletos não vêm mais com `FORNECEDOR` fixo — ou têm um tipo classificado, ou aparecem como "Classificar".

```bash
ssh root@2.25.147.243 "pm2 logs lkl-chatbot --lines 100 --nostream | grep -i 'CONTAS-PAGAR'"
```

- [ ] **Step 6: Atualizar a memória do projeto**

Adicione uma entrada em `project_sprint_status.md` (memória fora do repositório) registrando: migration 051/052 aplicadas em produção, taxonomia de 38 tipos ativa, fluxo WhatsApp do financeiro usando o número (21) 98402-3229 como remetente autorizado (não é uma Cloud API própria — é só um filtro por número remetente no webhook já existente).

---

## Self-Review

**1. Cobertura do spec:**
- Seção 1 (taxonomia) → Task 1.
- Seção 2 (fornecedor: cadastro automático + memória) → Tasks 3, 4.
- Seção 3 (conectar sem duplicar: DDA, manual, entrada de estoque) → Tasks 5, 7, 8.
- Seção 4 (captura por WhatsApp) → Tasks 9, 10, 11, 12.
- PWA/UI → Task 13.
- `.env` → Task 14.
- Deploy/smoke → Task 15.
- Achado durante a exploração de código (não estava no spec, mas quebraria em produção se ignorado): `revenda-compras/service.js` e `analises/service.js` também dependiam da coluna `tipo_despesa` removida — coberto na Task 7.

**2. Placeholder scan:** nenhum "TBD"/"similar à Task N" — todo código está completo em cada step.

**3. Consistência de tipos:**
- `fornecedores.id` é **UUID** em todo o plano (`fornecedor_id UUID` nas duas tabelas novas/alteradas) — conferido contra `sql/migrations/001_sprint1_foundation.sql` antes de escrever (o spec original tinha esse campo como `INTEGER`, já corrigido no spec e replicado corretamente aqui).
- `tipos_despesa.id` é `SERIAL`/`INTEGER`, consistente com `contas_pagar.tipo_despesa_id INTEGER` e `fornecedores.tipo_despesa_padrao_id INTEGER`.
- `service.js` exporta: `listar, buscarPorId, kpis, criar, editar, cancelar, pagarManual, criarRecorrente, sincronizarDDA, listarLotes, criarLoteC6, consultarLoteC6, removerItemLoteC6, submeterLoteC6, reconciliar, marcarVencidas, contasVencendoEm, atualizarStatusLotesSubmetidos, gerarRecorrentesProximoMes, listarTiposDespesa, sugerirTipoDespesa, gravarMemoriaFornecedor, criarOuReconciliarContaPagar` — todos os nomes usados em `router.js`, `whatsapp.js`, `entradas/service.js` e nos testes batem com essa lista.
- `whatsapp.js` exporta `isNumeroAutorizado, handleComprovanteDespesa, processarRespostaDespesaWA, limparPendentesExpirados` — usados exatamente com esses nomes em `webhook/routes.js` e `jobs/contas-pagar.js`.
- `fornecedor-matcher.js` exporta `encontrarOuCriarFornecedor` — usado com a mesma assinatura `{ nome, cnpj }` em `service.js` (`sincronizarDDA`) e `whatsapp.js` (`handleComprovanteDespesa`).
