# Melhorar reconhecimento de OCR de nota fiscal (fornecedor, parcelas, competência)

## Contexto

O time financeiro fotografa boletos/notas fiscais de fornecedor e manda pro WhatsApp; o bot faz OCR via GPT-4o vision e lança em `contas_pagar` após confirmação. O usuário reportou taxa de acerto muito baixa. Investigação encontrou 3 causas raiz concretas, todas confirmadas contra um caso real (nota da Konita Brasil, R$1.635,69, parcelada em 2 boletos):

1. **`ocr.js`'s prompt não distingue emitente/remetente (o fornecedor de verdade) de destinatário (a própria LKL).** Sem essa instrução, o modelo tem ~50% de chance de escolher o bloco errado — e escolheu. O "fornecedor" extraído foi literalmente "GRUPO DE GRAFICAS LKL LTDA ME", ou seja, a própria empresa.
2. **Não existe nenhuma trava contra auto-referência.** `fornecedor-matcher.js` cria um fornecedor novo com qualquer nome/CNPJ que o OCR mandar, sem checar se aquele CNPJ é o da própria LKL.
3. **O schema de extração só suporta 1 valor + 1 vencimento.** A nota tinha "PARCELADO 30/45" com 2 boletos; o OCR pegou só o valor/vencimento do 2º boleto (ainda errando o mês: 06→09) e reportou como se fosse a nota inteira.

O sistema já tem `criarParcelado()`/`converterEmParcelado()` (`src/modules/contas-pagar/service.js`), construídos recentemente pro parcelamento manual do dashboard, mas completamente desconectados desse fluxo de WhatsApp.

## Escopo

- Reescrever o prompt de `ocr.js` pra: (a) distinguir emitente/remetente de destinatário, com os CNPJs da LKL listados explicitamente como "nunca é o fornecedor"; (b) extrair `data_entrega` (data de emissão/saída da nota); (c) extrair `parcelas` como array (sempre, mesmo com 1 item).
- Adicionar trava de auto-referência: se o CNPJ extraído for da própria LKL, rejeitar a leitura.
- Confirmação por WhatsApp passa a listar cada parcela individualmente.
- Ao confirmar: 1 parcela usa o fluxo já existente (`criarOuReconciliarContaPagar`, com dedução contra DDA); 2+ parcelas usa `criarParcelado()`.
- `criarOuReconciliarContaPagar` ganha suporte a `competencia`.
- `despesas_pendentes_confirmacao` troca `valor`/`vencimento` únicos por `parcelas JSONB` + `data_entrega DATE`.
- **Fora de escopo**: suporte a PDF na visão do GPT-4o (a API não aceita PDF como `image_url`; time vai padronizar a saída do scanner como PNG ao invés de corrigir no código).

## Design técnico

### 1. `ocr.js` — prompt e schema

Novo `EMPRESA_CNPJS` (env var, `19.296.723/0001-08,44.448.899/0001-85`) injetado no prompt. Novo prompt:

```
Você recebe a foto ou PDF de um boleto ou nota fiscal de compra de uma gráfica (DANFE/NF-e).

IMPORTANTE — identificação do fornecedor:
- O FORNECEDOR é sempre o EMITENTE/REMETENTE da nota (quem vendeu/prestou o serviço) — geralmente no topo do documento, perto do CNPJ do emitente.
- O DESTINATÁRIO (para quem a nota foi emitida) NUNCA é o fornecedor — é o cliente que recebeu a mercadoria.
- Os CNPJs {CNPJ_1} e {CNPJ_2} são da nossa própria empresa (destinatária). Se o CNPJ que você está prestes a extrair como "fornecedor" for um desses, você pegou o bloco errado — procure o CNPJ do emitente, não o do destinatário.

IMPORTANTE — parcelas:
- Se a nota mostrar mais de um vencimento/boleto (ex: "PARCELADO", "BOL=001", "BOL=002", duplicatas), extraia CADA parcela separadamente no array "parcelas" — nunca escolha só uma.
- Se só houver 1 vencimento, "parcelas" ainda é um array, só que com 1 item.
- A soma dos valores das parcelas deve bater com o valor total da nota, se ele aparecer.

Extraia os dados e responda SOMENTE com um JSON no formato:
{"fornecedor": string ou null, "cnpj": string (somente dígitos) ou null, "data_entrega": "YYYY-MM-DD" ou null, "descricao": string ou null, "parcelas": [{"valor": number, "vencimento": "YYYY-MM-DD"}, ...] ou null}

"data_entrega" é a data de emissão ou de entrada/saída da nota (não confundir com vencimento de boleto).
Se não conseguir identificar um campo com confiança, use null nele. Não escreva nada fora do JSON.
```

`extrairDadosComprovante` passa a validar: `fornecedor`, pelo menos 1 parcela válida (`valor` e `vencimento` em cada), `data_entrega` (fallback pra hoje se ausente, mesmo padrão de `criarParcelado`). Retorno muda de `{fornecedor, cnpj, valor, vencimento, descricao}` pra `{fornecedor, cnpj, data_entrega, descricao, parcelas: [{valor, vencimento}, ...]}`.

### 2. `fornecedor-matcher.js` — trava de auto-referência

Nova função:

```js
function ehCnpjProprio(cnpj) {
  const digitos = soDigitos(cnpj);
  if (!digitos) return false;
  const proprios = String(process.env.EMPRESA_CNPJS || '').split(',').map(soDigitos).filter(Boolean);
  return proprios.includes(digitos);
}
```

Exportada. `handleComprovanteDespesa` (em `whatsapp.js`) chama isso ANTES de `encontrarOuCriarFornecedor` — se `true`, aborta com mensagem "Não consegui identificar o fornecedor corretamente (parece que peguei os dados da nossa própria empresa). Lance manualmente no painel." e não grava nada em `despesas_pendentes_confirmacao`.

### 3. `whatsapp.js` — parcelas na confirmação e no lançamento

`handleComprovanteDespesa`: monta a mensagem de confirmação listando cada parcela:

```
📄 Fornecedor: {nome}
Data de entrega: {data_entrega fmt}
Categoria sugerida: {nome do tipo}

1ª parcela: R$ 817,85 — vence 15/06/2026
2ª parcela: R$ 817,84 — vence 29/06/2026

Confirma? Responda sim ou não.
```

(pra 1 parcela só, mostra "Vencimento: R$X — DD/MM" sem numerar, texto mais simples — mesma ideia, menos verboso pro caso comum.)

Grava em `despesas_pendentes_confirmacao`: `data_entrega`, `parcelas` (JSONB), `fornecedor_id`, `descricao`, `tipo_despesa_id` (colunas `valor`/`vencimento` somem).

`processarRespostaDespesaWA`, ao confirmar:

```js
const parcelas = pendente.parcelas; // já vem como array do JSONB
if (parcelas.length === 1) {
  await service.criarOuReconciliarContaPagar({
    fornecedorId: pendente.fornecedor_id, fornecedorNome, descricao: pendente.descricao,
    valor: parcelas[0].valor, vencimento: parcelas[0].vencimento, competencia: pendente.data_entrega,
    tipoDespesaId: pendente.tipo_despesa_id, tipoEntrada: 'whatsapp_ocr', tipo: 'boleto',
  });
} else {
  await service.criarParcelado({
    descricao: pendente.descricao, fornecedor: fornecedorNome, fornecedor_id: pendente.fornecedor_id,
    tipo_despesa_id: pendente.tipo_despesa_id, competencia: pendente.data_entrega,
    tipo: 'boleto', parcelas,
  });
}
```

### 4. `service.js` — `criarOuReconciliarContaPagar` ganha `competencia`

Novo parâmetro `competencia`. No branch de match (UPDATE): adiciona `competencia` ao `SET` se informado (mesma lógica condicional já usada pra `vencimento`/`tipo`). No branch de criação (INSERT): adiciona a coluna `competencia` (se não informado, banco usa o `DEFAULT CURRENT_DATE` já existente — mesmo comportamento de `criar()`).

### 5. Migration nova (próximo número disponível, ex. `054_ocr_parcelas.sql`)

```sql
BEGIN;
ALTER TABLE despesas_pendentes_confirmacao DROP COLUMN valor;
ALTER TABLE despesas_pendentes_confirmacao DROP COLUMN vencimento;
ALTER TABLE despesas_pendentes_confirmacao ADD COLUMN parcelas JSONB NOT NULL DEFAULT '[]';
ALTER TABLE despesas_pendentes_confirmacao ADD COLUMN data_entrega DATE;
COMMIT;
```

Seguro dropar `valor`/`vencimento` sem backfill: a tabela só guarda pendências de confirmação de até 30 minutos (`JANELA_CONFIRMACAO_MINUTOS`), sem valor histórico.

### 6. `.env.example`

Adiciona `EMPRESA_CNPJS=19.296.723/0001-08,44.448.899/0001-85` com comentário explicando o uso (trava de auto-referência no OCR de notas fiscais).

## Testes

- `ocr.js`: não é possível testar a extração real (chama a API do GPT-4o) — sem teste automatizado pra isso, mesmo padrão já usado no resto do arquivo. A validação de shape (`parcelas` array, `data_entrega`, rejeição se faltar campo obrigatório) SIM é testável isoladamente se a função de parse for extraída, mas hoje ela está inline dentro de `extrairDadosComprovante` — extrair a validação pra uma função pura testável (`_validarDadosExtraidos(dados)`) faz parte da implementação.
- `fornecedor-matcher.js`: `ehCnpjProprio()` — teste unitário puro (sem banco), cobrindo: CNPJ com/sem máscara bate um dos dois; CNPJ de terceiro não bate; `EMPRESA_CNPJS` vazio/ausente não quebra.
- `service.js`: `criarOuReconciliarContaPagar` — teste que `competencia` é gravado tanto no branch de match (UPDATE) quanto no de criação (INSERT), mockando `pool.connect()`.
- `whatsapp.js`: sem teste automatizado (mesmo padrão do arquivo hoje — depende de `ocr`/`classificador`/`service` reais, não mockados em nenhum teste existente) — verificação por leitura cuidadosa + smoke manual pós-deploy mandando a mesma nota da Konita de novo.

## Fora de escopo

- Suporte a PDF na visão do GPT-4o (time vai padronizar scanner pra PNG).
- Fila de revisão humana pra extrações de baixa confiança (o OCR continua all-or-nothing: ou extrai com confiança, ou pede pra lançar manual — não há meio-termo "incerto, mas deixa eu tentar").
- Pré-processamento de imagem (crop, rotação, upscale) antes de mandar pro GPT-4o.
