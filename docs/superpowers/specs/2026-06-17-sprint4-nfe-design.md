# Sprint 4 — NF-e Design Spec

## Goal

Emissão manual de NF-e (produto) diretamente para SEFAZ-RJ a partir de orçamentos pagos, com DANFE em PDF, sem uso de serviços terceiros.

## Contexto

- Stack: Node.js 20 + Express 4 + PostgreSQL 15 + CommonJS
- Duas empresas emitentes (operador escolhe):
  - **GRUPO DE GRAFICAS LKL LTDA** — CNPJ 19.296.723/0001-08, IE 86591529
  - **FACTOR COMUNICAÇÃO VISUAL LTDA** — CNPJ 44.448.899/0001-85, IE 12306440
  - Ambas: RUA DOUTOR WALDIR DE SOUZA MEDEIROS, 315, QUADRA 28 LOTE 38, PARQUE DUQUE, CEP 25085-595, DUQUE DE CAXIAS - RJ
- Certificados A1 (.pfx, senha `12345678`) já no VPS em `/var/www/lkl-chatbot/certs/sefaz/`
- NF-e emitida **manualmente** pelo operador (nem todo orçamento gera nota)
- Pré-requisito: `status_pagamento = 'pago'`

---

## Arquitetura

### Novos arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/services/nfe.js` | Wrapper do pacote `nfe`: monta payload, assina com .pfx, transmite para SEFAZ-RJ, retorna autorização |
| `src/modules/nfe/service.js` | Busca dados do orçamento, monta objeto NF-e, persiste resultado |
| `src/modules/nfe/router.js` | `POST /api/v2/nfe/:orcamento_id/emitir`, `GET /api/v2/nfe/:id/danfe` |
| `sql/migrations/008_sprint4_nfe.sql` | Cria tabelas `nfe` e `nfe_sequencia` |
| `tests/modules/nfe.test.js` | Testes unitários do service |

### Arquivos modificados

| Arquivo | Mudança |
|---|---|
| `src/modules/index.js` | Registra router de NF-e |
| `public/pwa/admin.html` | Botão "Emitir NF-e" + modal |

---

## Banco de Dados

### Tabela `nfe`

```sql
CREATE TABLE nfe (
  id               SERIAL PRIMARY KEY,
  orcamento_id     INTEGER NOT NULL REFERENCES orcamentos(id),
  cnpj_emitente    VARCHAR(14) NOT NULL,        -- '19296723000108' ou '44448899000185'
  numero           INTEGER NOT NULL,
  serie            VARCHAR(3) NOT NULL DEFAULT '001',
  chave            VARCHAR(44),                  -- preenchida após autorização SEFAZ
  protocolo        VARCHAR(20),
  status           VARCHAR(20) NOT NULL DEFAULT 'pendente',  -- pendente/autorizada/rejeitada/cancelada
  xml              TEXT,                         -- XML autorizado completo
  danfe_path       TEXT,                         -- caminho em public/uploads/nfe/
  cfop             VARCHAR(4) NOT NULL,          -- preenchido pelo operador
  ncm_por_item     JSONB,                        -- {orcamento_item_id: ncm} por item
  frete_valor      NUMERIC(10,2) DEFAULT 0,
  transportador    JSONB,                        -- dados completos do transportador
  info_complementar TEXT,                        -- gerado automaticamente (Simples Nacional)
  emitido_em       TIMESTAMP,
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);
```

### Tabela `nfe_sequencia`

```sql
CREATE TABLE nfe_sequencia (
  cnpj           VARCHAR(14) PRIMARY KEY,
  ultimo_numero  INTEGER NOT NULL DEFAULT 0
);

-- Seeds iniciais
-- Em homologação: começa do zero (notas de teste não têm valor fiscal)
INSERT INTO nfe_sequencia (cnpj, ultimo_numero) VALUES
  ('19296723000108', 0),
  ('44448899000185', 0);

-- ⚠️ VIRADA PARA PRODUÇÃO: atualizar com o último número emitido no SisGraf no dia da migração
-- UPDATE nfe_sequencia SET ultimo_numero = XXXX WHERE cnpj = '19296723000108';
-- UPDATE nfe_sequencia SET ultimo_numero = YYYY WHERE cnpj = '44448899000185';
```

> **Importante:** o número 1859 deve ser confirmado com o operador — é o último número emitido no SisGraf para o GRUPO LKL antes da migração.

---

## Campos da NF-e

### Sistema preenche automaticamente

| Grupo | Campo | Origem |
|---|---|---|
| Emitente | Razão social, CNPJ, IE, endereço | Hardcoded por CNPJ escolhido |
| Destinatário | Nome, CNPJ/CPF, endereço, bairro, CEP, município, UF, fone, IE | `clientes_lkl` via `orcamentos.cliente_id` |
| Datas | Emissão e saída | `NOW()` |
| Produtos | Código, descrição, unidade, quantidade, valor unitário, desconto, valor líquido | `orcamento_itens` |
| Totais | Valor dos produtos, valor total da nota | Calculado dos itens + frete |
| Duplicatas | Número, vencimento, valor | `orcamentos.boleto_*` ou `pix_*` |
| Fiscal fixo | CSOSN=`0102`, ICMS=0, IPI=0, seguro=0, outras despesas=0 | Hardcoded |
| Natureza | `VENDA DE PRODUÇÃO DO ESTABELECIMENTO` | Hardcoded |
| Info complementar | Texto Simples Nacional com % crédito ICMS | Gerado automaticamente |

### Operador preenche no modal

| Campo | Detalhe |
|---|---|
| Empresa emitente | Dropdown: GRUPO LKL ou FACTOR |
| CFOP | Por nota (ex: 5101 dentro RJ, 6101 fora RJ) |
| NCM | Por item de produto (ex: 49111090) |
| Frete por conta | Dropdown: Emitente / Destinatário / Sem frete (código 9) |
| Valor do frete | Numérico (visível só se frete ≠ sem frete) |
| Transportador | Razão social, CNPJ, placa, UF, endereço, município, IE |
| Volumes | Quantidade, espécie, marca, numeração, peso bruto, peso líquido |

> Quando "Sem frete": transportador fica em branco, quantidade=1, espécie=VOLUME.

---

## Fluxo de Emissão

```
Operador abre orçamento (status_pagamento='pago')
  → clica "Emitir NF-e"
  → preenche modal (empresa, CFOP, NCM por item, transporte)
  → POST /api/v2/nfe/:orcamento_id/emitir
    → service.js busca orçamento + itens + cliente
    → nfe.js monta payload NFe 4.0
    → nfe.js assina com .pfx (senha 12345678)
    → nfe.js transmite para SEFAZ-RJ (homologação primeiro, depois produção)
    → SEFAZ retorna chave + protocolo
    → service.js gera DANFE PDF → public/uploads/nfe/{chave}.pdf
    → service.js salva registro em tabela nfe (status='autorizada')
  → modal mostra: ✅ NF-e Autorizada · Chave: xxxx · [Download DANFE]

Em caso de rejeição:
  → nfe.status = 'rejeitada'
  → modal mostra código + mensagem de erro SEFAZ
  → operador corrige e retenta (novo registro na tabela nfe)
```

---

## API

### POST `/api/v2/nfe/:orcamento_id/emitir`

**Role:** `admin` ou `operador`

**Body:**
```json
{
  "cnpj_emitente": "19296723000108",
  "cfop": "5101",
  "ncm_por_item": { "42": "49111090", "43": "49111090" },
  "frete_por_conta": "9",
  "frete_valor": 0,
  "transportador": null
}
```

**Resposta sucesso (200):**
```json
{
  "id": 1,
  "chave": "33211019296723000108550010000018591...",
  "protocolo": "333210165743554",
  "status": "autorizada",
  "danfe_url": "/uploads/nfe/3321...pdf"
}
```

**Resposta rejeição (422):**
```json
{
  "erro": "Rejeição 562: Valor do Desconto superior ao Valor do Item"
}
```

### GET `/api/v2/nfe/:id/danfe`

Serve o PDF do DANFE. Requer role `admin` ou `operador`.

---

## PWA admin.html

- Orçamentos com `status_pagamento='pago'` mostram botão **"Emitir NF-e"** (além dos botões existentes)
- Se já existe NF-e `status='autorizada'` para o orçamento: botão vira **"Ver NF-e"** (abre DANFE)
- Modal de emissão: empresa (dropdown) → CFOP → NCM por item → transporte → botão Emitir
- Badge de status NF-e: pendente (cinza) / autorizada (verde) / rejeitada (vermelho)

---

## Emitentes Hardcoded

```javascript
const EMITENTES = {
  '19296723000108': {
    razaoSocial: 'GRUPO DE GRAFICAS LKL LTDA',
    cnpj: '19296723000108',
    ie: '86591529',
    csosn: '0102',
    logradouro: 'RUA DOUTOR WALDIR DE SOUZA MEDEIROS',
    numero: '315',
    complemento: 'QUADRA 28 LOTE 38',
    bairro: 'PARQUE DUQUE',
    cep: '25085595',
    municipio: 'Duque de Caxias',
    cMun: '3301702',
    uf: 'RJ',
    certPath: process.env.SEFAZ_CERT_GRUPO,
    certPassword: process.env.SEFAZ_CERT_PASSWORD,
  },
  '44448899000185': {
    razaoSocial: 'FACTOR COMUNICACAO VISUAL LTDA',
    cnpj: '44448899000185',
    ie: '12306440',
    csosn: '0400',
    logradouro: 'RUA DOUTOR WALDIR DE SOUZA MEDEIROS',
    numero: '315',
    complemento: 'QUADRA28 LOTE 38 ANEXO PARTE',
    bairro: 'PARQUE DUQUE',
    cep: '25085595',
    municipio: 'Duque de Caxias',
    cMun: '3301702',
    uf: 'RJ',
    certPath: process.env.SEFAZ_CERT_FACTOR,
    certPassword: process.env.SEFAZ_CERT_PASSWORD,
  },
};
```

---

## Ambiente

- **Homologação primeiro:** `https://homologacao.nfe.fazenda.gov.br` (testes sem valor fiscal)
- **Produção:** `https://nfe.fazenda.gov.br` (RJ usa SEFAZ nacional para NF-e)
- Variável `NFE_AMBIENTE=1` (produção) ou `NFE_AMBIENTE=2` (homologação) no `.env`

---

## Dependências npm

```bash
npm install nfe danfe
```

- `nfe`: geração de XML NF-e 4.0, assinatura digital, transmissão SEFAZ
- `danfe`: geração do PDF DANFE a partir do XML autorizado

---

## Testes

`tests/modules/nfe.test.js` cobre:
1. Rejeição quando orçamento não encontrado
2. Rejeição quando `status_pagamento != 'pago'`
3. Rejeição quando NCM faltando para algum item
4. Mock de transmissão SEFAZ — retorno de autorização → salva corretamente
5. Mock de rejeição SEFAZ → status='rejeitada', erro retornado

---

## Pendências para confirmar antes de implementar

1. **Número inicial GRUPO LKL:** confirmar se 1859 é realmente a última nota emitida no SisGraf
2. **Código do município IBGE de Duque de Caxias:** 3301702 (confirmar)
3. **Ambiente inicial:** começar em homologação (`NFE_AMBIENTE=2`)
