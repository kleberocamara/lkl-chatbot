# OS-1 · Criação e Fluxo da Ordem de Serviço — Design

**Data:** 2026-06-22
**Sub-projeto:** OS-1 (primeiro de três — ver Roadmap)
**Objetivo:** Construir a criação de Ordens de Serviço a partir de orçamentos aprovados, com regra automática para Comunicação Visual e agrupamento manual para Offset, especificações/acabamentos e o fluxo de status existente.

---

## Contexto

Hoje **não existe criação de OS no código** — o módulo `os` só lista e gerencia status/arte/entrega. As OS de teste anteriores foram criadas por SQL manual e já foram apagadas (banco de OS zerado), o que torna a migração de schema **limpa, sem dados a preservar**.

As telas do Sisgraf (analisadas) revelam um módulo de produção offset completo. Este projeto foi decomposto em três sub-projetos sequenciais:

- **OS-1 (este)** — Criação e fluxo da OS.
- **OS-2** — Detalhe de produção offset (vias/materiais, frente-verso, cores, numeração, formato de corte).
- **OS-3** — Motor offset (otimizador de imposição "melhor corte", cadastro/seleção de máquinas, requisição e baixa de estoque).

## Decisões travadas com o usuário

1. **Comunicação Visual** → ao aprovar o orçamento, cria **1 OS com todos os itens** de Comunicação Visual daquele orçamento (automático).
2. **Offset** → criação **manual**: o gestor seleciona itens offset aprovados e os agrupa numa OS. **Pode misturar clientes** e itens de **orçamentos diferentes**.
3. **Numeração** de OS continua na sequência própria do sistema (`os_numero_seq`), não a do Sisgraf.
4. Orçamento misto (itens CV + Offset): os itens CV viram OS automática; os Offset ficam aguardando agrupamento manual.

---

## Modelo de dados

### Migração 025 — `orcamento_itens.tipo_producao`
```sql
ALTER TABLE orcamento_itens ADD COLUMN IF NOT EXISTS tipo_producao VARCHAR(30);
```
- Decide auto (COMUNICAÇÃO VISUAL) vs manual (OFFSET) **por item**.
- Preenchido na auto-criação do orçamento (`orders/service.js`), que já coleta o tipo por item no modal de pedido, mas hoje não grava no item do orçamento — será corrigido.

### Migração 026 — `ordens_servico` multi-item + cabeçalho
```sql
-- Deixa de ser "1 item": vínculo único antigo vira opcional
ALTER TABLE ordens_servico ALTER COLUMN orcamento_item_id DROP NOT NULL;

-- Cabeçalho (campos leves do Sisgraf que cabem na Fase 1)
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS tipo_servico      VARCHAR(20);   -- 'offset' | 'comunicacao_visual'
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS tipo_produto      VARCHAR(100);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS cliente_id        UUID REFERENCES clientes_lkl(id);  -- null quando OS mistura clientes
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS previsao_entrega  DATE;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS quantidade        INTEGER;
```
- `orcamento_item_id` é mantido (nullable) por compatibilidade, mas a verdade dos itens passa a viver em `os_itens`.

### Migração 027 — `os_itens` (OS ↔ itens de orçamento, M2M)
```sql
CREATE TABLE IF NOT EXISTS os_itens (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  os_id              UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  orcamento_item_id  UUID NOT NULL REFERENCES orcamento_itens(id),
  created_at         TIMESTAMPTZ DEFAULT now(),
  UNIQUE (orcamento_item_id)   -- cada item de orçamento pertence a no máximo 1 OS
);
CREATE INDEX IF NOT EXISTS idx_os_itens_os ON os_itens(os_id);
```

### Migração 028 — `especificacoes` (domínio) + `os_especificacoes`
```sql
CREATE TABLE IF NOT EXISTS especificacoes (
  id    SERIAL PRIMARY KEY,
  nome  VARCHAR(60) UNIQUE NOT NULL,
  ativo BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS os_especificacoes (
  os_id            UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  especificacao_id INTEGER NOT NULL REFERENCES especificacoes(id),
  PRIMARY KEY (os_id, especificacao_id)
);

-- Seed a partir das telas do Sisgraf
INSERT INTO especificacoes (nome) VALUES
 ('ARTE FINAL'),('BLOCO'),('COLAGEM'),('CORTE'),('DOBRA'),('ENVELOPE'),
 ('FIXO CABEÇA'),('FIXO ESQUERDA'),('GRAMPO'),('ILHÓS'),('IMPRESSO'),
 ('INTERCALAÇÃO'),('LAMINAÇÃO BRILHO'),('LAMINAÇÃO FOSCA'),('NUMERAÇÃO'),
 ('REFILE'),('SERRILHA'),('TALÃO'),('VINCO')
ON CONFLICT (nome) DO NOTHING;
```

---

## Fluxos de criação

### 1. Comunicação Visual — automático (ao aprovar orçamento)
Em `orcamentos/service.js` `aprovar()` (e nos caminhos de aprovação via token/WhatsApp que levam a `aprovado`):
- Buscar itens do orçamento com `tipo_producao = 'COMUNICAÇÃO VISUAL'`.
- Se houver ≥1: criar **1 OS** (`tipo_servico='comunicacao_visual'`, `cliente_id` = cliente do orçamento, `quantidade` = soma das quantidades, `previsao_entrega` = prazo do pedido se houver), status `aguardando`.
- Linkar todos esses itens em `os_itens`.
- Itens Offset do mesmo orçamento ficam **sem OS** (entram na fila de agrupamento manual).
- Fire-and-forget; falha não bloqueia a aprovação. Emite `global.io` `nova_os`.

### 2. Offset — manual (tela de agrupamento)
- **Listar itens disponíveis:** itens cujo `orcamento.status='aprovado'`, `tipo_producao='OFFSET'`, e que **não estão em `os_itens`**. Retorna: item id, descrição, quantidade, orçamento nº, cliente nome.
- **Criar OS:** o gestor seleciona N itens (de qualquer cliente/orçamento) + especificações + observação + tipo_produto + previsão de entrega → cria 1 OS (`tipo_servico='offset'`), linka itens em `os_itens`, grava `os_especificacoes`. `cliente_id` = o cliente comum se todos forem iguais, senão `null` (OS multi-cliente).

---

## Backend — endpoints

| Método | Rota | Papel | Função |
|---|---|---|---|
| GET | `/api/v2/os/itens-disponiveis?tipo=offset` | admin/gestor/analista | itens offset aprovados sem OS |
| POST | `/api/v2/os` | admin/gestor/analista | cria OS offset agrupada (body: `item_ids[]`, `especificacoes[]`, `observacao`, `tipo_produto`, `previsao_entrega`) |
| GET | `/api/v2/especificacoes` | autenticado | lista de domínio para o seletor |
| (hook) | — | — | auto-criação CV dentro de `orcamentos.aprovar()` |

Endpoints existentes (`GET /os`, `GET /os/:id`, `PATCH /os/:id/status`, `enviar-arte`, `entregar`) são **adaptados** para o modelo multi-item.

## Backend — refactor do `os/service.js`
As queries de `listar()` e `buscarPorId()` hoje fazem `JOIN orcamento_itens oi ON oi.id = os.orcamento_item_id` (1 item). Passam a agregar itens via `os_itens`:
- `listar()`: retorna `itens_count` e a descrição do 1º item (resumo).
- `buscarPorId()`: retorna array `itens` (descrição, quantidade) + `especificacoes` + dados do cabeçalho. Cliente: `cliente_id` direto, ou derivado dos itens quando null.
- Helper de criação `criarOSComunicacaoVisual(orcamentoId)` e `criarOSOffset(dados, userId)`.

## Frontend — dashboard (aba OS)
- Botão **"Gerar OS Offset"** → modal:
  - Tabela de itens disponíveis (checkbox · cliente · ORC nº · descrição · qtd).
  - Seletor de **especificações** (chips multi-seleção, vindos de `/api/v2/especificacoes`).
  - Campos: tipo de produto, observação, previsão de entrega.
  - Botão criar → `POST /api/v2/os`.
- Lista de OS passa a exibir múltiplos itens (badge "+N") e o tipo de serviço.
- OS de Comunicação Visual aparecem automaticamente após aprovação.

## PWA (produção/arte/motorista)
- `producao.html`, `arte_final.html`, `motorista.html` consomem `GET /os` e `/os/:id`. Como o retorno passa a ter `itens[]` em vez de um único item, ajustar a exibição para listar os itens da OS (mudança leve de template; sem dados legados para migrar).

---

## Fora de escopo (OS-2 / OS-3)
- Vias/materiais por item, frente-verso, cores CMYK, numeração, formato de corte → **OS-2**.
- Otimizador de imposição "melhor corte", cadastro/seleção de máquinas, requisição e baixa de estoque → **OS-3**.

## Riscos / atenção
- O refactor multi-item toca 3 PWAs + dashboard. Mitigado por: banco de OS vazio (sem migração de dados) e mudanças de template pequenas.
- `tipo_producao` por item precisa estar correto para a regra auto/manual — garantir o preenchimento na auto-criação do orçamento e validar os valores ('OFFSET' / 'COMUNICAÇÃO VISUAL', incluindo 'OUTROS/OFFSET' tratado como offset).

## Critérios de aceite (OS-1)
1. Aprovar um orçamento com itens de Comunicação Visual cria automaticamente 1 OS com todos esses itens, status `aguardando`.
2. Itens Offset aprovados aparecem na tela "Gerar OS Offset" e podem ser agrupados (inclusive de clientes/orçamentos diferentes) em 1 OS.
3. Especificações selecionadas são gravadas e exibidas na OS.
4. Lista e detalhe de OS exibem corretamente múltiplos itens.
5. Fluxo de status/arte/entrega existente continua funcionando com OS multi-item.
