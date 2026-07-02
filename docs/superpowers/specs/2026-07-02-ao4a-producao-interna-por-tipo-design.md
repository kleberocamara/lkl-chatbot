# AO-4a — Produção Interna por Tipo de Serviço — Design

**Data:** 2026-07-02
**Status:** Aprovado para escrita de plano
**Contexto:** Após a automação do orçamento (AO-1/2/3), os itens de revenda gravam `tipo_producao='REVENDA'` e, por isso, **não geram OS** — nem os que a LKL produz internamente. Este sub-projeto faz os itens **internos** entrarem na produção; a **terceirização** dos itens de revenda pura é o AO-4b (separado).

## Objetivo

Fazer os itens produzidos internamente pela LKL (estratégia `interno_m2` e `manual`) gerarem OS pelo fluxo de produção **já existente** (offset ou comunicação visual), roteando pelo tipo de serviço. Os itens terceirizados (`revenda_matriz`, incluindo todos os IMP. DIGITAL) continuam fora da produção interna.

## Premissas e decisões (do brainstorming)

- **IMP. DIGITAL é sempre terceirizado** (serviço de baixa quantidade que não compensa em offset) → não tem produção interna; não precisa de fluxo novo. Todos os IMP. DIGITAL são `revenda_matriz`.
- **Só há dois fluxos internos** (`fluxoProducao.js`): `offset` (corte→impressão→acabamento→entrega) e `comunicacao_visual` (impressão→acabamento→entrega). Nenhum fluxo novo é necessário.
- **Distinção interno × terceirizado = `estrategia`** do produto de revenda: `interno_m2`/`manual` = interno; `revenda_matriz` = terceirizado.
- **Mesmo gate de arte:** item interno só gera OS depois da arte aprovada (igual aos itens CV/offset atuais).
- **Reuso total do módulo de OS:** as funções `criarOSComunicacaoVisual` (auto ao aprovar arte) e `itensOffsetDisponiveis`/`criarOSOffset` (manual) filtram por `orcamento_itens.tipo_producao IN ('OFFSET','COMUNICAÇÃO VISUAL')` + `arte_status='aprovada'`. Basta o item interno ter o `tipo_producao` correto — zero mudança em `os/service.js`.

## Arquitetura

Uma única mudança de comportamento, no ponto onde o item de revenda é gravado.

- **`src/constants/produtos.js`** (ou um util pequeno) — função pura `tipoProducaoDoItemRevenda(estrategia, tipo_servico)` que mapeia:
  - `interno_m2` → `'COMUNICAÇÃO VISUAL'`
  - `manual` → do `tipo_servico`: `'OFFSET'`→`'OFFSET'`, `'COMUNICAÇÃO VISUAL'`→`'COMUNICAÇÃO VISUAL'`, `'IMP. DIGITAL'`→`'REVENDA'` (segurança; não deveria ocorrer, IMP. DIGITAL é sempre revenda_matriz)
  - `revenda_matriz` (ou qualquer outra) → `'REVENDA'`
- **`src/modules/orcamentos/router.js`** — no POST/PATCH de item, quando `revenda_produto_id` está presente, gravar `tipo_producao = tipoProducaoDoItemRevenda(estrategia, tipo_servico)` (busca a estratégia/tipo do `revenda_produtos`), em vez do fixo `'REVENDA'` do AO-2b.
- **Módulo de OS:** inalterado (as criações de OS já pegam os itens com tipo OFFSET/CV).

## Fluxo de dados

1. Atendente adiciona um item de revenda `interno_m2` (ex.: adesivo por m²) ou `manual` interno (ex.: LETREIRO OFFSET) no orçamento.
2. O backend grava o item com `tipo_producao` = 'COMUNICAÇÃO VISUAL' ou 'OFFSET' (conforme a estratégia/tipo). O `revenda_produto_id` continua gravado (rastreabilidade).
3. Orçamento aprovado + arte do item aprovada → o fluxo existente cria/alimenta a OS:
   - CV → `criarOSComunicacaoVisual` (OS automática, tipo_servico `comunicacao_visual`).
   - OFFSET → item aparece em `itensOffsetDisponiveis`, agrupado manualmente por `criarOSOffset`.
4. Itens `revenda_matriz` mantêm `tipo_producao='REVENDA'` → não entram em nenhuma OS interna (AO-4b tratará a terceirização).

## Backfill

Itens de revenda internos já lançados em orçamentos **abertos** (não aprovados/cancelados) ficaram com `tipo_producao='REVENDA'`. Um UPDATE único corrige por estratégia:
```sql
UPDATE orcamento_itens oi
SET tipo_producao = CASE
  WHEN rp.estrategia = 'interno_m2' THEN 'COMUNICAÇÃO VISUAL'
  WHEN rp.estrategia = 'manual' AND rp.tipo_servico = 'OFFSET' THEN 'OFFSET'
  WHEN rp.estrategia = 'manual' AND rp.tipo_servico = 'COMUNICAÇÃO VISUAL' THEN 'COMUNICAÇÃO VISUAL'
  ELSE oi.tipo_producao END
FROM revenda_produtos rp
WHERE oi.revenda_produto_id = rp.id
  AND rp.estrategia IN ('interno_m2','manual')
  AND oi.tipo_producao = 'REVENDA';
```
> Só afeta itens ainda não em OS (os que já estão em produção não são de revenda). Roda uma vez no VPS.

## Erros e bordas

- Item `manual` com `tipo_servico` nulo/inesperado → `tipoProducaoDoItemRevenda` retorna `'REVENDA'` (fica fora da produção; seguro).
- Produto de revenda sem estratégia (não deveria após AO-3) → default `revenda_matriz` → `'REVENDA'`.
- Não altera itens não-revenda (in-house clássicos): eles já têm `tipo_producao` OFFSET/CV e seguem como hoje.

## Testes

- **Unitário (TDD)** `tests/produtos.test.js` (ou novo) — `tipoProducaoDoItemRevenda`:
  - `('interno_m2', 'COMUNICAÇÃO VISUAL')` → `'COMUNICAÇÃO VISUAL'`
  - `('interno_m2', 'OFFSET')` → `'COMUNICAÇÃO VISUAL'` (interno_m2 é sempre CV)
  - `('manual', 'OFFSET')` → `'OFFSET'`
  - `('manual', 'COMUNICAÇÃO VISUAL')` → `'COMUNICAÇÃO VISUAL'`
  - `('manual', 'IMP. DIGITAL')` → `'REVENDA'`
  - `('revenda_matriz', 'OFFSET')` → `'REVENDA'`
  - estratégia/tipo ausentes → `'REVENDA'`
- **Smoke VPS:** adicionar item `interno_m2` num orçamento, aprovar arte → OS CV nasce com o item; adicionar item `manual/OFFSET`, aprovar arte → aparece em `itensOffsetDisponiveis`; item `revenda_matriz` → não gera OS.

## Fora de escopo (AO-4a)

- **Terceirização dos `revenda_matriz`** (enviar arte ao Graficonauta, acompanhar pedido, receber) → **AO-4b**.
- **Baixa de estoque dos `interno_m2`:** usam `bobina_grupo` (não `materiais.material_id`), então a requisição/baixa de material desses itens não é calculada pelo fluxo atual (`baixarMateriais` da OS). Fica para um passo futuro (mapear consumo de bobina → estoque).
- Ficha de produção específica para itens de revenda internos além do que a OS CV/offset já oferece.

## Dependências

- AO-3 concluído (`revenda_produtos.estrategia`/`tipo_servico`). Nenhuma dependência externa. Próxima migration livre: 047 (só se o backfill for versionado como migration; pode rodar como comando único).
