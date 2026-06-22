# OS-2 · Detalhe de Produção Offset — Design

**Data:** 2026-06-22
**Sub-projeto:** OS-2 (segundo de três — ver Roadmap em OS-1)
**Objetivo:** Adicionar a ficha de produção offset à Ordem de Serviço (parâmetros de produção + materiais por via), conforme as telas do Sisgraf, com edição numa tela de detalhe da OS.

---

## Contexto

OS-1 (concluído) criou a OS e o agrupamento de itens. A OS offset hoje tem cabeçalho (cliente, tipo_produto, observação, previsão) e itens (`os_itens`), mas **nenhum detalhe de produção**. O dashboard tem apenas a **lista** de OS — não há tela de detalhe/edição.

`materiais` (105 itens cadastrados, com `codigo`/`nome`/`unidade`/`estoque_atual`/`custo_medio`) é o catálogo de matéria-prima (= "Produtos de Matéria Prima" do Sisgraf). `GET /api/v2/materiais?busca=` já busca por nome/código.

## Decisões travadas com o usuário

1. **Ficha de produção é uma por OS** (modelo Sisgraf / ganging) — a OS inteira compartilha os parâmetros e a lista de vias, não por item.
2. **Materiais das vias vêm do catálogo** (`materiais`) + campos livres (cor do papel, cores das tintas, impressão) — prepara o terreno para a baixa de estoque do OS-3.

## Fora de escopo (OS-3)
- Otimizador de imposição "melhor corte" (cálculo automático de imagens/folha e formato).
- Cadastro/seleção de máquinas.
- Requisição e baixa de estoque pela OS.
Nesta fase os campos de imposição (imagens/folha, formato) são **entrada manual**; o cálculo automático é OS-3.

---

## Modelo de dados

### Migração 030 — ficha de produção em `ordens_servico`
```sql
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS nro_jogos         INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS nro_vias          INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS tipo_unidade      VARCHAR(5);   -- FLS/BLS/PCS/JGS/TLS
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS frente_verso      VARCHAR(20);  -- so_frente|fv_iguais|fv_diferentes
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS numeracao_inicial INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS numeracao_final   INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS formato_corte_alt  NUMERIC(8,2);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS formato_corte_larg NUMERIC(8,2);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS imagem_alt         NUMERIC(8,2);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS imagem_larg        NUMERIC(8,2);
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS imagens_folha      INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS imagens_impressao  INTEGER;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS cores_tintas       VARCHAR(50);
```

### Migração 031 — `os_materiais` (vias)
```sql
CREATE TABLE IF NOT EXISTS os_materiais (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  os_id          UUID NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  via            INTEGER NOT NULL,
  material_id    UUID REFERENCES materiais(id),
  descricao      VARCHAR(200),          -- snapshot do nome do material no momento
  cor_papel      VARCHAR(60),
  cores_tintas   VARCHAR(60),           -- ex: CMYK
  tipo_impressao VARCHAR(60),           -- ex: Frente e Verso Diferentes
  cores_frente   INTEGER,
  cores_verso    INTEGER,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_os_materiais_os ON os_materiais(os_id);
```

---

## Backend

### `src/modules/os/service.js`
- `buscarPorId(id)` → incluir `materiais` (array de `os_materiais` ordenado por `via`) junto de `itens` e `especificacoes` (já retornados).
- Nova função `atualizarFichaProducao(osId, dados)`:
  - Atualiza as colunas de ficha em `ordens_servico` (apenas os campos enviados).
  - **Substitui** as vias: `DELETE FROM os_materiais WHERE os_id=$1` e reinsere a partir de `dados.materiais` (array). Save atômico e simples (sem CRUD parcial de via nesta fase).
  - Retorna `{ os }` via `buscarPorId`.

### `src/modules/os/router.js`
- `PATCH /api/v2/os/:id/producao` (requireRole admin/gestor/analista/operador) → `atualizarFichaProducao`. Body: campos da ficha + `materiais: [{ via, material_id, descricao, cor_papel, cores_tintas, tipo_impressao, cores_frente, cores_verso }]`.

Reaproveita `GET /api/v2/materiais?busca=` para o seletor (já existe).

---

## Frontend — dashboard (aba OS)

### Tela de detalhe da OS (novo)
Ao clicar numa linha de OS na lista (ou botão "Abrir"), abre um modal/painel com:
1. **Cabeçalho** (somente leitura): nº OS, tipo de serviço, cliente, status, itens agrupados, especificações.
2. **Ficha de produção** (form editável):
   - Nº Jogos, Nº Vias, Tipo de unidade (select FLS/BLS/PCS/JGS/TLS)
   - Frente e Verso (select: Só Frente / F+V Iguais / F+V Diferentes)
   - Numeração inicial / final
   - Formato de corte (Alt × Larg), Tamanho da imagem (Alt × Larg)
   - Imagens por folha / por impressão (entrada manual nesta fase)
   - Cores das tintas
3. **Vias / Materiais** (sub-lista): linhas com Via nº, material (campo de busca → `GET /api/v2/materiais?busca=`, grava `material_id`+`descricao`), cor do papel, cores das tintas, tipo de impressão, cores frente × verso. Botões adicionar/remover via.
4. **Salvar** → `PATCH /api/v2/os/:id/producao` (envia ficha + array de vias).

A ficha só faz sentido para OS `tipo_servico = 'offset'`; para `comunicacao_visual` o detalhe mostra itens/especificações sem a ficha offset.

---

## Critérios de aceite (OS-2)
1. Abrir uma OS offset mostra a ficha de produção e a lista de vias (vazias inicialmente).
2. Preencher a ficha + adicionar vias com material do catálogo e salvar persiste tudo; reabrir mostra os valores.
3. Buscar material por código/nome no seletor de via funciona e grava `material_id` + descrição.
4. Editar e salvar de novo substitui as vias corretamente (sem duplicar).
5. OS de Comunicação Visual não exibe a ficha offset (sem erro).

## Riscos / atenção
- A ficha é por OS; se o usuário agrupou itens incompatíveis numa OS offset, é decisão operacional (gangagem deve ser de itens compatíveis) — não é validado pelo sistema nesta fase.
- `os/service.js` cresceu; manter as novas funções coesas. Tela de detalhe no dashboard é nova e adiciona JS — manter num bloco próprio.
