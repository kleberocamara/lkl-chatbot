# Competência e Parcelamento — DRE por regime de competência + parcelamento de despesas

## Contexto

Hoje o DRE (`analises.dre()`) soma despesas por `contas_pagar.pago_em` (regime de caixa — só conta o que já foi pago) e receita por `orcamentos.pago_em` (também caixa — só conta quando o cliente pagou). Isso quebra numa compra parcelada: se uma compra de R$1.200 é paga em 3x, o regime de caixa espalha a despesa por 3 meses conforme cada parcela é paga, quando na verdade a despesa aconteceu inteira no mês da compra. Não existe hoje nenhuma noção de parcelamento em `contas_pagar` (só existe "recorrente", que é conceitualmente diferente — uma obrigação nova a cada mês, tipo aluguel).

## Escopo

1. Parcelamento de despesas: nova forma de lançar uma compra em N parcelas, cada uma virando sua própria conta a pagar (com vencimento e boleto/PIX próprios, pois cada parcela é paga separadamente), mas todas reconhecidas no DRE como uma despesa única no mês da compra.
2. DRE de despesas por competência: conta a despesa no mês em que ela foi lançada/aconteceu, independente de já ter sido paga.
3. DRE de receita por competência: conta a receita no mês em que o pedido foi totalmente entregue (última OS do orçamento), não quando o cliente pagou.
4. `fluxoCaixa()` (projeção de caixa) **não muda** — já agrupa por `vencimento`, que é exatamente o que se quer pra saber quando o dinheiro sai/entra de fato.

## Design técnico

### 1. Colunas novas em `contas_pagar`

```sql
ALTER TABLE contas_pagar ADD COLUMN competencia DATE;
ALTER TABLE contas_pagar ADD COLUMN parcela_grupo_id UUID;
ALTER TABLE contas_pagar ADD COLUMN parcela_numero SMALLINT;
ALTER TABLE contas_pagar ADD COLUMN parcela_total SMALLINT;
```

- `competencia`: mês/data em que a despesa é reconhecida no DRE. Contas não-parceladas: preenchida automaticamente com a data de lançamento (`CURRENT_DATE` no momento da criação) — sem fricção nova no cadastro do dia a dia. Editável manualmente se precisar corrigir.
- `parcela_grupo_id`/`parcela_numero`/`parcela_total`: só preenchidos quando a conta faz parte de uma compra parcelada; `NULL` no resto. Servem pra mostrar "2/3" na UI e pra permitir uma futura tela de "ver todas as parcelas dessa compra" (fora de escopo agora, mas os campos já dão essa capacidade de graça).
- Contas já existentes no banco (`recorrente` incluído) recebem `competencia = created_at::date` no backfill — pra recorrentes, isso é correto: cada parcela de aluguel É uma despesa nova naquele mês, então competência = mês daquela linha faz sentido.
- Coluna nasce nullable pro backfill, depois vira `NOT NULL DEFAULT CURRENT_DATE`.

### 2. Fluxo de parcelamento — nova função `criarParcelado`

Em `src/modules/contas-pagar/service.js`, nova função espelhando a estrutura de `criarRecorrente` (mesma transação, mesmo padrão de INSERT em loop):

```js
async function criarParcelado({ descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor_total, parcelas, primeiro_vencimento, tipo, observacao }) {
  if (!descricao || !tipo_despesa_id || !valor_total || !parcelas || parcelas < 2 || !primeiro_vencimento) {
    return { erro: ['descricao, tipo_despesa_id, valor_total, parcelas (mínimo 2) e primeiro_vencimento são obrigatórios'] };
  }
  const parcelaGrupoId = crypto.randomUUID();
  const competencia = format(new Date(`${primeiro_vencimento}T00:00:00`), 'yyyy-MM-dd');
  const valorParcela = Math.floor((valor_total / parcelas) * 100) / 100;
  const ajusteUltima = Math.round((valor_total - valorParcela * (parcelas - 1)) * 100) / 100;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const criadas = [];
    for (let i = 0; i < parcelas; i++) {
      const data = new Date(`${primeiro_vencimento}T00:00:00`);
      data.setMonth(data.getMonth() + i);
      const valorInst = i === parcelas - 1 ? ajusteUltima : valorParcela;
      const r = await client.query(
        `INSERT INTO contas_pagar
           (descricao, fornecedor, fornecedor_id, tipo_despesa_id, valor, vencimento, tipo,
            tipo_entrada, status, competencia, parcela_grupo_id, parcela_numero, parcela_total, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'manual','pendente',$8,$9,$10,$11,$12) RETURNING *`,
        [`${descricao} (${i + 1}/${parcelas})`, fornecedor || null, fornecedor_id || null, tipo_despesa_id,
         valorInst, format(data, 'yyyy-MM-dd'), tipo || 'boleto',
         competencia, parcelaGrupoId, i + 1, parcelas, observacao || null]
      );
      criadas.push(r.rows[0]);
    }
    await client.query('COMMIT');
    if (fornecedor_id) await gravarMemoriaFornecedor(fornecedor_id, tipo_despesa_id);
    return { criadas };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
```

Note: usa `Math.floor`/ajuste na última parcela pra garantir que a soma das parcelas bate exatamente com `valor_total` (evita sobra/falta de centavos por arredondamento).

`criar()` (conta avulsa) e `criarOuReconciliarContaPagar()` (DDA/entrada de estoque/WhatsApp) passam a gravar `competencia = CURRENT_DATE` automaticamente no INSERT (via `DEFAULT CURRENT_DATE` da coluna — não precisa mudar código, só a migration já resolve). `editar()` ganha `competencia` na lista de campos editáveis, pra permitir correção manual.

### 3. UI — modal Nova Conta ganha "Parcelar"

Em `dashboard.html`, ao lado do checkbox "Conta Recorrente" já existente no modal `cp-modal`, novo checkbox "Parcelar" com os mesmos campos condicionais (`display:none` até marcar): número de parcelas e data da 1ª parcela. Os dois checkboxes são mutuamente exclusivos (marcar um desmarca o outro — uma conta não pode ser recorrente E parcelada ao mesmo tempo). `cpSalvarConta()` chama `POST /api/v2/contas-pagar/parcelado` (novo endpoint) quando "Parcelar" está marcado, em vez de `/contas-pagar` ou `/contas-pagar/recorrente`.

### 4. DRE — despesas por competência, sem exigir pagamento

Em `src/modules/analises/service.js`, a query de despesas do `dre()` muda de:

```sql
SELECT td.categoria_dre AS categoria, COALESCE(SUM(cp.valor),0) AS valor
FROM contas_pagar cp
JOIN tipos_despesa td ON td.id = cp.tipo_despesa_id
WHERE cp.status = 'pago' AND cp.pago_em::date BETWEEN $1 AND $2
GROUP BY td.categoria_dre ORDER BY valor DESC
```

para:

```sql
SELECT td.categoria_dre AS categoria, COALESCE(SUM(cp.valor),0) AS valor
FROM contas_pagar cp
JOIN tipos_despesa td ON td.id = cp.tipo_despesa_id
WHERE cp.status != 'cancelado' AND cp.competencia BETWEEN $1 AND $2
GROUP BY td.categoria_dre ORDER BY valor DESC
```

Contas canceladas continuam de fora (nunca aconteceram de verdade); todo o resto conta pela competência, esteja paga, pendente, agendada ou vencida.

### 5. DRE — receita pela última entrega do pedido

A query de receita muda de `orcamentos.status_pagamento='pago' AND pago_em` pra usar a data da última OS entregue. Um orçamento só conta quando **todas** as suas OSs estão com `status='entregue'`:

```sql
WITH entregas AS (
  SELECT os.orcamento_id,
         COUNT(*) AS total_os,
         COUNT(*) FILTER (WHERE os.status = 'entregue') AS os_entregues,
         MAX(h.em) AS ultima_entrega
  FROM ordens_servico os
  LEFT JOIN LATERAL (
    SELECT em FROM os_historico h WHERE h.os_id = os.id AND h.para_status = 'entregue' ORDER BY h.em DESC LIMIT 1
  ) h ON true
  GROUP BY os.orcamento_id
)
SELECT COALESCE(SUM(o.total),0) AS receita
FROM orcamentos o
JOIN entregas e ON e.orcamento_id = o.id
WHERE e.total_os = e.os_entregues AND e.ultima_entrega::date BETWEEN $1 AND $2
```

Pedidos sem nenhuma OS, ou com qualquer item ainda não entregue, não entram. `receita` no retorno de `dre()` passa a vir dessa query em vez da atual.

### 6. `fluxoCaixa()` — sem mudanças

Continua agrupando `contas_pagar` por `vencimento` — que já é exatamente a data de cada parcela paga separadamente. Com o parcelamento implementado (cada parcela = uma linha com seu próprio `vencimento`), o fluxo de caixa automaticamente já mostra a saída de caixa espalhada corretamente, sem precisar de nenhuma mudança nessa função.

## Testes

- `criarParcelado`: soma das parcelas bate com `valor_total` (incluindo ajuste de centavos); todas as parcelas compartilham `parcela_grupo_id` e `competencia`; `vencimento` incrementa um mês por parcela; erro se `parcelas < 2` ou campos obrigatórios faltando.
- `dre()`: despesa pendente (não paga) dentro da competência do período conta; despesa cancelada não conta; despesa paga fora da competência do período (competência em outro mês) não conta mesmo que `pago_em` caia dentro do período.
- `dre()` receita: orçamento com 2 OS, só uma entregue → não conta; as duas entregues em meses diferentes → conta no mês da última; orçamento sem nenhuma OS → não conta.

## Fora de escopo

- Tela dedicada de "ver parcelas de uma compra" (os campos `parcela_grupo_id`/`parcela_numero`/`parcela_total` já ficam prontos pra isso no futuro).
- Editar/cancelar uma compra parcelada inteira de uma vez (hoje cada parcela é editada/cancelada individualmente, como uma conta normal).
- Reclassificar competência de contas históricas além do backfill automático (`created_at`).
- Mudar como a receita de orçamentos com pagamento parcelado do cliente (boletos/parcelas do cliente, tabela `orcamento_boletos`) é tratada — esse spec cobre só o lado despesas/fornecedor.
