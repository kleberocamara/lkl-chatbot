# LKL Gráfica — Sistema Integrado de Gestão & Vendas
**Design Spec v1.0 · 15/06/2026**

---

## 1. Contexto e Objetivo

A Gráfica LKL possui um chatbot WhatsApp operacional (Node.js + GPT-4o + PostgreSQL no VPS Hostinger `2.25.147.243`). Este documento especifica o design do **Sistema Integrado de Gestão & Vendas** — uma extensão direta do chatbot existente, composta por 10 módulos (M0–M9) desenvolvidos em 5 sprints (~15 semanas).

**Objetivo central:** automatizar o fluxo completo lead → orçamento → OS → produção → entrega → cobrança → pós-venda, eliminando dependência do dono para vendas e atendimento.

**Meta financeira:** R$ 200.000/mês nos primeiros 6 meses pós-implantação (atual: R$ 150.000/mês).

---

## 2. Decisões de Design

| Decisão | Escolha | Motivo |
|---|---|---|
| Arquitetura | Extensão direta (Abordagem A) | Mesmo processo Node.js, sem fricção de infraestrutura |
| Banco | PostgreSQL 15 — mesmo banco, novas tabelas | Sem migração de dados, reutiliza conexão pool existente |
| Frontend mobile | PWA (app.graficalkl.com.br/pwa) | Sem app store, instalável, funciona offline |
| Push notifications | Firebase FCM | Mais estável, melhor entrega, suporte Android + iOS 16.4+ |
| Armazenamento de artes | VPS local `/uploads/artes/` | 96GB livres, suficiente, sem custo adicional |
| OCR documentos (M9) | Tesseract.js → Google Vision como upgrade | Gratuito no MVP, migra para Vision se precisar de precisão |
| Autenticação | JWT existente reutilizado + novos roles | Sem retrabalho, compatibilidade garantida |
| Pagamentos | C6 Bank (Bolepix + PIX) + Mercado Pago | LKL já tem conta em ambos |

---

## 3. Arquitetura

### Estrutura de Pastas

```
/Users/klebercamara/LKL/
├── src/
│   ├── index.js                  ← ponto de entrada (expandir)
│   ├── webhook/                  ← chatbot (inalterado)
│   ├── ai/                       ← agente GPT (inalterado)
│   ├── services/                 ← whatsapp, email, followup (inalterado)
│   ├── middleware/               ← auth JWT (expandir roles)
│   ├── dashboard/                ← api.js existente (manter compatibilidade)
│   └── modules/                  ← NOVO — módulos do novo sistema
│       ├── clientes/             ← M0
│       ├── fornecedores/         ← M0
│       ├── materiais/            ← M0 / M7
│       ├── orders/               ← M1 / M2 / M3
│       ├── financeiro/           ← M6 (C6 Bank)
│       ├── fiscal/               ← M5 (NF-e / NFS-e)
│       ├── estoque/              ← M7
│       ├── contas-pagar/         ← M9
│       └── relatorios/           ← M8
├── public/
│   ├── dashboard.html            ← expandir com novas abas
│   └── pwa/                      ← NOVO — app mobile
│       ├── index.html
│       ├── manifest.json
│       └── sw.js                 ← Service Worker + FCM
├── sql/
│   ├── schema.sql                ← existente (intocado)
│   ├── schema_v2.sql             ← NOVO — tabelas M0–M9
│   └── migrations/               ← uma migration por sprint
│       ├── 001_sprint1_foundation.sql
│       ├── 002_sprint2_producao.sql
│       ├── 003_sprint3_financeiro.sql
│       ├── 004_sprint4_fiscal_estoque.sql
│       └── 005_sprint5_relatorios.sql
└── uploads/
    └── artes/{ano}/{mes}/{os_id}/
```

### Roteamento Express

```
app.use('/webhook',        webhookRouter)      ← inalterado
app.use('/api',            dashboardRouter)    ← inalterado
app.use('/api/v2',         newSystemRouter)    ← NOVO
app.use('/pwa',            express.static('public/pwa'))
app.use('/webhooks/c6bank', c6WebhookRouter)  ← NOVO
```

---

## 4. Módulos e Responsabilidades

| Módulo | Nome | Sprint | Dependências |
|---|---|---|---|
| M0 | Cadastros Base | 1 | — |
| M1 | Canais de Entrada + Motor de Orçamento | 1 | M0 |
| M2 | Orçamento & Ordem de Serviço | 2 | M0, M1 |
| M3 | Pipeline de Produção | 2 | M2 |
| M6 | Financeiro C6 Bank | 3 | M2 |
| M5 | Fiscal NF-e / NFS-e | 4 | M2, M0 |
| M7 | Estoque & Compras | 4 | M0 |
| M9 | Contas a Pagar | 4 | M6 |
| M4 | Pós-Venda & NPS | 5 | M2, M3 |
| M8 | Dashboard & Relatórios | 5 (completo) | todos |

---

## 5. Schema do Banco de Dados

### Tabelas existentes (preservadas integralmente)
`contacts`, `conversations`, `messages`, `users`, `activity_logs`, `settings`, `follow_ups`, `orcamentos`

### Novas tabelas por sprint

**Sprint 1**
- `clientes_lkl` — cadastro completo, vinculado a `contacts` via `phone`
- `fornecedores` — 281 registros importados do SisGraph
- `materiais` — insumos de produção
- `funcionarios` — cadastro de funcionários da gráfica (RH/pessoal), vinculado opcionalmente a `users`
- `price_table` — produtos × quantidade × acabamento × preço (construída com o dono)
- `orders` — OS unificada (todos os canais)
- `order_items` — itens de cada OS

**Tabela `funcionarios` — campos:**
`id` (UUID PK), `user_id` (FK → users, opcional), `nome`, `cpf` (único), `rg`, `data_nascimento`, `cargo`, `salario`, `data_admissao`, `telefone`, `celular`, `email`, `status` (ativo/inativo/afastado), `created_at`, `updated_at`

Regra: `user_id` é opcional — funcionários sem acesso ao sistema ficam com `user_id = NULL`. O M9 (folha de pagamento) filtra `status = 'ativo'` para lançamentos mensais.

**Sprint 2**
- `order_stages` — pipeline 9 etapas por OS

**Sprint 3**
- `order_payments` — boletos / PIX / MP por OS
- `bank_statements` — extrato C6 mensal

**Sprint 4**
- `fiscal_documents` — NF-e e NFS-e emitidas
- `stock_movements` — entradas e saídas de estoque
- `purchase_orders` — ordens de compra
- `contas_pagar` — M9: contas a pagar cadastradas
- `dda_items` — boletos vindos do DDA C6
- `payment_batches` — lotes de pagamento C6

**Sprint 5**
- `alert_rules` — regras de alerta configuráveis
- `dre_monthly` — DRE mensal gerado automaticamente

### Fluxos de status

**`orcamentos.status`** (negociação — separado da OS)
```
gerado → aguardando_aprovacao_cliente
         ↓                    ↓
      aprovado            reprovado
         ↓                    ↓
    (cria OS)        renegociacao → aguardando_aprovacao_cliente
                                        ↓
                                    cancelado (terminal)
```

**`orders.status`** (OS — criada apenas após orçamento aprovado)
```
criada → gerando_arquivo_impressao → arte_enviada_cliente
         → arte_aprovada_cliente | arte_reprovada_cliente
         → em_producao → concluido → entregue
```

**`orders.status_arte`** (sub-status interno)
```
pendente → em_criacao → aguardando_aprovacao_cliente
         → aprovada | reprovada
```

### Campos críticos

- `orders.origin_channel`: `whatsapp | balcao | telefone | site | vendedor`
- `orders.external_reference_id`: ULID 26 chars — vincula OS ao boleto C6 Bank, nunca reutilizado
- `clientes_lkl.contact_id`: FK para `contacts` (NULL para clientes antigos sem WhatsApp)
- `orcamentos.tentativas_negociacao`: contador de renegociações

### Roles de usuário (expansão do JWT existente)

| Role | Acesso |
|---|---|
| `admin` | tudo (existente) |
| `analyst` | painel web completo (existente) |
| `gestor` | dashboard executivo, aprovar descontos, revisar orçamento, relatórios, configurações, painel web completo |
| `vendedor` | própria carteira, novo pedido, orçamentos dos seus clientes |
| `atendente` | novo pedido (todos os clientes), envio de orçamento, confirmação de entrega |
| `operador` | fila de produção da sua etapa, avanço de status, upload QC |
| `financeiro` | cobrança, contas a pagar, DRE, extrato C6 |

---

## 6. APIs

Todas as novas rotas sob `/api/v2`, protegidas por JWT. Única rota pública: `GET /api/v2/utils/cep/:cep`.

| Grupo | Rotas principais |
|---|---|
| Clientes | `GET/POST /clientes` · `GET/PUT/PATCH /clientes/:id` · `GET /clientes/busca?q=` |
| Fornecedores | `GET/POST /fornecedores` · `GET/PUT /fornecedores/:id` |
| Materiais | `GET/POST /materiais` · `PATCH /materiais/:id/estoque` |
| Price Table | `GET /price-catalog` · `POST/PUT /price-table` (gestor/admin) |
| Orders | `POST /orders` · `GET /orders/kanban` · `GET /orders/:id` · `PATCH /orders/:id/status` · `POST /orders/:id/approve` · `POST /orders/:id/art-approval` |
| Produção | `PATCH /orders/:id/stage` · `GET /orders/:id/timeline` · `POST /orders/:id/qc-photo` |
| Financeiro | `POST /orders/:id/cobranca` · `GET /orders/:id/payment-status` · `POST /orders/:id/parcelas` |
| Fiscal | `POST /fiscal/nfe/:order_id` · `POST /fiscal/nfse/:order_id` · `GET /fiscal/documents` |
| Estoque | `GET /estoque` · `POST /estoque/consume` · `POST /purchase-orders` |
| Contas a Pagar | `GET/POST /contas-pagar` · `POST /contas-pagar/dda-sync` · `POST /payment-batches` |
| Relatórios | `GET /relatorios/faturamento` · `GET /relatorios/dre/:periodo` · `GET /relatorios/vendedor/:id` |

---

## 7. Integrações Externas

| Serviço | Uso | Status |
|---|---|---|
| C6 Bank OAuth2 + mTLS | Bolepix, PIX, DDA, extrato | Conta PJ existe — solicitar API antes Sprint 3 |
| Mercado Pago | Checkout presencial balcão | Conta existe — pegar Access Token |
| Firebase FCM | Push notifications PWA | Criar projeto Firebase antes Sprint 1 |
| SEFAZ/RJ | Emissão NF-e protocolo 4.0 | Certificado A1 vigente — configurar Sprint 4 |
| Prefeitura Duque de Caxias | Emissão NFS-e ABRASF | Credenciais portal existem — configurar Sprint 4 |
| ViaCEP | Autopreenchimento de CEP | Sem chave — chamada via backend |
| WhatsApp Cloud API | Notificações ao cliente | Já operacional |
| OpenAI GPT-4o | Chatbot + coleta de briefing | Já operacional |

### Proteção de integrações financeiras

- **C6 Bank webhook**: valida HMAC-SHA256 no header `X-C6-Signature` antes de processar qualquer evento `PAID`
- **Certificados mTLS e A1**: armazenados em `/etc/lkl/certs/`, permissão `600`, fora do diretório do projeto
- **Tokens e secrets**: apenas no `.env`, nunca expostos ao frontend

---

## 8. Variáveis de Ambiente Novas

| Variável | Sprint | Descrição |
|---|---|---|
| `FCM_SERVER_KEY` | 1 | Firebase Cloud Messaging |
| `FCM_PROJECT_ID` | 1 | ID do projeto Firebase |
| `C6_CLIENT_ID` | 3 | OAuth2 C6 Bank |
| `C6_CLIENT_SECRET` | 3 | OAuth2 C6 Bank |
| `C6_CERT_PATH` | 3 | Caminho do certificado mTLS |
| `C6_KEY_PATH` | 3 | Caminho da chave mTLS |
| `C6_PIX_KEY_EVP` | 3 | Chave PIX aleatória da conta PJ |
| `MP_ACCESS_TOKEN` | 3 | Mercado Pago |
| `CERT_PFX_PATH` | 4 | Certificado A1 para NF-e |
| `CERT_PFX_PASSWORD` | 4 | Senha do certificado A1 |
| `NFSE_LOGIN` | 4 | Usuário portal prefeitura DC |
| `NFSE_PASSWORD` | 4 | Senha portal prefeitura DC |
| `NFSE_WSDL_URL` | 4 | URL webservice ABRASF |
| `GOOGLE_VISION_API_KEY` | 4 | OCR (opcional, upgrade do Tesseract) |

---

## 9. Segurança

- JWT existente (12h, cookie `httpOnly`) reutilizado — novo middleware `requireRole(...roles)`
- Rate limit mantido: 200/min webhook, 100/min API (aplicado também em `/api/v2`)
- Uploads: validação MIME server-side (`image/jpeg`, `image/png`, `application/pdf`), máximo 20MB por arte, 10MB por foto QC
- Queries parametrizadas `$1, $2...` em todos os módulos — sem concatenação SQL
- Webhook C6 Bank: HMAC-SHA256 obrigatório — `403` silencioso sem assinatura válida
- Certificados e chaves: `/etc/lkl/certs/`, permissão `600`, fora do repositório Git

---

## 10. Testes e Qualidade

### Sprint 1 — Fundação
- ESLint + Prettier configurados no projeto
- Checklists de teste manual por feature entregue

### Sprints 2–4 — Testes de integração
- Jest com banco `lkl_chatbot_test` (banco real, não mock)
- Cobertura obrigatória: M6 (webhook PAID), M5 (homologação SEFAZ), M0 (validação CPF/CNPJ), M2 (fluxo orçamento → OS)

### Sprint 5 — Teste de ponta a ponta
Roteiro completo executado pelo dono e equipe antes do go-live:
1. WhatsApp → chatbot coleta briefing → motor gera orçamento
2. Cliente aprova → OS criada → Socket.IO notifica painel
3. Operador avança etapas → arte enviada → cliente aprova
4. Produção concluída → atendente confirma entrega → cliente notificado
5. Bolepix gerado → webhook C6 PAID → OS baixada automaticamente
6. NF-e emitida → DANFE enviado por WhatsApp e e-mail
7. 24h depois → bot dispara NPS → resultado salvo

### Ambiente de homologação
Mesmo VPS, banco `lkl_chatbot_test`, variáveis apontando para sandboxes. `NODE_ENV=test` no PM2.

---

## 11. Cronograma e Go-live

| Sprint | Semanas | Entrega | Pré-requisito do cliente |
|---|---|---|---|
| Sprint 1 | 1–3 | M0 cadastros, M1 canais entrada, PWA base, importação 1.288 clientes | Criar projeto Firebase |
| Sprint 2 | 4–6 | M2 orçamento/OS, M3 pipeline produção, kanban | Reunião com dono para mapear lógica de preços |
| Sprint 3 | 7–9 | M6 financeiro C6 Bank, cobrança automática, Mercado Pago | API C6 Bank + mTLS + PIX EVP cadastrado |
| Sprint 4 | 10–12 | M5 fiscal, M7 estoque, M9 contas a pagar | Credenciais NFS-e prefeitura DC + `.pfx` e senha |
| Sprint 5 | 13–15 | M4 pós-venda, M8 dashboard completo, DRE, go-live | Disponibilidade do dono para testes |

### Estratégia de deploy sem downtime
1. Migration SQL aplicada primeiro (novas tabelas não afetam existentes)
2. `git pull` + `pm2 reload lkl-chatbot` (reload graceful)
3. Cada migration tem script `DOWN` para rollback

### Go-live gradual
- **Semana 13:** testes internos com equipe LKL
- **Semana 14:** operação assistida
- **Semana 15:** produção plena, SisGraph desativado

---

## 12. Dados Migrados do SisGraph

| Base | Registros | Qualidade | Ação |
|---|---|---|---|
| Clientes | 1.288 | Nome 100%, celular 39%, e-mail 31%, sem CPF/CNPJ | Importar no Sprint 1; CPF/CNPJ coletado no próximo pedido |
| Fornecedores | 281 | 87% sem e-mail | Importar no Sprint 1; e-mail coletado progressivamente |
| Tabela de preços | — | Não extraída do SisGraph | Construir do zero com o dono no Sprint 2 |

---

## 13. Checklist de Aquisições (o que o cliente precisa providenciar)

### Imediato
- [x] Repositório Git inicializado ✅ (feito em 15/06/2026)
- [ ] Criar projeto no Firebase Console → ativar Cloud Messaging → baixar credenciais
- [ ] Separar arquivo `.pfx` do certificado A1 e a senha

### Antes do Sprint 2
- [ ] Agendar reunião com o dono para mapear lógica de orçamento (produtos, acabamentos, faixas, preços)

### Antes do Sprint 3
- [ ] Acessar `developers.c6bank.com.br` → criar conta → solicitar credenciais sandbox → gerar certificado mTLS
- [ ] Cadastrar chave PIX EVP na conta PJ C6 pelo app
- [ ] Pegar `MP_ACCESS_TOKEN` no painel developer do Mercado Pago

### Antes do Sprint 4
- [ ] Separar usuário + senha do portal NFS-e da Prefeitura de Duque de Caxias
- [ ] Confirmar URL do webservice ABRASF nas configurações do portal
