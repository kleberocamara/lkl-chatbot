# Processos Operacionais — Gráfica LKL

Repositório dos processos documentados para treinamento de colaboradores e
fornecedores.

## Onde cada coisa mora

| | Onde | Para quê |
|---|---|---|
| **Fonte da verdade** | `docs/processos/PO-XX-*.md`, neste repositório | Guarda o conteúdo. Toda alteração vira commit, com autor, data e histórico completo — é o que permite auditar o que mudou, quando e por quem. |
| **Documento distribuído** | `docs/processos/PO-XX-*.pdf`, gerado do Markdown | O que vai para o colaborador e o fornecedor. Nunca editar o PDF direto: ele é descartável e se refaz do Markdown. |

O PDF carimba versão, vigência e data da próxima revisão em **todas as páginas**.
Quem tiver uma cópia antiga em mãos consegue perceber, sem consultar ninguém, que
existe versão mais nova.

## Índice

| Código | Processo | Versão | Vigência | Próxima revisão | Responsável |
|---|---|---|---|---|---|
| PO-01 | [Liberação de Acesso e Utilização do Portal do Fornecedor](PO-01-portal-fornecedor.md) | 1.0 | 15/09/2026 | 15/03/2027 | Kleber Câmara |

**A numeração nunca é reaproveitada.** Processo descontinuado permanece no índice
marcado como tal; o próximo documento recebe o número seguinte. Reutilizar um
código quebraria a rastreabilidade de treinamentos já realizados.

## Como criar um processo novo

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

## Como revisar um processo existente

Edite o `.md`, **suba a versão** no front matter, acrescente a linha no *Registro de
revisões* ao final do documento dizendo o que mudou, regenere o PDF e atualize o
índice acima.

Revisar sem subir a versão é o erro a evitar: passam a existir dois PDFs diferentes
com o mesmo número de versão, e não há como saber qual está em uso.

## Convenções de escrita

- **Cada passo diz quem executa.** O título do passo termina com o papel
  responsável — "5.2 Liberar o acesso ao portal — Atendimento ou Gestão".
- **Parágrafo iniciado em negrito vira caixa de destaque amarela** no PDF. Use para
  as regras que não podem passar batido numa leitura rápida.
- **Descreva o comportamento real do sistema**, não o desejado. Se a regra mudar no
  código, o processo precisa ser revisado junto.

## Distribuição e acesso

Os PDFs são enviados aos destinatários (colaboradores em treinamento, fornecedores
no momento da liberação de acesso). Este repositório é o arquivo permanente, não o
canal de distribuição: quem precisa da versão vigente consulta o índice acima.

Fornecedor não tem acesso a este repositório — recebe apenas o PDF do processo que
lhe diz respeito.
