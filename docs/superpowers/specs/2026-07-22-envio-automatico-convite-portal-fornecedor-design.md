# Envio automático do convite do Portal do Fornecedor (e-mail + WhatsApp)

## Contexto e motivação

Hoje, liberar o acesso de um fornecedor ao portal (`POST /api/v2/fornecedores/:id/portal/liberar`) exige que o atendente digite manualmente o e-mail num `prompt()`, e depois copie o link de convite gerado (outro `prompt()`) pra enviar por fora — WhatsApp, e-mail, o que for. É trabalho manual repetido pra cada fornecedor liberado, e depende do atendente lembrar de copiar/colar e escolher o canal certo.

Objetivo: ao clicar em "Liberar acesso", o sistema busca o e-mail e o celular já cadastrados no fornecedor e dispara o convite automaticamente pelos dois canais, sem que o atendente precise digitar nada nem copiar/colar o link (o link continua disponível no painel como plano B, caso o atendente precise reenviar por outro meio manualmente).

## Decisão de design: e-mail é obrigatório, celular é opcional

`fornecedor_logins.email` é `NOT NULL UNIQUE` — é o **login** do fornecedor no portal, não só um canal de notificação. Sem e-mail cadastrado no fornecedor, não existe como criar o acesso (não tem username). Por isso:

- **E-mail ausente no cadastro do fornecedor → bloqueia tudo**, com mensagem clara pedindo pra completar o cadastro antes de liberar.
- **Celular ausente → não bloqueia** — libera e envia só por e-mail, avisando no toast que o WhatsApp não foi enviado por falta de celular.

## Remetente dedicado

O usuário criou uma caixa de e-mail nova na Hostinger especificamente pra esse envio: `fornecedores@graficalkl.com.br`. Isso é uma conta SMTP **separada** da já usada em `src/services/email.js` (`SMTP_HOST/PORT/USER/PASS`, hoje usada pra `enviarOrcamentoCliente`/`notifyAnalyst`). Em vez de reusar o transporter existente (que autentica como outra caixa), criamos um segundo transporter dedicado, configurado por 4 variáveis de ambiente novas: `SMTP_FORNECEDOR_HOST`, `SMTP_FORNECEDOR_PORT`, `SMTP_FORNECEDOR_USER`, `SMTP_FORNECEDOR_PASS`. O usuário preenche o valor real no `.env` do VPS na hora do deploy (a senha nunca passa pelo chat).

## Arquitetura

- **`src/services/email.js`**: ganha um segundo `nodemailer.createTransport` (`transporterFornecedor`), configurado pelas 4 vars novas, e uma nova função `enviarConvitePortalFornecedor({ email, nome, conviteUrl })` — e-mail simples em HTML (reaproveitando o padrão visual/logo já usado em `enviarOrcamentoCliente`), assunto "Acesso ao Portal do Fornecedor — Gráfica LKL", corpo com saudação, explicação de 2 linhas, botão/link, e nota de validade de 7 dias.
- **`src/modules/fornecedores/router.js`** `POST /:id/portal/liberar`:
  - Não recebe mais `email` no corpo.
  - Busca `nome, email, celular` do fornecedor pelo `id`.
  - Se `!email` → `400 { error: 'Cadastre o e-mail do fornecedor antes de liberar o acesso ao portal' }`.
  - Chama `criarConvite(id, email)` (já existe, já faz UPSERT — reenviar convite pra quem já foi liberado antes simplesmente gera um token novo e reenvia).
  - Monta `conviteUrl`.
  - Envia e-mail via `email.enviarConvitePortalFornecedor(...)` — `try/catch` isolado, não derruba a rota se falhar (SMTP fora do ar, etc.).
  - Se `celular` presente: normaliza pra formato WhatsApp (`55` + só dígitos) e envia via `whatsapp.sendMessage(...)` — texto curto com saudação, link, e nota de validade. Também isolado em `try/catch`.
  - Resposta: `{ ok: true, conviteUrl, enviadoEmail: boolean, enviadoWhatsapp: boolean, avisos: [...] }` — `avisos` lista o que não rolou (ex.: `"Sem celular cadastrado — WhatsApp não enviado"`, `"Falha ao enviar e-mail: <motivo>"`).
- **`public/dashboard.html`** `liberarPortalFornecedor(fornecedorId)`:
  - Remove o `prompt()` de e-mail — chama a rota direto, sem corpo.
  - Trata o retorno: toast resumindo o que foi enviado + lista de avisos, se houver.
  - Mantém o `prompt()` do link como estava (cópia manual de backup).
  - Se a rota retornar 400 (sem e-mail cadastrado), mostra a mensagem de erro no toast, sem abrir prompt nenhum.

## Normalização do celular pra WhatsApp

`fornecedores.celular` é digitado livre no cadastro (hoje só tem 1 exemplo real: `"21986449859"`, sem DDI). Novo helper puro (local ao módulo, sem exportar) remove tudo que não é dígito e garante prefixo `55`:

```js
function celularParaWhatsapp(celular) {
  const d = String(celular || '').replace(/\D/g, '');
  if (!d) return null;
  return d.startsWith('55') ? d : '55' + d;
}
```

## Testes

- `criarConvite` já testado (Task 3 da feature anterior) — sem mudança de contrato.
- Novo: teste do router `POST /:id/portal/liberar` cobrindo: (a) sem e-mail cadastrado → 400 sem chamar `criarConvite`; (b) com e-mail e celular → chama `email.enviarConvitePortalFornecedor` e `whatsapp.sendMessage`, retorna `enviadoEmail: true, enviadoWhatsapp: true`; (c) com e-mail e sem celular → só e-mail, `avisos` menciona a ausência; (d) falha no envio de e-mail (mock rejeita) → rota não quebra, retorna `enviadoEmail: false` com aviso, mas `conviteUrl` continua presente na resposta.
- Novo: teste unitário de `celularParaWhatsapp` (casos: já com 55, sem 55, vazio/null).

## Fora de escopo

- Reenvio automático quando o convite expira sem uso (7 dias) — continua manual (atendente clica "Liberar acesso" de novo).
- Template de e-mail rico/responsivo com verificação cross-client — reaproveita o padrão simples já usado em `enviarOrcamentoCliente`.
- Envio por SMS como canal adicional — só e-mail + WhatsApp, conforme pedido.

## Auto-revisão

- **Cobertura do pedido**: liberar acesso → envia e-mail (novo remetente dedicado) + WhatsApp automaticamente usando os dados já cadastrados. ✅
- **Placeholders**: nenhum.
- **Consistência**: nomes de função/variável coerentes com o padrão já usado no módulo (`criarConvite`, `enviarOrcamentoCliente` como referência).
- **Escopo**: focado, não mexe em mais nada do fluxo de portal-fornecedor.
