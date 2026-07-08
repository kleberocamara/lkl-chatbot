# Parcelamento manual (linhas explícitas) + Data de Entrega → competência

## Contexto

O parcelamento de despesas implementado na sessão anterior (`criarParcelado`) assume que todas as parcelas seguem cadência mensal a partir de uma data, com valor dividido igualmente. Uma nota real de compra (Evolution Engeplotter, pedido 26/0471/05/1) mostra que isso não reflete a realidade: as parcelas vêm com prazos irregulares (28 e 35 dias — não 30/60), cada parcela é um boleto distinto com sua própria linha digitável, e a nota traz uma "Data de Entrega" separada da data de vencimento, que é a data correta pra reconhecer a despesa no DRE (regime de competência) — não a data em que alguém digitou a conta no sistema.

Este spec reformula o parcelamento pra ser 100% manual (usuário informa cada parcela — vencimento, valor, linha digitável — com uma sugestão automática só como ponto de partida editável), adiciona o campo "Data de Entrega" em todo formulário de conta (vira a `competencia`), e cobre o caso de converter uma conta já existente (lançada como uma linha só, antes desta feature) em um grupo de parcelas.

## Escopo

- Campo novo "Data de Entrega" no formulário de Nova/Editar Conta — grava em `contas_pagar.competencia` (coluna já existe, migration 053 da sessão anterior).
- Reformular `POST /contas-pagar/parcelado`: recebe um array explícito de parcelas (`vencimento`, `valor`, `linha_digitavel` cada), não mais `parcelas` (contador) + `primeiro_vencimento`.
- UI: ao digitar o número de parcelas, abrir N conjuntos de campos (vencimento/valor/linha digitável), pré-preenchidos com uma sugestão (divisão igual + cadência mensal, como já existe hoje), mas totalmente editáveis.
- Endpoint novo `POST /contas-pagar/:id/parcelar`: converte uma conta existente (uma linha) em N parcelas — apaga a original e cria as novas, dentro de uma transação. Bloqueado se a conta já está paga (`status='pago'`) ou já passou por um lote C6 (`c6_group_id IS NOT NULL`).
- **Fora de escopo**: mudar `criarRecorrente` (continua com cálculo automático mensal — é pra obrigações que realmente se repetem todo mês igual, ex: aluguel, onde o cálculo automático já é correto).

## Design técnico

### 1. `competencia` no formulário

`criar()` e `editar()` em `service.js` já aceitam `competencia` no corpo (adicionado na sessão anterior aos campos `permitidos` de `editar`; `criar` já grava qualquer coluna existente na tabela via INSERT explícito — precisa adicionar `competencia` na lista de colunas do INSERT de `criar()`, hoje ausente). No formulário (`dashboard.html`), um novo campo `<input type="date" id="cp-f-data-entrega">` mapeia pra `competencia` no body enviado. Se vazio, não envia o campo — o banco usa o `DEFAULT CURRENT_DATE` já existente (mesmo comportamento de hoje).

### 2. `criarParcelado` reformulado — array de parcelas

Assinatura nova:
```js
criarParcelado({ descricao, fornecedor, fornecedor_id, tipo_despesa_id, competencia, tipo, observacao, parcelas })
```
onde `parcelas` é um array `[{ vencimento, valor, linha_digitavel }, ...]`, mínimo 2 itens. Validação: cada item precisa de `vencimento` e `valor` (linha_digitavel é opcional — nem todo boleto tem código ainda no momento do cadastro). `competencia` é obrigatório vindo do formulário (Data de Entrega) — se não vier, usa `CURRENT_DATE` (mesmo default da coluna). A função grava N linhas com o mesmo `parcela_grupo_id`/`competencia`, cada uma com seu próprio `vencimento`/`valor`/`linha_digitavel`, dentro de uma transação (mesmo padrão de antes).

O cálculo automático de sugestão (divisão igual + mensal) sai do backend e vira responsabilidade só do frontend, que já manda o array pronto (o usuário edita antes de enviar) — o backend não recalcula nada, só valida e grava.

### 3. UI — N linhas dinâmicas

No campo "Número de parcelas", um listener `oninput` gera dinamicamente N blocos de 3 campos (`Vencimento`, `Valor`, `Linha Digitável`), com IDs previsíveis (`cp-parcela-{i}-vencimento`, etc.), inseridos num container vazio que já existe hoje como o grupo `#cp-grupo-parcelado`. Ao gerar os campos, cada um já vem pré-preenchido com a sugestão atual (valor total / N, vencimento mensal a partir da 1ª data informada) — se o usuário mudar o "Número de parcelas" depois de já ter editado alguma linha, os campos são regenerados do zero (perde edições manuais anteriores; aceitável, é raro mudar o número de parcelas no meio do preenchimento). `cpSalvarConta()` monta o array lendo os N conjuntos de campos.

### 4. Converter conta existente em parcelada

Botão novo no modal de edição, visível só quando `cpEditandoId` existe (edição, não criação): "Parcelar esta conta". Ao clicar, mostra os mesmos campos de N parcelas da seção 3 (sugestão inicial: valor total da conta / N, primeira data = vencimento atual da conta). Salvar chama `POST /contas-pagar/:id/parcelar` com o mesmo formato de `parcelas` da seção 2. No backend, `converterEmParcelado(id, { descricao, fornecedor, fornecedor_id, tipo_despesa_id, competencia, parcelas })`:
1. Busca a conta; se não existir, erro 404.
2. Se `status === 'pago'` ou `c6_group_id` não for nulo, retorna erro: `"Conta já paga ou processada em lote C6 — não é possível parcelar"`.
3. Dentro de uma transação: `DELETE FROM contas_pagar WHERE id=$1`, depois insere as N parcelas (mesma lógica de `criarParcelado`, usando os dados vindos da tela — que já vêm preenchidos com os valores atuais da conta, editáveis).

## Testes

- `criarParcelado`: array de parcelas com valores/vencimentos distintos (não mensal, não igual) grava exatamente como veio; soma que não bate com nenhum "total" externo não é validada (não existe mais campo total — é a soma do array, ponto); menos de 2 parcelas → erro; parcela sem `vencimento` ou `valor` → erro.
- `converterEmParcelado`: conta paga → erro sem apagar nada; conta com `c6_group_id` → erro sem apagar nada; conta elegível → apaga a original e cria N novas na mesma transação (se a criação falhar, a original não deveria ter sido apagada — testar rollback).
- UI: sem teste automatizado (mesmo padrão do resto do projeto pra HTML/JS) — verificação por parse check + smoke manual.

## Fora de escopo

- Mudar `criarRecorrente` (continua igual).
- Editar parcelas individualmente depois de criadas (ex: mudar só o vencimento da parcela 2 de um grupo já existente) — hoje isso já é possível via `editar()` em cada linha individualmente (cada parcela é uma `contas_pagar` normal), não precisa de endpoint novo.
- Validação de soma "valor total" no backend — já que não existe mais um campo de valor total separado no novo formato de `criarParcelado`, não há nada pra validar contra.
