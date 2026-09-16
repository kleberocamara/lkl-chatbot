# Processos Operacionais — Gráfica LKL

Repositório dos processos documentados para treinamento de colaboradores e
fornecedores.

## Os dois formatos

Um processo vive em **um** dos dois formatos, nunca nos dois — conteúdo duplicado
sempre acaba divergindo.

### Manual (treinamento interno)

O **Manual do Sistema**, em `public/manual.html`, é o módulo de treinamento dos
colaboradores, acessível pelo item **📚 Treinamento** do painel. Cada capítulo é um
processo, com código, versão e data de atualização exibidos no próprio capítulo.

O conteúdo vive no array `CHAPTERS` do arquivo — já versionado em git, como o resto
do sistema. Este índice é o registro formal: é aqui que se vê qual a versão vigente
de cada processo e quando cada um deve ser revisto.

### PDF (público externo ou material impresso)

Para quem não tem acesso ao painel — fornecedores, por exemplo — o processo vira um
`.md` neste diretório e um PDF gerado dele. O PDF carimba versão e vigência em todas
as páginas, para que uma cópia antiga se denuncie sozinha.

**Nunca edite o PDF direto**: ele se refaz do Markdown.

## Índice

| Código | Processo | Onde vive | Versão | Vigência | Próxima revisão | Responsável |
|---|---|---|---|---|---|---|
| PO-01 | [Liberação de Acesso e Utilização do Portal do Fornecedor](PO-01-portal-fornecedor.md) | PDF | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-02 | [Conversas com o bot](/manual#conversas) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-03 | [Pedido manual (balcão / vendedor)](/manual#pedidos) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-04 | [Validação, edição e envio do orçamento](/manual#orcamentos) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-05 | [Criação e envio de arte](/manual#artes) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-06 | [Criação da Ordem de Serviço (OS)](/manual#os) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-07 | [Melhor corte e baixa de materiais](/manual#formato) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-08 | [Esteira de produção](/manual#producao) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-09 | [Contas a pagar](/manual#contas-pagar) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-10 | [Cobranças — boleto, PIX e Mercado Pago](/manual#cobrancas) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-11 | [Geração de NF-e](/manual#nfe) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-12 | [Cadastros — fornecedores, clientes, materiais, funcionários e máquinas](/manual#cadastros) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-13 | [Liberação de acesso a usuários](/manual#usuarios) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |
| PO-14 | [Portal do Fornecedor — liberação e conferência](/manual#portal-fornecedor) | Manual | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |

O **PO-01** e o **PO-14** cobrem o mesmo fluxo por lados opostos: o PO-01 é o
documento entregue ao fornecedor, com os passos dele; o PO-14 é o capítulo de
treinamento da equipe, com o que a gráfica faz. **Revisar um exige conferir o
outro** — os dois descrevem as mesmas regras de negócio (prazo do convite, trava de
dado bancário, conta a pagar só na entrega).

**A numeração nunca é reaproveitada.** Processo descontinuado permanece no índice
marcado como tal; o próximo documento recebe o número seguinte. Reutilizar um
código quebraria a rastreabilidade de treinamentos já realizados.

## Como criar um processo novo (formato PDF)

1. Reserve o próximo código livre acrescentando a linha no índice acima, antes de
   escrever — evita dois processos nascerem com o mesmo número.
2. Copie um `.md` existente como ponto de partida e ajuste o *front matter*
   (código, título, versão, vigência, revisão prevista, responsável, público).
3. Escreva seguindo a estrutura padrão: Objetivo, Abrangência, Definições,
   Pré-requisitos, Procedimento, Controles e pontos de atenção, tabelas de apoio e
   Registro de revisões.
4. Gere o PDF e confira antes de distribuir:

```sh
python3 scripts/gerar-processo-pdf.py docs/processos/PO-XX-nome.md
```

5. Commit do `.md` e do `.pdf` juntos, para que a versão distribuída sempre tenha a
   fonte correspondente no mesmo ponto do histórico.

## Como criar um processo novo (formato Manual)

1. Reserve o próximo código livre no índice acima.
2. Acrescente o capítulo ao array `CHAPTERS` em `public/manual.html`, com
   `codigo`, `versao:'1.0'`, `atualizado` (data de hoje), `roles`, `subtitle`,
   `steps`, `tip` e `visual`.
3. A posição no array define a ordem de leitura e a numeração exibida.

## Como revisar um processo existente

**No manual:** edite o capítulo, **suba o `versao`** e atualize o campo `atualizado`.
Depois atualize a linha correspondente neste índice.

**Em PDF:** edite o `.md`, **suba a versão** no front matter, acrescente a linha no
*Registro de revisões* ao final do documento, regenere o PDF e atualize o índice.

Revisar sem subir a versão é o erro a evitar: passam a existir duas versões
diferentes com o mesmo número, e ninguém consegue saber qual está valendo — nem
quem treinou com qual.

## Convenções de escrita

- **Cada passo diz quem executa.** O título do passo termina com o papel
  responsável — "5.2 Liberar o acesso ao portal — Atendimento ou Gestão".
- **Parágrafo iniciado em negrito vira caixa de destaque amarela** no PDF. Use para
  as regras que não podem passar batido numa leitura rápida.
- **Descreva o comportamento real do sistema**, não o desejado. Se a regra mudar no
  código, o processo precisa ser revisado junto.

## Distribuição e acesso

**Colaboradores** acessam o Manual pelo item **📚 Treinamento** do painel. É sempre a
versão vigente, sem cópias circulando por e-mail.

**Fornecedores** não têm acesso ao painel nem a este repositório: recebem apenas o
PDF do processo que lhes diz respeito, no momento da liberação de acesso.
