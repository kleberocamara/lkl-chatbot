# Serviços no orçamento (Entrega, Arte Final, Visita de Vistoria, Instalação) — Design

**Data:** 2026-07-04
**Autor:** Kleber + Claude

## Problema / Objetivo

O orçamento hoje só permite itens de **produto** (impressos OFFSET / COMUNICAÇÃO VISUAL) e itens de **revenda**. A equipe precisa cobrar também 4 **serviços** avulsos junto ao orçamento:

1. Entrega
2. Arte Final
3. Visita de Vistoria
4. Instalação

Objetivo: permitir adicionar esses serviços como **linhas do orçamento** (com quantidade e valor manual), sem que virem produção.

## Decisões (do brainstorming)

- **Formato:** itens de serviço selecionáveis no combo de produto do item, num grupo "Serviços" (como o grupo "Revenda").
- **Preço:** sempre **manual** (o vendedor digita). Sem regra de preço automática.
- **Produção:** **só cobrança** — não pedem arte, não pedem m²/material/dimensões, não geram OS, não aparecem no board de produção.
- **Sem migration** e praticamente **sem backend novo** (a arquitetura já suporta).

## Contexto do código (por que quase não muda backend)

- `tipo_producao` em `orcamento_itens` é **texto livre** (já convivem `OFFSET`, `COMUNICAÇÃO VISUAL`, `REVENDA`; sem CHECK constraint). Um novo valor `SERVICO` é seguro.
- [POST /:id/itens](../../../src/modules/orcamentos/router.js) e [PATCH /:id/itens/:itemId](../../../src/modules/orcamentos/router.js) já aceitam `produto`, `tipo_producao`, `tem_arte`, `valor_unitario`/`valor_total`. Um item de serviço é gravado como qualquer outro.
- Auto-precificação: `precificacao.precificarItem('Entrega'…)` não acha regra → retorna `null` → o item fica `preco_origem='manual'` com o valor digitado. Nada a mudar.
- Criação de OS ([os/service.js](../../../src/modules/os/service.js), ~linhas 431/471/486) só considera itens com `tipo_producao IN ('OFFSET','COMUNICAÇÃO VISUAL') AND arte_status='aprovada'`. Um item `SERVICO` com `tem_arte=false` **nunca** é elegível → não gera OS, não pede arte, não vai ao board.
- Total do orçamento e PDF já somam/renderizam todos os `orcamento_itens` — serviços entram naturalmente.

## Arquitetura (mudança concentrada no frontend `public/dashboard.html`)

### Componente 1 — Catálogo de serviços + optgroup no combo

- Nova constante `SERVICOS_LKL = ['Entrega', 'Arte Final', 'Visita de Vistoria', 'Instalação']` (perto de `PRODUTOS_LKL`).
- Em `selectProduto(id, onchange)`: adicionar um `<optgroup label="Serviços">` com uma option por serviço, valor `servico:<Nome>` (ex.: `servico:Entrega`), renderizado após os produtos e antes/depois do grupo Revenda.

### Componente 2 — Modo serviço no formulário do item

Em `onItemProdutoChange(prefix)`, adicionar um ramo para quando `val.startsWith('servico:')`:
- Esconder os campos de m²/dimensões e material (`#${prefix}-larg`, `#${prefix}-alt`, `#${prefix}-mat`) — mesmo mecanismo `el.closest('div').style.display='none'` já usado no modo revenda.
- Esconder/neutralizar o toggle de arte (bloco de `tem_arte`), se visível no formulário.
- Setar o campo somente-leitura de tipo (`#${prefix}-tipo`) para `SERVICO`.
- Esconder a caixa de revenda (`#${prefix}-revenda`) se estiver aberta.
- Mostrar uma dica curta (reusando a caixa de revenda ou um `small`): "Serviço — digite o valor.".
- Ao voltar para um produto normal ou vazio, restaurar a exibição dos campos (o ramo `else` existente já faz isso; garantir que o modo serviço também restaure ao trocar).

### Componente 3 — Envio do item (adicionar e salvar)

Em `adicionarItemOrc(orcId)` (prefixo `ni`) e `salvarItemOrc(orcId, itemId)` (prefixo `ei`), espelhando o tratamento de `revenda:`:
- Detectar `servicoSel = produto && produto.startsWith('servico:')`.
- `produtoNome = servicoSel ? produto.slice(8) : (revSel ? … : produto)`.
- Quando `servicoSel`: forçar no body `tipo_producao='SERVICO'`, `tem_arte=false`, `largura_cm=null`, `altura_cm=null`, `material_id=null`, e **não** enviar campos de revenda.
- Valor: manual. Enviar `valor_unitario` e `valor_total = quantidade * valor_unitario` a partir do que foi digitado. Se o valor vier vazio, tratar como `0` (item manual com valor 0 — vendedor ajusta); **não** enviar `recalcular` para serviço (não há regra a calcular).
- `quantidade`: padrão sensato para serviço é `1`, mas manter o campo de quantidade como está (o vendedor informa; validação existente exige quantidade preenchida).

## Fluxo de dados

1. Vendedor escolhe "Serviços → Instalação" no combo do item.
2. Formulário entra em modo serviço: some m²/material/arte, tipo = `SERVICO`, dica "digite o valor".
3. Vendedor informa quantidade e valor, salva.
4. Frontend envia `produto='Instalação'`, `tipo_producao='SERVICO'`, `tem_arte=false`, valor manual.
5. Backend grava o item; total do orçamento é recalculado; item aparece no orçamento, no PDF e na cobrança.
6. Nenhuma OS é criada; o item não aparece no board de produção.

## Tratamento de erro / bordas

- Serviço sem valor → item com valor 0 (visível ao vendedor para corrigir). Sem crash.
- Trocar o combo de serviço → produto normal → revenda deve restaurar/ocultar os campos corretos a cada troca (o modo serviço limpa o que abriu).
- `tipo_producao='SERVICO'` é inócuo para os fluxos existentes (só OFFSET/CV/REVENDA têm comportamento especial).

## Testes

- **Sem lógica de backend nova** → sem teste unitário novo (a suíte de orçamentos/integração já depende de DB e roda só no VPS).
- **Smoke no VPS:** via API, adicionar um item de serviço a um orçamento de teste (`POST /:id/itens` com `produto='Entrega'`, `tipo_producao='SERVICO'`, `tem_arte=false`, `valor_unitario` manual) e conferir: gravou com `tipo_producao='SERVICO'`, `preco_origem='manual'`, entrou no `total`, e **não** aparece em `itensOffsetDisponiveis`/board (nenhuma OS criada). Limpar o item de teste depois.
- **Validação visual do usuário:** no painel, adicionar cada um dos 4 serviços a um orçamento, conferir que os campos de m²/material/arte somem, que o valor é manual, e que o total soma corretamente.

## Fora de escopo (futuro)

- **Fiscal (NF-e/NFS-e):** Entrega/Instalação/Vistoria são serviços (ISS/NFS-e), não produto (ICMS/NF-e). Incluir uma linha `SERVICO` numa NF-e de produto seria fiscalmente impreciso. Por ora o operador não inclui linhas de serviço na NF-e de produto; o tratamento fiscal de serviços fica como item futuro.
- Regra de preço padrão para serviços (hoje é sempre manual).
- Mapear Entrega/Instalação a etapas de logística na esteira.
