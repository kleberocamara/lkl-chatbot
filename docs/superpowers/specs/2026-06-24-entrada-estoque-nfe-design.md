# Entrada de Estoque via NF-e de Compra — Design

**Data:** 2026-06-24
**Contexto:** Complementa o OS-3C (baixa de estoque). Aqui é a **entrada** — repor o
estoque quando o material chega do fornecedor, importando o XML da NF-e de compra.

## Objetivo

Importar o XML de uma NF-e de compra, casar cada item com um material do catálogo
(por EAN/código), e dar entrada no estoque com atualização de custo médio ponderado.

## Decisões (confirmadas com o usuário)

1. **Recebimento:** upload do arquivo **XML** da NF-e (sem download SEFAZ).
2. **Casamento:** automático por **EAN** (`cEAN` = `materiais.codigo_barras`) ou **código**
   (`cProd` = `materiais.codigo`), com **fallback manual** (combo) para itens não casados.
3. **Custo:** atualiza `custo_medio` por **média ponderada** na entrada.
4. **Conversão de unidade:** **fator no material** (`fator_entrada`; ex.: 1 resma = 500 folhas).
5. **Estorno:** reverte **apenas a quantidade** (`estoque_atual`); `custo_medio` permanece
   (é média histórica). Idempotência por `chave` UNIQUE.
6. **Parsing:** feito no **Node** (lib `fast-xml-parser`), sem usar o sidecar Python.

## Modelo de dados (migration 038)

### `materiais` (novas colunas)
```sql
ALTER TABLE materiais ADD COLUMN IF NOT EXISTS codigo_barras VARCHAR(20);
ALTER TABLE materiais ADD COLUMN IF NOT EXISTS fator_entrada NUMERIC(12,4) DEFAULT 1;
```
- `codigo_barras` — EAN para casar com `cEAN` da NF.
- `fator_entrada` — quantas unidades de estoque por unidade da NF (default 1).

### `entradas_estoque` (cabeçalho)
```sql
CREATE TABLE IF NOT EXISTS entradas_estoque (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fornecedor_id UUID REFERENCES fornecedores(id) ON DELETE SET NULL,
  nnf           VARCHAR(20),
  chave         VARCHAR(44) UNIQUE,
  emitida_em    DATE,
  valor_total   NUMERIC(12,2),
  status        VARCHAR(12) NOT NULL DEFAULT 'lancada' CHECK (status IN ('lancada','estornada')),
  criada_em     TIMESTAMPTZ DEFAULT now(),
  criada_por    UUID REFERENCES users(id) ON DELETE SET NULL,
  estornada_em  TIMESTAMPTZ,
  estornada_por UUID REFERENCES users(id) ON DELETE SET NULL
);
```

### `entradas_estoque_itens`
```sql
CREATE TABLE IF NOT EXISTS entradas_estoque_itens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entrada_id          UUID NOT NULL REFERENCES entradas_estoque(id) ON DELETE CASCADE,
  material_id         UUID REFERENCES materiais(id),
  cprod               VARCHAR(60),
  cean                VARCHAR(20),
  xprod               VARCHAR(200),
  ucom                VARCHAR(10),
  qcom                NUMERIC(14,4),
  vun                 NUMERIC(14,6),
  fator_aplicado      NUMERIC(12,4),
  quantidade_estoque  NUMERIC(14,4),   -- qcom * fator_aplicado
  custo_unit_estoque  NUMERIC(14,6)    -- vun / fator_aplicado
);
CREATE INDEX IF NOT EXISTS idx_entradas_itens_entrada ON entradas_estoque_itens(entrada_id);
```

## Parsing do XML (Node)

`parseNfeCompra(xmlString)` usa `fast-xml-parser` e extrai do `nfeProc`/`NFe`:
- `emitente`: `emit.CNPJ`, `emit.xNome`.
- `nnf`: `ide.nNF`; `emitida_em`: `ide.dhEmi` (data); `chave`: do `infNFe@Id` (`NFe` + 44 díg.); `valor_total`: `total.ICMSTot.vNF`.
- itens (`det[]`, sempre tratar como array): `prod.cProd`, `prod.cEAN` (ignorar `SEM GTIN`),
  `prod.xProd`, `prod.uCom`, `prod.qCom`, `prod.vUnCom`, `prod.vProd`, `prod.NCM`.

Retorna `{ emitente, nnf, chave, emitida_em, valor_total, itens: [...] }`. Função pura,
sem efeito colateral.

## API — módulo `src/modules/entradas/`

**service.js:**
- `parseNfeCompra(xml)` — parsing puro (acima).
- `preview(xml)` — parse + casa fornecedor por CNPJ (retorna `fornecedor` ou `null` +
  `cnpj/nome` para criação) + casa cada item por `cEAN`/`cProd` (retorna `material` casado
  ou `null` + sugestão de `fator_entrada` do material). **Não grava.**
- `confirmar({ chave, nnf, emitida_em, valor_total, fornecedor_id, itens })` onde cada item
  é `{ material_id, cprod, cean, xprod, ucom, qcom, vun, fator }`. Transação: insere
  `entradas_estoque` + itens; para cada item com `material_id`:
  `quantidade_estoque = qcom*fator`, `estoque_atual += quantidade_estoque`, recalcula
  `custo_medio` ponderado (`custo_unit = vun/fator`). Itens sem `material_id` são ignorados
  (não entram). Erro `chave` duplicada → `{ erro: ['NF já lançada'] }`.
- `estornar(entradaId, { userId })` — reverte `estoque_atual -= quantidade_estoque` de cada
  item, marca `estornada`. Erro se já estornada.
- `listar()` / `buscarPorId(id)` — histórico.

**Cálculo do custo médio ponderado** (por material, na confirmação):
```
saldo = estoque_atual (antes)
novo_custo = (saldo*custo_medio + quantidade_estoque*custo_unit_estoque)
             / NULLIF(saldo + quantidade_estoque, 0)
```
Se o denominador for 0, mantém o `custo_unit_estoque` como `custo_medio`.

**router.js** (registrar em `modules/index.js` como `/api/v2/entradas`; `requireRole('admin','gestor')`):
- `POST /preview` — multipart (campo `xml`, multer memoryStorage) → `service.preview(req.file.buffer.toString('utf8'))`.
- `POST /` — body JSON `{ chave, nnf, emitida_em, valor_total, fornecedor_id, itens }` → `confirmar`.
- `POST /:id/estornar` → `estornar`.
- `GET /` e `GET /:id` — histórico.

## UI (dashboard)

Nova aba **"Entrada NF-e"** (nav Cadastros/Estoque, roles admin/gestor):
- Botão **Importar NF-e** → `<input type=file accept=".xml">` → `POST /preview`.
- Modal de pré-visualização:
  - Cabeçalho: fornecedor casado (ou aviso "fornecedor não cadastrado — será criado" com
    nome/CNPJ da NF), nNF, valor total.
  - Tabela de itens: descrição (xProd) · qCom · uCom · **material** (combo do catálogo,
    pré-selecionado quando casado) · **fator** (input, default do material) · qtd em estoque
    (calculada = qCom×fator, ao vivo).
  - Item sem material e não marcado "ignorar" → bloqueia confirmar.
  - Botão **Confirmar entrada** → `POST /` → atualiza estoque.
- Histórico de entradas (lista) com botão **Estornar**.

## Erros & testes

- `chave` duplicada → 409/`{erro}` "NF já lançada".
- XML inválido/sem `infNFe` → 400 "XML de NF-e inválido".
- Item sem material e não ignorado → confirmar bloqueado (validação na UI + backend ignora
  itens sem `material_id`).
- `node --check` + smoke no VPS com um XML de NF-e de exemplo: preview casa por EAN/código,
  confirma, `estoque_atual` sobe por `qcom×fator`, `custo_medio` recalcula; estorno reverte a
  quantidade.

## Fora de escopo (YAGNI)

- Download do XML na SEFAZ (manifestação do destinatário).
- Mapa de conversão por fornecedor (fator fica no material).
- Lançamento de contas a pagar a partir da NF (integra com M9-A em projeto futuro).
- Conferência de divergência de preço/quantidade vs pedido de compra.
