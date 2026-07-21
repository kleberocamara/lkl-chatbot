# Portal do Fornecedor — Entrada de NF com Verificação Anti-Fraude — Design

## Contexto e motivação

Hoje, notas fiscais de fornecedores chegam por dois caminhos: OCR via WhatsApp (número
autorizado envia foto/PDF, `src/modules/contas-pagar/ocr.js` extrai os dados) ou entrada
manual na tela de Entrada de Estoque. Boletos chegam separadamente via importação
automática do DDA (`src/modules/contas-pagar/service.js:sincronizarDDA`), casados com a
conta a pagar já existente (fornecedor + valor + vencimento) por
`criarOuReconciliarContaPagar`. Essa sessão já lidou três vezes com boletos frios
("Itev", "Speed Tecnet", "Sesnat Nacional") importados pelo DDA sem nenhuma
correspondência real — hoje só descobertos manualmente, depois de já aparecerem no
Contas a Pagar.

**Objetivo:** dar ao fornecedor um canal próprio (portal autenticado) pra declarar a NF
e a forma de pagamento *antes* da mercadoria chegar. Isso resolve dois problemas ao
mesmo tempo:
1. Reduz trabalho manual de digitação do atendente (dados da NF pré-preenchidos por OCR
   quando a mercadoria chega pra Entrada de Estoque).
2. Cria uma "lista branca declarada": um boleto que chega pelo DDA só é confiável de
   verdade se bate com algo que o próprio fornecedor declarou antes — o padrão dos
   boletos frios (nunca declarados por ninguém) fica evidente.

## Fora de escopo

- Contas recorrentes (água, luz, telefone, internet) — ficam numa tela interna simples
  do painel LKL, sem fornecedor externo logando (concessionárias não vão logar num
  portal de cliente pra declarar boleto).
- Múltiplos usuários por fornecedor — 1 login por empresa fornecedora.
- Webhook automático pra pagamentos via Link MP do próprio fornecedor (não é conta MP
  da LKL) — conciliação é manual por enquanto, com plano de evoluir pra cruzamento com
  o extrato do C6 quando esse acesso for liberado (ver `docs/suporte-c6-extrato-403.md`,
  pendência já em andamento com o suporte do C6).
- Notificação ativa (WhatsApp/e-mail) pro financeiro quando cai uma submissão nova —
  só badge de contador no painel, por decisão do usuário.

## Arquitetura

Extensão do sistema atual — nova área autenticada dentro do mesmo app Node.js/Express,
reaproveitando banco, middleware de auth (`requireAuthApi`/`requireRole`) e módulos já
existentes (`ocr.js`, `entradas/service.js`, `contas-pagar/service.js`,
`classificador.js`). Não é uma aplicação separada.

### Novo tipo de sessão: fornecedor

O sistema hoje só tem `users` (funcionários da LKL, com `role`). Login de fornecedor é
um universo diferente — não deve poder acessar nada do painel interno. Em vez de
misturar com `users`, cria uma tabela própria `fornecedor_logins` (1 por fornecedor) e
um novo middleware `requireAuthFornecedor`, com JWT de escopo distinto (claim
`tipo: 'fornecedor'`) pra impedir que um token de fornecedor seja aceito em qualquer
rota do painel interno, e vice-versa.

## Modelo de dados

### Nova tabela: `fornecedor_logins`

```sql
CREATE TABLE fornecedor_logins (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fornecedor_id   UUID NOT NULL UNIQUE REFERENCES fornecedores(id) ON DELETE CASCADE,
  email           VARCHAR(150) NOT NULL UNIQUE,
  senha_hash      VARCHAR(255),
  convite_token   VARCHAR(64) UNIQUE,
  convite_expira  TIMESTAMPTZ,
  senha_definida_em TIMESTAMPTZ,
  ativo           BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
```

`senha_hash` fica `NULL` até o fornecedor aceitar o convite e definir a senha
(`convite_token` usado uma vez, com expiração).

### Nova tabela: `fornecedor_submissoes`

Uma submissão = uma NF declarada pelo fornecedor, com sua forma de pagamento e status
de verificação.

```sql
CREATE TABLE fornecedor_submissoes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fornecedor_id         UUID NOT NULL REFERENCES fornecedores(id),
  nnf                   VARCHAR(20),
  emitida_em            DATE,
  data_entrega_agendada DATE,
  valor_total           NUMERIC(12,2) NOT NULL,
  arquivo_nf_path        VARCHAR(255),
  tipo_pagamento        VARCHAR(10) NOT NULL CHECK (tipo_pagamento IN ('boleto','pix','ted','link_mp')),
  pix_chave             VARCHAR(140),
  ted_banco_nome        VARCHAR(100),
  ted_banco_codigo      VARCHAR(10),
  ted_tipo_conta        VARCHAR(20),
  ted_titularidade      VARCHAR(2) CHECK (ted_titularidade IN ('PJ','PF')),
  ted_documento         VARCHAR(18),
  ted_agencia           VARCHAR(10),
  ted_conta             VARCHAR(20),
  link_mp_url           VARCHAR(500),
  status                VARCHAR(20) NOT NULL DEFAULT 'pendente'
                        CHECK (status IN ('pendente','alerta_dado_bancario','aguardando_entrega','aceita','rejeitada')),
  bot_verificacao        JSONB,
  entrada_estoque_id    UUID REFERENCES entradas_estoque(id) ON DELETE SET NULL,
  criada_em             TIMESTAMPTZ DEFAULT NOW(),
  revisada_por          UUID REFERENCES users(id) ON DELETE SET NULL,
  revisada_em           TIMESTAMPTZ
);

CREATE TABLE fornecedor_submissao_itens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submissao_id    UUID NOT NULL REFERENCES fornecedor_submissoes(id) ON DELETE CASCADE,
  produto         VARCHAR(200) NOT NULL,
  quantidade      NUMERIC(10,3) NOT NULL,
  valor_unitario  NUMERIC(12,4) NOT NULL,
  valor_total     NUMERIC(12,2) NOT NULL
);

CREATE TABLE fornecedor_submissao_boletos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submissao_id      UUID NOT NULL REFERENCES fornecedor_submissoes(id) ON DELETE CASCADE,
  arquivo_path      VARCHAR(255) NOT NULL,
  linha_digitavel   VARCHAR(60),
  valor             NUMERIC(12,2),
  vencimento        DATE
);
```

`bot_verificacao` guarda o resultado das checagens automáticas (formato válido,
duplicidade encontrada ou não, se é troca de dado bancário) — usado pra montar os
badges na fila e pra auditoria depois.

### Alteração em `fornecedores`

```sql
ALTER TABLE fornecedores ADD COLUMN portal_liberado BOOLEAN NOT NULL DEFAULT false;
```

### Alteração em `entradas_estoque`

```sql
ALTER TABLE entradas_estoque ADD COLUMN fornecedor_submissao_id UUID REFERENCES fornecedor_submissoes(id) ON DELETE SET NULL;
```

## Fluxo do fornecedor

1. **Login** (`POST /api/v2/portal-fornecedor/login`) — e-mail + senha, retorna JWT com
   `tipo: 'fornecedor'` e `fornecedor_id`.
2. **Anexa a NF** — upload de PDF/imagem. Backend chama
   `ocr.extrairDadosComprovante()` (reaproveitado do `contas-pagar/ocr.js`, mesmo
   prompt/model GPT-4o Vision, ajustado pra também extrair `nnf`, `emitida_em`, e a
   lista de itens produto/quantidade/valor_unitario/valor_total).
3. **Fornecedor confere/ajusta** os campos extraídos e preenche
   **Agendamento de entrega** (campo obrigatório, não vem da NF).
4. **Escolhe forma de pagamento** — um dos 4 tipos. Se `boleto`, pode anexar múltiplos
   arquivos; cada um passa por uma extração de linha digitável (mesmo mecanismo de
   OCR, prompt dedicado pra ler só o código de barras/linha digitável da imagem).
5. **Envia** — `POST /api/v2/portal-fornecedor/submissoes`.

## Verificação automática (bot)

Executada de forma síncrona ao receber a submissão, antes de gravar o status final:

```js
async function verificarSubmissao(fornecedorId, dados) {
  const alertas = [];

  // 1. Formato dos dados
  if (dados.tipo_pagamento === 'pix' && !validarChavePix(dados.pix_chave)) alertas.push('pix_formato_invalido');
  if (dados.tipo_pagamento === 'boleto') {
    for (const b of dados.boletos) {
      if (!validarLinhaDigitavel(b.linha_digitavel)) alertas.push('boleto_linha_invalida');
    }
  }

  // 2. Duplicidade — mesma NF+fornecedor já submetida
  const dup = await db.query(
    `SELECT id FROM fornecedor_submissoes WHERE fornecedor_id = $1 AND nnf = $2 AND status != 'rejeitada'`,
    [fornecedorId, dados.nnf]);
  if (dup.rows.length) alertas.push('duplicidade_nf');

  // 3. Mudança de dado bancário — compara com a última submissão APROVADA (status='aceita')
  //    do mesmo tipo de pagamento e mesmo fornecedor
  if (['pix', 'ted'].includes(dados.tipo_pagamento)) {
    const ultima = await db.query(
      `SELECT pix_chave, ted_banco_codigo, ted_agencia, ted_conta, ted_documento
       FROM fornecedor_submissoes
       WHERE fornecedor_id = $1 AND tipo_pagamento = $2 AND status = 'aceita'
       ORDER BY criada_em DESC LIMIT 1`,
      [fornecedorId, dados.tipo_pagamento]);
    if (ultima.rows.length && dadosBancariosMudaram(ultima.rows[0], dados)) {
      alertas.push('dado_bancario_mudou');
    }
  }

  return alertas;
}
```

Se `dado_bancario_mudou` estiver entre os alertas → `status = 'alerta_dado_bancario'`,
travado até aprovação manual explícita (endpoint separado de aprovação, não é
automático mesmo que os outros dados estejam corretos). Caso contrário, sem alertas de
formato/duplicidade → `status = 'aguardando_entrega'`. Com alerta de formato/duplicidade
(não bancário) → `status = 'pendente'` (revisão manual, mas sem bloquear
necessariamente o fluxo).

## Fluxo interno LKL

### Fila de submissões

Nova página no painel (`Fornecedores → Submissões`), listando `fornecedor_submissoes`
com filtro por status. Badge de contador de pendentes no menu (não notificação ativa).

### Aceite da mercadoria → Contas a Pagar

Ao clicar "Ver detalhes" numa submissão com `status IN ('aguardando_entrega', 'pendente')`,
o atendente é levado pra tela de **Entrada de Estoque já existente**
(`src/modules/entradas`), com o formulário pré-preenchido a partir de
`fornecedor_submissao_itens`. Ele confere/ajusta item a item (fluxo que já existe hoje,
sem mudança) e confirma. Ao confirmar (`entradas.confirmar()`), além do que já acontece
hoje (baixa de estoque, `criarOuReconciliarContaPagar`), grava
`entradas_estoque.fornecedor_submissao_id` e atualiza
`fornecedor_submissoes.status = 'aceita'`, `entrada_estoque_id`.

Se o pagamento declarado foi `boleto` com múltiplos arquivos, `criarOuReconciliarContaPagar`
é chamado uma vez por boleto, todos com o mesmo `parcela_grupo_id` (reaproveitando o
mecanismo já existente em `criarParcelado`), dividindo o `valor_total` proporcionalmente
aos valores de cada boleto declarado.

### Aprovação de mudança de dado bancário

Endpoint dedicado, só `admin`/`gestor` (mesmo padrão de `requireRole` já usado em
outras rotas sensíveis do contas-pagar):
`POST /api/v2/fornecedor-submissoes/:id/aprovar-dado-bancario`. Sem essa aprovação, a
submissão não pode seguir pra Entrada de Estoque.

## Cruzamento com DDA

`sincronizarDDA()` (`src/modules/contas-pagar/service.js`) já casa boletos importados
com contas pendentes existentes via `criarOuReconciliarContaPagar` (fornecedor + valor
+ janela de vencimento). Nenhuma mudança estrutural necessária aqui — o cruzamento já
funciona pela mesma lógica. A diferença é que, com o portal, uma conta "esperando
match" só existe se o fornecedor declarou algo previamente (via Entrada de Estoque
alimentada pela submissão) — então um boleto do DDA sem correspondência agora é um
sinal mais forte de possível fraude do que hoje. Ação concreta: nenhuma mudança de
código na reconciliação; o ganho vem de já ter mais contas "esperando match" geradas
por um canal confiável (declaração do fornecedor) ao invés de nenhuma.

## Testes

- `tests/portal-fornecedor-auth.test.js`: login com/sem senha definida, convite
  expirado, token de fornecedor rejeitado em rota do painel interno e vice-versa.
- `tests/portal-fornecedor-submissoes.test.js`: criação de submissão, extração OCR
  mockada, cálculo de `bot_verificacao` (duplicidade, formato, mudança de dado
  bancário — casos com e sem histórico anterior).
- `tests/fornecedor-submissoes-router.test.js`: aprovação de dado bancário exige
  `admin`/`gestor`; fila filtra por status corretamente.
- `tests/entradas-service.test.js` (estender existente): confirmar entrada vinculada a
  `fornecedor_submissao_id` atualiza `fornecedor_submissoes.status` e gera múltiplas
  contas a pagar com `parcela_grupo_id` quando há múltiplos boletos.

## Auto-revisão do spec

- Sem placeholders — todas as tabelas, campos e funções têm forma concreta.
- Consistência: `fornecedor_submissoes.status` usado de forma consistente em todas as
  seções; nomes de coluna batem entre a definição da tabela e o código de exemplo.
- Escopo: focado no fluxo de NF de mercadoria; contas recorrentes explicitamente fora
  de escopo, a tratar em spec separada quando priorizado.
