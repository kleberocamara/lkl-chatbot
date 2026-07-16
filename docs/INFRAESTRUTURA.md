# Infraestrutura e Sistemas — Gráfica LKL

> Documento de referência técnica para handoff/manutenção. **Não contém senhas nem chaves** — só nomes de variáveis, propósito de cada integração e onde as credenciais reais ficam guardadas. Mantenha este arquivo fora de qualquer publicação pública (é para uso interno da equipe/dev).

Última atualização: 2026-07-16

---

## 1. Visão geral da arquitetura

```
WhatsApp (Meta) ──┐
Cliente / Fornecedor ──┤
Navegador (painel) ────┼──► LiteSpeed (proxy :80/:443) ──► Node.js/Express (PM2, :3000) ──► PostgreSQL 16
                        │                                         │
                        │                                         ├──► Sidecar Python/Flask (NF-e, :3001, localhost)
                        │                                         ├──► OpenAI (chatbot + OCR)
                        │                                         ├──► Anthropic Claude (insights gerenciais)
                        │                                         ├──► Firebase (push notifications PWA)
                        │                                         ├──► Mercado Pago (checkout/PIX)
                        │                                         ├──► C6 Bank (boleto/PIX/pagamentos, mTLS)
                        │                                         ├──► SEFAZ (NF-e, mTLS/A1)
                        │                                         └──► SMTP (e-mail)
                        └── 2 domínios apontando pro mesmo app (ver §3)
```

Tudo roda num único servidor (VPS). Não há ambiente de staging separado — deploy é direto em produção via `rsync` + `pm2 restart`.

---

## 2. Hospedagem (VPS)

| Item | Valor |
|---|---|
| Provedor | Hostinger |
| IP | `2.25.147.243` |
| Acesso | SSH (chave própria, ver `~/.ssh/config` local — host `lkl`) |
| SO | Ubuntu 24.04.4 LTS |
| Painel de controle / proxy | **LiteSpeed** (não nginx — há um nginx instalado mas não está em uso, só o pacote default do Ubuntu) |
| Vhosts LiteSpeed | `/usr/local/lsws/conf/vhosts/` — `lkl` (chatbot.klebercamaraconsultoria.cloud) e `graficalkl` (app.graficalkl.com.br), ambos fazem proxy pra `http://localhost:3000` |
| Certificados SSL | Let's Encrypt via certbot, um por domínio (ver §3) |
| Disco | ~96GB total, ~6GB em uso |
| Backup automatizado | **Não há** — nenhum cron de backup de banco/arquivos configurado no momento. Ponto de atenção pra endereçar. |

---

## 3. Domínios e DNS

| Domínio | Aponta pra | Observação |
|---|---|---|
| **`app.graficalkl.com.br`** | `2.25.147.243` | **Domínio oficial** — definido em 2026-07-16. `BASE_URL`/`APP_URL` do `.env` apontam pra ele. |
| `chatbot.klebercamaraconsultoria.cloud` | `2.25.147.243` | Domínio usado durante o desenvolvimento (consultoria). Continua respondendo (mesmo app, mesmo certificado válido) por compatibilidade, mas não é mais o oficial. |

Comentário antigo no `.env` sugeria `https://chatbot.lklgrafica.com.br` como URL futura — esse domínio nunca chegou a ser registrado; a decisão final foi usar `app.graficalkl.com.br`, que já era da própria empresa.

> **Pendência remanescente**: os webhooks registrados nos painéis externos (Meta/WhatsApp, Mercado Pago) ainda apontam pro path do domínio antigo (`chatbot.klebercamaraconsultoria.cloud/webhook/...`). Isso **continua funcionando** normalmente porque os dois domínios apontam pro mesmo servidor/app — não é urgente. Mas pra terminar a migração por completo, vale reconfigurar esses webhooks nos painéis da Meta e do Mercado Pago pra usarem `app.graficalkl.com.br`, e depois considerar desativar o domínio antigo.
>
> **Nota técnica**: ao trocar `BASE_URL`/`APP_URL` no `.env`, o PM2 **não pega o valor novo automaticamente** mesmo com `pm2 restart --update-env` (ele cacheia o env do processo). É preciso reiniciar exportando a variável inline: `BASE_URL='...' APP_URL='...' pm2 restart lkl-chatbot --update-env && pm2 save`. Ver `reference_vps_pm2_env` na memória do projeto.

---

## 4. Repositório de código

| Item | Valor |
|---|---|
| Plataforma | GitHub |
| URL | `https://github.com/kleberocamara/lkl-chatbot` |
| Branch principal | `main` |
| Deploy | Manual — `rsync` dos arquivos alterados pra `/var/www/lkl-chatbot/` na VPS, seguido de `pm2 restart lkl-chatbot --update-env`. Não há CI/CD automatizado. |
| Migrations SQL | `sql/migrations/*.sql`, numeradas sequencialmente, aplicadas manualmente via `psql` na VPS (não há runner automático — `src/db/migrate.js`/`sql/schema.sql` estão desatualizados e não refletem o schema real) |

---

## 5. Banco de dados

| Item | Valor |
|---|---|
| Engine | PostgreSQL 16.14 (Ubuntu) |
| Nome do banco | `lkl_chatbot` |
| Acesso local (na VPS) | `sudo -u postgres psql lkl_chatbot` |
| Acesso da aplicação | via `pg` (node-postgres), configurado por `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` no `.env` |
| Backup | **Nenhum backup automatizado configurado** (mesmo ponto do §2) |

---

## 6. Aplicação principal (Node.js)

| Item | Valor |
|---|---|
| Runtime | Node.js v26.1.0 |
| Framework | Express 4 |
| Gerenciador de processo | PM2 v7 (`pm2-root` habilitado no systemd, sobrevive a reboot) |
| Nome do processo PM2 | `lkl-chatbot` (modo `cluster`) |
| Porta interna | `3000` |
| Diretório na VPS | `/var/www/lkl-chatbot/` |
| Logs | `pm2 logs lkl-chatbot` (arquivos em `/var/www/lkl-chatbot/logs/`) |
| Real-time | Socket.IO (atualizações ao vivo no painel — novas mensagens, aprovações, etc.) |
| Autenticação | JWT em cookie httpOnly (`JWT_SECRET`), sessão de 12h |
| Principais libs | `express`, `pg`, `openai`, `firebase-admin`, `pdfkit`, `playwright`, `socket.io`, `nodemailer`, `fast-xml-parser`, `helmet`, `express-rate-limit` |

### Frentes servidas pelo mesmo processo
- **Painel desktop**: `/dashboard` (`public/dashboard.html`) — atendimento, orçamentos, produção, financeiro, cadastros, usuários.
- **Manual do sistema**: `/manual` (`public/manual.html`) — documentação de uso, acessível sem necessidade de navegar pelo painel.
- **PWAs mobile**: `/pwa/*.html` — apps dedicados por perfil (vendedor/orçamentos, operador/produção, motorista/entregas, financeiro, admin, arte final).
- **Webhooks públicos**: `/webhook/whatsapp`, `/webhook/mercadopago`, `/webhook/c6bank`.
- **API interna**: `/api/*` (painel) e `/api/v2/*` (módulos mais recentes).

---

## 7. Sidecar de NF-e (Python)

| Item | Valor |
|---|---|
| Motivo de existir | Emissão de NF-e exige assinatura XML com certificado A1 e comunicação SOAP/REST com a SEFAZ — mais direto em Python do que replicar em Node. |
| Stack | Python 3 + Flask, ambiente virtual próprio |
| Diretório | `/var/www/lkl-chatbot/nfe_sidecar/` |
| Processo | `systemd` — serviço `nfe_sidecar.service`, habilitado (sobrevive a reboot), `Restart=always` |
| Porta | `3001`, só em `localhost` (não exposta à internet — só o Node conversa com ele) |
| Ambiente SEFAZ atual | **Homologação** (`NFE_AMBIENTE=2`) — notas emitidas não têm valor fiscal. Virada pra produção está deliberadamente adiada (ver `docs/superpowers` / memória do projeto — depende do dia oficial da migração dos sistemas da gráfica pra não colidir numeração com o sistema atual). |
| Certificados A1 | Dois certificados `.pfx`, um por CNPJ, em `/var/www/lkl-chatbot/certs/sefaz/` — confirmados como reais/válidos pelo cliente. Senha do certificado guardada só no `.env`/systemd, nunca no código. |
| CNPJs emissores | Grupo de Gráficas LKL LTDA (19.296.723/0001-08) e Factor Comunicação Visual LTDA (44.448.899/0001-85) |

---

## 8. Integrações externas

### 8.1 OpenAI (GPT)
- **Uso**: motor do chatbot de atendimento no WhatsApp (`gpt-4o` via function-calling) e leitura de notas fiscais/comprovantes por foto (OCR via visão computacional) no fluxo de Contas a Pagar.
- **Variáveis**: `OPENAI_API_KEY`, `OPENAI_MODEL`.
- **Onde**: `src/ai/agent.js`, `src/modules/contas-pagar/ocr.js`.

### 8.2 Anthropic (Claude)
- **Uso**: geração dos "Insights" automáticos na aba Análises Gerenciais (texto interpretando DRE/fluxo de caixa).
- **Modelo**: `claude-haiku-4-5`.
- **Variável**: `ANTHROPIC_API_KEY`.
- **Onde**: `src/modules/analises/service.js`.

### 8.3 Meta / WhatsApp Cloud API
- **Uso**: canal principal de atendimento — recebe e envia mensagens, mídia (fotos/PDF/áudio), templates.
- **Variáveis**: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_APP_SECRET` (valida assinatura HMAC do webhook), `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
- **Webhook**: `POST /webhook/whatsapp` (validado por assinatura — configurado no Meta for Developers).
- **Painel do desenvolvedor**: gerenciado via Meta for Developers / Meta Business Suite (acesso da conta da gráfica).

### 8.4 Google / Firebase
- **Uso**: envio de notificações push (FCM) pros PWAs instalados no celular (ex: operador é avisado quando uma nova OS chega pra ele).
- **Variáveis**: `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID`, `FIREBASE_MEASUREMENT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY_ID`, `FIREBASE_SERVICE_ACCOUNT_PATH`, `FCM_VAPID_PUBLIC_KEY`.
- **Console**: [console.firebase.google.com](https://console.firebase.google.com), projeto vinculado ao `FIREBASE_PROJECT_ID`.

### 8.5 Mercado Pago
- **Uso**: cobrança via checkout (link de pagamento), parcelamento no cartão, PIX.
- **Ambiente**: produção (chaves `APP_USR-...`), configurado em 2026-07-15.
- **Variáveis**: `MP_ACCESS_TOKEN`, `MP_PUBLIC_KEY`, `MP_WEBHOOK_SECRET`.
- **Webhook**: `POST /webhook/mercadopago` — **pendência conhecida**: a validação de assinatura do webhook está rejeitando notificações reais (ver memória do projeto `project_mp_webhook_assinatura_invalida`); pagamentos não fecham sozinhos até isso ser corrigido.
- **Painel**: [mercadopago.com.br/developers/panel](https://www.mercadopago.com.br/developers/panel), conta da gráfica.

### 8.6 C6 Bank
- **Uso**: emissão de boleto e PIX de cobrança a clientes, e pagamento em lote de contas a pagar (DDA, aprovação de lotes).
- **Ambiente**: produção, configurado em 2026-07-15 (mTLS com certificado próprio, distinto do certificado SEFAZ).
- **Variáveis**: `C6_ENV`, `C6_BASE_URL`, `C6_CLIENT_ID`, `C6_CLIENT_SECRET`, `C6_CERT_PATH`, `C6_KEY_PATH`, `C6_PIX_KEY`.
- **Certificado mTLS**: `/var/www/lkl-chatbot/certs/c6bank/` (produção e sandbox mantidos em arquivos separados pra rollback).
- **Webhook**: `POST /webhook/c6bank`.
- **Painel**: acesso via C6 Bank Empresas (API developer portal + conta PJ da gráfica).

### 8.7 SEFAZ (NF-e)
- Ver §7 (Sidecar de NF-e). Ambiente atual: homologação.

### 8.8 SMTP (e-mail)
- **Uso**: envio de orçamento em PDF por e-mail, notificações administrativas.
- **Variáveis**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `NOTIFY_EMAIL`.

### 8.9 Graficonauta (revenda)
- **Uso**: automação de compras de material de revenda — login automatizado (Playwright/cookie de sessão) no portal do fornecedor `sistema.graficonauta.com.br` pra consultar preços/fazer pedidos.
- **Variável**: `REVENDA_GRAFICONAUTA_COOKIE` (cookie de sessão autenticada — precisa ser renovado manualmente quando expira).
- **Onde**: `src/modules/revenda/scraper.js`.

### 8.10 Prefeitura (não utilizado atualmente)
- **Variáveis presentes no `.env` mas sem uso no código**: `PREFEITURA_LOGIN`, `PREFEITURA_SENHA` — resquício de uma investigação sobre emissão de NFS-e (nota fiscal de serviço) que não chegou a ser implementada. Seguro remover se confirmado que não será usado, ou manter reservado se a funcionalidade for retomada.

---

## 9. Variáveis de ambiente — inventário completo

Todas vivem em `/var/www/lkl-chatbot/.env` na VPS (não versionado no Git). Lista de **nomes** (sem valores):

```
NODE_ENV, PORT, BASE_URL, APP_URL, JWT_SECRET, SESSION_SECRET
DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
OPENAI_API_KEY, OPENAI_MODEL
ANTHROPIC_API_KEY
WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID,
  WHATSAPP_APP_SECRET, WHATSAPP_WEBHOOK_VERIFY_TOKEN
FIREBASE_PROJECT_ID, FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_STORAGE_BUCKET,
  FIREBASE_MESSAGING_SENDER_ID, FIREBASE_APP_ID, FIREBASE_MEASUREMENT_ID,
  FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY_ID, FIREBASE_SERVICE_ACCOUNT_PATH,
  FCM_VAPID_PUBLIC_KEY
MP_ACCESS_TOKEN, MP_PUBLIC_KEY, MP_WEBHOOK_SECRET
C6_ENV, C6_BASE_URL, C6_CLIENT_ID, C6_CLIENT_SECRET, C6_CERT_PATH, C6_KEY_PATH, C6_PIX_KEY
SEFAZ_CERT_PATH, SEFAZ_CERT_GRUPO, SEFAZ_CERT_FACTOR,
  SEFAZ_CERT_PASSWORD, SEFAZ_CERT_PASSWORD_GRUPO, SEFAZ_CERT_PASSWORD_FACTOR
EMPRESA_CNPJS
SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL
CONTAS_PAGAR_WHATSAPP_NUMEROS, OWNER_WHATSAPP
REVENDA_GRAFICONAUTA_COOKIE
PREFEITURA_LOGIN, PREFEITURA_SENHA   (não usadas atualmente — ver §8.10)
BUSINESS_HOURS_START, BUSINESS_HOURS_END, BUSINESS_TIMEZONE
AGENT_NAME
```

---

## 10. Segurança implementada

Resumo do que já foi endereçado numa auditoria de segurança feita durante o desenvolvimento:
- Validação de assinatura HMAC no webhook do WhatsApp (`WHATSAPP_APP_SECRET`).
- Rate limiting por telefone no webhook (evita flood/abuso do chatbot).
- Sanitização/escape de HTML no painel (proteção XSS).
- Reconciliação de pagamento C6 sempre reconsulta a API do banco antes de confirmar (não confia cegamente no corpo do webhook).
- Race conditions corrigidas em aprovação de orçamento (link de e-mail/WhatsApp não executa ação em GET, só em POST).
- Troca de senha obrigatória no primeiro acesso pra novos usuários do painel.
- Chave SSH dedicada sem passphrase pra automação de deploy, com acesso restrito de uso.

## 11. Pendências conhecidas (em 2026-07-16)

1. **Webhook do Mercado Pago rejeita assinatura real** — pagamentos via link MP não fecham sozinhos até correção (log de diagnóstico já ativo em produção).
2. **NF-e ainda em homologação** — virada pra produção adiada até o dia oficial da migração de sistemas da gráfica (precisa saber o último número real emitido por CNPJ antes de virar, pra não colidir numeração).
3. **Sem backup automatizado** de banco de dados nem de arquivos.
4. **Webhooks externos (Meta/WhatsApp, Mercado Pago) ainda registrados no domínio antigo** — `chatbot.klebercamaraconsultoria.cloud`. Funciona normalmente (mesmo servidor), mas o ideal é reapontar pros painéis usarem `app.graficalkl.com.br` (domínio oficial, definido em 2026-07-16) e depois desativar o domínio antigo.
5. **`PREFEITURA_LOGIN`/`PREFEITURA_SENHA`** — variáveis órfãs, sem código associado (NFS-e nunca foi implementada).
