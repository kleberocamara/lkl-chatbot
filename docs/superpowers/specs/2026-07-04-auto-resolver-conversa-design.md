# Auto-saída de `aguardando_humano` — Design

**Data:** 2026-07-04
**Autor:** Kleber + Claude

## Problema

Quando uma conversa do chatbot entra em `aguardando_humano` (aguardando intervenção humana), ela só sai desse estado quando alguém clica no botão **Resolver** do painel. Na prática, a equipe executa a ação que sana a pendência (envia o orçamento, envia a arte, envia o link de cobrança) mas **esquece de clicar em Resolver**, e a conversa fica presa em `aguardando_humano` indefinidamente. Exemplo real: pedido 31 — orçamento/arte/link enviados, mas a conversa continua em `aguardando_humano`.

## Objetivo

Tirar a conversa de `aguardando_humano` **automaticamente** quando a equipe executa uma das 3 ações-chave de liberação, sem depender do clique manual.

## Escopo

- **Só daqui pra frente.** Não há limpeza retroativa das conversas já presas (o usuário resolve as atuais no botão uma vez).
- **Gatilhos: as 3 ações-chave** (enviar orçamento ao cliente, enviar arte, enviar link/cobrança). Nenhuma outra mensagem (follow-up, resposta manual genérica) resolve a conversa.
- Sem migration — usa colunas e status já existentes (`conversations.status`, `resolved_at`, `alerta_humano_em`).

## Contexto do código (estado atual)

- `aguardando_humano` é setado em vários gatilhos: pedido completo capturado ([agent.js:375](../../../src/ai/agent.js)), cliente aprova orçamento e cliente responde/manda mídia no follow-up ([handler.js](../../../src/webhook/handler.js)).
- Sai de `aguardando_humano` **apenas** via `POST /conversations/:id/resolve` ([api.js:180](../../../src/dashboard/api.js)), que faz: `status='resolved', resolved_at=NOW(), alerta_humano_em=NULL`.
- As 3 ações de envio passam todas por `src/services/conversas.js` (`enviarClienteTexto`/`enviarClienteImagem`), que resolve a conversa por **sufixo de 9 dígitos** do telefone.
- A aprovação do orçamento pelo cliente (SIM/NÃO) é detectada por **duas** vias: a tabela `orcamento_confirmacao_wa` (por telefone, expira em 1h) e o status `orcamento_enviado` da conversa ([handler.js:109](../../../src/webhook/handler.js)). Por isso, ao enviar o orçamento, mover a conversa para `resolved` atrapalharia a via por status — o alvo correto nesse caso é `orcamento_enviado`.

## Arquitetura

### Componente central — `conversas.sairDeAguardandoHumano`

Nova função em `src/services/conversas.js`:

```
sairDeAguardandoHumano(celular, { para, motivo })
```

Comportamento:
1. Resolve o contato pelo telefone (reusa `acharContatoPorTelefone`, casamento por sufixo de 9 dígitos).
2. Acha a conversa ativa mais recente do contato (status em `active`/`aguardando_humano`/`orcamento_enviado`, mesma seleção de `getOrCreateConversaAtiva`, porém **sem criar** se não existir).
3. **Só age se a conversa estiver em `aguardando_humano`.** Caso contrário, no-op (idempotente).
4. Atualiza `status = para`. Se `para === 'resolved'`, seta `resolved_at = NOW()`. Em qualquer caso, `alerta_humano_em = NULL` e `updated_at = NOW()`.
5. Registra log `conversation_auto_resolved` com `{ conversationId, motivo, para }`.
6. Emite socket `conversation_updated` com `{ id, status: para }` (painel atualiza ao vivo, igual ao endpoint manual).
7. Retorna `{ conversationId, de: 'aguardando_humano', para }` quando agiu, ou `null` quando foi no-op.

Toda a lógica em `try/catch` do lado do **chamador** (ver abaixo) para nunca derrubar o envio.

### Pontos de chamada (as 3 ações)

| Ação | Função / arquivo | `para` | Momento |
|---|---|---|---|
| Enviar orçamento | `enviarParaCliente` — `src/modules/orcamentos/service.js` (bloco WhatsApp, após `conversas.enviarClienteTexto`) | `orcamento_enviado` | Após envio do WhatsApp ok |
| Enviar arte | `enviarArteItem` — `src/modules/orcamentos/service.js` | `resolved` | Após envio da imagem ok (quando o item passa a `arte_status='enviada'`) |
| Enviar link/cobrança | `cobrar` / rota `POST /:id/cobrar` — `src/modules/orcamentos/router.js` (bloco WhatsApp que já usa `conversas.enviarClienteTexto`) | `resolved` | Após envio da mensagem de cobrança ok |

Cada chamada:
- Roda **somente no caminho de sucesso** do envio. Se o envio falhar, a conversa continua em `aguardando_humano`.
- É embrulhada em `.catch(e => console.warn(...))` (ou try/catch), seguindo o padrão fire-and-forget já usado nesses pontos, para não afetar o fluxo principal.
- Usa `motivo` descritivo: `'orcamento_enviado'`, `'arte_enviada'`, `'cobranca_enviada'`.

## Fluxo de dados

1. Atendente aciona uma das 3 ações no painel → endpoint do módulo `orcamentos`.
2. A ação envia a mensagem ao cliente via `conversas` (comportamento atual, inalterado).
3. No sucesso, a ação chama `conversas.sairDeAguardandoHumano(celular, { para, motivo })`.
4. Se a conversa estava em `aguardando_humano`, ela transiciona (para `orcamento_enviado` ou `resolved`), some da fila de intervenção e o painel atualiza via socket.
5. Se o cliente voltar a interagir (ex.: aprova orçamento, responde arte), os gatilhos existentes re-flagam `aguardando_humano` normalmente — o ciclo continua funcionando.

## Tratamento de erro

- Falha ao mudar status **não** derruba o envio (o cliente já recebeu a mensagem, que é o essencial). Loga warning.
- Idempotente: chamada repetida ou em conversa fora de `aguardando_humano` é no-op seguro.
- Telefone sem conversa correspondente → no-op sem erro.

## Testes

Unitários com mock do `db` (novo arquivo `tests/conversas-auto-resolver.test.js` ou anexado ao `tests/conversas.test.js`):

1. Conversa em `aguardando_humano` + `para='resolved'` → UPDATE com `status='resolved'`, `resolved_at` setado, `alerta_humano_em=NULL`; emite socket; retorna objeto.
2. Conversa em `aguardando_humano` + `para='orcamento_enviado'` → UPDATE com `status='orcamento_enviado'` (sem `resolved_at`), `alerta_humano_em=NULL`.
3. Conversa em `active` / `resolved` / `orcamento_enviado` → **no-op** (nenhum UPDATE de status), retorna `null`.
4. Telefone sem contato/conversa → no-op sem erro, retorna `null`.
5. Casamento por sufixo de 9 dígitos (telefone formatado diferente ainda encontra a conversa).

As 3 integrações (orçamento/arte/cobrança) são validadas por **smoke no VPS**, não por Jest (os testes de integração já falham localmente por falta de DB — pré-existente).

## Fora de escopo

- Limpeza retroativa das conversas já presas.
- Resolver via resposta manual do atendente ou qualquer outra mensagem além das 3 ações.
- Qualquer mudança na UI do botão Resolver (ele continua existindo para casos manuais).
