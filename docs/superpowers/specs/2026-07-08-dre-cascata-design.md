# DRE em cascata (análise vertical) — Análises Gerenciais

## Contexto

A DRE atual (`src/modules/analises/service.js`'s `dre()`) devolve só `receita`, uma lista plana de despesas agrupadas por `categoria_dre`, e `resultado = receita - total_despesas`. Não existe estrutura de cascata (subtotais como Margem de Contribuição, Lucro Bruto, EBITDA), e a receita nunca é deduzida de impostos/comissões antes de virar "resultado".

A tabela `tipos_despesa` (migration 051) já carrega tanto `categoria_dre` quanto `natureza` (VARIÁVEL/FIXO/RESULTADO FINANCEIRO/NÃO OPERACIONAL) para as 38 categorias de despesa — dado suficiente para montar a cascata completa sem precisar de nova coluna ou migration. Não existe nenhuma coluna de imposto sobre lucro (IRPJ/CSLL) no sistema — só "DEDUÇÕES DE VENDAS" (imposto sobre faturamento), lançado manualmente como conta a pagar.

## Escopo

- Reestruturar `dre()` para devolver uma cascata com 12 linhas (bruta → líquida → margem de contribuição → lucro bruto → EBITDA → lucro líquido), cada uma com valor e percentual sobre a Receita Bruta.
- Cada linha de dedução (não-subtotal) carrega um `detalhamento` por `categoria_dre` que a compõe, cada item também com valor e percentual.
- Reescrever a UI da DRE em `public/dashboard.html`: KPI cards atualizados, cascata expansível por clique.
- **Fora de escopo**: Fluxo de Caixa (tratado como projeto separado, incluindo o bug do "atrasado" já identificado). Cálculo automático de imposto sobre faturamento ou sobre lucro (fica manual/zerado). Comparação com mês anterior.

## Design técnico

### 1. Mapeamento categoria_dre → linha da cascata

```
RECEITA BRUTA DE VENDAS        = SUM(orcamentos.total) [igual a hoje — competência por entrega]
(−) DEDUÇÕES DE VENDAS          = categoria_dre = 'DEDUÇÕES DE VENDAS'
= RECEITA LÍQUIDA DE VENDAS
(−) CUSTOS DE PRODUÇÃO (CPV)    = categoria_dre = 'CUSTOS DE PRODUÇÃO (CPV)'
(−) DEDUÇÕES E DESPESAS COMERCIAIS = categoria_dre = 'DEDUÇÕES E DESPESAS COMERCIAIS'
= MARGEM DE CONTRIBUIÇÃO BRUTA
(−) CUSTOS FIXOS DE PRODUÇÃO    = categoria_dre IN ('MÃO DE OBRA DIRETA (MOD)', 'CUSTOS OPERACIONAIS DA FÁBRICA')
= LUCRO BRUTO
(−) DESPESAS OPERACIONAIS       = categoria_dre IN ('OCUPAÇÃO E INFRAESTRUTURA', 'PESSOAL E ADMINISTRAÇÃO',
                                    'SERVIÇOS PROFISSIONAIS', 'SEGUROS', 'LOGÍSTICA E DESLOCAMENTO',
                                    'VIAGENS E REPRESENTAÇÃO', 'OUTROS')
= EBITDA / LAJIDA
(−) RESULTADO FINANCEIRO        = categoria_dre = 'DESPESAS FINANCEIRAS'
(−) IMPOSTOS SOBRE O LUCRO      = 0 (fixo — não há dado no sistema; reavaliar quando/se confirmado que incide)
= LUCRO LÍQUIDO DO PERÍODO
```

Todas as despesas continuam vindo de `contas_pagar` filtradas por `status != 'cancelado' AND competencia BETWEEN inicio AND fim` (mesma query base de hoje, só trocando o `GROUP BY` único por um mapeamento em memória depois de uma única query agrupada por `categoria_dre`).

### 2. Percentual (análise vertical)

Toda linha (subtotal, dedução ou item de detalhamento) carrega um `percentual = valor / receita_bruta * 100`, arredondado a 1 casa decimal. Receita Bruta é a base fixa (100%) para todas as linhas abaixo dela — é a convenção mais comum de análise vertical e evita que o "100%" mude dependendo de qual subtotal está sendo olhado. Se `receita_bruta` for 0 (período sem receita), todos os percentuais retornam `0` em vez de `Infinity`/`NaN`.

### 3. Forma do retorno de `dre()`

```js
{
  periodo: { inicio, fim },
  linhas: [
    { id: 'receita_bruta', label: 'Receita Bruta de Vendas', valor, percentual, tipo: 'base' },
    { id: 'deducoes_vendas', label: 'Deduções de Vendas', valor, percentual, tipo: 'deducao',
      detalhamento: [{ categoria, valor, percentual }, ...] },
    { id: 'receita_liquida', label: 'Receita Líquida de Vendas', valor, percentual, tipo: 'subtotal' },
    { id: 'cpv', label: 'Custos de Produção (CPV)', valor, percentual, tipo: 'deducao', detalhamento: [...] },
    { id: 'despesas_comerciais', label: 'Deduções e Despesas Comerciais', valor, percentual, tipo: 'deducao', detalhamento: [...] },
    { id: 'margem_contribuicao', label: 'Margem de Contribuição Bruta', valor, percentual, tipo: 'subtotal' },
    { id: 'custos_fixos_producao', label: 'Custos Fixos de Produção', valor, percentual, tipo: 'deducao', detalhamento: [...] },
    { id: 'lucro_bruto', label: 'Lucro Bruto', valor, percentual, tipo: 'subtotal' },
    { id: 'despesas_operacionais', label: 'Despesas Operacionais', valor, percentual, tipo: 'deducao', detalhamento: [...] },
    { id: 'ebitda', label: 'EBITDA / LAJIDA', valor, percentual, tipo: 'subtotal' },
    { id: 'resultado_financeiro', label: 'Resultado Financeiro', valor, percentual, tipo: 'deducao', detalhamento: [...] },
    { id: 'impostos_lucro', label: 'Impostos sobre o Lucro', valor: 0, percentual: 0, tipo: 'deducao' },
    { id: 'lucro_liquido', label: 'Lucro Líquido do Período', valor, percentual, tipo: 'final' },
  ],
  margem_liquida: lucro_liquido / receita_liquida (0 se receita_liquida for 0),
}
```

`detalhamento` só existe em linhas `tipo: 'deducao'` que tiverem pelo menos uma categoria com valor lançado no período (linhas sem lançamento não aparecem no array, igual ao comportamento atual da lista plana). `valor` de despesa é sempre negativo no array (visualmente já "descontado"); os subtotais/final são a soma corrida.

### 4. Frontend — `public/dashboard.html`

- `renderDre()` reescrito para consumir `linhas` e montar a cascata: cada linha é uma div com label à esquerda, percentual e valor à direita (duas colunas de número: `%` e `R$`). Linhas `tipo: 'subtotal'`/`'final'` recebem destaque visual (fundo `var(--surface-1)`/verde para o final, negrito) — igual ao mockup aprovado. Linhas `tipo: 'deducao'` com `detalhamento` mostram um ícone de expandir e, ao clicar, abrem uma sublista indentada com cada `categoria`/`valor`/`percentual`.
- KPI cards (`dre-kpis`) trocam de Receita/Despesas/Resultado/Margem para: Receita Líquida, Margem de Contribuição, EBITDA, Lucro Líquido (com `margem_liquida` como percentual auxiliar no card de Lucro Líquido).
- Formatação de moeda/percentual reaproveita os helpers já existentes no arquivo (`toLocaleString('pt-BR')`).
- Seletor de período (`dre-ini`/`dre-fim`, `drePeriodo()`/`dreAplicar()`) não muda.

## Testes

- `dre()`: teste unitário com `contas_pagar`/`orcamentos` mockados cobrindo: (a) cascata completa com valores em cada categoria — confirma que cada subtotal soma certo (ex: `margem_contribuicao = receita_liquida + cpv + despesas_comerciais`, lembrando que os valores de dedução são negativos); (b) período sem nenhuma despesa numa categoria → aquela linha não aparece com detalhamento mas a linha-mãe aparece com valor 0; (c) `receita_bruta = 0` → todos os percentuais retornam 0, sem erro de divisão; (d) `impostos_lucro` sempre 0.
- Sem teste automatizado de UI (mesmo padrão do resto do projeto) — verificação por parse check (`new Function`) + smoke manual comparando com o mockup aprovado.

## Fora de escopo

- Fluxo de Caixa (spec separado).
- Cálculo automático de impostos (sobre faturamento ou sobre lucro).
- Comparação com mês anterior / período anterior.
- Mudar `metaMes()` (usa base de receita diferente — por `aprovado_em` — e não faz parte desta cascata).
