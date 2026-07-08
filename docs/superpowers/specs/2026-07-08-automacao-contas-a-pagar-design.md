# Automação de Contas a Pagar — Taxonomia + Classificação Automática + Captura por WhatsApp

## Contexto

O módulo `contas-pagar` já existe e funciona: entrada manual (`financeiro.html`), entrada automática de boletos via DDA (C6 Bank, cron 7h) e pagamento em lote via C6 Bank. O que falta:

1. O `tipo_despesa` é um `ENUM` do Postgres com **18 categorias antigas**, sem noção de categoria DRE nem natureza do gasto — essa informação só existe hoje na planilha `TIPOS DE DESPESAS.xlsx`, fora do sistema. A tabela recém-revisada tem **38 categorias**.
2. Todo boleto importado via DDA cai **sempre** como `tipo_despesa='FORNECEDOR'`, sem nenhuma tentativa de classificação — furo na automação atual.
3. PIX avulso e Nota Fiscal de fornecedor (papel, tinta, etc.) não têm nenhuma entrada automática — hoje dependem de alguém abrir o painel e digitar manualmente.

Este spec cobre quatro pedaços que se conectam: (1) taxonomia nova, (2) motor de classificação automática ancorado no cadastro real de fornecedores, (3) reconciliação entre a entrada de NF (estoque) e o boleto correspondente do DDA — pra não duplicar a mesma dívida — e (4) captura de comprovantes por foto/PDF via WhatsApp.

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

## 2. Fornecedor: cadastro automático + memória de classificação

A tabela `fornecedores` já existe (nome, CNPJ, categoria, contato) e já é usada por `entradas_estoque` (compras via NF-e) e pelo cadastro manual. O motor de classificação usa essa tabela como fonte da verdade em vez de inventar uma memória paralela por texto solto.

**Migration `051_tipos_despesa.sql` (mesma migration da seção 1, continuação):**

```sql
ALTER TABLE fornecedores ADD COLUMN tipo_despesa_padrao_id INTEGER REFERENCES tipos_despesa(id);
ALTER TABLE contas_pagar ADD COLUMN fornecedor_id INTEGER REFERENCES fornecedores(id);
CREATE INDEX idx_contas_pagar_fornecedor_id ON contas_pagar(fornecedor_id);
```

`contas_pagar.fornecedor` (texto livre) continua existindo para exibição/histórico e para os casos em que não há um cadastro formal (ex: despesa avulsa sem fornecedor recorrente, tipo "Multas"), mas passa a ser preenchido a partir do `fornecedores.nome` quando há vínculo.

**`src/modules/contas-pagar/fornecedor-matcher.js`** (novo arquivo, testável isoladamente):

```js
function normalizarNome(nome) { ... } // mesmo padrão de _norm em src/constants/produtos.js
function soDigitos(s) { ... }         // já existe em src/modules/entradas/service.js — reaproveitar/extrair

// Localiza fornecedor por CNPJ (exato) ou, sem CNPJ, por nome normalizado (exato).
// Sem match nenhum: cria um cadastro mínimo (nome, cnpj se houver, status='ativo').
async function encontrarOuCriarFornecedor({ nome, cnpj }) { ... } // retorna fornecedores.id
```

**`src/modules/contas-pagar/classificador.js`** (novo arquivo):

```js
// fallback por palavra-chave — só usado quando o fornecedor é novo e ainda não tem
// tipo_despesa_padrao_id definido
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
  // demais tipos sem termo léxico natural (Pró-Labore, Depreciação etc.) ficam só na
  // memória de fornecedor / classificação manual, sem keyword.
};
function classificarPorPalavraChave(texto) { ... } // retorna tipo_despesa_id ou null

// função pública, usada por DDA / manual / whatsapp
async function classificarDespesa({ fornecedorId, nomeFornecedor, descricao }) {
  const fornecedor = await buscarFornecedor(fornecedorId); // já tem tipo_despesa_padrao_id?
  if (fornecedor?.tipo_despesa_padrao_id) {
    return { tipo_despesa_id: fornecedor.tipo_despesa_padrao_id, origem: 'fornecedor' };
  }
  const porKeyword = classificarPorPalavraChave(`${nomeFornecedor} ${descricao || ''}`);
  if (porKeyword) return { tipo_despesa_id: porKeyword, origem: 'keyword' };
  return { tipo_despesa_id: null, origem: 'nenhum' };
}

module.exports = { classificarDespesa, classificarPorPalavraChave };
```

**Aprendizado automático:** toda vez que uma conta é gravada/editada com `tipo_despesa_id` escolhido manualmente (não vindo de `classificarDespesa`) **e** tem `fornecedor_id`, grava esse tipo em `fornecedores.tipo_despesa_padrao_id` (`UPDATE`, sobrescreve — premissa confirmada: 1 fornecedor = 1 categoria). Fica em `service.js`, fire-and-forget, junto da gravação da conta.

## 3. Conectar às entradas existentes (DDA, manual, entrada de estoque) sem duplicar

Hoje `entradas_estoque` (lançamento de NF-e de compra, dá entrada no estoque) **não cria** nenhuma linha em `contas_pagar` — são dois sistemas desconectados, e por isso ainda não existe duplicação na prática. Mas os dois pontos abaixo, juntos, criam esse risco, então o design já nasce com reconciliação:

- **Entrada de estoque passa a gerar a dívida também.** `entradas/service.js confirmar()` ganha uma chamada final: para cada `entradas_estoque` confirmada com `fornecedor_id` e `valor_total`, chama `criarOuReconciliarContaPagar({ fornecedorId, valor: valor_total, vencimento: null, origem: 'entrada_estoque', origemId: entrada.id })`. Sem `vencimento` conhecido ainda (a NF não é o boleto), essa conta nasce com `vencimento` provisório = `emitida_em + 30 dias` (ajustável manualmente) e `status='pendente_classificacao'` ou `'pendente'` conforme a classificação automática.
- **`sincronizarDDA()`** deixa de inserir sempre uma linha nova. Primeiro tenta casar o fornecedor do boleto (`encontrarOuCriarFornecedor`), depois chama a mesma função `criarOuReconciliarContaPagar`, passando também `linha_digitavel`.

**`criarOuReconciliarContaPagar({ fornecedorId, valor, vencimento, linha_digitavel, ... })`** (em `service.js`):

1. Busca em `contas_pagar` uma linha com `fornecedor_id` igual, `valor` igual (exato — NF e boleto devem bater no centavo), `linha_digitavel IS NULL`, `status IN ('pendente','pendente_classificacao')`, e (se `vencimento` informado) dentro de uma janela de ±10 dias.
2. **Exatamente uma correspondência**: `UPDATE` nela — preenche `linha_digitavel` (se veio do DDA), `vencimento` real (se o dado novo é mais confiável, i.e. veio do DDA), `tipo='boleto'`. Não cria linha nova.
3. **Zero ou mais de uma correspondência**: insere uma linha nova normalmente (mais seguro que arriscar mesclar errado — casos ambíguos ficam para conferência manual no painel).
4. Roda `classificarDespesa` se a linha (nova ou existente) ainda não tem `tipo_despesa_id`.

`financeiro.html` mostra, na linha da conta, uma tag pequena indicando a origem (`Entrada de Estoque`, `DDA`, `Manual`, `WhatsApp`) para dar visibilidade de quando uma reconciliação aconteceu.

- **`criar()` (manual)**: aceita `fornecedor_id` (select com busca, reaproveitando o padrão de busca já usado em outros módulos) além do texto livre `fornecedor` (fallback pra quando não há cadastro). Ao informar `fornecedor_id`, o formulário chama `GET /api/v2/contas-pagar/sugerir-tipo?fornecedor_id=X` pra pré-selecionar a categoria.
- **`criarRecorrente()`**: mesmo tratamento — usa `tipo_despesa_id` escolhido e grava a memória no fornecedor.
- **Painel `financeiro.html`**: contas com `status='pendente_classificacao'` aparecem destacadas (badge amarelo "Classificar") no topo da lista; salvar com um tipo escolhido volta o status pra `pendente` automaticamente.

## 4. Captura por foto/PDF via WhatsApp

**Canal:** não cria número novo nem Cloud API adicional. O comprovante é enviado **para o número do chatbot que já existe hoje** (já tem Cloud API/webhook funcionando) — o número **(21) 98402-3229** é uma linha dedicada do financeiro (não é celular pessoal de ninguém) usada só pra fotografar e mandar os documentos. O sistema identifica esse fluxo pelo número **remetente**.

**Quem pode enviar:** lista de números autorizados via variável de ambiente `CONTAS_PAGAR_WHATSAPP_NUMEROS` (formato `5521984023229` separado por vírgula se houver mais de um no futuro) — mesmo padrão já usado para `OWNER_WHATSAPP`. Não usa `funcionarios.celular` (evita misturar telefone pessoal com documentação sensível da empresa).

**Fluxo (`src/webhook/handler.js` → `handleInboundMedia`):**

1. Antes do fluxo atual de chatbot, checa: `mediaType` é `image` ou `document` (PDF) **E** o telefone remetente está em `CONTAS_PAGAR_WHATSAPP_NUMEROS`. Se sim, desvia para `handleComprovanteDespesa(phone, mediaType, localPath)` — não passa pelo agente conversacional nem cria/atualiza `conversations`.
2. `handleComprovanteDespesa` chama a OpenAI (mesmo client de `src/ai/agent.js`, `gpt-4o`, que já suporta visão) com o arquivo baixado e um prompt estruturado pedindo JSON: `{ fornecedor, cnpj, valor, vencimento (YYYY-MM-DD), descricao }`. Se o parse falhar ou campos obrigatórios faltarem, responde no WhatsApp *"Não consegui ler os dados dessa imagem, lance manualmente no painel."* e encerra (sem gravar nada).
3. Chama `encontrarOuCriarFornecedor({ nome: fornecedor, cnpj })` e depois `classificarDespesa({ fornecedorId, nomeFornecedor: fornecedor, descricao })`.
4. Grava um registro temporário em nova tabela `despesas_pendentes_confirmacao` (`telefone`, `fornecedor_id`, `valor`, `vencimento`, `descricao`, `tipo_despesa_id`, `criado_em`, expira em 30 min — cron de limpeza reaproveita o padrão de `src/jobs/contas-pagar.js`) e responde:
   > 📄 *Fornecedor:* X · *Valor:* R$ Y · *Vencimento:* Z · *Categoria sugerida:* [nome do tipo] — confirma? Responda *sim* ou *não*.
5. Resposta `sim` (case-insensitive, próxima mensagem de texto desse telefone enquanto houver um pendente não expirado): chama `criarOuReconciliarContaPagar(...)` com `tipo_entrada='whatsapp_ocr'` (reconcilia com uma entrada de estoque pendente do mesmo fornecedor/valor, se existir — mesma lógica da seção 3). Remove o pendente, responde *"✅ Lançado."*
6. Resposta `não` ou qualquer outra coisa: descarta o pendente, responde *"Ok, não lancei. Você pode cadastrar manualmente no painel financeiro."*

Esse fluxo de confirmação é **isolado** da máquina de estados do chatbot de atendimento (`conversations`/`status`) — usa sua própria tabelinha de pendência, então não arrisca interferir no fluxo de orçamento/aprovação de clientes.

**Migration `052_whatsapp_ocr_despesas.sql`:**

```sql
BEGIN;

CREATE TABLE despesas_pendentes_confirmacao (
  id              SERIAL PRIMARY KEY,
  telefone        TEXT NOT NULL,
  fornecedor_id   INTEGER REFERENCES fornecedores(id),
  valor           NUMERIC(10,2),
  vencimento      DATE,
  descricao       TEXT,
  tipo_despesa_id INTEGER REFERENCES tipos_despesa(id),
  criado_em       TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_despesas_pendentes_telefone ON despesas_pendentes_confirmacao(telefone);

ALTER TABLE contas_pagar DROP CONSTRAINT contas_pagar_tipo_entrada_check;
ALTER TABLE contas_pagar ADD CONSTRAINT contas_pagar_tipo_entrada_check
  CHECK (tipo_entrada IN ('manual','dda','importacao_oc','whatsapp_ocr','entrada_estoque'));

COMMIT;
```

(Nome real da constraint de `tipo_entrada` também deve ser confirmado com `\d contas_pagar` antes do `DROP CONSTRAINT`, mesma ressalva da seção 1.)

Cron novo em `src/jobs/contas-pagar.js`: a cada 30 min, apaga pendentes com `criado_em < NOW() - INTERVAL '30 minutes'`.

## Testes

- `fornecedor-matcher.test.js`: match por CNPJ, match por nome normalizado, criação de fornecedor novo quando não há match.
- `classificador.test.js`: `classificarDespesa` com `tipo_despesa_padrao_id` do fornecedor, com keyword, sem match nenhum.
- `service.test.js` (contas-pagar): `criarOuReconciliarContaPagar` — mescla quando há 1 correspondência, cria nova quando há 0 ou 2+, aprendizado grava `fornecedores.tipo_despesa_padrao_id`.
- Smoke manual pós-deploy: confirmar uma NF de entrada de estoque (gera conta `pendente`), depois simular o DDA do boleto correspondente (mesmo fornecedor/valor) e confirmar que **mescla** em vez de duplicar; mandar uma foto de boleto pelo número dedicado do financeiro, confirmar leitura e checar gravação em `contas_pagar`.

## Fora de escopo

- Reclassificação em massa das contas históricas além do mapeamento automático da migration.
- Edição da lista de `tipos_despesa`/keywords pela UI (por enquanto só via SQL/migration — como o catálogo de revenda).
- Fusão automática de fornecedores duplicados (ex: cadastro criado sem CNPJ que depois se descobre ser o mesmo de um já existente) — fica para conferência manual via CRUD de fornecedores já existente.
- OCR de comprovante de PIX pessoal (não ligado a um fornecedor) — o fluxo funciona, mas cria um fornecedor "avulso" pelo nome informado, sem tratamento especial.
