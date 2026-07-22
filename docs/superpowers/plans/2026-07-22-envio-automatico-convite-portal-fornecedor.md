# Envio automático do convite do Portal do Fornecedor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ao liberar o acesso de um fornecedor ao portal, enviar o link de convite automaticamente por e-mail (remetente dedicado `fornecedores@graficalkl.com.br`) e WhatsApp (celular já cadastrado), sem exigir digitação manual do atendente.

**Architecture:** Extensão dos módulos existentes — `src/services/email.js` ganha um segundo transporter SMTP dedicado + uma função de envio; `src/modules/fornecedores/router.js` reescreve `POST /:id/portal/liberar` pra buscar e-mail/celular do cadastro em vez de receber por parâmetro; `public/dashboard.html` remove o `prompt()` de e-mail.

**Tech Stack:** Node.js/Express, `nodemailer` (já em uso), `src/services/whatsapp.js` (já em uso), Jest.

**Spec:** `docs/superpowers/specs/2026-07-22-envio-automatico-convite-portal-fornecedor-design.md`

---

### Task 1: `email.js` — transporter dedicado + `enviarConvitePortalFornecedor`

**Files:**
- Modify: `src/services/email.js`
- Test: `tests/email-convite-fornecedor.test.js`

- [ ] **Step 1: Escrever o teste**

```js
// tests/email-convite-fornecedor.test.js
jest.mock('nodemailer', () => {
  const transports = {};
  return {
    createTransport: jest.fn((cfg) => {
      const t = { sendMail: jest.fn().mockResolvedValue({ messageId: 'msg-id-teste' }), _cfg: cfg };
      transports[cfg.auth.user] = t;
      return t;
    }),
    __transports: transports,
  };
});

process.env.SMTP_HOST = 'smtp.existing.com';
process.env.SMTP_PORT = '587';
process.env.SMTP_USER = 'orcamentos@graficalkl.com.br';
process.env.SMTP_PASS = 'senha-existente';
process.env.SMTP_FORNECEDOR_HOST = 'smtp.hostinger.com';
process.env.SMTP_FORNECEDOR_PORT = '587';
process.env.SMTP_FORNECEDOR_USER = 'fornecedores@graficalkl.com.br';
process.env.SMTP_FORNECEDOR_PASS = 'senha-fornecedores';
process.env.BASE_URL = 'https://app.graficalkl.com.br';

const nodemailer = require('nodemailer');
const email = require('../src/services/email');

describe('enviarConvitePortalFornecedor', () => {
  test('usa o transporter dedicado (SMTP_FORNECEDOR_*), não o transporter existente', async () => {
    await email.enviarConvitePortalFornecedor({
      email: 'contato@vinilline.com.br',
      nome: 'Vinil Line',
      conviteUrl: 'https://app.graficalkl.com.br/portal-fornecedor/definir-senha.html?token=abc123',
    });

    const transporterFornecedor = nodemailer.__transports['fornecedores@graficalkl.com.br'];
    expect(transporterFornecedor.sendMail).toHaveBeenCalledTimes(1);
    const chamada = transporterFornecedor.sendMail.mock.calls[0][0];
    expect(chamada.to).toBe('contato@vinilline.com.br');
    expect(chamada.from).toContain('fornecedores@graficalkl.com.br');
    expect(chamada.subject).toMatch(/Portal do Fornecedor/i);
    expect(chamada.html).toContain('Vinil Line');
    expect(chamada.html).toContain('https://app.graficalkl.com.br/portal-fornecedor/definir-senha.html?token=abc123');

    const transporterExistente = nodemailer.__transports['orcamentos@graficalkl.com.br'];
    expect(transporterExistente).toBeUndefined(); // não foi usado nesse fluxo, nem precisa existir ainda
  });

  test('menciona validade de 7 dias no corpo do e-mail', async () => {
    await email.enviarConvitePortalFornecedor({
      email: 'x@y.com', nome: 'Fornecedor X', conviteUrl: 'https://x.com/token',
    });
    const transporterFornecedor = nodemailer.__transports['fornecedores@graficalkl.com.br'];
    const chamada = transporterFornecedor.sendMail.mock.calls.at(-1)[0];
    expect(chamada.html).toMatch(/7 dias/);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `npx jest tests/email-convite-fornecedor.test.js`
Expected: FAIL — `email.enviarConvitePortalFornecedor is not a function`

- [ ] **Step 3: Implementar**

Em `src/services/email.js`, logo depois da declaração do `transporter` existente (linha ~22), adicione o segundo transporter e a nova função. Substitua a linha `module.exports = { notifyAnalyst, enviarOrcamentoCliente };` no final do arquivo:

```js
const SMTP_FORNECEDOR_PORT = parseInt(process.env.SMTP_FORNECEDOR_PORT);
const transporterFornecedor = nodemailer.createTransport({
  host: process.env.SMTP_FORNECEDOR_HOST,
  port: SMTP_FORNECEDOR_PORT,
  secure: SMTP_FORNECEDOR_PORT === 465,
  auth: {
    user: process.env.SMTP_FORNECEDOR_USER,
    pass: process.env.SMTP_FORNECEDOR_PASS,
  },
});

async function enviarConvitePortalFornecedor({ email, nome, conviteUrl }) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <div style="background:#1a237e;padding:20px 24px;text-align:center">
        <img src="${getLogoBase64()}" alt="Gráfica LKL" style="height:56px;display:inline-block">
        <div style="color:white;font-size:16px;font-weight:700;margin-top:8px">Portal do Fornecedor</div>
      </div>
      <div style="padding:28px;background:#f9f9f9">
        <p style="font-size:15px">Olá, <strong>${nome}</strong>!</p>
        <p>A Gráfica LKL liberou seu acesso ao Portal do Fornecedor. Por lá você pode declarar Notas Fiscais, itens e forma de pagamento antes da entrega da mercadoria.</p>
        <div style="margin:28px 0;text-align:center">
          <a href="${conviteUrl}"
             style="background:#1a237e;color:white;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:bold;display:inline-block">
            Definir minha senha e acessar
          </a>
        </div>
        <p style="font-size:13px;color:#555">Este link é válido por 7 dias. Se expirar, peça um novo convite à Gráfica LKL.</p>
      </div>
      <div style="padding:12px;text-align:center;color:#aaa;font-size:11px">
        Gráfica LKL — Portal do Fornecedor
      </div>
    </div>`;

  const info = await transporterFornecedor.sendMail({
    from: `"Gráfica LKL — Fornecedores" <${process.env.SMTP_FORNECEDOR_USER}>`,
    to: email,
    subject: 'Acesso ao Portal do Fornecedor — Gráfica LKL',
    html,
  });
  console.log(`[EMAIL] Convite do portal do fornecedor enviado para ${email} (messageId: ${info.messageId})`);
}

module.exports = { notifyAnalyst, enviarOrcamentoCliente, enviarConvitePortalFornecedor };
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npx jest tests/email-convite-fornecedor.test.js`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add src/services/email.js tests/email-convite-fornecedor.test.js
git commit -m "feat(portal-fornecedor): transporter SMTP dedicado e email de convite do portal"
```

---

### Task 2: `fornecedores/router.js` — reescreve `POST /:id/portal/liberar`

**Files:**
- Modify: `src/modules/fornecedores/router.js`
- Test: `tests/fornecedores-portal-liberar.test.js` (já existe — vai ser reescrito)

- [ ] **Step 1: Ler o arquivo atual pra confirmar imports/estrutura**

Run: `sed -n '1,10p' src/modules/fornecedores/router.js`

- [ ] **Step 2: Reescrever o teste**

Substitua TODO o conteúdo de `tests/fornecedores-portal-liberar.test.js`:

```js
jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/modules/portal-fornecedor/auth-service', () => ({ criarConvite: jest.fn() }));
jest.mock('../src/services/email', () => ({ enviarConvitePortalFornecedor: jest.fn() }));
jest.mock('../src/services/whatsapp', () => ({ sendMessage: jest.fn() }));

const request = require('supertest');
const express = require('express');

process.env.JWT_SECRET = 'test-secret';
process.env.BASE_URL = 'https://app.graficalkl.com.br';

const db = require('../src/db');
const authService = require('../src/modules/portal-fornecedor/auth-service');
const email = require('../src/services/email');
const whatsapp = require('../src/services/whatsapp');
const fornecedoresRouter = require('../src/modules/fornecedores/router');

const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: 'user-1', role: 'admin' }; next(); });
app.use('/fornecedores', fornecedoresRouter);

describe('POST /fornecedores/:id/portal/liberar', () => {
  afterEach(() => jest.clearAllMocks());

  test('com email e celular cadastrados → libera e envia pelos dois canais', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'forn-1', nome: 'Vinil Line', email: 'contato@vinilline.com.br', celular: '21986449859' }] });
    authService.criarConvite.mockResolvedValueOnce({ conviteToken: 'abc123' });
    email.enviarConvitePortalFornecedor.mockResolvedValueOnce();
    whatsapp.sendMessage.mockResolvedValueOnce();

    const res = await request(app).post('/fornecedores/forn-1/portal/liberar').send({});

    expect(res.status).toBe(200);
    expect(res.body.conviteUrl).toMatch(/\/portal-fornecedor\/definir-senha\.html\?token=abc123$/);
    expect(res.body.enviadoEmail).toBe(true);
    expect(res.body.enviadoWhatsapp).toBe(true);
    expect(res.body.avisos).toEqual([]);
    expect(authService.criarConvite).toHaveBeenCalledWith('forn-1', 'contato@vinilline.com.br');
    expect(email.enviarConvitePortalFornecedor).toHaveBeenCalledWith(expect.objectContaining({
      email: 'contato@vinilline.com.br', nome: 'Vinil Line',
    }));
    expect(whatsapp.sendMessage).toHaveBeenCalledWith('5521986449859', expect.stringContaining('token=abc123'));
  });

  test('sem celular cadastrado → libera, envia só email, avisa da ausência de WhatsApp', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'forn-2', nome: 'Fornecedor Y', email: 'y@x.com', celular: null }] });
    authService.criarConvite.mockResolvedValueOnce({ conviteToken: 'xyz789' });
    email.enviarConvitePortalFornecedor.mockResolvedValueOnce();

    const res = await request(app).post('/fornecedores/forn-2/portal/liberar').send({});

    expect(res.status).toBe(200);
    expect(res.body.enviadoEmail).toBe(true);
    expect(res.body.enviadoWhatsapp).toBe(false);
    expect(res.body.avisos.some(a => /celular/i.test(a))).toBe(true);
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('sem email cadastrado → 400, não cria convite nem envia nada', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'forn-3', nome: 'Fornecedor Z', email: null, celular: '21999998888' }] });

    const res = await request(app).post('/fornecedores/forn-3/portal/liberar').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/e-mail/i);
    expect(authService.criarConvite).not.toHaveBeenCalled();
    expect(email.enviarConvitePortalFornecedor).not.toHaveBeenCalled();
    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('falha no envio de email não derruba a rota — convite continua disponível', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'forn-4', nome: 'Fornecedor W', email: 'w@x.com', celular: null } ]});
    authService.criarConvite.mockResolvedValueOnce({ conviteToken: 'fail-email' });
    email.enviarConvitePortalFornecedor.mockRejectedValueOnce(new Error('SMTP indisponível'));

    const res = await request(app).post('/fornecedores/forn-4/portal/liberar').send({});

    expect(res.status).toBe(200);
    expect(res.body.conviteUrl).toMatch(/token=fail-email$/);
    expect(res.body.enviadoEmail).toBe(false);
    expect(res.body.avisos.some(a => /e-mail/i.test(a))).toBe(true);
  });

  test('fornecedor não encontrado → 404', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post('/fornecedores/inexistente/portal/liberar').send({});
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `npx jest tests/fornecedores-portal-liberar.test.js`
Expected: FAIL (rota ainda exige `email` no body, não tem `enviadoEmail`/`enviadoWhatsapp`/`avisos`)

- [ ] **Step 4: Implementar**

Em `src/modules/fornecedores/router.js`, adicione os imports no topo (depois da linha 4):

```js
const email = require('../../services/email');
const whatsapp = require('../../services/whatsapp');
```

Substitua a rota `POST /:id/portal/liberar` inteira por:

```js
function celularParaWhatsapp(celular) {
  const d = String(celular || '').replace(/\D/g, '');
  if (!d) return null;
  return d.startsWith('55') ? d : '55' + d;
}

router.post('/:id/portal/liberar', async (req, res) => {
  try {
    const forn = await db.query('SELECT id, nome, email, celular FROM fornecedores WHERE id = $1', [req.params.id]);
    if (!forn.rows[0]) return res.status(404).json({ error: 'Fornecedor não encontrado' });
    const { nome, email: fornEmail, celular } = forn.rows[0];
    if (!fornEmail) return res.status(400).json({ error: 'Cadastre o e-mail do fornecedor antes de liberar o acesso ao portal' });

    const { conviteToken } = await authService.criarConvite(req.params.id, fornEmail);
    const baseUrl = process.env.BASE_URL || 'https://app.graficalkl.com.br';
    const conviteUrl = `${baseUrl}/portal-fornecedor/definir-senha.html?token=${conviteToken}`;

    const avisos = [];
    let enviadoEmail = false;
    let enviadoWhatsapp = false;

    try {
      await email.enviarConvitePortalFornecedor({ email: fornEmail, nome, conviteUrl });
      enviadoEmail = true;
    } catch (e) {
      console.error('[FORNECEDORES] Falha ao enviar e-mail de convite:', e.message);
      avisos.push('Falha ao enviar e-mail: ' + e.message);
    }

    const numeroWhatsapp = celularParaWhatsapp(celular);
    if (numeroWhatsapp) {
      try {
        await whatsapp.sendMessage(numeroWhatsapp,
          `🏭 *Gráfica LKL — Portal do Fornecedor*\n\nOlá, ${nome}! Seu acesso ao Portal do Fornecedor foi liberado.\n\nDefina sua senha e acesse: ${conviteUrl}\n\nEsse link é válido por 7 dias.`);
        enviadoWhatsapp = true;
      } catch (e) {
        console.error('[FORNECEDORES] Falha ao enviar WhatsApp de convite:', e.message);
        avisos.push('Falha ao enviar WhatsApp: ' + e.message);
      }
    } else {
      avisos.push('Sem celular cadastrado — WhatsApp não enviado');
    }

    res.json({ ok: true, conviteUrl, enviadoEmail, enviadoWhatsapp, avisos });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});
```

- [ ] **Step 5: Rodar e confirmar que passa**

Run: `npx jest tests/fornecedores-portal-liberar.test.js`
Expected: PASS (5/5)

- [ ] **Step 6: Rodar a suíte completa**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: baseline conhecida (5 suites falhando por Postgres local ausente), sem regressão nova.

- [ ] **Step 7: Commit**

```bash
git add src/modules/fornecedores/router.js tests/fornecedores-portal-liberar.test.js
git commit -m "feat(portal-fornecedor): liberar acesso envia convite automatico por email e whatsapp"
```

---

### Task 3: `dashboard.html` — remove o prompt de e-mail, mostra resumo do envio

**Files:**
- Modify: `public/dashboard.html`

- [ ] **Step 1: Localizar a função atual**

Run: `grep -n "async function liberarPortalFornecedor" public/dashboard.html`

- [ ] **Step 2: Substituir a função**

Troque a função `liberarPortalFornecedor` inteira (por volta da linha 3172) por:

```js
async function liberarPortalFornecedor(fornecedorId) {
  const r = await api(`/api/v2/fornecedores/${fornecedorId}/portal/liberar`, { method: 'POST', body: JSON.stringify({}) });
  if (!r?.conviteUrl) {
    showToast('❌ ' + (r?.error || 'Erro ao liberar portal'));
    return;
  }
  const canais = [];
  if (r.enviadoEmail) canais.push('e-mail');
  if (r.enviadoWhatsapp) canais.push('WhatsApp');
  const resumo = canais.length ? `✅ Convite enviado por ${canais.join(' e ')}` : '⚠️ Convite gerado, mas não foi possível enviar por nenhum canal';
  const avisos = (r.avisos || []).length ? '\n\n' + r.avisos.join('\n') : '';
  showToast(resumo + avisos);
  prompt('Link de convite (backup — copie e envie manualmente se precisar):', r.conviteUrl);
}
```

- [ ] **Step 3: Testar manualmente**

Suba o servidor local (`preview_start`), abra o cadastro de um fornecedor com e-mail e celular preenchidos, clique em "Liberar acesso ao Portal do Fornecedor", confirme que não pede mais e-mail digitado e mostra o toast de confirmação.

- [ ] **Step 4: Commit**

```bash
git add public/dashboard.html
git commit -m "feat(portal-fornecedor): remove prompt de email, mostra resumo do envio automatico"
```

---

### Task 4: `.env.example` + Deploy no VPS

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Documentar as novas variáveis**

Em `.env.example`, logo após o bloco `SMTP_*` existente (linha ~48), adicione:

```
# E-mail dedicado para envio de convites do Portal do Fornecedor (conta separada da acima)
SMTP_FORNECEDOR_HOST=smtp.hostinger.com
SMTP_FORNECEDOR_PORT=587
SMTP_FORNECEDOR_USER=fornecedores@graficalkl.com.br
SMTP_FORNECEDOR_PASS=                         # senha da caixa fornecedores@graficalkl.com.br
```

- [ ] **Step 2: Rodar a suíte completa uma última vez**

Run: `npx jest tests/ --silent 2>&1 | tail -8`
Expected: baseline conhecida, sem regressão.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(portal-fornecedor): documenta SMTP_FORNECEDOR_* no .env.example"
```

- [ ] **Step 4: Pedir ao usuário pra preencher as credenciais reais no VPS**

**IMPORTANTE — nunca visualizar/digitar a senha real.** Peça ao usuário para rodar no VPS (ele mesmo, com o valor real da senha da caixa `fornecedores@graficalkl.com.br`):

```bash
ssh lkl "cat >> /var/www/lkl-chatbot/.env << 'EOF'
SMTP_FORNECEDOR_HOST=smtp.hostinger.com
SMTP_FORNECEDOR_PORT=587
SMTP_FORNECEDOR_USER=fornecedores@graficalkl.com.br
SMTP_FORNECEDOR_PASS=<senha real aqui>
EOF"
```

(Ajustar `SMTP_FORNECEDOR_HOST`/`PORT` se a Hostinger usar valores diferentes do SMTP já configurado em `SMTP_HOST`/`SMTP_PORT` — confirmar com o usuário nas configurações da caixa de e-mail.)

- [ ] **Step 5: Sincronizar os arquivos alterados**

```bash
rsync -av src/services/email.js lkl:/var/www/lkl-chatbot/src/services/email.js
rsync -av src/modules/fornecedores/router.js lkl:/var/www/lkl-chatbot/src/modules/fornecedores/router.js
rsync -av public/dashboard.html lkl:/var/www/lkl-chatbot/public/dashboard.html
```

- [ ] **Step 6: Verificar md5 de cada arquivo (local vs remoto)**

```bash
md5sum src/services/email.js src/modules/fornecedores/router.js public/dashboard.html
ssh lkl "md5sum /var/www/lkl-chatbot/src/services/email.js /var/www/lkl-chatbot/src/modules/fornecedores/router.js /var/www/lkl-chatbot/public/dashboard.html"
```
Expected: hashes idênticos em cada par.

- [ ] **Step 7: Reiniciar o processo**

Run: `ssh lkl "cd /var/www/lkl-chatbot && set -a && source .env && set +a && pm2 restart lkl-chatbot --update-env && pm2 save"`
Expected: `[PM2] [lkl-chatbot](0) ✓`, status `online`

- [ ] **Step 8: Checar logs de startup**

Run: `ssh lkl "pm2 logs lkl-chatbot --lines 20 --nostream --err"`
Expected: sem erros novos relacionados a `email.js`/`fornecedores`.

- [ ] **Step 9: Smoke test manual — fornecedor de teste descartável**

1. Criar um fornecedor de teste com e-mail real (do próprio usuário) e celular real cadastrados.
2. Clicar em "Liberar acesso ao Portal do Fornecedor" no painel.
3. Confirmar toast "✅ Convite enviado por e-mail e WhatsApp".
4. Confirmar recebimento do e-mail (remetente `fornecedores@graficalkl.com.br`) e da mensagem de WhatsApp.
5. Apagar o fornecedor de teste (e o `fornecedor_logins` associado) depois de confirmar.

---

## Cobertura do spec

- E-mail obrigatório (bloqueia sem ele), celular opcional (avisa sem bloquear) → Task 2.
- Remetente dedicado `fornecedores@graficalkl.com.br` via transporter separado → Task 1.
- Link continua disponível como backup no painel → Task 3.
- Reenvio ao clicar de novo → comportamento herdado de `criarConvite` (UPSERT já existente), sem mudança necessária.
- Normalização do celular pro formato WhatsApp → Task 2 (`celularParaWhatsapp`).
- Fora de escopo (SMS, reenvio automático por expiração, template rico) → nenhuma task criada, como esperado.
