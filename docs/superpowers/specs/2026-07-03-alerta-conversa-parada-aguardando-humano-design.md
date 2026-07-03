# Alerta de conversa parada em aguardando_humano (2h) — Design

**Data:** 2026-07-03
**Status:** Aprovado para escrita de plano
**Contexto:** Conversas em `status='aguardando_humano'` podem ficar paradas sem ninguém responder. Precisamos evidenciar que o cliente aguarda retorno — tanto passivamente no painel quanto com um alerta ativo à equipe. Reusa infra existente: agendador `src/services/followup.js` (roda a cada 60s), push FCM `src/services/fcm.js` (`sendToUser`), socket.io, e a aba Conversas do `dashboard.html`.

## Objetivo

Quando uma conversa em `aguardando_humano` fica **2h+ parada sem resposta**, (A) evidenciar isso no painel (pastilha de tempo + ordenação + contador) e (B) disparar **um** push FCM à equipe de atendimento, em horário comercial.

## Decisões (do brainstorming)

- **Gatilho:** `status='aguardando_humano'` e **última mensagem há > 2h** (`MAX(messages.created_at)`), qualquer conversa (sem exclusão por pedido).
- **Push (B):** uma única vez ao cruzar 2h; destinatários = todos os usuários com papel `admin`/`gestor`/`analista`/`atendente` que tenham device token; só em **horário comercial** (dia útil, 9h–18h SP).
- **Painel (A):** camada visual no dashboard (pastilha `⏱ parada há Xh`, paradas no topo, contador).

## Modelo de dados (migration 050)

```sql
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS alerta_humano_em TIMESTAMPTZ;
```

Flag para enviar o push **uma vez por parada** (espelha `reengajado_em`). Próxima migration livre: **050**.

**Reset do flag** (`alerta_humano_em = NULL`):
- Quando um humano responde — na rota `POST /conversations/:id/reply` (`src/dashboard/api.js:103`), junto do INSERT `sent_by='human'`.
- Quando a conversa é resolvida/muda de status (rotas `resolve`, `orcamento-enviado`, `orcamento-aprovado`): incluir `alerta_humano_em = NULL` no UPDATE de status. Assim, se voltar a `aguardando_humano` e estagnar de novo, alerta outra vez.

## Backend

### `src/services/fcm.js` — novo helper `sendToRoles`

```js
async function sendToRoles(roles, payload) {
  const { rows } = await db.query(
    `SELECT DISTINCT dt.user_id FROM device_tokens dt
     JOIN users u ON u.id = dt.user_id
     WHERE u.role = ANY($1)`, [roles]);
  for (const r of rows) {
    try { await sendToUser(r.user_id, payload); }
    catch (e) { console.warn('[FCM sendToRoles]', e.message); }
  }
}
```
Exportar junto de `sendToUser`. (`db` já é usado no arquivo.)

### `src/services/followup.js` — detecção + push

**Função pura `deveAlertarHumano(conv, agora)`** (testável, espelha `deveReengajar`):
```js
const ALERTA_HUMANO_APOS_MS = 2 * 3600 * 1000;
function deveAlertarHumano(conv, agora) {
  if (!conv || conv.status !== 'aguardando_humano') return false;
  if (conv.alerta_humano_em != null) return false;
  if (!conv.ultima_msg_at) return false;
  return (agora.getTime() - new Date(conv.ultima_msg_at).getTime()) > ALERTA_HUMANO_APOS_MS;
}
```

**`processAlertasHumano()`** (chamada no `setInterval` do `startScheduler`, junto de `processFollowUps`/`processReengajamentos`):
- Retorna cedo se `isWeekendSP(agora)` ou hora SP < 9 ou ≥ 18.
- `SELECT` conversas `status='aguardando_humano'` e `alerta_humano_em IS NULL`, com `ct.name`/`ct.phone` e `ultima_msg_at = (SELECT MAX(created_at) FROM messages …)`.
- Para cada `deveAlertarHumano(conv, agora)`:
  - `horas = Math.floor((agora - ultima_msg_at)/3600000)`.
  - `fcm.sendToRoles(['admin','gestor','analista','atendente'], { title: '⏱ Cliente aguardando', body: 'Cliente ' + (nome||telefone) + ' aguarda retorno há ' + horas + 'h', data: { conversationId } })`.
  - `UPDATE conversations SET alerta_humano_em = NOW() WHERE id=$1`.
  - `log('alerta_humano', …)` e `global.io.emit('alerta_humano', { conversationId, nome, horas })`.
  - Falha no envio → não grava o flag (tenta na próxima rodada).

### `src/dashboard/api.js` — contador global de paradas

No endpoint de stats do dashboard (o que já retorna `waitingHuman`), adicionar um campo `stalledHuman` = contagem de conversas `status='aguardando_humano'` cuja última mensagem foi há > 2h:
```sql
SELECT COUNT(*) FROM conversations c
WHERE c.status='aguardando_humano'
  AND (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id=c.id) < NOW() - INTERVAL '2 hours'
```
Sem endpoint novo — só um campo a mais na resposta de stats.

## Frontend (`public/dashboard.html`) — camada A

- **Pastilha por item** (`renderConversations`): se `c.status==='aguardando_humano'` e `last_message_at` há > 2h, renderizar uma pastilha vermelha `⏱ parada há Xh` (X = horas inteiras). Abaixo de 2h, nada.
- **Ordenação:** antes de renderizar, ordenar a lista pondo as paradas (>2h) no topo, da mais antiga para a mais recente; as demais mantêm a ordem atual.
- **Contador no filtro:** a aba `Aguardando` passa a exibir `Aguardando (N)` com N = nº de paradas na lista carregada; vermelho quando N>0.
- **Badge do menu:** usar `stalledHuman` do stats (em `updateDashboard`, onde hoje se usa `waitingHuman`): se `stalledHuman>0`, o `waitingBadge` do item "Conversas" fica **vermelho** e mostra `stalledHuman`; senão mantém o comportamento atual (total `waitingHuman`, cor padrão).
- **Tempo real:** no socket `alerta_humano` (novo) e no `conversation_updated` (existente), recarregar a lista; se a aba Conversas estiver ativa, tocar um beep curto (WebAudio) + toast `Cliente aguardando retorno`.

## Erros e bordas

- Sem device token de ninguém → `sendToRoles` não envia (loga), painel (A) segue evidenciando. Sem erro.
- Push falha → flag não é gravado; nova tentativa na próxima rodada dentro do horário comercial.
- Fora do horário comercial → não envia push; o painel (A) continua mostrando as paradas normalmente (A não tem janela de horário).
- Conversa respondida entre a seleção e o envio → improvável no ciclo de 60s; se ocorrer, o pior caso é um push a mais (aceitável).

## Testes

- **Jest (pura):** `deveAlertarHumano(conv, agora)` — elegível (2h+, sem flag); não elegível por status, por `alerta_humano_em` presente, por < 2h, por sem última mensagem.
- **Smoke no VPS:** forjar conversa `aguardando_humano` com última mensagem há 3h → rodar o SELECT do job e conferir que entra; conferir `stalledHuman` no stats; validar `sendToRoles` seleciona os user_ids certos (sem enviar de fato, se não houver token). Cleanup.

## Fora de escopo

- Atribuição de "dono" da conversa (não existe hoje; o push vai para toda a equipe).
- Repetição do push (decidido: uma vez por parada).
- E-mail/digest (camada C descartada por YAGNI).

## Dependências

- Nenhuma externa nova. FCM, socket, agendador e a aba Conversas já existem. Próxima migration livre: **050**.
