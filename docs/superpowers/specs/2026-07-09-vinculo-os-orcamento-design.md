# Vínculo OS↔Orçamento por dois caminhos (corrige receita subestimada)

## Contexto

`criarOSOffset()` (`src/modules/os/service.js:486-527`) e o `INSERT` de OS de revenda (`src/modules/revenda-compras/service.js:98-102`) nunca gravam `ordens_servico.orcamento_id` — porque uma única OS Offset pode legitimamente agrupar itens de vários orçamentos diferentes (a mesma razão pela qual `cliente_id` também vira `null` nesse caso, `os/service.js:500-501`). O vínculo real com o(s) orçamento(s) só existe via `os_itens` (os_id → orcamento_item_id) → `orcamento_itens.orcamento_id`. Só `criarOSComunicacaoVisual()` grava `orcamento_id` diretamente, porque CV é sempre 1 OS por orçamento.

Isso deixa toda query que filtra `ordens_servico` só por `orcamento_id` direto cega pra OS offset/revenda. Confirmado em produção: 2 OS offset e 1 OS revenda, todas `entregue`, com `orcamento_id = NULL` — nenhuma órfã (todas têm `os_itens` recuperável), mas invisíveis pra quem só olha a coluna direta. Impacto medido: 7 orçamentos, R$11.711,00 de receita potencialmente não reconhecida na DRE.

O próprio código já tem o padrão certo pra resolver isso: `orcamentosAfetadosPorOS()`/`statusOSsDoOrcamento()` (`os/service.js:656-683`) fazem `UNION` entre os dois caminhos de vínculo. Esta correção replica esse padrão nos 5 pontos que ainda não usam.

## Escopo

1. `dre()` (`src/modules/analises/service.js`) — receita por competência de entrega.
2. `orcamentos.buscarPorId()` e `orcamentos.listar()` (`src/modules/orcamentos/service.js`) — lista de OS embutida no detalhe e flag `tem_os_entregue`.
3. `os/service.js` — `avancarFase()`, `atualizarStatus()`, `entregar()`: trocar a checagem `WHERE orcamento_id=$1`/`if (os.orcamento_id)` por `statusOSsDoOrcamento()`/`orcamentosAfetadosPorOS()`, já existentes no arquivo.
4. `os/service.js` `listar()` (usada pelo filtro `?orcamento_id=` de `os/router.js`) — mesmo padrão de dois caminhos.
5. Bônus (já combinado antes): `dre()` passa a **excluir OS com `status='cancelado'`** da contagem de "totalmente entregue" — hoje uma OS cancelada trava o reconhecimento de receita daquele orçamento pra sempre, mesmo com todas as outras entregues.

**Fora de escopo**: fazer `criarOSOffset()`/o `INSERT` de revenda gravarem `orcamento_id` diretamente — impossível de forma correta, já que uma OS offset pode cobrir vários orçamentos. A correção é sempre do lado de quem lê.

## Design técnico

### 1. `dre()` — nova `entregas` CTE

```sql
WITH os_do_orcamento AS (
  SELECT DISTINCT orcamento_id, os_id FROM (
    SELECT os.orcamento_id, os.id AS os_id
    FROM ordens_servico os
    WHERE os.orcamento_id IS NOT NULL AND os.status != 'cancelado'
    UNION
    SELECT oi.orcamento_id, os.id AS os_id
    FROM os_itens oit
    JOIN orcamento_itens oi ON oi.id = oit.orcamento_item_id
    JOIN ordens_servico os ON os.id = oit.os_id
    WHERE os.status != 'cancelado'
  ) t
),
entregas AS (
  SELECT p.orcamento_id,
         COUNT(*) AS total_os,
         COUNT(*) FILTER (WHERE os.status = 'entregue') AS os_entregues,
         MAX(h.em) AS ultima_entrega
  FROM os_do_orcamento p
  JOIN ordens_servico os ON os.id = p.os_id
  LEFT JOIN LATERAL (
    SELECT em FROM os_historico hh WHERE hh.os_id = os.id AND hh.para_status = 'entregue' ORDER BY hh.em DESC LIMIT 1
  ) h ON true
  GROUP BY p.orcamento_id
)
SELECT COALESCE(SUM(o.total),0) AS receita
FROM orcamentos o
JOIN entregas e ON e.orcamento_id = o.id
WHERE e.total_os = e.os_entregues AND e.ultima_entrega::date BETWEEN $1 AND $2
```

`os_do_orcamento` já exclui `status='cancelado'` em ambos os ramos do UNION antes de agregar — resolve o item 5 do escopo junto. `DISTINCT` evita duplicar quando uma OS de Comunicação Visual bate nos dois ramos (tem `orcamento_id` direto E `os_itens`).

### 2. `orcamentos/service.js`

`buscarPorId()`: troca `SELECT * FROM ordens_servico WHERE orcamento_id = $1` por uma versão com o mesmo `UNION` (subquery inline ou reaproveitando `statusOSsDoOrcamento`-like query, mas retornando as linhas completas de `ordens_servico`, não só `status`).

`listar()`: a subquery `EXISTS(SELECT 1 FROM ordens_servico os WHERE os.orcamento_id = o.id AND os.status='entregue')` vira `EXISTS(... os.orcamento_id = o.id ... UNION ... os_itens ...)`.

### 3. `os/service.js` — `avancarFase`, `atualizarStatus`, `entregar`

Os três pontos que hoje fazem, respectivamente:
- `avancarFase` (linha ~142): `if (proximo === 'entregue' && os.orcamento_id) { checa pendentes WHERE orcamento_id=$1 }`
- `atualizarStatus` (linha ~337): `SELECT COUNT(*) FROM ordens_servico WHERE orcamento_id=$1 AND status NOT IN ('entregue','cancelado')`
- `entregar` (linha ~402): mesmo padrão de `atualizarStatus`

Passam a usar `statusOSsDoOrcamento(orcamentoId)` (já existe, `os/service.js:671-683`) pra pegar os status de todas as OS do orçamento pelos dois caminhos, e checar localmente em JS se sobra alguma pendente — em vez de montar `COUNT(*) WHERE orcamento_id=$1` (que sempre dá 0 quando `$1` é `null`, causando o falso-positivo hoje). Como esses 3 pontos rodam a partir de uma OS específica (não têm o orçamento_id da OS de mão — ela pode ser `null`), primeiro chamam `orcamentosAfetadosPorOS(osId)` pra descobrir quais orçamentos essa OS afeta (pode ser mais de um, no caso de offset multi-orçamento), e repetem a checagem pra cada um.

### 4. `os/service.js` `listar()` — filtro `?orcamento_id=`

A cláusula `AND os.orcamento_id = $N` (linha ~199) vira `AND (os.orcamento_id = $N OR os.id IN (SELECT oit.os_id FROM os_itens oit JOIN orcamento_itens oi ON oi.id=oit.orcamento_item_id WHERE oi.orcamento_id = $N))`.

## Testes

- `dre()`: teste com uma OS offset (orcamento_id NULL, vínculo só via os_itens) entregue → orçamento correspondente conta na receita. Teste com OS cancelada + outras OS entregues do mesmo orçamento → orçamento ainda conta (cancelada é ignorada). Teste de regressão: cenário atual (OS com orcamento_id direto, tipo Comunicação Visual) continua funcionando idêntico a antes.
- `orcamentos.buscarPorId()`: OS offset vinculada só via os_itens aparece na lista embutida.
- `orcamentos.listar()`: `tem_os_entregue=true` pra orçamento com só OS offset entregue.
- `os/service.js` `avancarFase`/`atualizarStatus`/`entregar`: evento `servico_concluido` só dispara quando TODAS as OS não-canceladas do(s) orçamento(s) afetado(s) (pelos dois caminhos) estão entregues — inclui cenário de OS offset multi-orçamento (uma OS afeta 2 orçamentos diferentes, só um dos dois está completo).
- `os/service.js` `listar({orcamento_id})`: retorna OS offset vinculada só via os_itens.

## Fora de escopo

- Fazer `criarOSOffset()`/revenda gravarem `orcamento_id` diretamente (impossível corretamente — 1 OS pode cobrir N orçamentos).
- Backfill de dados históricos (não há OS órfã — todo dado é recuperável via `os_itens`, então não há nada pra corrigir retroativamente na tabela, só na lógica de leitura).
- Detalhamento clicável na linha "Receita Bruta de Vendas" da DRE (pedido original do usuário, tratado depois desta correção).
