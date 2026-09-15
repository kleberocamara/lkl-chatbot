---
codigo: PO-01
titulo: Liberação de Acesso e Utilização do Portal do Fornecedor
versao: "1.0"
vigencia: 2026-09-15
revisao_prevista: 2027-03-15
responsavel: Kleber Câmara
aprovado_por: Kleber Câmara
publico: Colaboradores (Atendimento, Gestão, Financeiro) e Fornecedores
---

## 1. Objetivo

Padronizar a liberação de acesso de fornecedores ao Portal do Fornecedor e o envio
de notas fiscais e boletos para pagamento, garantindo que nenhuma obrigação seja
registrada sem a mercadoria correspondente e que alterações de dados bancários
passem por conferência humana.

## 2. Abrangência

Aplica-se a todo fornecedor que emita nota fiscal contra a Gráfica LKL ou a Factor
Comunicação Visual. Envolve três papéis:

- **Atendimento / Gestão** — cadastra o fornecedor e libera o acesso.
- **Fornecedor** — define a senha e envia NF e boletos.
- **Gestão / Financeiro** — trata alertas, confirma o recebimento e gera a conta a pagar.

## 3. Definições

- **Submissão** — conjunto formado por uma NF, seus itens, a forma de pagamento e os
  boletos anexados, enviado de uma só vez pelo fornecedor.
- **Convite** — link de uso único, válido por 7 dias, que permite ao fornecedor
  definir sua senha de acesso.
- **Alerta de dado bancário** — trava automática acionada quando os dados de
  pagamento divergem da última submissão aceita do mesmo fornecedor.

## 4. Pré-requisitos

| Item | Onde | Obrigatório |
|---|---|---|
| Razão social e CNPJ do fornecedor | Aba Fornecedores | Sim |
| E-mail do fornecedor | Aba Fornecedores | Sim — sem ele o sistema recusa a liberação |
| Celular do fornecedor | Aba Fornecedores | Não — se houver, o convite também vai por WhatsApp |

## 5. Procedimento

### 5.1 Cadastrar o fornecedor — Atendimento ou Gestão

Acesse a aba **Fornecedores** e cadastre razão social, CNPJ, e-mail e, quando
disponível, o celular.

O e-mail é o identificador de login do fornecedor no portal. Confira antes de
prosseguir: um e-mail errado envia o convite de acesso a terceiros.

### 5.2 Liberar o acesso ao portal — Atendimento ou Gestão

No cadastro do fornecedor, acione **liberar acesso ao portal**. O sistema:

1. gera um convite de uso único, válido por **7 dias**;
2. envia o link por **e-mail** e, havendo celular cadastrado, também por **WhatsApp**;
3. marca o fornecedor como liberado.

Se o convite expirar, basta liberar novamente — o convite anterior é substituído,
sem duplicar cadastro.

### 5.3 Definir a senha — Fornecedor

O fornecedor abre o link recebido e cadastra a própria senha. O link é consumido
nesse momento e deixa de funcionar.

A Gráfica LKL **não cadastra, não conhece e não solicita** a senha do fornecedor.
Nenhum colaborador deve pedi-la por telefone, e-mail ou WhatsApp.

### 5.4 Enviar NF e boletos — Fornecedor

Acesso pelo endereço **app.graficalkl.com.br/portal-fornecedor/login.html**, opção
**Nova NF**:

1. **Anexar o PDF da nota fiscal.** O sistema tenta ler número, data, valor e itens
   automaticamente. Não conseguindo, os campos ficam disponíveis para preenchimento
   manual — a submissão não é impedida.
2. **Informar a forma de pagamento**: PIX, TED, boleto ou link de pagamento.
3. **Anexar os boletos**, quando houver. O sistema tenta extrair a linha digitável,
   com o mesmo preenchimento manual como alternativa.
4. **Informar a data de entrega agendada** e enviar.

O fornecedor acompanha a situação de cada submissão pelo próprio portal.

### 5.5 Verificação automática — Sistema

Toda submissão é conferida no ato do envio e recebe uma situação inicial:

| Verificação | Situação resultante |
|---|---|
| Nenhum problema encontrado | **Aguardando entrega** |
| Chave PIX fora de formato válido | **Pendente** |
| Linha digitável de boleto inválida | **Pendente** |
| NF já enviada anteriormente pelo mesmo fornecedor | **Pendente** |
| Dados bancários diferentes da última submissão aceita | **Alerta de dado bancário** |

### 5.6 Tratar alertas — Gestão ou Administração

Na aba **Submissões de Fornecedores**, acompanhe a fila.

Submissões em **Alerta de dado bancário** não avançam sozinhas: exigem aprovação
explícita de um usuário com perfil Administrador ou Gestor.

**Antes de aprovar, confirme a alteração com o fornecedor por um canal já conhecido**
— o telefone que consta no cadastro, não um contato informado na própria mensagem
que comunicou a mudança. Esta conferência é o principal controle antifraude do
processo; ver item 6.

### 5.7 Receber a mercadoria e gerar a conta a pagar — Gestão

Quando a mercadoria chega, lance a entrada de estoque vinculada à submissão
correspondente (aba **Entrada NF-e**). Nesse momento, e somente nesse momento,
o sistema:

1. marca a submissão como **aceita**;
2. vincula a entrada de estoque à submissão;
3. **gera a conta a pagar** com valor, vencimento e linha digitável do boleto.

Uma submissão já aceita não pode ser lançada novamente.

## 6. Controles e pontos de atenção

**Nota fiscal enviada não vira obrigação de pagamento.** A conta a pagar só nasce na
confirmação do recebimento (5.7). É proposital: evita pagamento de mercadoria não
entregue. Cobranças de fornecedor antes da entrega devem ser respondidas com esta
regra.

**Mudança de dados bancários trava o fluxo.** O golpe mais comum contra contas a
pagar é a comunicação falsa de nova conta, em nome de um fornecedor legítimo. Por
isso a divergência em relação à última submissão aceita nunca é aprovada
automaticamente. A conferência do item 5.6 é obrigatória e deve ser feita por quem
aprova, não por quem recebeu a comunicação.

**Convite expira em 7 dias.** Passado o prazo, o link não funciona e precisa ser
reemitido pela gráfica.

**Teste do portal exige navegador separado.** Um colaborador logado no sistema da
gráfica no mesmo navegador não consegue usar o portal do fornecedor: a sessão
interna prevalece. Para testar, use uma janela anônima ou outro navegador.

## 7. Situações da submissão

| Situação | Significado | Quem resolve |
|---|---|---|
| Aguardando entrega | Aprovada na verificação, aguardando a mercadoria | Gestão, ao receber |
| Pendente | Há inconsistência a esclarecer com o fornecedor | Gestão |
| Alerta de dado bancário | Dados de pagamento mudaram e exigem confirmação | Administrador ou Gestor |
| Aceita | Mercadoria recebida e conta a pagar gerada | — |
| Rejeitada | Submissão recusada | — |

## 8. Registro de revisões

| Versão | Data | Alteração | Responsável |
|---|---|---|---|
| 1.0 | 15/09/2026 | Emissão inicial | Kleber Câmara |
