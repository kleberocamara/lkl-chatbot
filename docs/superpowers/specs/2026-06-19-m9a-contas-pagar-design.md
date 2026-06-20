# M9-A — Contas a Pagar (Sprint A) Design Spec

**Goal:** Módulo de gestão financeira passiva da LKL Gráfica — cadastro de contas a pagar, integração DDA + Agendamento de Pagamentos C6 Bank, contas recorrentes, alertas WhatsApp e reconciliação automática via extrato bancário.

**Architecture:** Híbrido leve — tabelas locais para controle (`contas_pagar`, `payment_batches`) + C6 Bank APIs para DDA, agendamento e extrato. Cron jobs para automações. Duas novas telas PWA no painel admin.

**Tech Stack:** Node.js · Express · PostgreSQL 15 · node-cron · C6 Bank BaaS API (mTLS + OAuth2 já implementado em `src/services/c6bank.js`)

**Fora de escopo (M9-B):** Scanner OCR, parser NF-e XML, tela Calendário, tela Aging, integração DRE.

---

## 1. Banco de Dados

### Migration: `sql/migrations/012_contas_pagar.sql`

#### ENUM `tipo_despesa_enum`

```sql
CREATE TYPE tipo_despesa_enum AS ENUM (
  'ALUGUEL', 'AGUA', 'TARIFA_BANCO', 'FRETE', 'COMBUSTIVEL',
  'TELEFONIA_INTERNET', 'MATERIAL_LIMPEZA', 'MATERIAL_ESCRITORIO',
  'DESPESA_VIAGEM', 'LUZ', 'IMPOSTOS', 'MANUTENCAO', 'COMISSOES',
  'FORNECEDOR', 'SERVICO_TERCEIRIZADO', 'EMPRESTIMO_FINANCIAMENTO',
  'CONTADOR_FOLHA_PAGAMENTO', 'OUTRAS_DESPESAS'
);
```

#### Tabela `contas_pagar`

| Coluna | Tipo | Notas |
|--------|------|-------|
| `id` | SERIAL PK | — |
| `descricao` | TEXT NOT NULL | Ex: "Conta Light Janeiro 2026" |
| `fornecedor` | TEXT | Livre, sem FK |
| `tipo_despesa` | `tipo_despesa_enum` NOT NULL | — |
| `valor` | NUMERIC(10,2) NOT NULL | — |
| `vencimento` | DATE NOT NULL | Base dos filtros e alertas |
| `tipo` | VARCHAR(10) CHECK IN ('boleto','pix','outro') | Forma de pagamento |
| `linha_digitavel` | TEXT | 44 dígitos do boleto |
| `pix_content` | TEXT | Chave ou brcode PIX |
| `tipo_entrada` | VARCHAR(20) DEFAULT 'manual' CHECK IN ('manual','dda','importacao_oc') | Origem do lançamento |
| `status` | VARCHAR(20) DEFAULT 'pendente' CHECK IN ('pendente','agendado','pago','vencido','cancelado') | — |
| `c6_group_id` | TEXT | FK lógica para `payment_batches.c6_group_id` |
| `c6_item_id` | TEXT | ID do item no lote C6 |
| `c6_status` | TEXT | Último status retornado pelo C6 |
| `recorrente` | BOOLEAN DEFAULT false | — |
| `recorrencia_dia` | SMALLINT | Dia do mês (1–28) |
| `recorrencia_valor_fixo` | BOOLEAN DEFAULT true | false = valor variável (água/luz) |
| `pago_em` | TIMESTAMP | Preenchido na reconciliação ou marcação manual |
| `observacao` | TEXT | Notas internas |
| `created_at` | TIMESTAMP DEFAULT NOW() | — |
| `updated_at` | TIMESTAMP DEFAULT NOW() | — |

Índices: `(status)`, `(vencimento)`, `(tipo_despesa)`, `(c6_group_id)`.

#### Tabela `payment_batches`

| Coluna | Tipo | Notas |
|--------|------|-------|
| `id` | SERIAL PK | — |
| `c6_group_id` | TEXT UNIQUE NOT NULL | group_id retornado pelo C6 /decode |
| `uploader_name` | TEXT NOT NULL | Exibido no web banking C6 |
| `status` | VARCHAR(20) DEFAULT 'decodificando' CHECK IN ('decodificando','pronto','submetido','aprovado','parcial','erro') | — |
| `valor_total` | NUMERIC(10,2) | Soma dos itens |
| `quantidade_itens` | INTEGER | — |
| `submetido_em` | TIMESTAMP | — |
| `aprovado_em` | TIMESTAMP | Detectado pelo cron `check_batch_status` |
| `created_at` | TIMESTAMP DEFAULT NOW() | — |
| `updated_at` | TIMESTAMP DEFAULT NOW() | — |

---

## 2. Extensão do `src/services/c6bank.js`

Cinco funções novas adicionadas ao serviço existente (reutilizam `getAccessToken`, `getAgent`, `authHeaders`, `c6Request`):

```
consultarDDA()
  GET /v1/schedule_payments/query
  Retorna: [{ amount, bank_name, beneficiary_name, content, due_date, overdue, payer_name }]

criarLote(items)
  POST /v1/schedule_payments/decode
  Body: { items: [{ content, amount, description, transaction_date? }] }
  Retorna: { group_id }

consultarLote(groupId)
  GET /v1/schedule_payments/{group_id}/items
  Retorna: [{ id, content, amount, status, error_message, ... }]

removerItemLote(groupId, itemId)
  DELETE /v1/schedule_payments/{group_id}/items/{item_id}
  Retorna: void (204)

submeterLote(groupId, uploaderName)
  POST /v1/schedule_payments/submit
  Body: { group_id, uploader_name }
  Retorna: void (204)

consultarExtrato(startDate, endDate)
  GET /v1/statement/?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
  Retorna: [{ reference, amount, title, description, operation_type, transaction_type, entry_date }]
```

**Reconciliação:** ao agendar, o campo `description` enviado ao C6 é prefixado com `CP-{id}` (ex: `"CP-42 Conta Light Janeiro"`). O cron `reconciliar_extrato` filtra entradas com `operation_type=OUTGOING`, `transaction_type=PAYMENT` e faz match por `description LIKE 'CP-{id} %'`.

---

## 3. Módulo `src/modules/contas-pagar/`

### Arquivos
- `src/modules/contas-pagar/service.js`
- `src/modules/contas-pagar/router.js`

### Rotas (todas `requireRole('admin')`, montadas em `/api/v2/contas-pagar`)

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/` | Lista com filtros: `status`, `tipo_despesa`, `vencimento_de`, `vencimento_ate`, `dias` (0/1/2/3/5/7/15/30) |
| POST | `/` | Cadastro manual. Valida: descricao, tipo_despesa, valor, vencimento obrigatórios |
| PATCH | `/:id` | Editar (só se `status='pendente'`) |
| PATCH | `/:id/pagar` | Marcar como pago manualmente (registra `pago_em=NOW()`) |
| DELETE | `/:id` | Cancelar (só se `status IN ('pendente','vencido')`) |
| POST | `/recorrente` | Cria conta recorrente + gera instâncias para os próximos 12 meses |
| GET | `/dda/sync` | Dispara sync DDA manual → importa boletos novos |
| POST | `/lote` | Body: `{ ids: [], uploaderName }` → cria lote C6, salva em `payment_batches` |
| GET | `/lote/:groupId` | Consulta status do lote no C6 |
| DELETE | `/lote/:groupId/item/:itemId` | Remove item do lote no C6 |
| POST | `/lote/:groupId/submeter` | Submete lote para aprovação no C6 |
| POST | `/reconciliar` | Reconciliação manual via extrato C6 (últimos 30 dias) |

### Regras de negócio

- Conta só pode ser editada/cancelada se `status='pendente'` ou `'vencido'`
- Ao criar lote: `description` enviada ao C6 = `CP-{id} {descricao truncada em 80 chars}`
- DDA: boletos já existentes (mesmo `linha_digitavel`) são ignorados (upsert por `linha_digitavel`)
- Contas recorrentes com `recorrencia_valor_fixo=false` geram instâncias com valor zero — gestor preenche ao chegar a conta

---

## 4. Cron Jobs — `src/jobs/contas-pagar.js`

Utiliza `node-cron`. Registrado no startup via `src/app.js`.

| Job | Schedule | Ação |
|-----|----------|------|
| `sync_dda` | `0 7 * * *` (07h00) | `consultarDDA()` → insere novas contas com `tipo_entrada='dda'` |
| `reconciliar_extrato` | `30 7 * * *` (07h30) | Extrato 30 dias → cruza `CP-{id}` → atualiza `status='pago'`, `pago_em` |
| `check_overdue` | `0 8 * * *` (08h00) | `UPDATE ... SET status='vencido' WHERE vencimento < NOW() AND status='pendente'` |
| `alert_vencendo` | `0 9 * * *` (09h00) | Busca contas vencendo em 2 dias → `whatsapp.js sendMessage()` para número do dono |
| `check_batch_status` | `0 7,9,11,13,15,17,19,21 * * *` (a cada 2h, 07h–21h) | `consultarLote()` para lotes `status='submetido'` → atualiza `c6_status`, `aprovado_em` |
| `generate_recurrent` | `0 9 25 * *` (dia 25 às 09h) | Gera contas recorrentes do mês seguinte para `recorrente=true` |

Número do WhatsApp do dono: variável de ambiente `OWNER_WHATSAPP`.

---

## 5. Frontend — `public/pwa/financeiro.html`

Nova página PWA com duas seções acessadas por abas.

### Aba 1 — Visão Geral

- **4 KPI cards:** Total a pagar (30 dias) · Vencendo hoje (vermelho se > 0) · Vencidos em aberto · Total pago este mês
- **Filtros rápidos** (chips): Hoje · Amanhã · 2d · 3d · 5d · 7d · 15d · 30d · Todos · Vencidos
- **Filtros adicionais** (dropdowns): Tipo de despesa · Status · Tipo de entrada
- **Tabela:** checkbox · Vencimento (badge colorido: verde/amarelo/laranja/vermelho) · Descrição · Fornecedor · Tipo despesa · Valor · Status · Origem · Ações
- **Ações por linha:** Pagar (manual) · Adicionar ao lote · Cancelar
- **Rodapé:** total selecionado + botão "Criar lote C6" (ativo quando há itens com linha digitável/PIX selecionados)
- **Botões topo:** "+ Nova conta" · "🔄 Sincronizar DDA" · "⚡ Reconciliar"
- **Modal "+ Nova conta":** formulário com todos os campos, incluindo toggle "Recorrente"

### Aba 2 — Lote de Pagamentos C6

- Lista de contas pendentes com linha digitável/PIX + checkboxes
- **Painel lateral:** itens selecionados + total acumulado
- **Fluxo em 4 passos** (step indicator): Selecionar → Validar → Revisar → Submeter
- Após "Montar lote": spinner "Validando no C6..." → resultado por item (✅/❌/⚠)
- Campo "Seu nome" (uploader_name) + datepicker opcional (transaction_date)
- Botão "Enviar para aprovação" com modal de confirmação
- **Histórico de lotes:** tabela com lotes anteriores, status e valor total

---

## 6. Variáveis de Ambiente (`.env`)

```
OWNER_WHATSAPP=5521XXXXXXXXX   # número do dono para alertas
```

As credenciais C6 (`C6_CLIENT_ID`, `C6_CLIENT_SECRET`, `C6_CERT_PATH`, `C6_KEY_PATH`, `C6_BASE_URL`) já existem.

---

## 7. Dependência: node-cron

```bash
npm install node-cron
```

Já pode existir no projeto — verificar antes de instalar.

---

## 8. Fluxo Principal — DDA → Lote → Aprovação

```
07h00  sync_dda        → boletos DDA importados como contas_pagar
Admin  seleciona       → POST /lote (ids, uploaderName)
C6     /decode         → group_id gravado em payment_batches
Admin  revisa + remove → DELETE /lote/:groupId/item/:itemId (se necessário)
Admin  submete         → POST /lote/:groupId/submeter → C6 /submit
Dono   aprova          → web banking C6 (obrigatório — sem isto nada é pago)
07h30  check_batch     → consultarLote() detecta PROCESSED → status='pago'
```

---

## 9. M9-B (fora deste sprint)

- Scanner OCR (Tesseract.js + Sharp)
- Parser NF-e XML (schema SEFAZ 4.0)
- Tela Calendário de Vencimentos
- Tela Aging & Relatórios
- Integração DRE (M8)
