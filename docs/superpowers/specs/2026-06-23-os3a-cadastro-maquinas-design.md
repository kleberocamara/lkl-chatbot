# OS-3A — Cadastro de Máquinas + Seleção na OS — Design

**Data:** 2026-06-23
**Sprint:** 5 (Módulo de Ordem de Serviço), sub-projeto OS-3A
**Referência:** módulo de OS offset do Sisgraf

## Objetivo

Permitir cadastrar as máquinas de impressão offset (ex.: Heidelberg) e selecionar
uma máquina por OS na ficha de produção, com o operador padrão da máquina
pré-preenchido (e editável). É a base para o futuro motor de custos.

## Decisões (confirmadas com o usuário)

1. **Seleção:** uma máquina por OS (campo `maquina_id` na ficha de produção, escolhido
   de um combo do cadastro). Modelo Sisgraf (uma ficha por OS).
2. **Operador:** cada máquina tem um operador padrão (FK `funcionarios`); ao selecionar
   a máquina na OS, o operador é pré-preenchido, mas continua editável por OS.
3. **Custo de lavagem:** apenas informativo no cadastro. Nenhum cálculo de custo nesta
   fase (fica para um sprint futuro de custos — YAGNI).

## Modelo de dados (migration 036)

### Nova tabela `maquinas`

```sql
CREATE TABLE IF NOT EXISTS maquinas (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome               VARCHAR(120) NOT NULL,
  fabricante         VARCHAR(80),
  modelo             VARCHAR(80),
  num_cores          INTEGER,
  formato_max_larg   NUMERIC(8,2),
  formato_max_alt    NUMERIC(8,2),
  velocidade_iph     INTEGER,             -- impressões/hora (capacidade), opcional
  operador_padrao_id UUID REFERENCES funcionarios(id) ON DELETE SET NULL,
  custo_lavagem      NUMERIC(10,2),       -- informativo
  status             VARCHAR(20) DEFAULT 'ativa' CHECK (status IN ('ativa','inativa')),
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);
```

### Colunas novas em `ordens_servico` (mesma migration)

```sql
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS maquina_id  UUID REFERENCES maquinas(id) ON DELETE SET NULL;
ALTER TABLE ordens_servico ADD COLUMN IF NOT EXISTS operador_id UUID REFERENCES funcionarios(id) ON DELETE SET NULL;
```

`ON DELETE SET NULL` em todas as FKs: desativar/remover uma máquina nunca quebra uma OS
histórica.

## Backend

### Novo módulo `src/modules/maquinas/` (espelha `materiais`)

**service.js**
- `listar({ busca, status, page, limit })` — `LEFT JOIN funcionarios` para devolver
  `operador_padrao_nome`. Filtro `busca` em `nome`/`fabricante`/`modelo` (ILIKE). Filtro
  `status` opcional.
- `buscarPorId(id)` — registro único com `operador_padrao_nome`.
- `criar(dados)` — valida: `nome` obrigatório; `num_cores`/`velocidade_iph`/`custo_lavagem`
  numéricos ≥ 0 quando informados; `operador_padrao_id`, se informado, deve existir em
  `funcionarios`. Retorna `{ maquina }` ou `{ erro: [...] }`.
- `atualizar(id, dados)` — SET dinâmico das colunas presentes; mesma validação; retorna
  `{ maquina }` ou `{ erro: [...] }`.

Sem exclusão física: desativar via `status='inativa'` (padrão dos catálogos).

**router.js**
- `GET /` (lista, `?busca=&status=`), `GET /:id`, `POST /`, `PATCH /:id`.
- Escrita (`POST`/`PATCH`): `requireRole('admin','gestor')`.
- Leitura (`GET`): qualquer autenticado (operador/atendente precisam listar para montar a OS).
- Registrar em `src/modules/index.js` como `/api/v2/maquinas`.

### Integração na OS (`src/modules/os/service.js`)

- `atualizarFichaProducao`: adicionar `maquina_id` e `operador_id` ao array `COLS` (o
  fluxo de SET dinâmico já existe; strings vazias viram `null`).
- `buscarPorId` da OS: `LEFT JOIN maquinas` e `LEFT JOIN funcionarios` para devolver
  `maquina_nome` e `operador_nome`.

## UI (public/dashboard.html)

### a) Nova aba "Máquinas" (menu admin, junto de Materiais/Funcionários)
- Lista: nome · fabricante/modelo · nº cores · formato máx · operador padrão · custo
  lavagem · chip de status.
- Botão **+ Nova máquina** e ✏️ editar → modal com os campos do cadastro.
- Operador padrão = combo carregado de `funcionarios` (ativos). Status ativa/inativa.

### b) Ficha de produção da OS (tela de detalhe já existente)
- Combo **Máquina** carregado de `/api/v2/maquinas?status=ativa`.
- Ao escolher a máquina, o campo **Operador** é pré-preenchido com o operador padrão
  (editável; também combo de `funcionarios`).
- Salvam junto com o resto da ficha via `PATCH /api/v2/os/:id/producao` (já existente).
- No modo leitura da OS: exibir "Máquina: X · Operador: Y".

## Testes & validação

- Smoke E2E no VPS (sem postgres local): criar máquina via API → listar → vincular a uma
  OS via `PATCH /os/:id/producao` → confirmar que `buscarPorId` da OS retorna
  `maquina_nome`/`operador_nome`.
- `node --check` em todos os arquivos novos/alterados antes do deploy.
- Validação de FK inválida retorna 400 com `{ erro: [...] }`.

## Tratamento de erros

- Padrão dos módulos: `{ erro: [...] }` → 400; não encontrado → 404.
- Máquina inativa não aparece no combo da OS, mas OSs que a referenciam continuam
  exibindo o nome (LEFT JOIN).

## Fora de escopo (YAGNI)

- Cálculo de custo de impressão/lavagem (sprint futuro de custos).
- Agendamento/capacidade de produção por máquina.
- Exclusão física de máquina.
