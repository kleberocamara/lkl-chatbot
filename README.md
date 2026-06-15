# LKL Gráfica — Chatbot WhatsApp com IA

Chatbot 24/7 para WhatsApp integrado com GPT-4o, painel web de atendimento e notificações por email.

---

## Pré-requisitos

- VPS Hostinger com Ubuntu 22.04+
- Node.js 20+
- PostgreSQL 15+
- Domínio com HTTPS (obrigatório para webhook Meta)
- Conta Meta Developer com WhatsApp Cloud API ativa

---

## 1. Configurar o VPS Hostinger

```bash
# Atualizar sistema
sudo apt update && sudo apt upgrade -y

# Instalar Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Instalar PostgreSQL
sudo apt install -y postgresql postgresql-contrib

# Instalar PM2 (mantém o app rodando 24/7)
sudo npm install -g pm2

# Instalar Nginx (proxy reverso)
sudo apt install -y nginx certbot python3-certbot-nginx
```

---

## 2. Configurar PostgreSQL

```bash
sudo -u postgres psql

-- Dentro do psql:
CREATE DATABASE lkl_chatbot;
CREATE USER lkl_user WITH ENCRYPTED PASSWORD 'SUA_SENHA_AQUI';
GRANT ALL PRIVILEGES ON DATABASE lkl_chatbot TO lkl_user;
\q
```

---

## 3. Deploy do projeto

```bash
# Clonar/enviar os arquivos para o VPS
cd /var/www
git clone <seu-repositorio> lkl-chatbot
cd lkl-chatbot

# Instalar dependências
npm install --production

# Copiar e preencher o .env
cp .env.example .env
nano .env   # preencha todas as variáveis

# Criar tabelas no banco
npm run migrate

# Criar usuários padrão
npm run seed

# Iniciar com PM2
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup   # siga as instruções para iniciar no boot
```

---

## 4. Configurar Nginx + HTTPS

```nginx
# /etc/nginx/sites-available/lkl-chatbot
server {
    server_name chatbot.seudominio.com.br;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/lkl-chatbot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# HTTPS gratuito com Let's Encrypt
sudo certbot --nginx -d chatbot.seudominio.com.br
```

---

## 5. Configurar WhatsApp Cloud API (Meta)

1. Acesse [developers.facebook.com](https://developers.facebook.com) e crie um App do tipo **Business**
2. Adicione o produto **WhatsApp**
3. Em **Configuração do Webhook**:
   - URL: `https://chatbot.seudominio.com.br/webhook`
   - Token de verificação: o mesmo valor de `WHATSAPP_WEBHOOK_VERIFY_TOKEN` no `.env`
   - Campos a assinar: `messages`
4. Copie o **Phone Number ID** e o **Access Token** para o `.env`
5. Gere um **Token de Sistema Permanente** em: Configurações do Negócio → Usuários do Sistema

---

## 6. Acessar o painel

- URL: `https://chatbot.seudominio.com.br/dashboard`
- Admin padrão: `admin@lklgrafica.com.br` / `Admin@LKL2024`
- Analista padrão: `analista@lklgrafica.com.br` / `Analista@LKL2024`
- **⚠️ Altere as senhas imediatamente após o primeiro login!**

---

## Comandos úteis no VPS

```bash
pm2 status              # ver status do app
pm2 logs lkl-chatbot    # ver logs em tempo real
pm2 restart lkl-chatbot # reiniciar o app
pm2 stop lkl-chatbot    # parar o app
```

---

## Estrutura do projeto

```
lkl-chatbot/
├── src/
│   ├── index.js           # Servidor principal
│   ├── ai/agent.js        # Agente GPT-4o
│   ├── webhook/           # Recebe mensagens do WhatsApp
│   ├── dashboard/api.js   # API REST do painel
│   ├── services/          # WhatsApp, Email, Logger
│   ├── middleware/auth.js # Autenticação JWT
│   └── db/                # PostgreSQL + migrações
├── public/
│   ├── login.html         # Página de login
│   └── dashboard.html     # Painel completo
├── sql/schema.sql         # Schema do banco
├── ecosystem.config.js    # Configuração PM2
├── .env.example           # Template de variáveis
└── package.json
```
