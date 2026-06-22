# OS-3B · Otimizador de Imposição ("Melhor Corte") — Design

**Data:** 2026-06-22
**Sub-projeto:** OS-3B (primeiro slice do OS-3 — o "motor offset"). Ordem definida com o usuário: **3B (imposição) → 3A (máquinas) → 3C (estoque)**.
**Objetivo:** Dado o tamanho da imagem, calcular o melhor aproveitamento de papel (quantas imagens montam por folha em cada formato de corte) e preencher automaticamente o formato de corte e imagens/folha na ficha de produção da OS (OS-2).

---

## Contexto

OS-1 (criação/agrupamento) e OS-2 (ficha de produção + vias) concluídos. Na ficha da OS-2, `formato_corte_alt/larg`, `imagem_alt/larg` e `imagens_folha` são **entrada manual**. OS-3B automatiza o cálculo do formato de corte e imagens/folha — o "Pesquisa Melhor Corte" do Sisgraf (tela 6).

A planilha `MELHORCORTE.xlsx` fornecida tem 3 colunas — **FORMATO** (tier de subdivisão da folha: 1 = folha inteira, tiers maiores = cortes menores), **ALTURA CORTE**, **LARGURA CORTE** — com **107 tamanhos** em **31 tiers**.

## Validação da lógica (contra o Sisgraf)

A fórmula abaixo reproduz exatamente o "Nº Imagens Montadas" da tela 6 do Sisgraf para a imagem 42×30 (50×66→2, 64×88→4, 66×96→4, 76×112→4, 89×117→6):
```
imagens_montadas(alt_corte, larg_corte, img_alt, img_larg) = max(
  floor(alt_corte/img_alt) * floor(larg_corte/img_larg),   // orientação normal
  floor(alt_corte/img_larg) * floor(larg_corte/img_alt)    // girada 90°
)
```
**Premissa:** os tamanhos de corte já são a área útil e a imagem informada já inclui a sangria/refile — por isso **sem margem extra**. Rotação 90° é considerada. (Se na validação real precisar de margem de refile, adiciona-se um parâmetro depois — combinado com o usuário: ajustamos no caso real.)

## Fora de escopo (OS-3A / OS-3C)
- Cadastro e seleção de máquinas → **OS-3A**.
- Requisição e baixa de estoque (folhas necessárias a partir de imagens/folha + % perda) → **OS-3C**.

---

## Modelo de dados

### Migração 032 — `formatos_papel` + seed
```sql
CREATE TABLE IF NOT EXISTS formatos_papel (
  id            SERIAL PRIMARY KEY,
  formato       INTEGER NOT NULL,   -- tier de subdivisão (1 = folha inteira)
  altura_corte  INTEGER NOT NULL,
  largura_corte INTEGER NOT NULL,
  ativo         BOOLEAN DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_formatos_papel_formato ON formatos_papel(formato);

INSERT INTO formatos_papel (formato, altura_corte, largura_corte) VALUES
 (1,50,66),(1,55,73), ... ;  -- 107 linhas, geradas a partir de MELHORCORTE.xlsx
```
(O seed completo com as 107 linhas é gerado no plano a partir da planilha.)

---

## Backend

### `src/modules/formatos/service.js` (novo)
- `melhorCorte({ imagem_alt, imagem_larg, formato })`:
  - Valida `imagem_alt`/`imagem_larg` > 0.
  - Busca formatos ativos (filtrando por `formato` tier se informado).
  - Para cada, calcula `imagens_montadas` pela fórmula validada.
  - Retorna a lista com `{ formato, altura_corte, largura_corte, imagens_montadas }`, **apenas onde imagens_montadas ≥ 1**, ordenada por `imagens_montadas` desc (melhor aproveitamento primeiro), depois por menor área de corte.

### `src/modules/formatos/router.js` (novo)
- `GET /api/v2/formatos/melhor-corte?imagem_alt=&imagem_larg=&formato=` → `melhorCorte(...)`. Autenticado.
- `GET /api/v2/formatos` → lista de formatos cadastrados (para referência/admin).

### `src/modules/index.js`
- Registrar `router.use('/formatos', requireAuthApi, require('./formatos/router'));`.

---

## Frontend — dashboard (tela de detalhe da OS, dentro da ficha OS-2)

Na ficha de produção (modal de detalhe da OS), ao lado de **Tamanho da imagem** (`imagem_alt`/`imagem_larg`):
- Botão **"🔍 Melhor corte"**.
- Ao clicar: lê `imagem_alt`/`imagem_larg` da ficha (se vazios, avisa para preencher), chama `GET /api/v2/formatos/melhor-corte`, e mostra **inline** (na própria área da ficha/vias, sem trocar de modal — padrão do OS-2) um grid igual ao Sisgraf: Formato · Corte (Alt×Larg) · Imagens montadas.
- Ao **clicar numa linha** do grid: preenche na ficha `formato_corte_alt = altura_corte`, `formato_corte_larg = largura_corte`, `imagens_folha = imagens_montadas`, e volta para a ficha. O usuário então salva normalmente (PATCH /producao do OS-2).
- `imagens_impressao` permanece manual nesta fase (sua relação com frente/verso fica para refinamento).

---

## Critérios de aceite (OS-3B)
1. `GET /api/v2/formatos/melhor-corte?imagem_alt=42&imagem_larg=30&formato=1` retorna 89×117→6, 64×88→4, 66×96→4, 50×66→2 (bate com o Sisgraf), ordenado por imagens montadas.
2. Sem `formato`, retorna todos os tiers calculados, melhor primeiro.
3. No detalhe da OS, "🔍 Melhor corte" lista os cortes e, ao escolher, preenche formato_corte_alt/larg + imagens_folha na ficha.
4. Salvar a ficha persiste os valores preenchidos pelo otimizador.
5. Imagem sem dimensões (0/vazio) → mensagem clara, sem cálculo.

## Riscos / atenção
- A premissa "sem margem de refile" foi validada contra o Sisgraf para um caso; confirmar em mais casos reais e, se necessário, adicionar parâmetro de margem (acordado: ajustar no teste real).
- O seed de 107 linhas deve ser idempotente o suficiente; como é tabela nova, basta inserir uma vez (a migração roda uma vez).
