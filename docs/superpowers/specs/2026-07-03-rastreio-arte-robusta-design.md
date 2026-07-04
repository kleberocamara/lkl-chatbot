# Rastreio de mensagens ao cliente + Arte robusta — Design

**Data:** 2026-07-03
**Status:** Aprovado para escrita de plano

## Contexto

Testando o workflow ponta-a-ponta apareceram dois bugs:

1. **Arte não chegou ao cliente.** Em `enviarArteItem` (`src/modules/orcamentos/service.js:854`) o envio é *fire-and-forget*: `whatsapp.sendImage(...).catch(e => console.warn('[ARTE-WA]', e.message))`. Não há `await`, o erro é engolido (só loga `status`, não o corpo da Meta), não há retry nem fallback — e mesmo assim o item vira `arte_status='enviada'`. Nos logs do VPS a Meta devolveu **400 transitório** (a URL da arte é pública e retorna 200 image/png; refazendo a chamada agora retorna 200). Resultado: a arte sumiu silenciosamente e o status mentiu.

2. **Perda de rastreio.** A mensagem do valor do orçamento (`_dispararNotificacoesEnvio`, `:327`) e a arte (`:873`) chamam `whatsapp.send*` mas **nunca inserem em `messages`**, então não aparecem no histórico da conversa do chatbot. O analista perde o rastreio do que foi enviado ao cliente.

**Restrição do negócio:** o número de WhatsApp é **dedicado ao chatbot** (não funciona em outro dispositivo). Toda mensagem ao cliente passa por esse número; logo, a **conversa é a âncora natural** de qualquer mensagem — e, para enviar, é obrigatório que exista uma conversa. O design garante isso via **find-or-create** de contato + conversa.

## Objetivo

(A) **Rastreio:** toda mensagem enviada ao cliente (valor do orçamento, arte, e futuros envios de sistema) é registrada na `messages` da conversa do cliente, aparecendo no histórico do chatbot ao vivo. (B) **Arte robusta:** o envio da arte é confiável (await, log de erro completo, retry, fallback texto-com-link) e o `arte_status` só diz "enviada" quando algo realmente foi entregue.

## Modelo de dados (existente, sem migration)

- `contacts(id, phone, profile_name, name, ...)` — contatos do WhatsApp (chave por `phone`).
- `conversations(id, contact_id, status, ...)` — `status ∈ {active, aguardando_humano, orcamento_enviado, ...}`.
- `messages(id, conversation_id, contact_id, content, direction, whatsapp_message_id, sent_by, sent_by_name?, created_at)`.
- `clientes_lkl(id, celular, nome, ...)` — cliente do ERP (ligado ao orçamento por `orcamentos.cliente_id`). **Não** é o mesmo que `contacts`; a ponte entre os dois é o **telefone**.

O painel (`dashboard.html:3255`) renderiza mídia no histórico quando o `content` casa `/\[([^\]]+) recebido:\s*([^\s|\]]+)(?:\s*\|\s*([^\]]*))?\]/i`. A **miniatura inline** (`<img>`) só aparece quando o `fileRef` é **local** — começa com `/uploads/` ou `/api/file/` (`:3260`, `:3264`). Uma URL absoluta (`https://...`) cai no botão "Ver/Baixar". Portanto, o `content` da arte deve guardar o **caminho relativo** (`arte_arquivo_url`, ex.: `/uploads/artes/arte_orc_...png`), **não** a `publicUrl` — mesmo que o envio ao WhatsApp use a URL absoluta.

## Parte 1 — Rastreio: módulo `src/services/conversas.js` (novo)

Um módulo único e testável que resolve a conversa do cliente e registra a mensagem. Reaproveita a lógica que hoje vive dentro de `webhook/handler.js` (`getOrCreateContact`, `getActiveConversation`/`createConversation`), agora exportada e compartilhada.

### `registrarMensagemCliente(celular, conteudo, opts = {})`

- `opts.sentBy` default `'system'`; `opts.whatsappMessageId` default `null`.
- Normaliza o telefone (`String(celular).replace(/\D/g,'')`); se vazio → retorna `null` (nada a fazer).
- **find-or-create do contato** por telefone (`getOrCreateContact(celular, null)` — não sobrescreve `profile_name` se já existir; ver nota abaixo).
- **find-or-create da conversa:** pega a conversa ativa mais recente (`getActiveConversation`); se não houver, cria uma (`createConversation`, status `active`).
- `INSERT INTO messages (conversation_id, contact_id, content, direction, whatsapp_message_id, sent_by) VALUES (..., 'outbound', ...)`.
- Emite socket para o painel atualizar ao vivo (mesmo shape já usado no handler):
  `global.io?.emit('new_message', { conversationId, contactPhone: celular, contactName, message: conteudo, timestamp, sent_by })`.
- Retorna `{ conversationId, contactId }`.

**Nota `getOrCreateContact`:** hoje ele faz `UPDATE ... SET profile_name=$1` sempre. Para não apagar o nome quando `profileName` vier `null`, ajustar o UPDATE para `profile_name = COALESCE($1, profile_name)`. (Mudança pequena e segura; o webhook sempre passa um nome, então o comportamento atual dele não muda.)

**Refactor de `handler.js`:** mover `getOrCreateContact`, `getActiveConversation`, `createConversation` para `conversas.js` e passar o handler a importá-las de lá (sem duplicar). `saveMessage` do handler continua onde está (é específico do fluxo inbound).

### Wrappers de envio ao cliente (no mesmo `conversas.js`)

- `async enviarClienteTexto(celular, texto, opts = {})`:
  `await whatsapp.sendMessage(celular, texto)` e então `await registrarMensagemCliente(celular, texto, opts)`. Retorna o resultado do registro.
- `async enviarClienteImagem(celular, urlEnvio, legenda, opts = {})`:
  faz o envio robusto de imagem (Parte 2, usando `urlEnvio` absoluta para a Meta) e registra usando o formato de mídia com o **caminho relativo** — passado em `opts.mediaRef` (ex.: `arte_arquivo_url`); se ausente, usa `urlEnvio`:
  `content = `[imagem recebido: ${opts.mediaRef || urlEnvio} | ${legenda}]``. Com o caminho relativo, a arte aparece como **miniatura** no histórico. Se cair no fallback texto, registra o texto simples do fallback (não o formato de mídia).

## Parte 2 — Arte robusta (`enviarArteItem`, `service.js:854`)

Reescrever o trecho de envio (`:870-874`) para:

1. **Montar** `publicUrl` (como hoje) e a `legenda`.
2. **Tentar imagem com await + retry:** função interna `enviarImagemComRetry(celular, url, legenda)`:
   - `await whatsapp.sendImage(celular, url, legenda)`.
   - Em erro: logar o **corpo real da Meta** (`console.warn('[ARTE-WA]', e.response?.data ? JSON.stringify(e.response.data) : e.message)`), esperar ~2s (`await new Promise(r => setTimeout(r, 2000))`) e tentar **uma vez** mais.
   - Retorna `true` se algum envio deu certo, `false` se ambos falharam.
3. **Fallback texto-com-link:** se a imagem falhou nas duas tentativas, `await enviarClienteTexto(celular, `Olá! Segue a arte do seu *Pedido #${pedido}* (${produto}): ${publicUrl}\n\nResponda *APROVADO* para confirmar ou envie os ajustes desejados.`)`. Retorna se o texto foi enviado.
4. **Registro:** o caminho de imagem OK registra via formato de mídia com `opts.mediaRef = arquivo_url` (caminho relativo → miniatura); o caminho de fallback registra o texto. Em ambos os sucessos a mensagem entra no histórico.
5. **Status honesto:** o `UPDATE orcamento_itens SET arte_status='enviada'...` só ocorre se **algum** envio (imagem ou fallback) teve sucesso. Se **tudo** falhar:
   - grava `arte_status='erro_envio'`, `arte_arquivo_url` e `arte_enviada_em=NULL` (não finge que enviou), loga o erro, e retorna `{ erro: ['Falha ao enviar arte ao cliente'], item_id: itemId, status: 'erro_envio' }`.
   - `erro_envio` é apenas um valor de string na coluna existente `arte_status` (text) — sem migration.

**Estrutura sugerida:** `enviarArteItem` passa a fazer o UPDATE de status **depois** de tentar o envio (hoje faz antes). A ordem vira: buscar item → tentar enviar (imagem→retry→fallback) → UPDATE de status conforme o resultado → retornar.

## Parte 3 — Aplicar o rastreio no valor do orçamento

Em `_dispararNotificacoesEnvio` (`:318-336`), trocar `await whatsapp.sendMessage(orc.cliente_celular, msg)` por `await enviarClienteTexto(orc.cliente_celular, msg)`. A pendência `orcamento_confirmacao_wa` continua igual. O e-mail (`:339`) não muda.

## Erros e bordas

- **Cliente sem `celular`:** os wrappers só são chamados quando há telefone (guardas atuais em `if (orc.cliente_celular)` / `if (item.cliente_celular)` permanecem). `registrarMensagemCliente` com telefone vazio retorna `null` sem quebrar.
- **`sendMessage`/`sendImage` lançam:** os wrappers propagam a exceção do `sendMessage` de texto (valor do orçamento) — mantém o comportamento atual (já era `await` sem try). Para a arte, a exceção é tratada internamente (retry+fallback), nunca sobe.
- **Socket ausente (`global.io` indefinido):** usar `global.io?.emit`, sem quebrar em contexto de teste/CLI.
- **Conversa criada só para logar:** aceitável e desejado — a restrição do negócio diz que enviar exige conversa; se o cliente veio de canal manual, criamos a conversa-âncora para não perder o rastreio.
- **Formato de mídia com `|` na legenda:** a legenda da arte não contém `|`; se um produto tiver, sanitizar trocando `|` por `/` antes de montar o `content`.

## Testes

- **Jest (puro, com mocks de `db` e `whatsapp`):**
  - `registrarMensagemCliente`: com conversa existente → insere na conversa achada; sem conversa → cria e insere; telefone vazio → `null`. Verifica o INSERT com `direction='outbound'`, `sent_by='system'`.
  - `enviarClienteImagem`: `sendImage` OK → registra `content` no formato `[imagem recebido: url | legenda]`; `sendImage` falha 2x → chama fallback `sendMessage` e registra o texto.
  - `enviarImagemComRetry`: sucesso na 1ª; sucesso no retry após 1ª falhar; falha nas 2 → `false` (mockar timer).
  - `enviarArteItem`: imagem OK → `arte_status='enviada'`; imagem falha + fallback OK → `arte_status='enviada'`; ambos falham → `arte_status='erro_envio'` e `arte_enviada_em` não setado.
- **Smoke no VPS:** enviar a arte de um item real e conferir (a) o cliente recebe (imagem ou link) e (b) a mensagem aparece no histórico da conversa no painel; reenviar um orçamento e conferir que o texto do valor aparece no histórico.

## Fora de escopo

- Reprocessar automaticamente artes já marcadas `enviada` no passado (o analista reenvia manualmente).
- Coluna nova para `erro_envio` ou máquina de estados da arte (usa a coluna `arte_status` text existente).
- Alterar o e-mail do orçamento ou o fluxo de aprovação por token.

## Dependências

- `src/services/whatsapp.js` (`sendMessage`, `sendImage`) — existentes.
- `src/webhook/handler.js` — refatorado para importar helpers de contato/conversa de `conversas.js`.
- Sem migration. Próxima migration livre continua 051.
