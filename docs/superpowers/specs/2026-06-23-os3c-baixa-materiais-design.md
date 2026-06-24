# OS-3C — Baixa de Materiais de Produção — Design

**Data:** 2026-06-23
**Sprint:** 5 (Módulo de Ordem de Serviço), sub-projeto OS-3C
**Referência:** módulo de estoque/requisição do Sisgraf

## Objetivo

Dar baixa automática no estoque dos materiais consumidos por uma OS ao entrar em
impressão, de forma reversível (estorno). Cobre duas fontes de consumo:
- **Offset:** papel, pelas vias da ficha de produção (`os_materiais.folhas_total`).
- **Comunicação Visual (CV):** material por área, calculado pelas dimensões do item
  (`m² = (largura_cm/100) × (altura_cm/100) × quantidade`).

## Decisões (confirmadas com o usuário)

1. **Gatilho:** baixa automática quando a OS entra no status `'impressao'` (idempotente).
2. **Quantidade offset:** `folhas_total` (já inclui o % de perda — consumo real).
3. **Reversão:** requisição registrada e **estornável**; saldo de estoque pode ficar
   **negativo** (modelo Sisgraf); vias/itens **sem material vinculado são ignorados**.
4. **CV:** consumo calculado **por dimensões** do item (não manual).
5. **Captura das dimensões/material de CV:** **no item do orçamento** (estruturado em
   `orcamento_itens`), fluindo para a OS.
6. **Escopo:** OS-3C cobre só a **baixa** (saída). A **entrada via NF-e de compra** é o
   próximo sub-projeto ("Estoque-Entrada"), fora deste escopo.

## Modelo de dados (migration 037)

### Tabelas de requisição (genéricas — servem offset e CV)

```sql
CREATE TABLE IF NOT EXISTS os_requisicoes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  os_id         UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  status        VARCHAR(12) NOT NULL DEFAULT 'baixada' CHECK (status IN ('baixada','estornada')),
  criada_em     TIMESTAMPTZ DEFAULT now(),
  criada_por    UUID REFERENCES users(id) ON DELETE SET NULL,
  estornada_em  TIMESTAMPTZ,
  estornada_por UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_os_requisicoes_os ON os_requisicoes(os_id);

CREATE TABLE IF NOT EXISTS os_requisicao_itens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requisicao_id UUID NOT NULL REFERENCES os_requisicoes(id) ON DELETE CASCADE,
  material_id   UUID NOT NULL REFERENCES materiais(id),
  quantidade    NUMERIC(10,3) NOT NULL,
  unidade       VARCHAR(10) NOT NULL  -- 'folha' | 'm2'
);
CREATE INDEX IF NOT EXISTS idx_os_requisicao_itens_req ON os_requisicao_itens(requisicao_id);
```

O snapshot em `os_requisicao_itens` garante estorno exato mesmo se a ficha/dimensões
mudarem depois da baixa.

### Dimensões/material dos itens de CV

```sql
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS largura_cm  NUMERIC(8,2);
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS altura_cm   NUMERIC(8,2);
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS material_id UUID REFERENCES materiais(id);
```

## Fontes de consumo

O motor de baixa coleta o consumo de **duas fontes** para a OS:

- **Offset:** linhas de `os_materiais` da OS com `material_id` não nulo e `folhas_total > 0`
  → `{ material_id, quantidade: folhas_total, unidade: 'folha' }`.
- **CV:** itens da OS (`os_itens → orcamento_itens`) com `material_id` não nulo,
  `largura_cm > 0`, `altura_cm > 0` e `quantidade > 0`
  → `{ material_id, quantidade: round((largura_cm/100)*(altura_cm/100)*quantidade, 3), unidade: 'm2' }`.

Linhas/itens sem `material_id` (ou sem dimensões, no CV) são ignorados.

## Fluxo

- **Baixa automática:** em `atualizarStatus`, quando a OS **entra** em `'impressao'` e não há
  requisição ativa (`status='baixada'`): numa transação, cria a requisição, coleta o
  consumo das duas fontes, decrementa `materiais.estoque_atual -= quantidade` por material,
  e grava cada linha em `os_requisicao_itens`. **Idempotente** (requisição ativa existente →
  não rebaixa). Saldo pode ficar **negativo**.
- **Estorno:** na requisição ativa, devolve `quantidade` a cada material
  (`estoque_atual += quantidade`), marca a requisição `estornada`. Após estorno é possível
  **requisitar novamente** (nova requisição).
- **Robustez:** se a baixa falhar, ela **não** bloqueia a mudança de status (loga e segue) —
  produção não trava por estoque.

## API (módulo os)

**service.js:**
- `baixarMateriais(osId, { userId } = {})` — idempotente; coleta offset + CV; transação;
  retorna `{ requisicao, itens, ignorados }`.
- `estornarRequisicao(osId, { userId })` — reverte a requisição ativa; erro se não houver.
- `atualizarStatus` chama `baixarMateriais` no `try/catch` quando entra em `'impressao'`.
- `buscarPorId` retorna a requisição ativa + itens (com `material_nome` e `estoque_atual`).

**router.js:**
- `POST /api/v2/os/:id/requisicao` — baixa manual (admin/gestor/atendente).
- `POST /api/v2/os/:id/requisicao/estornar` — estorno (admin/gestor).

## UI (dashboard)

- **Item de orçamento (CV):** no form de adicionar/editar item, campos **largura (cm)**,
  **altura (cm)** e **material** (combo do catálogo). Aparecem para itens de CV.
- **Detalhe da OS:** bloco "Requisição de Materiais":
  - Sem baixa: "Materiais não baixados" + botão **Requisitar**.
  - Baixada: "✅ Baixado em DD/MM por X" + tabela (material · quantidade · unidade ·
    estoque atual) + botão **↩ Estornar** (admin/gestor).
  - Estornada: "Estornada em DD/MM" + botão **Requisitar novamente**.

## Plano em 2 fases (mesma spec)

1. **Motor + offset:** migration 037 (tabelas de requisição), `baixarMateriais` (só fonte
   offset) + `estornarRequisicao` + auto em `'impressao'` + rotas + UI do bloco de
   requisição na OS. Entregável testável sozinho.
2. **CV por dimensões:** colunas em `orcamento_itens` (largura/altura/material) + UI no
   item do orçamento + segunda fonte de consumo (CV) no `baixarMateriais`, reutilizando o
   mesmo motor.

## Erros & testes

- Baixa sem itens com material → requisição com 0 itens + aviso
  "nenhum material do catálogo vinculado".
- Estoque pode negativar (sem bloqueio).
- `node --check` + smoke E2E no VPS (sem postgres local):
  - **Fase 1:** ficha offset com via+material+folhas → status → impressão → estoque
    decrementado e requisição criada → estorno → estoque restaurado.
  - **Fase 2:** item de CV com largura/altura/material → OS de CV → impressão → m²
    decrementado corretamente.

## Fora de escopo (YAGNI)

- Entrada de estoque (compra/NF-e) — próximo sub-projeto.
- Custo do material consumido (sprint futuro de custos).
- Conversão de unidades (assume material de CV cadastrado em m² e papel em folha).
