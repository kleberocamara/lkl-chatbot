# CONTEXTO DO PROJETO — LKL Gráfica · Sistema de Atendimento

> Gerado em 15/06/2026 a partir das sessões: *WhatsApp chatbot for LKL graphics*, *LKL chatbot follow-up notifications*, *AI intervention in human-attended cases* e *Firebird database export error*. Atualize a cada sprint.

---

## 1. Objetivo do Projeto

Transformação operacional da **LKL Gráfica** por meio de automação end-to-end do ciclo comercial:

| Etapa | Sistema | Status |
|---|---|---|
| Captação de leads 24/7 via WhatsApp | Chatbot IA (GPT-4o) | ✅ Produção |
| Painel de atendimento para analistas | Dashboard web (Socket.IO) | ✅ Produção |
| Follow-up automático de orçamentos | Scheduler (5 tentativas) | ✅ Produção |
| Migração de dados legados (SISGRAF) | Export Firebird 2.1 → PostgreSQL | 🔴 Bloqueado (ver §5) |
| Novo sistema de gestão interno | ERP/CRM completo | 📋 Planejado |
| Site institucional / landing page | HTML estático | ✅ Pronto (Desktop/LKL) |

---

## 2. Arquitetura

```
Cliente WhatsApp
      │
      ▼
Meta Cloud API (WhatsApp Cloud API v19.0)
      │  POST /webhook
      ▼
┌─────────────────────────────────────────────────────┐
│  VPS Hostinger · Ubuntu 22.04 · IP: 2.25.147.243   │
│                                                     │
│  Nginx (proxy reverso + HTTPS via Certbot)          │
│       │                                             │
│       ▼                                             │
│  PM2 → Node.js (src/index.js, porta 3000)          │
│       │                                             │
│  ┌────┴───────────────────────────────────┐        │
│  │ Express App                            │        │
│  │  /webhook  → webhook/routes.js        │        │
│  │  /api      → dashboard/api.js         │        │
│  │  /         → public/ (HTML estático)  │        │
│  └────┬───────────────────────────────────┘        │
│       │                                             │
│  ┌────▼────┐  ┌────────────┐  ┌─────────────────┐ │
│  │ OpenAI  │  │ PostgreSQL │  │  Socket.IO 4    │ │
│  │ GPT-4o  │  │ lkl_chatbot│  │  (tempo real)   │ │
│  └─────────┘  └────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────┘
      │
      ▼ (notificações)
Analista (e-mail SMTP + painel web)
```

**Stack:**
| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Express 4 |
| Banco de dados | PostgreSQL 15 (pool `pg`, max 20 conexões) |
| IA | OpenAI SDK v4 — modelo `gpt-4o` |
| Tempo real | Socket.IO 4 (autenticado via JWT) |
| Auth | JWT 12h + cookie `httpOnly` |
| E-mail | Nodemailer SMTP (Gmail) |
| Scheduler | `setInterval` 60s (in-process) |
| Processo | PM2 (`ecosystem.config.js`) |
| Proxy | Nginx + Certbot HTTPS |

---

## 3. Principais Módulos

### `src/index.js` — Ponto de entrada
- Inicializa Express, Socket.IO, Helmet, CORS, Rate Limit (200/min webhook, 100/min API), Morgan
- Verifica conexão com PostgreSQL antes de subir
- Inicia o scheduler de follow-ups (`followup.startScheduler()`)
- Autentica conexões Socket.IO via JWT no cookie

### `src/webhook/routes.js` — Webhook Meta
- `GET /webhook` → verificação de challenge (token `WHATSAPP_WEBHOOK_VERIFY_TOKEN`)
- `POST /webhook` → responde 200 imediatamente; processa apenas `msg.type === 'text'`; chama `markAsRead` silenciosamente

### `src/webhook/handler.js` — Orquestrador
Fluxo por status da conversa:

| Status | Comportamento |
|---|---|
| `active` | IA processa e responde |
| `orcamento_enviado` | Detecta aprovação do cliente ("sim/confirmo/aceito"); se sim → `aguardando_humano` + cancela follow-ups; senão → `aguardando_humano` simples |
| `aguardando_humano` | Salva mensagem silenciosamente + emite `new_message` via Socket.IO (sem resposta automática ao cliente) |

Deduplicação via `Set` em memória (TTL 60s por `waMessageId`).

### `src/ai/agent.js` — Agente IA
- `SYSTEM_PROMPT` hardcoded com o perfil da LKL Gráfica (ou substituível por `settings.agent_prompt` do banco)
- Histórico de contexto armazenado em `conversations.ai_context` (JSONB), limitado a 30 mensagens
- Detecta tag `[PEDIDO_COMPLETO]` + JSON estruturado no retorno do modelo
- Ao detectar pedido completo: atualiza `conversations.status → 'aguardando_humano'`, `service_type`, `needs_details`
- Retorna resposta limpa ao cliente (sem a tag interna)

### `src/services/followup.js` — Scheduler de follow-up
Regras de agendamento (horário de Brasília, UTC-3 fixo desde 2019):

| Tentativa | Quando |
|---|---|
| 1ª | 4h após envio do orçamento; se > 20h ou FDS → próximo dia útil às 10h |
| 2ª | Dia seguinte às 10h (pula FDS) |
| 3ª | 3º dia às 10h (pula FDS) |
| 4ª | 5º dia às 10h (pula FDS) |
| 5ª | 10º dia às 10h (pula FDS) |

- `scheduleFollowUps(conversationId, sentAt)` → insere 5 registros em `follow_ups`
- `cancelPendingFollowUps(conversationId)` → cancela todos os `pending` quando cliente responde
- `startScheduler()` → `setInterval` 60s que verifica follow-ups vencidos e dispara via WhatsApp
- Mensagens personalizadas com nome do cliente para cada tentativa

### `src/dashboard/api.js` — API REST completa

| Rota | Acesso | Descrição |
|---|---|---|
| `POST /api/auth/login` | Público | JWT em cookie httpOnly |
| `GET /api/dashboard/stats` | Analista | Totais + logs recentes |
| `GET /api/conversations` | Analista | Paginado, filtro por status |
| `GET /api/conversations/:id` | Analista | Detalhe + mensagens |
| `POST /api/conversations/:id/reply` | Analista | Envia mensagem manual |
| `POST /api/conversations/:id/orcamento-enviado` | Analista | Marca orçamento enviado + agenda 5 follow-ups |
| `POST /api/conversations/:id/orcamento-aprovado` | Analista | Marca orçamento aprovado manualmente |
| `POST /api/conversations/:id/resolve` | Analista | Resolve conversa |
| `GET /api/orders` | Analista | Lista pedidos capturados pelo chatbot |
| `POST /api/orders/:id/status` | Analista | Altera status do pedido |
| `GET /api/orcamentos` | Analista | Lista orçamentos |
| `POST /api/orcamentos` | Analista | Cria orçamento |
| `PUT /api/orcamentos/:id/itens` | Analista | Edita itens do orçamento |
| `POST /api/orcamentos/:id/enviado` | Analista | Marca orçamento como enviado ao cliente |
| `POST /api/orcamentos/:id/aprovar` | Analista | Aprova orçamento |
| `POST /api/orcamentos/:id/cancelar` | Analista | Cancela orçamento |
| `POST /api/conversations/send-message` | Analista | Envia mensagem avulsa a qualquer número |
| `GET /api/media/:mediaId` | Analista | Proxy para mídia do WhatsApp |
| `GET /api/settings` | Admin | Lista configurações |
| `PUT /api/settings/:key` | Admin | Upsert de configuração |
| `GET /api/prices` | Analista | Tabela de preços |
| `POST /api/prices/:id` | Admin | Atualiza preço |
| `GET /api/users` | Admin | Lista usuários |
| `POST /api/users` | Admin | Cria usuário |
| `PATCH /api/users/:id/toggle` | Admin | Ativa/desativa usuário |

### `src/services/whatsapp.js`
- `sendMessage(to, text)` — WhatsApp Cloud API Graph v19.0
- `sendTemplate(to, name, lang, components)` — templates aprovados (implementado, não utilizado em fluxo)
- `markAsRead(messageId)` — falha silenciosa

### `src/services/email.js`
- `notifyAnalyst({ contact, conversation, orderDetails })` — e-mail HTML com link para o painel

### `src/middleware/auth.js`
- `requireAuthApi` — retorna 401 JSON
- `requireAdmin` — retorna 403 JSON
- `requireAuth` — redireciona para `/login`

### `sql/schema.sql` + `sql/followup_migration.sql`

**Tabelas principais:**

| Tabela | Campos-chave |
|---|---|
| `contacts` | `phone` (único), `name`, `profile_name`, `last_contact` |
| `conversations` | `status` (`active`, `aguardando_humano`, `orcamento_enviado`, `orcamento_sem_retorno`, `resolved`, `closed`), `ai_context` (JSONB), `needs_details` (JSONB), `orcamento_enviado_at`, `follow_up_count`, `pedido_numero`, `pedido_status` |
| `messages` | `direction` (`inbound`/`outbound`), `sent_by` (`ai`/`human`/`system`) |
| `follow_ups` | `conversation_id`, `attempt` (1-5), `scheduled_at`, `status` (`pending`/`sent`/`cancelled`) |
| `orcamentos` | Orçamentos formais com itens, status, vinculados à conversa |
| `users` | `role` (`admin`/`analyst`), `password_hash` (bcrypt) |
| `activity_logs` | Audit trail de todos os eventos |
| `settings` | Configurações chave-valor (prompt do agente, horários, mensagens) |

### `public/` — Frontend
- `login.html` — autenticação com logotipo LKL
- `dashboard.html` — painel completo: conversas, orçamentos, pedidos, configurações, usuários

---

## 4. Convenções de Código

- **Linguagem:** JavaScript (CommonJS / `require`)
- **Status de conversa:** sempre em português — `aguardando_humano` (não `waiting_human`)
- **Banco:** queries parametrizadas `$1, $2...`; IDs em UUID v4; timezone fixo SP = UTC-3
- **Erros externos** (e-mail, WhatsApp): capturados com `try/catch` sem derrubar o fluxo
- **Segurança:** Helmet (CSP off), Rate Limit, JWT httpOnly, bcrypt salt 10
- **IA:** contexto limitado a 30 mensagens; prompt substituível via `settings.agent_prompt`
- **Deploy:** `pm2 restart lkl-chatbot` no VPS; variáveis em `.env` (nunca commitado)
- **Sem linter/testes** configurados

---

## 5. Pendências

### Alta prioridade

- [ ] **Migração de dados do SISGRAF (Firebird 2.1 → PostgreSQL)**
  - Banco legado em `/Users/klebercamara/Desktop/Projeto Grafica LKL/SISGRAF/SISGRAF.FDB`
  - **Bloqueio atual:** Firebird 5.0 instalado é incompatível com banco versão 2.1; Mac é Apple Silicon (ARM64) — pkg Intel não funciona nativamente
  - **Solução definida:** instalar Docker Desktop (Apple Silicon) e usar container `jacobalberty/firebird:2.5-sc`
  - Tabelas a exportar: `CLIENTE`, `PEDIDO`, `PRODUTO`, `FORNECEDOR` (confirmar estrutura via `SHOW TABLE`)
  - Após exportar: criar script de importação para PostgreSQL

- [ ] **Suporte a mídias no WhatsApp** — imagens, documentos e áudios são ignorados (`msg.type !== 'text'`); clientes enviam fotos de artes com frequência

### Funcionalidades planejadas

- [ ] **Horário de atendimento** — `business_hours_start/end` e `BUSINESS_TIMEZONE` existem no `.env` e no banco mas não são verificados no webhook; fora do horário o bot deveria avisar e não processar
- [ ] **Mensagem de boas-vindas automática** — `settings.welcome_message` no banco mas não disparada em novas conversas
- [ ] **Atribuição de analista** — campo `assigned_to` existe em `conversations` mas sem endpoint/lógica
- [ ] **Módulo de gestão interno** (novo sistema) — ERP/CRM completo planejado para substituir o SISGRAF; escopo detalhado em `/Desktop/Projeto Grafica LKL/NOVO SISTEMA/LKL_Requisitos_Sistema_v1.docx`

### Técnicas

- [ ] **Deduplicação em memória** — o `Set` de `processedMessages` é perdido ao reiniciar o PM2; usar Redis ou coluna `processed` no banco
- [ ] **Scheduler in-process** — o `setInterval` de follow-ups está dentro do processo Node.js; se o processo cair os follow-ups ficam suspensos até o restart; considerar `node-cron` ou job externo
- [ ] **Bug:** `total_conversations` em `saveMessage` incrementa com `+ 0` — não incrementa nada
- [ ] **Paginação:** `GET /api/conversations` não retorna total de registros para o frontend paginar
- [ ] **Refresh de token JWT:** sem endpoint; ao expirar (12h) o analista precisa fazer login novamente
- [ ] **`express-session`** listado no `package.json` mas não utilizado no código
- [ ] **Linter / testes automatizados:** sem ESLint, Prettier ou qualquer suite de testes
- [ ] **Git:** repositório sem histórico de commits — inicializar com `git init` e configurar `.gitignore`
- [ ] **Backup do banco:** sem rotina documentada/configurada no VPS

---

## 6. Histórico de Alterações e Próximos Passos

### Sessão 1 — *WhatsApp chatbot for LKL graphics* · ~07/06/2026
**O que foi feito:**
- Projeto criado do zero: 20 arquivos (src/, public/, sql/, .env.example, ecosystem.config.js, README.md)
- VPS Hostinger configurado: Node.js 20, PostgreSQL 15, PM2, Nginx, Certbot HTTPS
- Meta Developer configurado: App Business, WhatsApp Cloud API, token permanente de sistema
- Logotipo LKL aplicado no painel e na tela de login
- Deploy realizado no VPS `2.25.147.243`

### Sessão 2 — *LKL chatbot follow-up notifications* · ~10-11/06/2026
**O que foi feito:**
- Sistema de follow-up criado do zero (não existia no código original):
  - `sql/followup_migration.sql` → tabela `follow_ups` + colunas `orcamento_enviado_at`, `follow_up_count` em `conversations` + novos status
  - `src/services/followup.js` → lógica completa de agendamento com timezone SP
  - Endpoint `POST /api/conversations/:id/orcamento-enviado` → agenda os 5 follow-ups
  - Scheduler iniciado no `src/index.js` (verifica a cada 60s)
- Endpoints faltantes criados: `/api/orders`, `/api/orcamentos` e variantes
- **Bug corrigido:** `status = 'waiting_human'` no `agent.js` era rejeitado pela constraint do banco → corrigido para `'aguardando_humano'`
- Migração rodada no VPS via SSH

### Sessão 3 — *AI intervention in human-attended cases* · ~05/06/2026
**O que foi feito:**
- Comportamento do bot quando `aguardando_humano` corrigido:
  - **Antes:** enviava mensagem automática de espera ao cliente (causava reclamações: *"Tem como desativar esse robô chato?"*)
  - **Depois:** salva mensagem silenciosamente + emite evento Socket.IO para o painel; analista fica no controle total
- Renomeação global `waiting_human` → `aguardando_humano` em 6 arquivos:
  - `src/webhook/handler.js`, `src/ai/agent.js`, `src/dashboard/api.js`, `public/dashboard.html`, `sql/schema.sql`, `CONTEXTO.md`
- UPDATE rodado no banco: `UPDATE conversations SET status = 'aguardando_humano' WHERE status = 'waiting_human';` (retornou `UPDATE 0` — não havia registros antigos)

### Sessão 4 — *Firebird database export error* · ~10/06/2026
**O que foi feito:**
- Identificado banco legado SISGRAF (Firebird 2.1) em `/Desktop/Projeto Grafica LKL/SISGRAF/SISGRAF.FDB`
- Tentativas de conexão com `isql` (Firebird 5.0 instalado): incompatibilidade de versão (banco v2.1 vs cliente v5.0)
- Tentativas com Python (`firebird-driver`, `fdb`): falhou por biblioteca `libfbclient.dylib` com dependências quebradas
- Mac é ARM64 (Apple Silicon) — pkg Intel do Firebird 2.5 não funciona
- **Status: BLOQUEADO**

### Próximos Passos (por prioridade)

1. **Desbloquear migração SISGRAF**
   - Instalar Docker Desktop para Apple Silicon
   - Rodar: `docker run --rm -v /tmp/SISGRAF.FDB:/db/SISGRAF.FDB jacobalberty/firebird:2.5-sc isql-fb ...`
   - Exportar tabelas para CSV/SQL
   - Criar script de importação para PostgreSQL

2. **Suporte a mídias no WhatsApp**
   - Tratar `msg.type === 'image'` e `msg.type === 'document'`
   - Proxy via endpoint `/api/media/:mediaId` (já criado)

3. **Horário de atendimento**
   - Implementar verificação de `business_hours` no handler antes de processar com IA

4. **Inicializar repositório Git**
   - `git init` no `/Users/klebercamara/LKL`
   - Criar `.gitignore` adequado (node_modules, .env, .DS_Store)
   - Primeiro commit do estado atual

5. **Planejamento do novo sistema de gestão** (ERP/CRM)
   - Revisar documentos em `/Desktop/Projeto Grafica LKL/NOVO SISTEMA/`
   - Definir se será extensão do sistema atual ou projeto separado

---

*Gerado por análise das sessões Claude Code em 15/06/2026. VPS: `ssh root@2.25.147.243` · Projeto: `/Users/klebercamara/LKL`*
