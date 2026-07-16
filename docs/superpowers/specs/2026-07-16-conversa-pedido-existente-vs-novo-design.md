# Evitar pedido duplicado quando conversa é sobre pedido existente — Design

## Contexto

O cliente Wendell tinha o pedido #44 em produção/arte. Um atendente (André) estava
conversando com ele sobre detalhes da arte final. Ao enviar a arte para aprovação, o
sistema fechou a conversa automaticamente (`status = 'resolved'`). Quando o Wendell
escreveu de novo (dúvida sobre instalação), o sistema não encontrou conversa ativa,
criou uma conversa nova (`status = 'active'`) e a IA reassumiu o atendimento sozinha —
sem saber que o pedido #44 já existia — e acabou registrando um pedido novo (#46) para
o mesmo assunto.

Causa raiz, em uma frase: fechar a conversa ao enviar a arte tira a conversa da lista
de "ativas"; a próxima mensagem cria uma conversa nova sem contexto de pedidos abertos,
e a IA nunca consulta `orders` antes de decidir criar um pedido.

## Objetivo

1. Parar de fechar a conversa automaticamente ao enviar a arte.
2. Fechar conversas automaticamente só por inatividade real (3 dias sem mensagem).
3. Antes de criar um pedido novo, a IA deve checar se o cliente já tem pedido(s) em
   aberto e, se tiver, confirmar explicitamente com o cliente se é sobre um desses
   pedidos ou um pedido novo — com uma trava no código que impede a criação sem essa
   confirmação.

## Fora de escopo

- FK formal entre `orders` e `conversations` (a checagem usa `cliente_id`, não precisa
  de vínculo novo).
- Mudanças no botão manual "Marcar como resolvida" (`POST /conversations/:id/resolve`),
  que já existe e continua funcionando como está.

## Componente 1 — Remover auto-resolve ao enviar arte

**Arquivo:** `src/modules/orcamentos/service.js` (~linha 981)

Hoje, ao enviar a arte final de um item para aprovação, o código chama:
```js
conversas.sairDeAguardandoHumano(item.cliente_celular, { para: 'resolved', motivo: 'arte_enviada' })
```

Essa chamada deve ser removida. Enviar a arte não deve mais alterar o `status` da
conversa. A conversa só fecha por: (a) ação manual do atendente no painel, ou (b) o
job de inatividade do Componente 2.

## Componente 2 — Fechamento automático por inatividade (3 dias)

Novo cron job, seguindo o padrão de `src/jobs/contas-pagar.js` (usa `node-cron`,
`timezone: 'America/Sao_Paulo'`, registrado via `require()` em `src/app.js`).

**Criar:** `src/jobs/conversas-inativas.js`

Roda 1x por dia (03h00) e fecha (`status = 'resolved'`, `resolved_at = NOW()`) toda
conversa com `status IN ('active', 'aguardando_humano', 'orcamento_enviado')` que não
teve nenhuma mensagem (nem do cliente, nem do atendente/IA) nos últimos 3 dias.

Definição de "sem mensagem recente": não existe linha em `messages` com
`conversation_id` igual à conversa e `created_at > NOW() - INTERVAL '3 days'`. Usa
também `updated_at < NOW() - INTERVAL '3 days'` como segunda condição, para não fechar
uma conversa que teve o `status` alterado por outro motivo há pouco tempo mas ainda não
recebeu mensagem.

**Registrar** em `src/app.js`, ao lado de `require('./jobs/contas-pagar')`.

## Componente 3 — Checar pedido aberto antes de `registrar_pedido`

**Arquivo:** `src/ai/agent.js`, função `processMessage()`.

### 3a. Lookup de pedidos abertos

A tabela `orders` (`sql/migrations/001_sprint1_foundation_v2.sql:118`) tem a coluna
`status` com `CHECK (status IN ('criada','gerando_arquivo_impressao',
'arte_enviada_cliente','arte_aprovada_cliente','arte_reprovada_cliente','em_producao',
'concluido','entregue','cancelado'))`. "Pedido aberto" = `status NOT IN ('concluido',
'entregue','cancelado')`. A coluna `orders.produto` já é preenchida com o produto
principal do pedido (`src/modules/orders/service.js:126`), suficiente para o texto do
prompt — não precisa fazer JOIN com `order_items`.

Ao lado do bloco `clienteNota` existente (que já busca `buscarClientesPorTelefone`, faz
lookup por telefone e guarda `cands`), adicionar, reaproveitando os `cands.map(c => c.id)`
já resolvidos:

```js
let pedidosAbertos = [];
if (cands.length) {
  const ids = cands.map(c => c.id);
  const r = await db.query(
    `SELECT numero_os, status, produto FROM orders
     WHERE cliente_id = ANY($1) AND status NOT IN ('concluido','entregue','cancelado')
     ORDER BY created_at DESC`,
    [ids]);
  pedidosAbertos = r.rows;
  if (pedidosAbertos.length) {
    const lista = pedidosAbertos
      .map(p => `#${p.numero_os} (${p.produto || 'produto não especificado'}, status: ${p.status})`)
      .join(', ');
    clienteNota += `\n\n[PEDIDOS EM ABERTO] Este cliente já tem pedido(s) em andamento: ${lista}. Se a mensagem do cliente parecer estar relacionada a um desses pedidos (dúvida sobre arte, instalação, prazo, revisão, etc.), NÃO chame registrar_pedido — responda a dúvida normalmente ou use [FALAR_HUMANO] se precisar de alguém da equipe. Só chame registrar_pedido se o cliente confirmar explicitamente que é um pedido NOVO e diferente desses. Nesse caso, preencha "pedido_novo_confirmado": true no registrar_pedido.`;
  }
}
```

Isso roda apenas quando `cands.length >= 1` (cliente já identificado/cadastrado);
clientes totalmente novos (`cands.length === 0`) não têm pedido para checar.

### 3b. Trava no código dentro do handler de `registrar_pedido`

No bloco que já trata `toolCall.function.name === 'registrar_pedido'`
(`src/ai/agent.js` ~linha 294), logo após fazer `JSON.parse(toolCall.function.arguments)`
e **antes** de resolver o cliente e chamar `ordersService.criarOrder`:

```js
if (pedidosAbertos.length && args.pedido_novo_confirmado !== true) {
  const numeros = pedidosAbertos.map(p => `#${p.numero_os}`).join(', ');
  cleanResponse = `Só pra confirmar: isso é sobre o pedido ${numeros} que você já tem com a gente, ou é um pedido novo? 😊`;
  history.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Aguardando confirmação: pedido existente ou novo.' });
  isComplete = false;
  orderDetails = null;
} else {
  // fluxo atual (resolve cliente, monta itens, chama ordersService.criarOrder, etc.)
}
```

Isso segue o mesmo padrão já usado para `args.cliente_existente_confirmado`
(linha 310): um flag que a IA preenche na tool call e que o código valida antes de
agir — não confia apenas na instrução do prompt.

### 3c. Tool schema

O parâmetro `pedido_novo_confirmado` (boolean, opcional) precisa ser adicionado à
definição da função `registrar_pedido` em `TOOLS` (mesmo arquivo, próximo à definição
existente de `cliente_existente_confirmado`, por volta da linha 178).

### 3d. Regra no `SYSTEM_PROMPT`

Adicionar uma regra nova (após a regra 6, que trata da confirmação de pedido) descrevendo
o comportamento esperado quando existir `[PEDIDOS EM ABERTO]` no contexto: perguntar
antes de chamar `registrar_pedido`, e só prosseguir com `pedido_novo_confirmado: true`
após confirmação explícita do cliente.

## Testes

- `tests/modules/orcamentos.test.js` (ou arquivo equivalente que cobre envio de arte):
  adicionar/ajustar teste garantindo que `conversations.status` **não** muda para
  `'resolved'` após o envio da arte final.
- `tests/jobs/conversas-inativas.test.js` (novo): conversa sem mensagem há 3+ dias
  fecha; conversa com mensagem recente não fecha; conversa já `resolved` não é afetada.
- `tests/ai/agent.test.js` (criar se não existir; mockar `openai.chat.completions.create`
  e `db.query`):
  1. Cliente sem pedido aberto → `registrar_pedido` cria o pedido normalmente (fluxo
     atual, sem regressão).
  2. Cliente com pedido aberto, tool call sem `pedido_novo_confirmado` → não chama
     `ordersService.criarOrder`; resposta pede confirmação.
  3. Cliente com pedido aberto, tool call com `pedido_novo_confirmado: true` → cria o
     pedido normalmente.

## Auto-revisão do spec

- Sem placeholders (TBD/TODO) — todos os trechos de código são completos.
- Consistência: os três componentes usam os mesmos nomes de tabela/coluna confirmados
  no schema (`orders.status`, `orders.produto`, `conversations.status`).
- Escopo: focado neste incidente específico; não expande para reestruturação de
  conversas/pedidos.
