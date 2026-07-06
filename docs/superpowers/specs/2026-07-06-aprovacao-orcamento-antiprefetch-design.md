# Aprovação de orçamento à prova de prefetch + itens detalhados — Design

**Data:** 2026-07-06
**Autor:** Kleber + Claude

## Problema

O link de aprovação enviado ao cliente (`GET /api/v2/orcamentos/resposta?token=…&r=aprovado`) **muda estado no próprio GET**: chama `processarRespostaToken` → `mudarStatus(orc,'aprovado')`, aprovando o orçamento e sincronizando o pedido. A mensagem do WhatsApp embute essa URL de aprovação direta; o **crawler de preview do WhatsApp (e scanners de e-mail tipo SafeLinks)** pré-buscam a URL para gerar preview → o orçamento é **aprovado sem clique humano**. Confirmado em produção: orçamentos #32 (pedido 27) e #38 (pedido 32) aprovados com `aprovado_via='email'` sem ação do cliente. Restaurados manualmente para `enviado`/`aguardando_aprovacao`.

Segundo ponto: a mensagem enviada não detalha os itens orçados (só total).

## Objetivo

1. Nenhuma pré-busca/preview pode aprovar ou reprovar um orçamento. A confirmação exige uma ação deliberada (POST).
2. Ao clicar no link, o cliente vê uma **página de confirmação** com o orçamento detalhado (itens) e dois botões **Aprovar** / **Reprovar**.
3. O orçamento enviado passa a **detalhar os itens** (na página e no texto do WhatsApp).

## Decisões (do brainstorming)

- Link vira **token-only** (`/resposta?token=xxx`, sem `&r=`).
- `GET` = **somente leitura** (renderiza a página). `POST` = ação real. Crawlers fazem GET, nunca POST.
- `GET` com `&r=` legado (mensagens já enviadas) deixa de mutar → também mostra a página.
- Itens detalhados na **página** e no **texto do WhatsApp**.
- Mantém o caminho **SIM/NÃO por texto** (já seguro, 2 etapas). Não mexe nos 6 orçamentos antigos aprovados via link.

## Contexto do código

- `src/modules/orcamentos/router.js` — `GET /resposta` (público) hoje muta no GET.
- `src/modules/orcamentos/service.js` — `processarRespostaToken(token, resposta)` valida status `enviado` e chama `mudarStatus`; `buscarPorId(id)` retorna `{...orcamento, itens, ordens_servico, boletos_parcelas}` (itens = todas as colunas de `orcamento_itens`: `descricao`, `produto`, `quantidade`, `valor_unitario`, `valor_total`, `codigo`). `_dispararNotificacoesEnvio(orc)` monta a mensagem WhatsApp (linha ~320) e reusa em e-mail.
- Sites que geram o link (todos com `&r=aprovado`/`&r=reprovado` hoje): `src/modules/orcamentos/service.js:305-306`, `src/services/email.js:71-72`, `src/services/pdf.js:180-181`.

## Arquitetura

### Componente 1 — Service: resumo por token

Nova função em `service.js`: `buscarResumoPorToken(token)`:
1. `SELECT id FROM orcamentos WHERE token_aprovacao=$1` → se não achar, retorna `null`.
2. Retorna `buscarPorId(id)` (orçamento + itens).

Usada pela página GET. `processarRespostaToken` permanece para o POST (sem mudança de lógica — já só age em status `enviado`, idempotente nos demais).

### Componente 2 — Router: GET vira página de confirmação (read-only)

`GET /resposta?token=xxx` (ignora qualquer `&r=` que venha):
1. Valida `token` (UUID). Inválido → 400 "Link inválido.".
2. `orc = buscarResumoPorToken(token)`. Não achou → página "Link inválido ou expirado".
3. Se `orc.status !== 'enviado'` → página informativa ("Este orçamento já foi {status}.") **sem** botões.
4. Se `enviado` → renderiza página com: cabeçalho Gráfica LKL, "Pedido #{pedido_numero||numero}", **tabela de itens** (descrição · qtd · valor total), **total**, e um `<form method="POST" action="/api/v2/orcamentos/resposta">` com `<input type="hidden" name="token">` e dois `<button name="r" value="aprovado">Aprovar</button>` / `value="reprovado">Reprovar</button>`. **Nenhuma** query de escrita neste GET.

### Componente 3 — Router: POST executa a ação

`POST /resposta` (público; precisa de body parser urlencoded na app — verificar/gerar):
1. `{ token, r } = req.body`. Valida token UUID e `r ∈ {aprovado,reprovado}` → senão 400.
2. `result = processarRespostaToken(token, r)`.
3. `result.erro` → página de erro (ex.: "Orçamento já foi aprovado"). Sucesso → página "✅ Orçamento aprovado!" / "❌ Orçamento reprovado." (as mesmas mensagens de hoje).

### Componente 4 — Links token-only nos 3 sites

`service.js`, `email.js`, `pdf.js`: trocar as duas URLs (`urlAprovar`/`urlReprovar` com `&r=`) por **uma** `urlConfirmar = ${baseUrl}/api/v2/orcamentos/resposta?token=${token}`.
- WhatsApp (`service.js`): "Ou clique para aprovar/reprovar: {urlConfirmar}".
- E-mail (`email.js`): os dois botões passam a apontar para `urlConfirmar` (ou um botão único "Ver e responder ao orçamento"). Ambos levam à página de confirmação.
- PDF (`pdf.js`): o(s) link(s) do rodapé apontam para `urlConfirmar`.

### Componente 5 — Itens no texto do WhatsApp

Em `_dispararNotificacoesEnvio` (`service.js`), antes da linha do total, inserir uma lista compacta dos itens de `orc.itens`:
```
Itens:
• {descricao||produto} — {quantidade}un — R$ {valor_total}
...
```
Formatar `valor_total` em pt-BR. Se `orc.itens` vazio, omite a seção.

## Fluxo de dados

1. Vendedor envia orçamento → mensagem WhatsApp/e-mail com **um** link token-only + lista de itens; PDF com o mesmo link.
2. Preview/crawler pré-busca a URL → `GET` só renderiza a página → **nada muda**.
3. Cliente abre o link → vê itens + botões → clica Aprovar/Reprovar → **POST** → `processarRespostaToken` muda status (enviado→aprovado/reprovado) → sincroniza pedido + notifica vendedor (comportamento atual).
4. Cliente também pode responder SIM/NÃO por texto (2 etapas, inalterado).

## Tratamento de erro / bordas

- Token inválido/expirado → página amigável, sem 500.
- Orçamento já respondido → GET mostra estado atual sem botões; POST retorna erro amigável (guarda de `processarRespostaToken`).
- Link legado com `&r=` → GET ignora o `r` e mostra a página (não muta).
- Falha no POST (exceção) → página "não foi possível processar agora" (como hoje).
- Garantir `express.urlencoded()` disponível para a rota pública do POST (adicionar middleware específico na rota se a app não tiver global).

## Testes

- **Unit** (`tests/`): `processarRespostaToken` — só muda de `enviado` (aprovado/reprovado), no-op/erro nos demais (mock de db). `buscarResumoPorToken` — retorna orçamento+itens por token, `null` se não achar.
- **Smoke no VPS:** (a) `curl` no `GET /resposta?token=<enviado>` retorna HTML com botões e **não** altera o status (conferir no banco antes/depois); (b) `curl -X POST` com `token`+`r=aprovado` altera para `aprovado`; (c) `curl` no GET de um token já `aprovado` mostra página sem botões. Usar um orçamento de teste e restaurar depois.

## Fora de escopo

- Caminho SIM/NÃO por texto (inalterado, já seguro).
- Reversão dos 6 orçamentos antigos aprovados via link (indistinguíveis de cliques reais; orç 37 é sabidamente legítimo).
- Autenticação/nonce adicional no POST além do token (YAGNI — token já é o segredo; crawler não faz POST).
