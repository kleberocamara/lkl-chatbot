-- sql/migrations/051_tipos_despesa.sql
-- Substitui o ENUM tipo_despesa_enum (18 valores antigos) por uma tabela com 38
-- categorias, categoria DRE e natureza do gasto. Liga contas_pagar e fornecedores
-- ao cadastro real de fornecedores (fornecedores.id é UUID).

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

-- Novo status 'pendente_classificacao' precisa existir antes do CHECK que o referencia.
-- Nome real da constraint confirmado com: psql "$DATABASE_URL" -c "\d contas_pagar"
ALTER TABLE contas_pagar DROP CONSTRAINT contas_pagar_status_check;
ALTER TABLE contas_pagar ADD CONSTRAINT contas_pagar_status_check
  CHECK (status IN ('pendente','pendente_classificacao','agendado','pago','vencido','cancelado'));

-- fornecedor_id: fornecedores.id é UUID (ver sql/migrations/001_sprint1_foundation.sql)
ALTER TABLE contas_pagar ADD COLUMN fornecedor_id UUID REFERENCES fornecedores(id);
CREATE INDEX idx_contas_pagar_fornecedor_id ON contas_pagar(fornecedor_id);

-- Memória de classificação: 1 fornecedor = 1 categoria padrão
ALTER TABLE fornecedores ADD COLUMN tipo_despesa_padrao_id INTEGER REFERENCES tipos_despesa(id);

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
-- status='pendente_classificacao' até agora).
ALTER TABLE contas_pagar ADD CONSTRAINT chk_tipo_despesa_classificado
  CHECK (tipo_despesa_id IS NOT NULL OR status = 'pendente_classificacao');

ALTER TABLE contas_pagar DROP COLUMN tipo_despesa;
DROP TYPE tipo_despesa_enum;

CREATE INDEX idx_contas_pagar_tipo_despesa_id ON contas_pagar(tipo_despesa_id);

COMMIT;
