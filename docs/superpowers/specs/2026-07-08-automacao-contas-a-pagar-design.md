# Automação de Contas a Pagar — Taxonomia + Classificação Automática + Captura por WhatsApp

## Contexto

O módulo `contas-pagar` já existe e funciona: entrada manual (`financeiro.html`), entrada automática de boletos via DDA (C6 Bank, cron 7h) e pagamento em lote via C6 Bank. O que falta:

1. O `tipo_despesa` é um `ENUM` do Postgres com **18 categorias antigas**, sem noção de categoria DRE nem natureza do gasto — essa informação só existe hoje na planilha `TIPOS DE DESPESAS.xlsx`, fora do sistema. A tabela recém-revisada tem **38 categorias**.
2. Todo boleto importado via DDA cai **sempre** como `tipo_despesa='FORNECEDOR'`, sem nenhuma tentativa de classificação — furo na automação atual.
3. PIX avulso e Nota Fiscal de fornecedor (papel, tinta, etc.) não têm nenhuma entrada automática — hoje dependem de alguém abrir o painel e digitar manualmente.

Este spec cobre dois pedaços que se conectam: (1) uma taxonomia nova + motor de classificação automática, e (2) captura de comprovantes por foto/PDF via WhatsApp, que depende do motor da parte 1 para classificar o que extrai.

## 1. Taxonomia: tabela `tipos_despesa` substitui o enum

**Migration `051_tipos_despesa.sql`:**

```sql
BEGIN;

CREATE TABLE tipos_despesa (
  id            SERIAL PRIMARY KEY,
  codigo        VARCHAR(2) UNIQUE NOT NULL,
  nome          TEXT NOT NULL,
  categoria_dre TEXT NOT NULL,
  natureza      TEXT NOT NULL,
  ativo         BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO tipos_despesa (codigo, nome, categoria_dre, natureza) VALUES
('01','PAPEL E SUBSTRATOS','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('02','TINTAS E QUÍMICOS','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('03','FORNECEDOR (Outros insumos)','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('04','EMBALAGEM','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('05','TERCEIRIZAÇÃO DE IMPRESSÃO','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('06','TERCEIRIZAÇÃO DE ACABAMENTO','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('07','FRETE (Entrega de pedidos)','CUSTOS DE PRODUÇÃO (CPV)','VARIÁVEL (PRODUÇÃO)'),
('08','COMISSÕES','DEDUÇÕES E DESPESAS COMERCIAIS','VARIÁVEL (VENDAS)'),
('09','PUBLICIDADE','DEDUÇÕES E DESPESAS COMERCIAIS','VARIÁVEL (VENDAS)'),
('10','IMPOSTOS (Sobre o Faturamento)','DEDUÇÕES DE VENDAS','VARIÁVEL (FISCAL)'),
('11','SALÁRIOS DA PRODUÇÃO + ENCARGOS','MÃO DE OBRA DIRETA (MOD)','FIXO OPERACIONAL'),
('12','BENEFÍCIOS (Vale Transporte | Refeição)','MÃO DE OBRA DIRETA (MOD)','FIXO OPERACIONAL'),
('13','MANUTENÇÃO DE MAQUINÁRIO','CUSTOS OPERACIONAIS DA FÁBRICA','FIXO OPERACIONAL'),
('14','DEPRECIAÇÃO (Máquinas e Equipamentos)','CUSTOS OPERACIONAIS DA FÁBRICA','FIXO OPERACIONAL'),
('15','ALUGUEL','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('16','AGUA','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('17','LUZ','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('18','TELEFONIA | INTERNET','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('19','MATERIAL DE LIMPEZA','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('20','MATERIAL DE ESCRITORIO','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('21','MANUTENÇAO (Predial)','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('22','IPTU | TAXAS E ALVARÁS','OCUPAÇÃO E INFRAESTRUTURA','FIXO ADMINISTRATIVO'),
('23','SALARIO SOCIOS (Pró-Labore)','PESSOAL E ADMINISTRAÇÃO','FIXO ADMINISTRATIVO'),
('24','CONTADOR | FOLHA PAGAMENTO','SERVIÇOS PROFISSIONAIS','FIXO ADMINISTRATIVO'),
('25','SERVIÇO TERCEIRIZADO (ADM)','SERVIÇOS PROFISSIONAIS','FIXO ADMINISTRATIVO'),
('26','ADVOGADO','SERVIÇOS PROFISSIONAIS','FIXO ADMINISTRATIVO'),
('27','SOFTWARE E ASSINATURAS (Sistema | Hospedagem)','SERVIÇOS PROFISSIONAIS','FIXO ADMINISTRATIVO'),
('28','SEGUROS (Equipamento | Predial | Veicular)','SEGUROS','FIXO ADMINISTRATIVO'),
('29','COMBUSTIVEL','LOGÍSTICA E DESLOCAMENTO','FIXO ADMINISTRATIVO'),
('30','PEDAGIO','LOGÍSTICA E DESLOCAMENTO','FIXO ADMINISTRATIVO'),
('31','IPVA | LICENCIAMENTO VEÍCULO','LOGÍSTICA E DESLOCAMENTO','FIXO ADMINISTRATIVO'),
('32','DESPESA DE VIAGEM','VIAGENS E REPRESENTAÇÃO','FIXO ADMINISTRATIVO'),
('33','ESTADIA HOTEL','VIAGENS E REPRESENTAÇÃO','FIXO ADMINISTRATIVO'),
('34','ALIMENTAÇAO EM VIAGEM','VIAGENS E REPRESENTAÇÃO','FIXO ADMINISTRATIVO'),
('35','TARIFA BANCO','DESPESAS FINANCEIRAS','RESULTADO FINANCEIRO'),
('36','EMPRESTIMO | FINANCIAMENTO (Juros)','DESPESAS FINANCEIRAS','RESULTADO FINANCEIRO'),
('37','MULTAS E PENALIDADES','OUTROS','NÃO OPERACIONAL'),
('38','OUTRAS DESPESAS','OUTROS','NÃO OPERACIONAL');

-- Novo status 'pendente_classificacao' precisa existir antes do CHECK que o referencia
ALTER TABLE contas_pagar DROP CONSTRAINT contas_pagar_status_check;
ALTER TABLE contas_pagar ADD CONSTRAINT contas_pagar_status_check
  CHECK (status IN ('pendente','pendente_classificacao','agendado','pago','vencido','cancelado'));

-- tipo_despesa_id nasce nullable: contas sem classificação automática (status='pendente_classificacao')
-- ficam sem tipo até classificação manual; todas as outras são obrigadas a ter um tipo.
ALTER TABLE contas_pagar ADD COLUMN tipo_despesa_id INTEGER REFERENCES tipos_despesa(id);

-- Migra os dados existentes do enum antigo para o código novo mais próximo
UPDATE contas_pagar cp SET tipo_despesa_id = td.id FROM tipos_despesa td WHERE
  (cp.tipo_despesa = 'ALUGUEL' AND td.codigo = '15') OR
  (cp.tipo_despesa = 'AGUA' AND td.codigo = '16') OR
  (cp.tipo_despesa = 'TARIFA_BANCO' AND td.codigo = '35') OR
  (cp.tipo_despesa = 'FRETE' AND td.codigo = '07') OR
  (cp.tipo_despesa = 'COMBUSTIVEL' AND td.codigo = '29') OR
  (cp.tipo_despesa = 'TELEFONIA_INTERNET' AND td.codigo = '18') OR
  (cp.tipo_despesa = 'MATERIAL_LIMPEZA' AND td.codigo = '19') OR
  (cp.tipo_despesa = 'MATERIAL_ESCRITORIO' AND td.codigo = '20') OR
  (cp.tipo_despesa = 'DESPESA_VIAGEM' AND td.codigo = '32') OR
  (cp.tipo_despesa = 'LUZ' AND td.codigo = '17') OR
  (cp.tipo_despesa = 'IMPOSTOS' AND td.codigo = '10') OR
  (cp.tipo_despesa = 'MANUTENCAO' AND td.codigo = '13') OR
  (cp.tipo_despesa = 'COMISSOES' AND td.codigo = '08') OR
  (cp.tipo_despesa = 'FORNECEDOR' AND td.codigo = '03') OR
  (cp.tipo_despesa = 'SERVICO_TERCEIRIZADO' AND td.codigo = '25') OR
  (cp.tipo_despesa = 'EMPRESTIMO_FINANCIAMENTO' AND td.codigo = '36') OR
  (cp.tipo_despesa = 'CONTADOR_FOLHA_PAGAMENTO' AND td.codigo = '24') OR
  (cp.tipo_despesa = 'OUTRAS_DESPESAS' AND td.codigo = '38');

-- Toda conta pré-existente já tem tipo_despesa_id preenchido nesse ponto (nenhuma tinha
-- status='pendente_classificacao', esse status só passa a existir a partir de agora).
ALTER TABLE contas_pagar ADD CONSTRAINT chk_tipo_despesa_classificado
  CHECK (tipo_despesa_id IS NOT NULL OR status = 'pendente_classificacao');

ALTER TABLE contas_pagar DROP COLUMN tipo_despesa;
DROP TYPE tipo_despesa_enum;

CREATE INDEX idx_contas_pagar_tipo_despesa_id ON contas_pagar(tipo_despesa_id);

COMMIT;
```

Nota para quem implementar: o nome real da constraint de `status` (`contas_pagar_status_check` acima) deve ser confirmado com `\d contas_pagar` no banco antes de rodar o `DROP CONSTRAINT` — Postgres pode ter gerado um nome diferente do que a migration original (`012_contas_pagar.sql`) sugere.

`GET /api/v2/contas-pagar/tipos-despesa` (novo endpoint, `requireRole('admin')`) lista `tipos_despesa` para popular o combo do `financeiro.html`, substituindo a lista hardcoded no HTML hoje.

## 2. Motor de classificação automática

Novo arquivo `src/modules/contas-pagar/classificador.js`, testável isoladamente (funções puras + uma função de I/O):

```js
// normaliza como já faz _norm em src/constants/produtos.js
function normalizarFornecedor(nome) { ... }

// tabela nova: memória fornecedor -> tipo_despesa
// fornecedor_tipo_despesa(fornecedor_normalizado PK, tipo_despesa_id, atualizado_em)

async function buscarPorMemoria(fornecedorNormalizado) { ... }   // SELECT
async function gravarMemoria(fornecedorNormalizado, tipoDespesaId) { ... } // UPSERT

// fallback: tokens do fornecedor/descrição batem com KEYWORDS[codigo]
const KEYWORDS = {
  '01': ['PAPEL','SUBSTRATO','COUCHE','OFFSET'],
  '02': ['TINTA','QUIMICO','TONER'],
  '13': ['MANUTENCAO','CONSERTO','PECA','MAQUINA'],
  '17': ['ENEL','CEMIG','LUZ','ENERGIA'],
  '16': ['SABESP','COPASA','AGUA'],
  '18': ['VIVO','CLARO','TIM','INTERNET','TELEFONIA'],
  '29': ['POSTO','COMBUSTIVEL','GASOLINA','ETANOL'],
  '30': ['PEDAGIO','SEM PARAR','CONECTCAR'],
  '27': ['HOSPEDAGEM','DOMINIO','SAAS','ASSINATURA','SOFTWARE'],
  // ... demais tipos com keywords óbvias; tipos sem termo léxico natural (ex: Pró-Labore) ficam
  // só na memória de fornecedor / classificação manual, sem keyword.
};
function classificarPorPalavraChave(texto) { ... } // retorna tipo_despesa_id ou null

// função pública, usada por DDA / manual / whatsapp
async function classificarDespesa(fornecedor, descricao) {
  const norm = normalizarFornecedor(fornecedor);
  const porMemoria = await buscarPorMemoria(norm);
  if (porMemoria) return { tipo_despesa_id: porMemoria, origem: 'memoria' };
  const porKeyword = classificarPorPalavraChave(`${fornecedor} ${descricao || ''}`);
  if (porKeyword) return { tipo_despesa_id: porKeyword, origem: 'keyword' };
  return { tipo_despesa_id: null, origem: 'nenhum' };
}

module.exports = { classificarDespesa, gravarMemoria, normalizarFornecedor };
```

**Aprendizado automático:** toda vez que `service.criar()` ou `service.atualizar()` grava um `tipo_despesa_id` vindo de escolha manual (não vindo de `classificarDespesa`), chama `gravarMemoria(normalizarFornecedor(fornecedor), tipo_despesa_id)`. Como definido na seção de premissas, é **1 fornecedor = 1 categoria**: `gravarMemoria` faz `UPSERT ... DO UPDATE` (sobrescreve, não acumula histórico).

## 3. Conectar o motor às entradas existentes

- **`sincronizarDDA()`**: em vez de gravar `tipo_despesa='FORNECEDOR'` fixo, chama `classificarDespesa(b.beneficiary_name, null)`. Se retornar `tipo_despesa_id`, grava normalmente com `status='pendente'`. Se retornar `null`, grava com `status='pendente_classificacao'` e `tipo_despesa_id=NULL`.
- **`criar()` (manual)**: aceita `tipo_despesa_id` do body (já escolhido pelo usuário no formulário) — **não muda o contrato atual**, só passa a chamar `gravarMemoria` no final (fire-and-forget, como os outros side-effects do módulo).
- **Novo endpoint `GET /api/v2/contas-pagar/sugerir-tipo?fornecedor=X`**: chama `classificarDespesa(fornecedor)` e devolve `{ tipo_despesa_id, origem }`. `financeiro.html` chama isso via `onblur` do campo fornecedor pra pré-selecionar o combo antes de salvar (usuário sempre pode trocar).
- **`criarRecorrente()`**: mesmo tratamento do `criar()` — usa o `tipo_despesa_id` escolhido e grava a memória.
- **Painel `financeiro.html`**: contas com `status='pendente_classificacao'` aparecem destacadas (ex: badge amarelo "Classificar") no topo da lista; ao editar e salvar com um tipo escolhido, o status volta pra `pendente` automaticamente.

## 4. Captura por foto/PDF via WhatsApp

**Quem pode enviar:** número do remetente precisa bater com `celular` ou `telefone` de algum registro em `funcionarios` com `status` ativo. Normalização de telefone reaproveita o que já existe em `getOrCreateContact`/matching de telefone do webhook atual.

**Fluxo (`src/webhook/handler.js` → `handleInboundMedia`):**

1. Antes do fluxo atual de chatbot, checa: `mediaType` é `image` ou `document` (PDF) **E** telefone bate com funcionário ativo. Se sim, desvia para `handleComprovanteDespesa(phone, mediaType, localPath)` — não passa pelo agente conversacional nem cria/atualiza `conversations`.
2. `handleComprovanteDespesa` chama a OpenAI (mesmo client de `src/ai/agent.js`, `gpt-4o`, que já suporta visão) com o arquivo baixado e um prompt estruturado pedindo JSON: `{ fornecedor, valor, vencimento (YYYY-MM-DD), descricao }`. Se o parse falhar ou campos obrigatórios faltarem, responde no WhatsApp *"Não consegui ler os dados dessa imagem, lance manualmente no painel."* e encerra (sem gravar nada).
3. Chama `classificarDespesa(fornecedor, descricao)`.
4. Grava um registro temporário em nova tabela `despesas_pendentes_confirmacao` (`telefone`, `payload_json`, `criado_em`, expira em 30 min — cron de limpeza reaproveita o padrão de `src/jobs/contas-pagar.js`) e responde:
   > 📄 *Fornecedor:* X · *Valor:* R$ Y · *Vencimento:* Z · *Categoria sugerida:* [nome do tipo] — confirma? Responda *sim* ou *não*.
5. Resposta `sim` (case-insensitive, próxima mensagem de texto desse telefone enquanto houver um pendente não expirado): grava em `contas_pagar` com `tipo_entrada='whatsapp_ocr'`, `status` = `'pendente'` se classificou ou `'pendente_classificacao'` se não, remove o pendente, responde *"✅ Lançado."*
6. Resposta `não` ou qualquer outra coisa: descarta o pendente, responde *"Ok, não lancei. Você pode cadastrar manualmente no painel financeiro."*

Esse fluxo de confirmação é **isolado** da máquina de estados do chatbot de atendimento (`conversations`/`status`) — usa sua própria tabelinha de pendência, então não arrisca interferir no fluxo de orçamento/aprovação de clientes.

**Migration `052_whatsapp_ocr_despesas.sql`:**

```sql
BEGIN;

CREATE TABLE despesas_pendentes_confirmacao (
  id           SERIAL PRIMARY KEY,
  telefone     TEXT NOT NULL,
  fornecedor   TEXT,
  valor        NUMERIC(10,2),
  vencimento   DATE,
  descricao    TEXT,
  tipo_despesa_id INTEGER REFERENCES tipos_despesa(id),
  criado_em    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_despesas_pendentes_telefone ON despesas_pendentes_confirmacao(telefone);

ALTER TABLE contas_pagar ADD CONSTRAINT contas_pagar_tipo_entrada_check2
  CHECK (tipo_entrada IN ('manual','dda','importacao_oc','whatsapp_ocr'));
-- (drop da constraint antiga de tipo_entrada antes, se necessário)

COMMIT;
```

Cron novo em `src/jobs/contas-pagar.js`: a cada 30 min, apaga pendentes com `criado_em < NOW() - INTERVAL '30 minutes'`.

## Testes

- `classificador.test.js`: `classificarDespesa` com memória, com keyword, sem match; `normalizarFornecedor`; `gravarMemoria` (UPSERT sobrescreve).
- `service.test.js` (contas-pagar): `sincronizarDDA` grava `pendente_classificacao` quando sem match e `pendente` quando classifica.
- Smoke manual pós-deploy: reenviar um boleto DDA de teste, mandar uma foto de boleto real pelo WhatsApp do número de um funcionário cadastrado, confirmar leitura e checar gravação em `contas_pagar`.

## Fora de escopo

- Reclassificação em massa das contas históricas além do mapeamento automático da migration.
- Edição da lista de `tipos_despesa`/keywords pela UI (por enquanto só via SQL/migration — like o catálogo de revenda).
- OCR de PIX comprovante de recibo não-fornecedor (ex: comprovante de PIX pessoal do sócio) — mesmo fluxo funciona, mas não há tratamento especial para diferenciar.
