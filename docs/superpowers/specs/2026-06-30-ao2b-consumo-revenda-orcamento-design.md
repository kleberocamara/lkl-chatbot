# AO-2b — Consumo do Catálogo de Revenda no Orçamento — Design

**Data:** 2026-06-30
**Status:** Aprovado para escrita de plano
**Sub-projeto:** AO-2b de 2 (AO-2a = robô + catálogo — CONCLUÍDO). Depende do catálogo populado por `revenda_produtos`/`revenda_precos`/`revenda_acabamentos`/`revenda_config`.

## Objetivo

Permitir precificar um item do orçamento a partir do catálogo de revenda sincronizado: o atendente escolhe um produto de revenda (pela nomenclatura do Graficonauta) num **combo unificado**, informa a tiragem e o prazo, marca acabamentos, e o preço é calculado automaticamente pela faixa de tiragem × prazo, com a **margem global** aplicada. Substitui, na prática, o placeholder `revenda` do AO-1.

## Premissas e decisões (do brainstorming)

- **Seleção:** combo de produto do item **unificado** — produtos internos (`PRODUTOS_LKL`) + produtos de revenda (nomenclatura Graficonauta, ex.: "Folheto 80g | 10x14cm | 4/0"). Escolher um de revenda coloca o item em **modo revenda**.
- **Faixa × quantidade:** menor faixa `>=` quantidade **no prazo escolhido**; quantidade menor que todas → usa a **menor** faixa; maior que todas → usa a **maior**. Nunca sub-precifica.
- **Preço:** `total = (preço_da_faixa + Σ acabamentos_selecionados) × (1 + markup_global/100)`. Margem incide sobre **tudo** (base + acabamentos).
- **`valor_unitario` = total / quantidade** (a célula da faixa já é o total da tiragem; não é unitário × quantidade).
- **Prazo:** default = `revenda_config.prazo_padrao_horas`; o atendente pode trocar por item (12/24/48h → recalcula).
- **Acabamentos:** selecionáveis por checkbox; somam ao preço (com margem).
- Reusa o gate/UX do AO-1: preço é **sugestão editável**; digitar valor manual vira `preco_origem='manual'`.

## Arquitetura

Unidades isoladas:
1. **`src/modules/revenda/pricer.js`** — função **pura** `calcularRevenda(ctx, opts)` (sem banco). 100% testável.
2. **`src/modules/revenda/service.js`** (estende o do AO-2a) — `precificarItemRevenda(...)` carrega faixas/acabamentos/config e chama o pricer.
3. **`src/modules/revenda/router.js`** (estende) — `POST /preview` de revenda.
4. **`src/modules/orcamentos/router.js`** — POST/PATCH de item aceitam campos de revenda e gravam.
5. **`public/dashboard.html`** — combo unificado + modo revenda no form de item.

## Modelo de dados (migration 045)

```sql
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS revenda_produto_id UUID REFERENCES revenda_produtos(id) ON DELETE SET NULL;
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS revenda_prazo_horas INTEGER;
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS revenda_acabamentos JSONB DEFAULT '[]'::jsonb;
```

> **ATENÇÃO:** `orcamento_itens` pertence ao user `postgres` — rodar via `sudo -u postgres psql`. Próxima migration livre: **045**.
> `revenda_acabamentos` guarda o snapshot do que foi escolhido: `[{ "nome": "1 Corte Extra", "preco": 3.00 }]` (preço no momento, para o orçamento não mudar se o catálogo mudar).
> `tipo_producao` do item = `'REVENDA'` quando `revenda_produto_id` está preenchido.

## Precificador (`pricer.js`) — função pura

`calcularRevenda(ctx, opts) → { valor_unitario, valor_total, memoria, faixa_usada } | null`
- `ctx = { faixas: [{quantidade, prazo_horas, preco_total}], acabamentos: [{nome, preco}], markup_percent }`
- `opts = { quantidade, prazo_horas, selecionados: [nomes] }`

Regra:
```
qtd = quantidade > 0 ? quantidade : 1
faixasDoPrazo = ctx.faixas.filter(prazo_horas === opts.prazo_horas).sort(por quantidade asc)
se vazio → null (produto sem preço nesse prazo)
faixa = primeira com quantidade >= qtd
        ?? maior faixa (se qtd acima de todas)
        (se qtd abaixo de todas, a "primeira >= qtd" já é a menor)
base = faixa.preco_total
acab = soma de ctx.acabamentos.filter(nome ∈ selecionados).preco
subtotal = base + acab
total = round2(subtotal × (1 + markup_percent/100))
valor_unitario = round2(total / qtd)
memoria = "Faixa {faixa.quantidade}un/{prazo}h R$ {base}" + (acab? " + acab R$ {acab}":"") + " ×(1+{markup}%) = R$ {total} (un R$ {valor_unitario})"
retorna { valor_unitario, valor_total: total, memoria, faixa_usada: faixa.quantidade }
```

Casos de borda cobertos por teste: faixa exata; próxima acima; abaixo da mínima (usa a menor); acima da máxima (usa a maior); com/sem acabamentos; markup 0; prazo sem faixas → null.

## Serviço + API

`precificarItemRevenda(revenda_produto_id, quantidade, prazo_horas, selecionados)` (em `revenda/service.js`):
- Carrega `revenda_precos` do produto, `revenda_acabamentos`, e `revenda_config` (markup + prazo padrão).
- `prazo_horas` ausente → usa `prazo_padrao_horas`.
- Chama `calcularRevenda` e devolve `{ valor_unitario, valor_total, memoria }` ou `null`.

Rota: `POST /api/v2/revenda/preview` `{ revenda_produto_id, quantidade, prazo_horas, acabamentos }` → `{ auto:true, valor_unitario, valor_total, memoria }` ou `{ auto:false }`. Leitura para qualquer role autenticada.

## Integração no orçamento (`orcamentos/router.js`)

POST e PATCH de item aceitam: `revenda_produto_id`, `revenda_prazo_horas`, `revenda_acabamentos` (array de `{nome,preco}`).
- Se `revenda_produto_id` veio e não há valor explícito (ou `recalcular`): chama `precificarItemRevenda`, grava `valor_unitario/valor_total`, `preco_origem='auto'`, `preco_memoria`, `tipo_producao='REVENDA'`, e persiste `revenda_produto_id/revenda_prazo_horas/revenda_acabamentos`.
- Valor explícito digitado → respeita, `preco_origem='manual'` (mantém os campos de revenda para rastreio).
- Itens **não-revenda** seguem pelo caminho do AO-1 (precificação por `regras_preco`), inalterados.

Total do orçamento continua `SUM(valor_total)`. Trava por status preservada.

## UI (`public/dashboard.html`)

- **Combo unificado:** o form de item carrega o catálogo (`GET /api/v2/revenda/produtos`) e mescla no `selectProduto` as entradas de revenda, rotuladas (ex.: `🛰️ Folheto 80g | 10x14cm | 4/0 [flt001]`, `value` = `revenda:<id>`).
- **Modo revenda:** ao selecionar uma entrada `revenda:*`, esconde os campos de m²/material e mostra: **Tiragem** (usa o campo quantidade), **Prazo** (select 12/24/48, default da config), **Acabamentos** (checkboxes vindos do produto). Um botão/al­teração dispara `POST /revenda/preview` e auto-preenche o valor + memória.
- No **salvar item**, envia `revenda_produto_id`, `revenda_prazo_horas`, `revenda_acabamentos`. A lista de itens marca os de revenda (selo 🛰️).

## Testes

- **Unitários (TDD)** `tests/revenda-pricer.test.js` — todos os casos de borda do `calcularRevenda` (números reais do catálogo, ex.: flt001 2.500un/24h = R$74,00; markup 40% → R$103,60; +Corte Extra R$3 → (74+3)×1,4=R$107,80).
- **Smoke E2E no VPS:** cadastra config markup, chama `precificarItemRevenda` para flt001 com quantidade 1.000 (→ usa faixa 2.500) e confere valor + memória; adiciona item de revenda via API e confere `valor_total`/`preco_origem='auto'`.

## Fora de escopo (AO-2b)

- **OS/produção do item de revenda** (terceirizado no Graficonauta) — fluxo de compra/OS externa fica para depois.
- Fazer o pedido no Graficonauta automaticamente.
- Drop do `precos_revenda`/método `revenda` legado do AO-1 (fica órfão, inofensivo).

## Dependências

- Catálogo de revenda populado (AO-2a) e `revenda_config` com markup configurado. Nenhuma dependência externa nova.
