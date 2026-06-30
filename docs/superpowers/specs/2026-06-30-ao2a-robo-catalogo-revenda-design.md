# AO-2a — Robô + Catálogo de Revenda (Graficonauta) — Design

**Data:** 2026-06-30
**Status:** Aprovado para escrita de plano
**Sub-projeto:** AO-2a de 2 (AO-2b = consumo no orçamento, brainstorm/spec posterior, depende deste catálogo)
**Antecede:** AO-1 (framework de estratégia de preço) — CONCLUÍDO. Este sub-projeto **substitui** o placeholder `precos_revenda`/método `revenda` do AO-1 por um catálogo real.

## Objetivo

Espelhar para o banco da LKL um **catálogo padronizado** de produtos do site de revenda Graficonauta (mesma nomenclatura/Ref), com a **matriz de preço** (tiragem × prazo de produção) e os **acabamentos/serviços** de cada produto, mantido atualizado por um robô que loga no site e lê os preços. Entrega um catálogo consultável e re-sincronizável; o consumo no orçamento é o AO-2b.

## Premissas e decisões (do brainstorming)

- **Padronização pela nomenclatura:** a entrada do pedido passará a usar este catálogo (no AO-2b); como o item É o produto do Graficonauta (mesmo nome/Ref), o preço sai direto da tabela, sem "casamento" difuso.
- **Abrangência curada:** só as categorias que a LKL revende. O admin cadastra **quais categorias sincronizar** (cola a URL da categoria). Nada de varrer o site inteiro.
- **Login exige navegador:** o Graficonauta é Laravel com **reCAPTCHA v3** (`api.js?render=<sitekey>` + `grecaptcha.execute`) e **todo conteúdo é logado** (sessão ~2h). Um cliente HTTP puro não gera o token v3 e é recusado (verificado). Portanto o robô usa **Playwright/Chromium headless** no VPS, que executa o reCAPTCHA v3 como o navegador do usuário.
- **Preço é total por faixa:** cada célula da matriz é o **total** daquela tiragem (ex.: 250un/24h = R$50), não unitário. (O markup e a escolha de faixa/prazo são do AO-2b.)
- **Margem e prazo (config, usados no AO-2b):** markup **global** único; **prazo padrão = 24h** ("Recomendado"). Ambos editáveis na UI; guardados aqui para o AO-2b consumir.
- **Acabamentos:** sincronizados e, no AO-2b, **selecionáveis** (somam ao preço). No AO-2a só importamos e exibimos.
- **Credenciais:** `REVENDA_GRAFICONAUTA_USER` / `REVENDA_GRAFICONAUTA_PASS` **só no `.env` do VPS** — nunca em git/memória. (Senha atual passou pelo chat → recomendar troca.)
- **Seletores reais:** a estrutura exata do DOM (lista de produtos + tabela de preço) será **capturada ao vivo** (login headless real) na fase de planejamento; o spec descreve o comportamento, o plano fixa os seletores a partir da captura e de um **fixture HTML** salvo para os testes.

## Arquitetura

Quatro unidades com responsabilidade única:

1. **Parser (`src/modules/revenda/parser.js`)** — funções **puras** que recebem o HTML/estrutura de uma página e devolvem dados: `parseListaProdutos(html) → [{ref,nome,url,tamanho,cores,gramatura}]` e `parseTabelaPreco(html) → { linhas:[{quantidade, precos:{12,24,48}}], acabamentos:[{nome,preco,tipo,prazo_extra_dias}] }`. 100% testável contra fixtures capturados (sem rede/navegador).
2. **Scraper (`src/jobs/revenda-sync.js`)** — script standalone Node + Playwright. `login()` (executa o reCAPTCHA v3), itera as categorias ativas, navega cada produto, extrai o HTML relevante, chama o parser, e faz **upsert** no catálogo. Rodado por **cron (1x/dia)** e **sob demanda** (spawn por um endpoint). Não roda dentro do processo web (Chromium pesado) — é processo filho.
3. **Service/Router (`src/modules/revenda/{service,router}.js`)** — CRUD das categorias a sincronizar, leitura do catálogo, disparo da sync sob demanda (spawn do job + status), e a config (markup/prazo). Auth cookie-session; escrita admin/gestor.
4. **UI (`public/dashboard.html`)** — aba/sub-aba "Revenda": cadastro de categorias (URL + apelido), botão "🔄 sincronizar agora" + status/última sync, visão do catálogo (produtos + matriz + acabamentos), e config de margem global + prazo padrão.

## Modelo de dados (migration 044)

```sql
-- Categorias a sincronizar (curadas pelo admin)
CREATE TABLE revenda_categorias (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          VARCHAR(150) NOT NULL,
  url           TEXT NOT NULL,           -- URL da página de categoria no Graficonauta
  ativo         BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Catálogo de produtos espelhado (mesma nomenclatura/Ref do site)
CREATE TABLE revenda_produtos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ref            VARCHAR(40) UNIQUE NOT NULL,   -- ex.: flte057 (chave estável)
  nome           VARCHAR(200) NOT NULL,         -- ex.: "Folheto 115g | 10x14cm | 4/0"
  categoria_id   UUID REFERENCES revenda_categorias(id) ON DELETE SET NULL,
  url            TEXT,
  tamanho        VARCHAR(60),                   -- ex.: 10x14cm (quando extraível)
  cores          VARCHAR(20),                   -- ex.: 4/0, 4/4
  gramatura      VARCHAR(40),                   -- ex.: 115g
  ativo          BOOLEAN DEFAULT TRUE,          -- false = sumiu do site na última sync
  sincronizado_em TIMESTAMPTZ
);
CREATE INDEX idx_revenda_produtos_categoria ON revenda_produtos(categoria_id);

-- Matriz de preço: tiragem × prazo (preço TOTAL da célula)
CREATE TABLE revenda_precos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id    UUID NOT NULL REFERENCES revenda_produtos(id) ON DELETE CASCADE,
  quantidade    INTEGER NOT NULL,        -- 50, 100, 250, ...
  prazo_horas   INTEGER NOT NULL,        -- 12, 24, 48
  preco_total   NUMERIC(12,2) NOT NULL,
  UNIQUE (produto_id, quantidade, prazo_horas)
);
CREATE INDEX idx_revenda_precos_produto ON revenda_precos(produto_id);

-- Acabamentos/serviços do produto
CREATE TABLE revenda_acabamentos (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id       UUID NOT NULL REFERENCES revenda_produtos(id) ON DELETE CASCADE,
  nome             VARCHAR(150) NOT NULL,
  preco            NUMERIC(12,2) NOT NULL,
  tipo             VARCHAR(20) NOT NULL CHECK (tipo IN ('acabamento','servico')),
  prazo_extra_dias INTEGER DEFAULT 0,
  UNIQUE (produto_id, nome)
);

-- Log de sincronização (para "última sync" e diagnóstico)
CREATE TABLE revenda_sync_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  iniciado_em   TIMESTAMPTZ DEFAULT NOW(),
  finalizado_em TIMESTAMPTZ,
  status        VARCHAR(20) DEFAULT 'rodando' CHECK (status IN ('rodando','ok','erro')),
  produtos_atualizados INTEGER DEFAULT 0,
  erro          TEXT
);

-- Config de revenda (linha única; consumida pelo AO-2b)
CREATE TABLE revenda_config (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  markup_percent NUMERIC(6,2) DEFAULT 0,   -- margem global, ex.: 40.00 = +40%
  prazo_padrao_horas INTEGER DEFAULT 24,
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO revenda_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
```

> **ATENÇÃO migrations (padrão do projeto):** tabelas novas criadas como `lkl_user` (o app acessa); não há ALTER em tabela do `postgres` aqui. Próxima migration livre: **044**.
> O placeholder `precos_revenda` do AO-1 fica **órfão** (nunca foi populado); pode ser dropado numa migration futura — fora de escopo aqui para não arriscar.

## Fluxo do robô (scraper)

1. `login()`: abre `/login`, preenche `usuario`/`senha`, deixa o reCAPTCHA v3 executar, submete; confirma sessão (presença de marcador logado, ex.: "Olá, <nome>"). Falha → registra `revenda_sync_log.status='erro'` e aborta.
2. Para cada `revenda_categorias` ativa: abre a URL, `parseListaProdutos` → lista de `{ref,nome,url,...}`.
3. Para cada produto: abre a URL do produto, abre/expande a "Tabela de preços", `parseTabelaPreco` → matriz + acabamentos.
4. **Upsert idempotente** por produto (transação): upsert em `revenda_produtos` por `ref` (atualiza nome/atributos/`sincronizado_em`, `ativo=true`); **substitui** `revenda_precos` e `revenda_acabamentos` daquele produto (delete + insert) para refletir mudanças de tabela.
5. Ao fim de cada categoria: produtos daquela categoria **não vistos** nesta run → `ativo=false` (somem da seleção no AO-2b, sem perder histórico).
6. Atualiza `revenda_sync_log` (status ok/erro, contagem). Rate-limit gentil entre requisições (ex.: pequena pausa) para não martelar o site.

## Orquestração

- **Sob demanda:** `POST /api/v2/revenda/sincronizar` (admin/gestor) cria uma linha `revenda_sync_log status='rodando'`, **spawna** `node src/jobs/revenda-sync.js` (processo filho, não bloqueia o web), retorna o id do log. A UI faz polling em `GET /api/v2/revenda/sync/status`.
- **Cron:** 1x/dia (ex.: 04:00) o mesmo job roda. Reaproveita o padrão de cron já existente no projeto (`src/jobs/`), sem duplicar lógica.
- **Concorrência:** se já houver sync `rodando`, novo disparo é recusado (evita 2 Chromium simultâneos).

## API (`/api/v2/revenda`)

- `GET /categorias` · `POST /categorias` · `PUT /categorias/:id` (ativar/desativar) — admin/gestor.
- `GET /produtos?categoria=&busca=` — lista do catálogo (produto + matriz + acabamentos) para a UI/consumo.
- `POST /sincronizar` — dispara sync sob demanda (spawn). `GET /sync/status` — última/atual sync.
- `GET /config` · `PUT /config` — markup global + prazo padrão (admin/gestor).
- Auth cookie-session; escrita admin/gestor via `requireRole`.

## UI (aba "Revenda" no painel)

- **Categorias:** lista + form (apelido + URL) + ativar/desativar.
- **Sincronização:** botão "🔄 sincronizar agora" + indicador de status (rodando/ok/erro, última data, nº produtos) com polling.
- **Catálogo:** busca por nome/Ref; ao abrir um produto, mostra a matriz (tiragem × prazo) e os acabamentos.
- **Config:** margem global (%) + prazo padrão (12/24/48h).

## Tratamento de erros

- **Login falha** (v3 baixo score, credencial errada, site fora): aborta, `sync_log.status='erro'` com mensagem; cron tenta de novo no próximo ciclo; UI mostra o erro.
- **Produto/categoria com layout inesperado:** o parser retorna vazio para aquele item, registra no log e segue (não derruba a sync inteira).
- **Sessão expira no meio:** detecta redirecionamento para `/login` e re-loga uma vez; se falhar, aborta com erro.
- **Idempotência:** re-rodar é seguro (upsert por ref + replace de matriz/acabamentos).

## Testes

- **Unitários (TDD)** `tests/revenda-parser.test.js`: `parseListaProdutos` e `parseTabelaPreco` contra **fixtures HTML reais** salvos na captura ao vivo (`tests/fixtures/revenda/*.html`) — verifica refs, nomes, a matriz (tiragens, prazos, valores) e os acabamentos. Rodam local (puras, sem rede).
- **Smoke E2E no VPS:** após deploy, dispara uma sync de **1 categoria piloto** e confere que `revenda_produtos`/`revenda_precos`/`revenda_acabamentos` populam e o `sync_log` fica `ok`.

## Fora de escopo (AO-2a)

- **Consumo no orçamento** (seletor de revenda, faixa+prazo+markup+acabamentos no preço) — é o **AO-2b**.
- Varrer o catálogo inteiro do site.
- **Fazer pedidos** no Graficonauta (o robô só lê preços; nunca compra).
- Drop do `precos_revenda` legado do AO-1.

## Dependências externas

- Credenciais de revendedor Graficonauta (no `.env` do VPS).
- **Chromium + Playwright instalados no VPS** (`npx playwright install chromium` + libs do sistema). Custo de espaço/instalação a validar no deploy.
- **Captura ao vivo** (login headless real) de 1 categoria + 1 tabela de preço para fixar seletores e gerar os fixtures de teste — feita na fase de planejamento, antes de implementar.
- Risco aceito: reCAPTCHA v3 pode, raramente, dar score baixo a navegador automatizado (mitigação: `playwright` com contexto/`user-agent` realista e perfil persistente; retry). Mudança de layout do site quebra seletores (mitigação: parser isolado + fixtures + log que não derruba a sync).
