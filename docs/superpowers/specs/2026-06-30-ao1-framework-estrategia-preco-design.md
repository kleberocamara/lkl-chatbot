# AO-1 — Framework de Estratégia de Preço (Automação do Orçamento) — Design

**Data:** 2026-06-30
**Status:** Aprovado para escrita de plano
**Sub-projeto:** AO-1 de 2 (AO-2 = robô de sincronização da revenda, brainstorm posterior com prints/URL do site)

## Objetivo

Calcular automaticamente o preço de cada item do orçamento conforme uma **estratégia de preço por produto**, eliminando a digitação manual onde há regra cadastrada. Cada produto pode ser precificado por: tabela (vários métodos de cálculo), manual (como hoje) ou revenda (preço externo sincronizado — alimentado pelo AO-2).

## Premissas e contexto

- Hoje o item do orçamento (`orcamento_itens`) tem `valor_unitario`/`valor_total` **digitados manualmente**. O total do orçamento é `SUM(valor_total)` dos itens.
- `orcamento_itens` já possui: `produto`, `especificacao`, `tipo_producao`, `largura_cm`, `altura_cm`, `material_id`, `quantidade`.
- `materiais` possui `id`, `codigo`, `nome`, `unidade`, `custo_medio` — **não** tem largura de bobina.
- `price_table` existente (produto/acabamento/faixa) **não** é reaproveitado pelo motor novo; permanece intocado para não quebrar nada. O AO-1 introduz `regras_preco` como fonte canônica das regras.
- Lista canônica de produtos: `src/constants/produtos.js` (PRODUTOS) + `PRODUTOS_LKL` no front. O campo de junção das regras é `orcamento_itens.produto` (string).
- Migrations ficam em `sql/migrations/`. Próxima livre: **043**.
- CV é precificado por m²; a maioria por área simples, mas alguns sofrem **perda pela largura da bobina** (escolher a bobina mais econômica). Offset/outros podem ser `faixa`, `fixo` ou `manual`.
- O preço calculado é **sugestão editável**: o atendente pode sobrescrever (vira `manual`).

## Arquitetura

Um **motor de precificação** (funções puras) que, dado a regra do produto e o item, devolve `{ valor_unitario, valor_total, memoria }`. O serviço de orçamentos chama o motor ao criar/editar item e auto-preenche o valor, guardando a origem (`auto`/`manual`) e a memória de cálculo. Produtos sem regra ativa permanecem manuais.

Unidades isoladas:
- **`src/modules/precificacao/engine.js`** — funções puras por método (`fixo`, `m2`, `m2_bobina`, `faixa`, `revenda`). Sem acesso a banco; recebe dados já carregados. 100% testável.
- **`src/modules/precificacao/service.js`** — carrega a regra ativa do produto (+ faixas, + bobinas do material, + preço de revenda) e chama o engine. Expõe `precificarItem(item)`.
- **`src/modules/precificacao/router.js`** — CRUD de `regras_preco`/faixas/bobinas (admin/gestor) + endpoint de preview de cálculo.
- Integração em **`src/modules/orcamentos/service.js`** (adicionar/editar item).
- UI em **`public/dashboard.html`** (aba Preços).

## Modelo de dados (migration 043)

```sql
-- Regra de preço por produto (opcionalmente por material)
CREATE TABLE regras_preco (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto         VARCHAR(150) NOT NULL,
  material_id     UUID REFERENCES materiais(id) ON DELETE SET NULL, -- NULL = qualquer material
  metodo_calculo  VARCHAR(20) NOT NULL
                  CHECK (metodo_calculo IN ('manual','fixo','m2','m2_bobina','faixa','revenda')),
  preco_base      NUMERIC(12,4),        -- R$/m² (m2/m2_bobina), R$/un (fixo); NULL p/ faixa/revenda/manual
  m2_minimo       NUMERIC(10,4),        -- área mínima cobrada (m²); NULL = sem mínimo
  ativo           BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
-- Apenas uma regra ativa por (produto, material_id). material_id NULL é o "default" do produto.
CREATE UNIQUE INDEX uq_regras_preco_ativa
  ON regras_preco (produto, COALESCE(material_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE ativo;

-- Faixas de quantidade (método 'faixa')
CREATE TABLE regras_preco_faixa (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  regra_id        UUID NOT NULL REFERENCES regras_preco(id) ON DELETE CASCADE,
  qtd_min         INTEGER NOT NULL DEFAULT 1,
  qtd_max         INTEGER,              -- NULL = sem teto
  preco_unitario  NUMERIC(12,4) NOT NULL
);
CREATE INDEX idx_regras_preco_faixa_regra ON regras_preco_faixa(regra_id);

-- Larguras de bobina por material (método 'm2_bobina')
CREATE TABLE material_bobinas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id     UUID NOT NULL REFERENCES materiais(id) ON DELETE CASCADE,
  largura_cm      NUMERIC(8,2) NOT NULL,
  ativo           BOOLEAN DEFAULT TRUE
);
CREATE INDEX idx_material_bobinas_material ON material_bobinas(material_id);

-- Espelho de preços da revenda (preenchido pelo AO-2; criado VAZIO aqui)
CREATE TABLE precos_revenda (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto         VARCHAR(150) NOT NULL,
  opcoes          JSONB DEFAULT '{}'::jsonb,  -- variações (tamanho/papel/qtd) que diferenciam o preço
  preco_unitario  NUMERIC(12,4) NOT NULL,
  sincronizado_em TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_precos_revenda_produto ON precos_revenda(produto);

-- Origem e memória do preço no item do orçamento
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS preco_origem  VARCHAR(10) DEFAULT 'manual'; -- 'auto' | 'manual'
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS preco_memoria TEXT;
```

> **ATENÇÃO migrations:** `orcamento_itens` pertence ao user `postgres`, não `lkl_user`. O `ALTER TABLE orcamento_itens` precisa rodar via `sudo -u postgres psql` (padrão já registrado nos sprints anteriores).

A "fonte de preço" do produto **é** o `metodo_calculo` da regra ativa. Sem regra ativa → comportamento manual.

## Motor de cálculo (`engine.js`) — funções puras

Assinatura: `calcularItem(regra, item, ctx) → { valor_unitario, valor_total, memoria }`
onde `item = { quantidade, largura_cm, altura_cm }` e `ctx = { faixas, bobinas, precoRevenda }`.

Regras gerais:
- Dimensões em cm → m dividindo por 100. Área em m² = `(largura_cm/100) × (altura_cm/100)`.
- Arredondamento monetário: `valor_unitario` e `valor_total` com 2 casas (`Math.round(x*100)/100`).
- `quantidade` ausente/inválida → trata como 1.

### método `fixo`
```
vu = preco_base
vt = vu × quantidade
memoria = "R$ {preco_base}/un × {qtd} = R$ {vt}"
```

### método `m2`
```
area = (largura_cm/100) × (altura_cm/100)
if m2_minimo: area = max(area, m2_minimo)
vu = area × preco_base
vt = vu × quantidade
memoria = "{largura}m × {altura}m = {area}m² × R$ {preco_base}/m² = R$ {vu}/un × {qtd} = R$ {vt}"
```
Se `largura_cm` ou `altura_cm` ausentes → não calcula (retorna `null`, item fica manual).

### método `m2_bobina`
Escolhe, entre as bobinas ativas do material (`ctx.bobinas`), a **mais econômica** para a largura da arte, considerando quantos itens cabem lado a lado na largura da bobina (mesma lógica de aproveitamento do módulo `formatos`/melhor-corte):

```
para cada bobina B com largura_cm = Lb (Lb >= largura_arte):
    n_por_largura = floor(Lb / largura_arte)         # itens lado a lado
    largura_util_por_item = Lb / n_por_largura        # largura "imputada" a cada item
    desperdicio = (Lb - n_por_largura*largura_arte) / Lb
escolhe a bobina que MINIMIZA largura_util_por_item (menor custo por item).
Bobinas com Lb < largura_arte são descartadas.

area_cobrada = (largura_util_por_item/100) × (altura_cm/100)
vu = area_cobrada × preco_base
vt = vu × quantidade
memoria = "Bobina {Lb}m ({n_por_largura} por largura) → {largura_util_por_item}m × {altura}m = {area_cobrada}m² × R$ {preco_base}/m² = R$ {vu}/un × {qtd} = R$ {vt}"
```
Sem bobinas cadastradas que comportem a arte, OU dimensões ausentes → não calcula (item fica manual).

> Premissa: a perda é só na **largura** (a altura é sob demanda na bobina, sem perda no comprimento). Margem de refile não é considerada no AO-1 (ajustar em caso real, como no melhor-corte).

### método `faixa`
```
acha a faixa em ctx.faixas onde qtd_min <= quantidade <= (qtd_max ?? +inf)
vu = faixa.preco_unitario
vt = vu × quantidade
memoria = "Faixa {qtd_min}–{qtd_max}: R$ {vu}/un × {qtd} = R$ {vt}"
```
Sem faixa correspondente → não calcula (item fica manual).

### método `revenda`
```
ctx.precoRevenda = melhor correspondência em precos_revenda por (produto[, opcoes])
vu = precoRevenda.preco_unitario
vt = vu × quantidade
memoria = "Revenda (sinc. {sincronizado_em}): R$ {vu}/un × {qtd} = R$ {vt}"
```
Sem preço de revenda (tabela ainda vazia, antes do AO-2) → não calcula (item fica manual).

### método `manual`
Retorna `null` — o item mantém o valor digitado.

## Integração no orçamento (`orcamentos/service.js`)

No **adicionar item** e **editar item**:
1. Se a regra do produto existe e o motor retorna valor:
   - Se o usuário **não** enviou `valor_unitario`/`valor_total` (ou enviou flag `recalcular=true`): grava o calculado, `preco_origem='auto'`, `preco_memoria=<memoria>`.
   - Se o usuário **enviou** valor explícito: respeita, `preco_origem='manual'`, `preco_memoria=NULL`.
2. Se não há regra ou o motor retorna `null`: comportamento atual (manual).
3. O total do orçamento continua sendo recalculado por `SUM(valor_total)` (já existe).

Trava por status preservada: orçamento aprovado/cancelado não recalcula (já bloqueado hoje).

## API

`src/modules/precificacao/router.js`, montado em `/api/v2/precificacao`:
- `GET    /regras` — lista regras (admin/gestor).
- `POST   /regras` — cria regra (admin/gestor).
- `PUT    /regras/:id` — atualiza regra (admin/gestor).
- `GET    /regras/:id/faixas` · `POST /regras/:id/faixas` · `DELETE /faixas/:id` — faixas.
- `GET    /materiais/:id/bobinas` · `POST /materiais/:id/bobinas` · `DELETE /bobinas/:id` — bobinas.
- `POST   /preview` — `{ produto, material_id, quantidade, largura_cm, altura_cm }` → `{ valor_unitario, valor_total, memoria, metodo }` (preview sem gravar; leitura para qualquer role autenticada).

Auth: cookie-session (`api(path,{method,body:JSON.stringify})`), padrão do dashboard. Escrita admin/gestor via `requireRole`.

## UI (`public/dashboard.html`, aba Preços)

- Sub-aba "Regras de preço": lista por produto com método e preço base; modal de criar/editar (select de método; campos condicionais: `preco_base` para fixo/m2/m2_bobina; faixas para faixa; nota "alimentado pela revenda" para revenda).
- Sub-aba "Bobinas por material": cadastro das larguras de bobina por material.
- No **adicionar/editar item do orçamento**: após escolher produto + dimensões + material + quantidade, chama `POST /precificacao/preview` e auto-preenche o campo de valor com tooltip mostrando a `memoria`. Campo continua editável (editar manualmente marca origem manual). Botão "🔄 recalcular".

## Testes

- **Unitários (TDD)** em `tests/precificacao.test.js` — um bloco por método do engine:
  - `fixo`: preço × qtd.
  - `m2`: área simples + aplicação de `m2_minimo`.
  - `m2_bobina`: escolha da bobina mais econômica (ex.: arte 0,50m com bobinas 1,52m e 1,10m → escolhe a que dá menor largura imputada; arte 1,20m com bobina 1,10m e 1,52m → descarta 1,10 e usa 1,52), dimensão ausente → null.
  - `faixa`: seleção da faixa por quantidade; fora de faixa → null.
  - `revenda`: lookup; vazio → null.
  - `manual`: sempre null.
- **Smoke E2E no VPS** (padrão do projeto): cadastra uma regra `m2` e uma `m2_bobina`, adiciona itens via API e confere `valor_total` + `preco_memoria`; confere que produto sem regra continua manual.

## Fora de escopo (AO-1)

- Somatório automático de acabamentos (laminação/ilhós/corte especial) — fica para AO futuro; no AO-1 acabamento é ajuste manual sobre o valor.
- Robô de sincronização da revenda (login + drill-down + scraping) — **AO-2**, depende dos prints/URL do site.
- Margem de refile/sangria no cálculo de bobina.
- Reaproveitamento/migração do `price_table` legado.

## Dependências externas

- Nenhuma para o AO-1. (O AO-2 dependerá dos prints e da URL do site de revenda + credenciais de login do revendedor.)
