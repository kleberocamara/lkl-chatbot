# AO-3 — Aplicar as Condições Revisadas do Catálogo — Design

**Data:** 2026-07-01
**Status:** Aprovado para escrita de plano
**Contexto:** Fecha o ciclo de automação do orçamento (AO-1 tabela/manual, AO-2a robô+catálogo, AO-2b consumo no orçamento). Aplica a revisão do usuário sobre o catálogo (planilha `Revisao_Catalogo_Revenda_LKL.xlsx`).

## Objetivo

Fazer cada produto do catálogo padronizado precificar conforme a **condição revisada** pelo usuário: manter o preço de revenda por tiragem, calcular por **m² interno da LKL** (adesivo/lona), ou ficar manual — além de guardar o **tipo de serviço** (OFFSET/CV/IMP. DIGITAL) de cada item e cadastrar os produtos internos que não existem no Graficonauta.

## Premissas e decisões (do brainstorming + planilha)

- **Revisão do usuário (336 itens):**
  - **278 → "manter auto"** = `revenda_matriz` (tiragem × prazo, já funciona).
  - **42 CV → "regra interna LKL"** = `interno_m2` (m² por bobina, motor do AO-1).
  - **16 → "manual"** = produtos internos `lkl01`–`lkl16` (BLOCK LETTER, CATÁLOGO, ENVELOPAMENTO, FOLDER, ILUMINAÇÃO, JORNAL, LETREIRO, LIVROS, PAINEL, PAINEL ACM, TALÃO PEDIDOS, RECORTE ELETRÔNICO, REVISTA, ROUTER, SINALIZAÇÃO, TAG) — **não existem no site**.
- **Tipo de serviço** (coluna H): OFFSET / COMUNICAÇÃO VISUAL / IMP. DIGITAL — por produto.
- **m² interno** (confirmado): reaproveita o método `m2_bobina` do AO-1, escolhendo a bobina de menor desperdício.
  - **Adesivo:** bobinas **1,06 / 1,27 / 1,50 m**, **R$30/m²**.
  - **Lona:** bobinas **1,60 / 2,20 / 3,20 m**, **R$30/m²**.
  - **R$30/m² é o preço FINAL de venda** (sem margem adicional).
- **6 categorias vazias já removidas** do banco (Adesivo Blackout dup, Adesivo Retroverso, Cartão 350g Hotstamp, Cartão PVC, Móbile PVC, Vinil Retroverso). Sobraram 51 categorias / ~320 produtos.
- **Catálogo = lista única padronizada.** A `estrategia` decide a precificação; a nomenclatura vem do Graficonauta (ou LKL, para os internos).

## Arquitetura

Reaproveita o máximo do AO-1/AO-2b. Unidades:
1. **`src/modules/revenda/pricer.js`** (estende) — `calcularInternoM2(ctx, item)` (puro): usa `escolherBobina` do AO-1 (via `src/modules/precificacao/engine.js`) e `preco_m2`. 100% testável.
2. **`src/modules/revenda/service.js`** — `precificarItemRevenda` passa a **despachar por `estrategia`**.
3. **`scripts/revenda-importar-revisao.js`** — importa a planilha (por Ref): grava `tipo_servico` + `estrategia` + `bobina_grupo`, cria os 16 internos.
4. **`public/dashboard.html`** — modo do item por estratégia (tiragem/prazo · m²/dimensão · manual).

## Modelo de dados (migration 046)

```sql
ALTER TABLE revenda_produtos ADD COLUMN IF NOT EXISTS tipo_servico  VARCHAR(30);   -- OFFSET | COMUNICAÇÃO VISUAL | IMP. DIGITAL
ALTER TABLE revenda_produtos ADD COLUMN IF NOT EXISTS estrategia    VARCHAR(20) NOT NULL DEFAULT 'revenda_matriz'
  CHECK (estrategia IN ('revenda_matriz','interno_m2','manual'));
ALTER TABLE revenda_produtos ADD COLUMN IF NOT EXISTS bobina_grupo  VARCHAR(20);   -- 'adesivo' | 'lona' | NULL (só interno_m2)
ALTER TABLE revenda_produtos ADD COLUMN IF NOT EXISTS preco_m2      NUMERIC(12,4); -- R$/m² (interno_m2)
ALTER TABLE revenda_produtos ADD COLUMN IF NOT EXISTS espaco_corte_cm NUMERIC(6,2) DEFAULT 0;

-- Larguras de bobina por grupo (reuso da lógica melhor-bobina do AO-1)
CREATE TABLE IF NOT EXISTS revenda_bobina_grupos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grupo       VARCHAR(20) NOT NULL,     -- 'adesivo' | 'lona'
  largura_cm  NUMERIC(8,2) NOT NULL,
  ativo       BOOLEAN DEFAULT TRUE,
  UNIQUE (grupo, largura_cm)
);
INSERT INTO revenda_bobina_grupos (grupo, largura_cm) VALUES
  ('adesivo',106),('adesivo',127),('adesivo',150),
  ('lona',160),('lona',220),('lona',320)
ON CONFLICT (grupo, largura_cm) DO NOTHING;

-- Flag para o robô de sync ignorar categorias internas (sem URL do Graficonauta)
ALTER TABLE revenda_categorias ADD COLUMN IF NOT EXISTS sincronizavel BOOLEAN DEFAULT TRUE;
```

> `revenda_produtos` pertence a `lkl_user` (criada na 044) → `ALTER` roda normal como `lkl_user`. Próxima migration livre: **046**.
> Os 16 internos são inseridos numa `revenda_categorias` nova "LKL — Interno" (url vazia/placeholder, para não entrar na sincronização), com `ref` lkl01–lkl16, `estrategia='manual'`, `tipo_servico` da planilha, `ativo=true`. O robô de sync ignora essa categoria (url placeholder → 0 produtos; ou marcar um flag — ver "sync" abaixo).

## Precificação por estratégia

`precificarItemRevenda(...)` (service) despacha:
- **`revenda_matriz`** → como hoje (faixa × prazo × markup) via `pricer.calcularRevenda`.
- **`interno_m2`** → `pricer.calcularInternoM2`: carrega `revenda_bobina_grupos` do `bobina_grupo` do produto; `engine.escolherBobina(largura_arte, espaco_corte_cm, bobinas)` (AO-1) escolhe a bobina; `area_cobrada = (largura_util/100)×(altura/100)`; `valor_unitario = area_cobrada × preco_m2`; `valor_total = valor_unitario × qtd`. Sem margem. Precisa de `largura_cm/altura_cm` no item (senão → null/manual).
- **`manual`** → retorna `null` (atendente digita).

`calcularInternoM2(ctx, item)` é **função pura** (ctx = `{ bobinas:[{largura_cm}], preco_m2, espaco_corte_cm }`, item = `{ largura_cm, altura_cm, quantidade }`), reaproveitando `escolherBobina` do engine do AO-1. Testável.

## Integração no orçamento

O item de revenda já grava `revenda_produto_id` (AO-2b). Ao precificar:
- Se o produto tem `estrategia='interno_m2'`, o preview/gravação usa as **dimensões** do item (largura/altura) — que o item do orçamento já suporta (`largura_cm`/`altura_cm`).
- `estrategia='manual'` → sem auto-preço.
- `estrategia='revenda_matriz'` → tiragem/prazo (AO-2b).
`POST /api/v2/revenda/preview` passa a aceitar `largura_cm`/`altura_cm` e despachar por estratégia.

## UI (modo por estratégia no item)

Ao escolher um produto do catálogo (`revenda:<id>`), o front lê a `estrategia` do produto (já vem em `GET /revenda/produtos`) e mostra:
- **revenda_matriz:** tiragem + prazo + acabamentos (como no AO-2b).
- **interno_m2:** largura + altura (cm); calcula por m² e auto-preenche. Mostra a bobina escolhida na memória.
- **manual:** só o campo de valor (sem controles extras).

## Importação da planilha (`scripts/revenda-importar-revisao.js`)

Lê `Revisao_Catalogo_Revenda_LKL.xlsx` (aba "Catálogo (revisão)"), por **Ref**:
- Mapeia condição (col G) → `estrategia`: "→ manter auto" = `revenda_matriz`; "→ regra interna LKL" = `interno_m2`; "→ manual" = `manual`.
- Grava `tipo_servico` (col H).
- Para `interno_m2`: define `preco_m2=30`, `bobina_grupo` = `adesivo` se o nome contém "adesivo/vinil/kraft…", `lona` se contém "lona" (heurística por nome; **relatório de conferência** ao final para o usuário corrigir manualmente os divergentes).
- Cria os 16 internos (refs lkl01–lkl16) na categoria "LKL — Interno" com `estrategia='manual'` + `tipo_servico`.
- Idempotente (upsert por ref). Roda no VPS (onde está o banco).

## Sync × produtos internos

O robô de sync (AO-2a) itera categorias ativas. A categoria "LKL — Interno" tem URL placeholder → `parseListaProdutos` retorna 0 e a lógica de "inativar não-vistos" **desativaria** os lkl. Ajuste: o sync **pula categorias sem URL http válida** (ou com flag `sincronizavel=false`). Migration adiciona `revenda_categorias.sincronizavel BOOLEAN DEFAULT TRUE`; a categoria interna entra com `false`; o job filtra `WHERE ativo AND sincronizavel AND url ILIKE 'http%'`.

## Testes

- **Unitário (TDD)** `tests/revenda-pricer.test.js` (estende): `calcularInternoM2` — adesivo arte 1,00m → bobina 1,06m (melhor), área × 30; lona arte 2,00m → bobina 2,20m; escolha de menor desperdício; dimensão ausente → null; folga de corte.
- **Smoke VPS:** importar a planilha; conferir contagem por estratégia (≈278/42/16) e tipo_servico; `precificarItemRevenda` de um interno_m2 (ex.: adesivo 1,00×2,00m) retorna preço por m² coerente; um `manual` retorna null.

## Fora de escopo (AO-3)

- **Roteamento da OS por tipo_servico** (produção) — `tipo_servico` só é armazenado agora.
- Margem sobre o m² interno (R$30 é final).
- Reprecificar itens de orçamentos já existentes.

## Dependências

- Planilha `Revisao_Catalogo_Revenda_LKL.xlsx` no VPS (upload) para o import.
- Catálogo populado (AO-2a) + AO-2b em produção. Nenhuma dependência externa nova.
