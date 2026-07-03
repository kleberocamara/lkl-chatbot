# Identificação de cliente no chatbot + limpeza de duplicados — Design

**Data:** 2026-07-03
**Status:** Aprovado para escrita de plano
**Contexto:** O chatbot identifica o cliente pelo telefone com `SELECT nome,email FROM clientes_lkl WHERE celular LIKE '%<9 dígitos>' LIMIT 1`. Isso: (a) escolhe um duplicado aleatório (sem `ORDER BY`), (b) ignora `telefone` e não normaliza `55`/traços, (c) casa 1 só cliente quando o número pode pertencer a vários (a pessoa é contato de várias empresas), e (d) ao ser negado, desiste e trata como novo — mesmo com o cadastro real na base. A base tem duplicados (ex.: 3× "KLEBER DE OLIVEIRA CAMARA" com o mesmo celular) e um e-mail (`klebero.camara@gmail.com`) espalhado por 6 clientes.

## Objetivo

(A) Tornar a identificação do cliente no bot robusta: buscar por celular **e** telefone normalizados, retornar **todos** os cadastros, deduplicar, e — quando houver vários — **listar e deixar o cliente escolher**. (B) Limpar duplicados idênticos na base com um script seguro (dry-run → apply).

## Escopo — duas partes

- **Parte A — Bot:** `src/ai/agent.js` (funções puras + busca revisada + regras de prompt + resolução no `registrar_pedido`).
- **Parte B — Limpeza:** `scripts/dedup-clientes.js` (merge conservador de duplicados, dry-run/apply).

Sem migration (nenhuma mudança de schema). `clientes_lkl` é referenciado por `orders`, `orcamentos`, `ordens_servico`, `revenda_compras` (`cliente_id`).

---

## Parte A — Identificação no bot (`src/ai/agent.js`)

### Funções puras (testáveis, exportadas)

**`normalizarTelefone(s)`** — retorna os últimos 9 dígitos do telefone, ignorando formatação e o DDI 55:
```js
function normalizarTelefone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  return d.slice(-9);
}
```
Ex.: `5521988596449` → `988596449`; `21988596449` → `988596449`; `2198012-7348` → `980127348`.

**`normalizarNome(s)`** — uppercase, sem acento, colapsa espaços:
```js
function normalizarNome(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}
```

**`dedupClientes(rows)`** — recebe linhas `{id, nome, tipo_pessoa, celular, telefone, email, cpf_cnpj, updated_at}` e retorna 1 por grupo. Chave do grupo: `cpf_cnpj` (só dígitos) quando preenchido; senão `normalizarNome(nome) + '|' + normalizarTelefone(celular||telefone)`. Canônico do grupo: prefere quem tem `cpf_cnpj`; empate → maior `updated_at`/`created_at`; último desempate → menor `id`. Retorna os canônicos preservando a ordem de entrada.

### Busca revisada — `buscarClientesPorTelefone(phone)`

```sql
SELECT id, nome, tipo_pessoa, celular, telefone, email, cpf_cnpj, updated_at, created_at
FROM clientes_lkl
WHERE regexp_replace(COALESCE(celular,''),  '\D','','g') LIKE $1
   OR regexp_replace(COALESCE(telefone,''), '\D','','g') LIKE $1
```
com `$1 = '%' + normalizarTelefone(phone)`. Depois aplica `dedupClientes` no resultado. Retorna array (0, 1 ou N canônicos).

### Nota de contexto injetada no prompt (substitui o bloco atual em `processMessage`)

- **0 matches** → `[CLIENTE NOVO] Telefone não cadastrado. Faça o cadastro mínimo: peça o nome e o e-mail do cliente.` (igual ao atual)
- **1 match** → `[CLIENTE NA BASE] Telefone cadastrado como "<nome>", e-mail "<email|sem e-mail>". Confirme a identidade pelo nome e confirme/peça o e-mail.` (igual ao atual)
- **>1 matches** → `[CLIENTES NA BASE] O telefone está ligado a mais de um cadastro:\n1) <nome> (<PF|PJ>)\n2) <nome> (<PF|PJ>)\n... Pergunte para QUAL desses cadastros é este pedido, ou se é um cadastro novo. Não escolha por conta própria.`

A lista numerada usa os canônicos (após dedup). Limite de **5** itens; se houver mais, listar os 5 primeiros e dizer "entre outros — confirme o nome/empresa".

### Regras novas no `SYSTEM_PROMPT` (regra 11 estendida)

- Se a nota for `[CLIENTES NA BASE]`, o bot **lista os cadastros e pergunta qual é** (ou cadastro novo). Só prossegue após a escolha. Se o cliente disser que nenhum é (ou é novo), trata como **cadastro novo** (pede nome + e-mail).
- Nunca escolher um cadastro sozinho quando há vários.
- Ao preencher `registrar_pedido`, o `nome_cliente` deve ser **exatamente** o nome do cadastro escolhido (quando o cliente escolheu um existente), para a resolução casar o `id`.

### Resolução no `registrar_pedido` (bloco de criação de pedido em `processMessage`)

Hoje refaz `celular LIKE … LIMIT 1`. Passa a:
1. `cands = await buscarClientesPorTelefone(phone)`.
2. Se `cliente_existente_confirmado !== false` e houver candidato cujo `normalizarNome(nome)` casa com `normalizarNome(args.nome_cliente)` → usa esse `id` (completa e-mail se faltava).
3. Senão, se `cands.length === 1` e confirmado → usa esse `id`.
4. Senão → cria cliente novo (como hoje), com `nome_cliente`/e-mail informados.

Mantém o resto do fluxo (criar pedido pela mesma porta) inalterado.

### Testes (Parte A)

- **Jest (puras):** `normalizarTelefone` (com/sem 55, com traço, mobile/landline), `normalizarNome`, `dedupClientes` (junta os 3 "KLEBER…CAMARA" celular 21988596449 num só; **não** junta com "A NOSSA DROGARIA" — email igual, nome/tipo diferentes; **não** junta o Kleber de telefone `5521967625358` com os de `21988596449` — telefone diferente). Sanidade do `SYSTEM_PROMPT` (âncora `[CLIENTES NA BASE]`).
- **Smoke no VPS:** número com múltiplos cadastros → nota `[CLIENTES NA BASE]` lista os certos; número com 1 → `[CLIENTE NA BASE]`; número inexistente → `[CLIENTE NOVO]`.

---

## Parte B — Limpeza de duplicados (`scripts/dedup-clientes.js`)

Script Node standalone, rodado no VPS. Reusa `normalizarTelefone`/`normalizarNome` da Parte A (importados de `src/ai/agent.js` ou de um util compartilhado).

### Agrupamento (conservador)

Carrega todos os `clientes_lkl`. Agrupa por chave: `cpf_cnpj` (só dígitos) quando preenchido; senão `normalizarNome(nome) + '|' + normalizarTelefone(celular||telefone)`. Só processa grupos com **≥ 2** registros.

### Canônico e merge (por grupo, dentro de `BEGIN/COMMIT`)

- Canônico: prefere `cpf_cnpj` preenchido; empate → maior `updated_at`/`created_at`; último → menor `id`.
- Para cada duplicado do grupo:
  - **Repontar** `cliente_id` do duplicado → canônico em `orders`, `orcamentos`, `ordens_servico`, `revenda_compras`.
  - **Completar** campos vazios do canônico com os do duplicado (`email`, `telefone`, `celular`, `cpf_cnpj` — `COALESCE(canonico.campo, dup.campo)` só onde o canônico está NULL/'').
  - **Deletar** o duplicado.
- Erro em qualquer passo → `ROLLBACK` do grupo inteiro (idealmente da execução toda).

### Modos

- `--dry-run` (padrão): imprime cada grupo (canônico + duplicados + nº de referências que seriam repontadas). **Nada muda.**
- `--apply`: executa o merge; imprime resumo (`grupos, duplicados removidos, referências repontadas por tabela`).

### Testes (Parte B)

- A função de **agrupamento** (pura) é coberta pelos testes de `dedupClientes`/agrupamento na Parte A.
- **Execução:** `--dry-run` no VPS (revisar os grupos — em especial confirmar que Kleber-PF, A Nossa Drogaria e o 2º número ficam **separados**), depois `--apply`, e verificar: contagem de "KLEBER…CAMARA" cai de 4 para o esperado (2: um por telefone), referências (`orcamentos`/`orders`/…) intactas apontando para o canônico.

## Erros e bordas

- Telefone muito curto/vazio → `normalizarTelefone` retorna string curta; a busca com `LIKE '%<curto>'` pode super-casar — se `normalizarTelefone(phone).length < 8`, tratar como `[CLIENTE NOVO]` (não arriscar match).
- Grupo com CPF/CNPJ diferentes nunca é unido (chave distinta).
- Cliente escolhe um cadastro e depois o nome não casa exatamente → cai no passo 3/4 (usa único candidato ou cria novo) — nunca associa ao cadastro errado.

## Fora de escopo

- Merge por nome+email iguais (rejeitado — email compartilhado entre empresas).
- Unir telefones diferentes da mesma pessoa (ficam separados — conservador).
- UI de gestão de duplicados no painel (a limpeza é via script).

## Dependências

- Nenhuma externa nova. Sem migration. `clientes_lkl` e as 4 tabelas referenciadoras já existem.
