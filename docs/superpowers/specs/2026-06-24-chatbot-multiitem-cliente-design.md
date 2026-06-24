# Chatbot — Multi-item, E-mail e Identificação de Cliente — Design

**Data:** 2026-06-24
**Contexto:** Após unificar a entrada do chatbot no Pedido (`criarOrder`), um teste real
(pedido #23) revelou 3 problemas de qualidade da conversa: (a) 2 produtos foram colapsados
num único item; (b) o e-mail nunca é pedido; (c) o vínculo de cliente por telefone não é
confirmado (risco de associar ao cliente errado).

## Objetivo

Melhorar a coleta do chatbot para: registrar **múltiplos itens** corretamente, **tratar o
e-mail** (pedir do novo cliente, confirmar o do cliente existente), e **identificar o cliente**
pelo telefone confirmando a identidade antes de usar; quando não houver cadastro, fazer o
cadastro mínimo.

## Decisões (confirmadas com o usuário)

1. **Identificação:** se o telefone do WhatsApp casa com um cliente cadastrado, **confirmar a
   identidade** antes de usar ("Vi que você já é cliente como NOME. É isso mesmo?").
2. **E-mail:**
   - Cliente **novo** (sem cadastro) → **pedir** o e-mail (parte do cadastro mínimo).
   - Cliente **já cadastrado** → **confirmar** o e-mail do cadastro (e atualizar se corrigir; se
     o cadastro não tiver e-mail, pedir).
3. **Multi-item:** cada produto é um item separado; nunca juntar vários produtos num só.

## Arquitetura — tudo em `src/ai/agent.js` (sem migration)

O prompt (`SYSTEM_PROMPT`) é usado quando `settings.agent_prompt` está vazio (confirmado: está
vazio). Logo, editar `SYSTEM_PROMPT` no código tem efeito.

### a) Pré-busca do cliente + injeção de contexto

Em `processMessage`, antes de chamar o modelo, buscar o cliente pelo telefone do contato da
conversa e montar uma **nota de contexto** anexada ao system prompt:
- Existe com e-mail: `[CLIENTE NA BASE] Telefone cadastrado como "<nome>", e-mail "<email>". Confirme a identidade pelo nome antes de prosseguir e confirme se o e-mail "<email>" está correto.`
- Existe sem e-mail: `[CLIENTE NA BASE] Telefone cadastrado como "<nome>", sem e-mail. Confirme a identidade e peça o e-mail.`
- Não existe: `[CLIENTE NOVO] Telefone não cadastrado. Faça o cadastro mínimo: peça o nome e o e-mail do cliente.`

Lookup: `SELECT id, nome, email FROM clientes_lkl WHERE celular LIKE '%<últimos9>' LIMIT 1` a
partir do `phone` do `contacts` da conversa.

### b) Regras no SYSTEM_PROMPT (acréscimos)

- **Identificação:** havendo `[CLIENTE NA BASE]`, confirmar a identidade pelo nome. Se o cliente
  negar (não é essa pessoa/empresa), tratar como cliente novo e pedir o nome.
- **E-mail:** seguir a regra da nota — pedir (novo / sem e-mail) ou confirmar (existente com
  e-mail). Nunca registrar sem ter o e-mail tratado.
- **Multi-item:** quando o cliente pedir mais de um produto, registrar **um item por produto**
  (com suas próprias dimensões/quantidade/material/arte). No resumo, listar cada item
  separadamente (já faz hoje); ao chamar `registrar_pedido`, preencher o array `itens`.

### c) Tool `registrar_pedido` — schema

Adicionar:
```js
itens: {
  type: 'array',
  description: 'Um objeto por produto pedido. Use SEMPRE que houver itens; um item por produto.',
  items: {
    type: 'object',
    properties: {
      produto:    { type: 'string' },
      dimensoes:  { type: 'string' },
      quantidade: { type: 'number' },
      material:   { type: 'string' },
      tem_arte:   { type: 'boolean' },
    },
    required: ['produto', 'quantidade'],
  },
},
cliente_existente_confirmado: { type: 'boolean', description: 'true se o cliente confirmou ser o cadastro encontrado pelo telefone; false se negou; ausente se não havia cadastro' },
email: { type: 'string', description: 'E-mail do cliente (pedido se novo, confirmado se já cadastrado)' },
```
Manter os campos achatados (`produto`, `dimensoes`, `quantidade`, `material`, `tem_arte`) como
fallback de compatibilidade.

### d) `agent.js` — mapeamento e resolução do cliente

- **Itens:** se `args.itens` for um array não vazio, mapear cada um para
  `{ produto, quantidade, especificacao: [dimensoes, material].filter(Boolean).join(' · '), tem_arte }`.
  Senão, usar o item único atual (fallback dos campos achatados).
- **Cliente:**
  - Buscar por telefone (como hoje).
  - Se encontrou **e** `cliente_existente_confirmado !== false` → usar o cliente existente; se ele
    estava sem e-mail e `args.email` veio, atualizar o e-mail.
  - Senão (não encontrou, ou cliente negou) → cadastro mínimo:
    `INSERT INTO clientes_lkl (nome, celular, email, canal_origem, tipo_pessoa) VALUES ($1,$2,$3,'chatbot','PF')`.
- Passar `email` em `dados` para `criarOrder` (ele já atualiza o cadastro do cliente).

## Erros & testes

- `node --check`.
- Smoke no VPS: `criarOrder({origin_channel:'chatbot', cliente_id, itens:[item1,item2]})` cria
  **2 itens** no pedido (e 2 em orcamento_itens). Limpar o teste depois.
- Verificação real: uma conversa de teste no WhatsApp com **2 produtos** + cliente novo →
  confere 2 itens no pedido, e-mail pedido e gravado, e (com cliente existente) a confirmação de
  identidade/e-mail.

## Fora de escopo (YAGNI)

- Parsing fino de dimensões (m² × cm) pela IA — ajuste separado de prompt.
- Mesclagem de cliente duplicado (mesmo telefone, pessoa diferente).
- Edição do prompt pela UI (settings.agent_prompt) — continua via código por enquanto.
