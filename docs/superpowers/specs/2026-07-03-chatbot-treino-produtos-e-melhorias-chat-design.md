# Chatbot — Treino de produtos/materiais + melhorias no chat — Design

**Data:** 2026-07-03
**Status:** Aprovado para escrita de plano
**Contexto:** O chatbot (`src/ai/agent.js`, OpenAI gpt-4o) conduz o cliente até `registrar_pedido`. Hoje ele conhece a lista de produtos (`src/constants/produtos.js`) e regras de mínimos, mas (a) não sabe sugerir material/gramatura quando o cliente não domina os termos, e (b) não normaliza unidades (mistura m/cm). Além disso, o painel de chat mostra só o horário das mensagens e conversas param indefinidamente em `aguardando_humano` quando ninguém as assume.

## Objetivo

Deixar o bot mais assertivo na criação do pedido (sugerindo materiais e padronizando dimensões em metros) e melhorar o chat do painel (datas nas mensagens + auto-liberação de conversas paradas para o bot reengajar o cliente).

## Escopo — duas partes independentes num só spec

- **Parte A — Treino do bot (prompt):** guia de materiais + normalização de unidades. Só texto no `SYSTEM_PROMPT`, sem migration.
- **Parte B — Melhorias do chat:** datas nas mensagens (+ separador de dia) e auto-liberação após 2 dias (cron + migration 049).

---

## Parte A — Treino de produtos/materiais + unidades

**Arquivo:** `src/ai/agent.js` — acréscimos ao `SYSTEM_PROMPT` (constante `SYSTEM_PROMPT`). Nenhuma nova infra. Observação: se `settings.agent_prompt` estiver preenchido, ele SUBSTITUI o `SYSTEM_PROMPT` (ver `processMessage`); portanto as novas regras vão no `SYSTEM_PROMPT` (default) e o texto equivalente deve ser replicado no `agent_prompt` do banco caso exista um customizado — a Task de deploy verifica isso.

### A.1 — Guia de materiais por serviço (nova seção do prompt)

Regra: **quando o cliente não souber o material/acabamento, o bot sugere 1–2 opções da tabela** em vez de perguntar de forma aberta. Ex.: *"Pra banner a gente usa lona 440g. Prefere acabamento fosco ou brilho? 😊"*. O bot nunca trava esperando o cliente saber termos técnicos.

Rascunho inicial do guia (o usuário revisa/ajusta os materiais reais da LKL):

| Serviço | Sugestão padrão | Variações comuns |
|---|---|---|
| Banner | Lona 440g | fosco / brilho |
| Adesivo / Adesivação | Vinil fosco | vinil brilho, vinil transparente, vinil perfurado |
| Lona (fachada/faixa) | Lona 440g | com ilhós / bastão |
| Cartão de visita | Couché 300g | verniz total, laminação fosca/brilho |
| Folder / Folheto / Flyer | Couché 150g | couché 115g / 170g |
| Cartaz | Couché 150g | — |
| Placa / Sinalização | ACM 3mm | PS 2mm, PVC expandido |
| Painel ACM | ACM 3mm | — |
| Wind Banner | Tecido (sublimação) | P / M / G |

> Regra no prompt: "NÃO invente material fora deste guia. Se o cliente pedir algo que não está no guia, registre o que ele descreveu e deixe a equipe ajustar."

### A.2 — Normalização de unidades para METRO (regra obrigatória no prompt)

- **Metro é o padrão.** Toda dimensão é registrada em metros com vírgula: `1,20m x 1,20m`, `0,30m x 0,45m`. Nunca misturar m e cm na mesma medida.
- Se o cliente informar cm/mm, o bot **converte e confirma**: *"Só confirmando: 30cm × 45cm = 0,30m × 0,45m, certo? 😊"* (30cm→0,30m; 1200mm→1,20m).
- O bot **sempre confirma as dimensões** antes de prosseguir para o resumo.
- O campo `dimensoes` da `registrar_pedido` (e de cada objeto em `itens`) vai **sempre em metros** no formato `L,LLm x A,AAm`.

### A.3 — Cliente sem precisão de material/acabamento (reforço)

Regra no prompt: se o cliente demonstrar dúvida ("não sei", "o que vocês recomendam?", "tanto faz"), o bot assume a sugestão padrão do guia (A.1) e segue, confirmando de leve — sem transformar em interrogatório técnico.

### Testes (Parte A)

Não há como testar o LLM offline. Testes possíveis:
- **Teste de sanidade do prompt (Jest):** `agent.js` exporta (ou o teste importa) o `SYSTEM_PROMPT`; assert de que contém as âncoras das novas regras (ex.: `/GUIA DE MATERIAIS/`, `/METRO/`, `/0,30m/`). Garante que o deploy não perdeu as regras.
- **Smoke real no VPS:** conversa de teste no WhatsApp — cliente diz "quero um banner 90x120 cm, não sei o material" → bot deve sugerir lona 440g (fosco/brilho) e confirmar "0,90m × 1,20m".

---

## Parte B — Melhorias do chat

### B.1 — Data nas mensagens (`public/dashboard.html`)

- **Balão de mensagem** (`dashboard.html:3206`, `.msg-time`): hoje usa só `toLocaleTimeString`. Passa a mostrar:
  - Mensagem de **hoje** → só a hora (`14:32`).
  - Mensagem de **dia anterior** → `dd/mm HH:MM` (`02/07 14:32`).
- **Separador de dia:** entre blocos de mensagens de datas diferentes, renderizar uma linha central com a data por extenso curta (ex.: "3 de julho"). Implementado no `loadMessages` (`dashboard.html:3152`): ao iterar as mensagens ordenadas por `created_at`, quando o dia muda em relação à mensagem anterior, injeta um `<div class="msg-day-sep">…</div>` antes do balão. CSS novo `.msg-day-sep` (texto pequeno, centralizado, cinza).
- Sem mudança de backend — as mensagens já vêm com `created_at`.

### B.2 — Auto-liberação após 2 dias (`src/services/followup.js` + migration 049)

**Migration 049** — `sql/migrations/049_conversations_reengajado.sql`:
```sql
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS reengajado_em TIMESTAMPTZ;
```
Flag para reengajar **no máximo uma vez por parada** (evita cutucar toda hora).

**Elegibilidade** (função pura `deveReengajar(conv, agora)` em `followup.js`, testável):
- `status === 'aguardando_humano'`
- `pedido_numero` é `null` (se já há pedido registrado, a conversa espera a EQUIPE, não o cliente — excluída, conforme decisão)
- `reengajado_em` é `null`
- última mensagem há **mais de 48h** (`agora - ultima_msg_at > 48h`)

**Job (cron, de hora em hora, dentro de `startScheduler`):**
```sql
SELECT c.id, c.ai_context, ct.phone,
       (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id) AS ultima_msg_at
FROM conversations c
JOIN contacts ct ON ct.id = c.contact_id
WHERE c.status = 'aguardando_humano'
  AND c.pedido_numero IS NULL
  AND c.reengajado_em IS NULL
```
Em JS filtra por `deveReengajar` (48h) e por **horário comercial** (reusa `isWeekendSP`/`getHourSP` já existentes — só envia em dia útil, 9h–18h SP). Para cada elegível:
1. Gera a mensagem de reengajamento com contexto: injeta no histórico (`ai_context`) uma instrução de sistema — *"Faça o cliente voltar: retome de onde parou, cite o produto em questão e pergunte se ainda tem interesse, de forma simpática e curta."* — e chama o OpenAI (reaproveitando o modelo/estilo do agente). Fallback, se a chamada falhar: mensagem templada *"Oi! 😊 Voltando aqui pra te ajudar a finalizar seu orçamento na Gráfica LKL. Ainda tem interesse?"*.
2. Envia pelo WhatsApp (`sendMessage`), grava a mensagem em `messages` (outbound, sent_by 'ai'), atualiza `conversations SET status='active', reengajado_em=NOW(), updated_at=NOW()`.
3. Log (`log('reengajamento', …)`) e `global.io.emit('conversation_updated', …)` pro painel.
- **Se o envio falhar:** não muda status nem grava `reengajado_em` (tenta na próxima rodada).

**Reset do flag:** quando chega uma nova mensagem **inbound** do cliente (no `handler.js`, onde a conversa volta a `active`), limpar `reengajado_em = NULL` — assim, se a conversa estagnar de novo no futuro, pode ser reengajada outra vez. Uma linha no UPDATE existente.

### Testes (Parte B)

- **Jest (função pura):** `deveReengajar(conv, agora)` — casos: elegível (48h+, sem pedido, sem flag); não elegível por status; por `pedido_numero` presente; por `reengajado_em` presente; por < 48h.
- **Smoke no VPS:** forjar uma conversa `aguardando_humano` sem `pedido_numero` com última mensagem há 3 dias → rodar o job manualmente → conferir mensagem enviada, `status='active'`, `reengajado_em` preenchido; rodar de novo → não reenvia. Cleanup.

---

## Arquitetura / arquivos

- `src/ai/agent.js` — Parte A (prompt) + exportar `SYSTEM_PROMPT` para o teste de sanidade.
- `public/dashboard.html` — B.1 (datas + separador de dia + CSS `.msg-day-sep`).
- `sql/migrations/049_conversations_reengajado.sql` — B.2 (coluna `reengajado_em`).
- `src/services/followup.js` — B.2 (`deveReengajar` + job no `startScheduler`).
- `src/webhook/handler.js` — B.2 (reset de `reengajado_em` no inbound).
- Testes: `tests/agent-prompt.test.js`, `tests/reengajamento.test.js`.

## Erros e bordas

- `agent_prompt` customizado no banco sobrepõe o `SYSTEM_PROMPT` — a Task de deploy verifica e, se houver, atualiza também esse registro (senão as regras A não valem em produção).
- Reengajamento só em horário comercial e uma vez por parada; falha de envio não consome o flag.
- Conversas com pedido já registrado ficam de fora (esperam a equipe) — sem risco de "cutucar" cliente que já pediu.

## Fora de escopo

- Tela no painel para editar o guia de materiais (fica no prompt/settings por ora).
- Reengajamento de conversas com pedido/orçamento em andamento (decisão: excluídas).
- Cálculo/exibição de preço pelo bot (mantém a regra atual de nunca informar valores).

## Dependências

- Nenhuma externa nova. OpenAI já em uso; WhatsApp `sendMessage` já em uso; cron (`startScheduler`) já roda. Próxima migration livre: **049**.
