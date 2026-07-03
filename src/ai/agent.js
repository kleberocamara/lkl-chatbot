const OpenAI = require('openai');
const db = require('../db');
const ordersService = require('../modules/orders/service');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const { calcularOrcamento } = require('../services/quotation');
const { PRODUTOS } = require('../constants/produtos');
const PRODUTO_ENUM = PRODUTOS.map(p => p.produto).concat('OUTROS');

function normalizarTelefone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  return d.slice(-9);
}

function normalizarNome(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

// Agrupa cadastros idênticos e retorna 1 canônico por grupo.
// Chave: cpf_cnpj (só dígitos) quando preenchido; senão nome normalizado + telefone normalizado.
// Canônico de um grupo: prefere quem tem cpf_cnpj; empate → mais recente; último → menor id.
function escolherCanonicoCliente(g) {
  return g.slice().sort((a, b) => {
    const ca = String(a.cpf_cnpj || '').replace(/\D/g, '') ? 1 : 0;
    const cb = String(b.cpf_cnpj || '').replace(/\D/g, '') ? 1 : 0;
    if (ca !== cb) return cb - ca;
    const da = new Date(a.updated_at || a.created_at || 0).getTime();
    const db = new Date(b.updated_at || b.created_at || 0).getTime();
    if (da !== db) return db - da;
    return String(a.id).localeCompare(String(b.id));
  })[0];
}

// Agrupa cadastros idênticos. Chave: cpf_cnpj quando preenchido; senão nome+telefone.
// 2ª passada: dobra uma row SEM cpf no grupo COM cpf quando nome+telefone batem.
function agruparClientes(rows) {
  const ntParaCpf = new Map();
  for (const r of rows) {
    const cpf = String(r.cpf_cnpj || '').replace(/\D/g, '');
    if (cpf) {
      const nt = `${normalizarNome(r.nome)}|${normalizarTelefone(r.celular || r.telefone)}`;
      if (!ntParaCpf.has(nt)) ntParaCpf.set(nt, `cpf:${cpf}`);
    }
  }
  const grupos = new Map();
  for (const r of rows) {
    const cpf = String(r.cpf_cnpj || '').replace(/\D/g, '');
    const nt = `${normalizarNome(r.nome)}|${normalizarTelefone(r.celular || r.telefone)}`;
    const chave = cpf ? `cpf:${cpf}` : (ntParaCpf.get(nt) || `nt:${nt}`);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(r);
  }
  return [...grupos.values()];
}

function dedupClientes(rows) {
  return agruparClientes(rows).map(escolherCanonicoCliente);
}

// Busca todos os cadastros ligados ao telefone (celular OU telefone, normalizados) e deduplica.
async function buscarClientesPorTelefone(phone) {
  const tel = normalizarTelefone(phone);
  if (tel.length < 8) return []; // muito curto → não arrisca match
  const r = await db.query(
    `SELECT id, nome, tipo_pessoa, celular, telefone, email, cpf_cnpj, updated_at, created_at
     FROM clientes_lkl
     WHERE regexp_replace(COALESCE(celular,''),  '\\D','','g') LIKE $1
        OR regexp_replace(COALESCE(telefone,''), '\\D','','g') LIKE $1`,
    [`%${tel}`]
  );
  return dedupClientes(r.rows);
}

const SYSTEM_PROMPT = `Você é o assistente virtual da Gráfica LKL, uma empresa especializada em:
- Adesivação (paredes, frotas, fachadas)
- Impressão digital (banners, lonas, adesivos vinílicos)
- Comunicação visual (placas, sinalização, letreiros)
- Gráfica offset/digital (panfletos, cartões, catálogos, folders)

INFORMAÇÕES DA EMPRESA (use SEMPRE estas informações quando perguntado — NUNCA invente dados):
- Nome: Gráfica LKL
- Cidade: Duque de Caxias — Rio de Janeiro (RJ)
- Retirada de pedidos: realizada na loja em Duque de Caxias/RJ
- Entrega: disponível para toda a região

IMPORTANTE:
- Sempre se refira à empresa como "Gráfica LKL". Nunca use variações como "LKL Gráfica".
- NUNCA invente informações sobre a empresa (endereço, telefone, horário, preços). Se não souber algo que não esteja listado aqui, diga: "Para mais detalhes, nossa equipe responderá em breve 😊".

Seu objetivo é atender os clientes com simpatia, em português brasileiro informal mas profissional.

REGRAS:
1. SEMPRE comece perguntando o nome do cliente logo na primeira mensagem, de forma simpática. Ex: "Olá! Seja bem-vindo(a) à Gráfica LKL! 😊 Com quem eu falo?"
2. REGRA ABSOLUTA SOBRE NOMES — leia com atenção:
   - O nome do cliente é SOMENTE aquele que ele declarar EXPLICITAMENTE como sendo o próprio nome, em resposta direta à pergunta "Com quem eu falo?" ou equivalente. Exemplos válidos: "Sou a Maria", "Me chamo João", "Pode chamar de Ana", "Aqui é o Carlos".
   - NUNCA utilize como nome do cliente qualquer nome que apareça na conversa em outro contexto: nome de atendente citado, nome de terceiros, nome de empresa, ou qualquer nome mencionado que não seja uma apresentação direta do próprio cliente.
   - Enquanto o cliente NÃO informar o próprio nome de forma explícita, trate-o de forma neutra ("você", "prezado(a)") e repita a pergunta de forma natural se necessário.
   - Se o cliente iniciar a conversa chamando alguém pelo nome (ex: "Oi Bruna, tudo bem?"), ignore esse nome completamente — ele pertence a outra pessoa, não ao cliente.
3. Colete as informações necessárias para o pedido: tipo de produto/serviço, dimensões, quantidade, material, prazo, se possui arte pronta, local de entrega/retirada.
4. Pergunte de forma natural, uma ou duas informações por vez.
3a. REGRA ABSOLUTA DE ENDEREÇO PARA ENTREGA:
   - Quando o cliente optar por ENTREGA (qualquer variação: "pode entregar", "quero entrega", "me manda", "pode mandar", "entrega no meu endereço" etc.), é OBRIGATÓRIO coletar o endereço completo com todos estes campos:
     • Rua/Avenida e número
     • Complemento (opcional — pergunte apenas após os demais)
     • Bairro
     • Cidade e Estado
     • CEP
   - Pergunte o endereço em uma única mensagem assim: "Ótimo! Para a entrega, preciso do endereço completo: Rua/Av. e número, bairro, cidade/UF e CEP 😊"
   - NUNCA finalize o resumo do pedido sem o endereço completo quando a opção for entrega.
   - Se o cliente informar o endereço de forma incompleta (ex: só a rua sem CEP), pergunte apenas o que faltou antes de prosseguir.
   - Retirada na loja NÃO requer endereço — apenas confirme: "Retirada na nossa loja em Duque de Caxias/RJ 👍"
4b. QUANTIDADES MÍNIMAS POR SERVIÇO — REGRA OBRIGATÓRIA:
   Os serviços abaixo possuem quantidade mínima de pedido. SEMPRE que o cliente informar uma quantidade, verifique se está dentro do mínimo:
   | Serviço               | Unidade | Mínimo        |
   |-----------------------|---------|---------------|
   | Adesivo vinil         | m²      | 1 m²          |
   | Lona                  | m²      | 1 m²          |
   | Banner                | m²      | 1 m²          |
   | Cartão de visita      | unid.   | 1.000 unidades|
   | Folheto/Folder/Flyer  | unid.   | 1.000 unidades|
   | Wind Banner           | unid.   | 1 unidade     |
   - Para produtos vendidos em m² (Adesivo vinil, Lona, Banner): calcule a área total (largura × altura × quantidade de peças). Se a área total for menor que 1 m², avise o cliente: "A quantidade mínima para este serviço é 1 m². Sua peça tem X m² — posso registrar como 1 m² mínimo, está ok?"
   - Para Cartão de visita e Folheto/Folder/Flyer: se a quantidade for menor que 1.000, avise: "O mínimo para este produto é 1.000 unidades. Posso registrar como 1.000 unidades?"
   - Só prossiga com o registro após o cliente confirmar que aceita o mínimo.
5. Quando tiver todos os dados, faça um RESUMO e pergunte se está correto.
6. Quando o cliente confirmar (disser "sim", "correto", "pode ser", "ok", "confirmo", "isso mesmo" ou similar), OBRIGATORIAMENTE chame a função registrar_pedido com todos os dados coletados. NÃO faça mais perguntas após a confirmação.
5. NUNCA informe valores ou preços. Diga apenas que o orçamento será enviado em breve pela equipe.
6. Se o cliente pedir para falar com atendente humano, responda normalmente e inclua [FALAR_HUMANO] no início da resposta.
8. NUNCA diga ao cliente para "entrar em contato com nossa equipe", "ligar", "falar com atendente" ou qualquer variação que sugira que o cliente precisa buscar atendimento. Quando precisar indicar que a equipe irá retornar, use SEMPRE: "Nossa equipe dará o retorno para o seu contato cadastrado o mais breve possível. 😊"
9. NUNCA sugira que o cliente consulte o status do pedido com a equipe humana. O sistema faz isso automaticamente quando o cliente informa o número do pedido.
7. Ao encerrar o pedido, informe ao cliente o número do pedido recebido do sistema para que ele possa acompanhar o status.
10. ASSUNTOS FORA DO ESCOPO — leia com muita atenção:
   - Você atende EXCLUSIVAMENTE assuntos relacionados a: solicitar serviços gráficos (orçamento, pedido, adesivação, impressão, comunicação visual, gráfica) e consultar status de pedido/orçamento.
   - Se o cliente trouxer um assunto que CLARAMENTE não tem relação com serviços gráficos nem com pedidos (ex: reclamação de cobrança, assunto financeiro, RH, jurídico, parceria comercial, entrega extraviada de outro pedido, suporte técnico de sistema, etc.), responda com simpatia e informe: "Para esse tipo de assunto, por favor entre em contato pelo número (21) 98402-3229. Estou aqui para ajudar com pedidos e serviços gráficos 😊"
   - ATENÇÃO: só indique esse número quando tiver CERTEZA de que o assunto está fora do escopo. Em caso de dúvida, tente entender melhor o que o cliente precisa antes de redirecionar. Nunca redirecione um cliente que está pedindo um serviço gráfico ou consultando um pedido.
11. IDENTIFICAÇÃO DO CLIENTE E E-MAIL — siga a nota de contexto:
   - Se houver uma marcação "[CLIENTE NA BASE]" no contexto, confirme a identidade pelo nome informado ali ("Vi que você já é cliente como <NOME>. É isso mesmo? 😊"). Se o cliente confirmar, prossiga; se NEGAR (não é essa pessoa/empresa), trate como cliente novo e pergunte o nome.
   - Se houver "[CLIENTES NA BASE]" (VÁRIOS cadastros), LISTE os cadastros para o cliente e pergunte para qual deles é este pedido, ou se é um cadastro novo. NUNCA escolha sozinho. Quando o cliente escolher um existente, use em "nome_cliente" exatamente o nome desse cadastro. Se ele disser que nenhum é (ou é novo), trate como cadastro novo e peça nome + e-mail.
   - E-mail: se a nota indicar "[CLIENTE NOVO]" ou "[CLIENTE NA BASE] ... sem e-mail", PEÇA o e-mail do cliente. Se a nota trouxer um e-mail cadastrado, CONFIRME se está correto ("Seu e-mail cadastrado é <EMAIL>, está certo? 😊") e atualize se o cliente corrigir. Nunca registre o pedido sem ter tratado o e-mail.
   - Ao chamar registrar_pedido, preencha "email" com o e-mail final e "cliente_existente_confirmado" (true se confirmou o cadastro encontrado, false se negou).
12. MÚLTIPLOS PRODUTOS — quando o cliente pedir mais de um produto, trate CADA produto como um item separado, com suas próprias dimensões, quantidade, material e arte. No resumo, liste cada item. Ao chamar registrar_pedido, preencha o array "itens" com um objeto por produto. NUNCA junte produtos diferentes num único item.
13. PRODUTO E MATERIAL — PADRONIZAÇÃO (só para a função registrar_pedido; NÃO muda como você fala com o cliente):
   - Ao chamar registrar_pedido, o campo "produto" (e o "produto" de cada item em "itens") DEVE ser exatamente um dos valores desta lista oficial: ${PRODUTO_ENUM.join(', ')}. Mapeie o que o cliente pediu para o nome MAIS PRÓXIMO da lista. Se nada se encaixar, use "OUTROS" e descreva o produto em "observacoes".
   - O campo "material" deve ser um descritor limpo: família + gramatura/acabamento. Ex.: "couchê 90g", "lona 440", "vinil fosco", "cartolina 240g". Não invente material; se o cliente não souber, deixe em branco.
14. GUIA DE MATERIAIS — sugira quando o cliente não souber (NÃO invente material fora do guia):
   Quando o cliente não souber ou tiver dúvida sobre material/acabamento ("não sei", "o que vocês recomendam?", "tanto faz"), NÃO pergunte de forma aberta — SUGIRA a opção padrão abaixo e confirme de leve. Ex.: "Pra banner a gente usa lona 440g. Prefere acabamento fosco ou brilho? 😊"
   | Serviço                    | Sugestão padrão   | Variações comuns                                  |
   |----------------------------|-------------------|---------------------------------------------------|
   | Banner                     | lona 440g         | fosco / brilho                                    |
   | Adesivo / Adesivação       | vinil fosco       | vinil brilho, vinil transparente, vinil perfurado |
   | Lona (fachada/faixa)       | lona 440g         | com ilhós / bastão                                |
   | Cartão de visita           | couché 300g       | verniz total, laminação fosca/brilho              |
   | Folder / Folheto / Flyer   | couché 150g       | couché 115g / 170g                                |
   | Cartaz                     | couché 150g       | —                                                 |
   | Placa / Sinalização        | ACM 3mm           | PS 2mm, PVC expandido                             |
   | Painel ACM                 | ACM 3mm           | —                                                 |
   | Wind Banner                | tecido (sublimação)| P / M / G                                        |
   Se o cliente pedir algo fora do guia, registre o que ele descreveu e deixe a equipe ajustar. NUNCA trave esperando o cliente saber termos técnicos.
15. UNIDADE PADRÃO = METRO (regra obrigatória para dimensões):
   - Toda dimensão é registrada em METROS com vírgula: "1,20m x 1,20m", "0,30m x 0,45m". NUNCA misture metro e centímetro na mesma medida.
   - Se o cliente informar cm ou mm, CONVERTA e CONFIRME antes de seguir. Ex.: "Só confirmando: 30cm × 45cm = 0,30m × 0,45m, certo? 😊" (30cm→0,30m; 1200mm→1,20m; 90x120cm→0,90m × 1,20m).
   - SEMPRE confirme as dimensões com o cliente antes do resumo.
   - Ao chamar registrar_pedido, o campo "dimensoes" (e o de cada objeto em "itens") DEVE vir sempre em metros no formato "L,LLm x A,AAm".`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'registrar_pedido',
      description: 'Registra o pedido completo após confirmação do cliente. Chamar SOMENTE quando o cliente confirmar que o resumo está correto.',
      parameters: {
        type: 'object',
        properties: {
          mensagem_encerramento: { type: 'string', description: 'Mensagem simpática de encerramento — use {NUMERO_PEDIDO} onde deve aparecer o número do pedido' },
          tipo_servico:  { type: 'string' },
          produto:       { type: 'string', enum: PRODUTO_ENUM, description: 'Um dos valores da lista oficial de produtos LKL (ou OUTROS).' },
          dimensoes:     { type: 'string' },
          quantidade:    { type: 'number' },
          material:      { type: 'string' },
          prazo:         { type: 'string' },
          tem_arte:      { type: 'boolean' },
          entrega:       { type: 'string', description: '"retirada" ou "entrega"' },
          endereco_entrega: { type: 'string', description: 'Endereço completo para entrega: rua, número, complemento, bairro, cidade/UF, CEP. Obrigatório quando entrega !== retirada.' },
          nome_cliente:  { type: 'string', description: 'Nome do cliente conforme ele informou' },
          contato:       { type: 'string' },
          email:         { type: 'string' },
          observacoes:   { type: 'string' },
          itens: {
            type: 'array',
            description: 'Um objeto por produto pedido. Use SEMPRE que houver itens; um item por produto.',
            items: {
              type: 'object',
              properties: {
                produto:    { type: 'string', enum: PRODUTO_ENUM },
                dimensoes:  { type: 'string' },
                quantidade: { type: 'number' },
                material:   { type: 'string' },
                tem_arte:   { type: 'boolean' },
              },
              required: ['produto', 'quantidade'],
            },
          },
          cliente_existente_confirmado: { type: 'boolean', description: 'true se o cliente confirmou ser o cadastro encontrado pelo telefone; false se negou' },
        },
        required: ['mensagem_encerramento', 'tipo_servico', 'quantidade'],
      },
    },
  },
];

async function getOrCreateConversationContext(conversationId) {
  const result = await db.query('SELECT ai_context FROM conversations WHERE id = $1', [conversationId]);
  return result.rows[0]?.ai_context || [];
}

async function saveContext(conversationId, messages) {
  const trimmed = messages.slice(-30);
  await db.query(
    'UPDATE conversations SET ai_context = $1, updated_at = NOW() WHERE id = $2',
    [JSON.stringify(trimmed), conversationId]
  );
}

async function getSetting(key) {
  const result = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return result.rows[0]?.value;
}

async function processMessage(conversationId, userMessage) {
  const history = await getOrCreateConversationContext(conversationId);
  const customPrompt = await getSetting('agent_prompt');
  const systemPrompt = customPrompt || SYSTEM_PROMPT;

  // Pré-busca: o telefone do contato está cadastrado? (injeta nota de contexto)
  let clienteNota = '';
  try {
    const cinfo = await db.query(
      `SELECT ct.phone FROM conversations c LEFT JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = $1`,
      [conversationId]);
    const phone = cinfo.rows[0]?.phone;
    if (phone) {
      const cands = await buscarClientesPorTelefone(phone);
      if (cands.length === 0) {
        clienteNota = `\n\n[CLIENTE NOVO] Telefone não cadastrado. Faça o cadastro mínimo: peça o nome e o e-mail do cliente.`;
      } else if (cands.length === 1) {
        const nm = cands[0].nome, em = cands[0].email;
        clienteNota = em
          ? `\n\n[CLIENTE NA BASE] Telefone cadastrado como "${nm}", e-mail "${em}". Confirme a identidade pelo nome e confirme se esse e-mail está correto (atualize se o cliente corrigir).`
          : `\n\n[CLIENTE NA BASE] Telefone cadastrado como "${nm}", sem e-mail. Confirme a identidade pelo nome e peça o e-mail.`;
      } else {
        const lista = cands.slice(0, 5)
          .map((c, i) => `${i + 1}) ${c.nome} (${c.tipo_pessoa === 'PJ' ? 'PJ' : 'PF'})`).join('\n');
        const extra = cands.length > 5 ? '\n(entre outros — confirme o nome/empresa)' : '';
        clienteNota = `\n\n[CLIENTES NA BASE] O telefone está ligado a mais de um cadastro:\n${lista}${extra}\nPergunte para QUAL desses cadastros é este pedido, ou se é um cadastro novo. NÃO escolha por conta própria. Ao registrar, use em "nome_cliente" exatamente o nome do cadastro escolhido.`;
      }
    }
  } catch (e) { console.warn('[CHATBOT-CLIENTE] lookup falhou:', e.message); }
  const promptFinal = systemPrompt + clienteNota;

  history.push({ role: 'user', content: userMessage });

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [{ role: 'system', content: promptFinal }, ...history],
    tools: TOOLS,
    tool_choice: 'auto',
    temperature: 0.7,
    max_tokens: 800,
  });

  const choice = response.choices[0];
  const assistantMessage = choice.message;
  history.push(assistantMessage);

  let isComplete = false;
  let orderDetails = null;
  let cleanResponse = '';

  if (choice.finish_reason === 'tool_calls' && assistantMessage.tool_calls?.length > 0) {
    const toolCall = assistantMessage.tool_calls[0];
    if (toolCall.function.name === 'registrar_pedido') {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        orderDetails = args;
        isComplete = true;

        // Resolve o cliente (find/create por celular) — entrada única no Pedido
        const conv = await db.query(
          `SELECT c.contact_id, ct.phone, ct.name AS contact_name
           FROM conversations c LEFT JOIN contacts ct ON ct.id = c.contact_id
           WHERE c.id = $1`, [conversationId]);
        const row = conv.rows[0];
        let clienteId = null;
        if (row?.phone) {
          const celular = row.phone.replace(/\D/g, '');
          const cands = await buscarClientesPorTelefone(row.phone);
          const confirmado = args.cliente_existente_confirmado !== false; // ausente/true => usa existente
          let matched = null;
          if (confirmado && cands.length) {
            const alvo = normalizarNome(args.nome_cliente);
            matched = (alvo && cands.find(c => normalizarNome(c.nome) === alvo))
              || (cands.length === 1 ? cands[0] : null);
          }
          if (matched) {
            clienteId = matched.id;
            if (!matched.email && args.email) {
              await db.query('UPDATE clientes_lkl SET email = $1 WHERE id = $2', [args.email, clienteId]);
            }
          } else {
            const nomeCliente = args.nome_cliente || row.contact_name || row.phone;
            const ins = await db.query(
              `INSERT INTO clientes_lkl (nome, celular, email, canal_origem, tipo_pessoa)
               VALUES ($1, $2, $3, 'chatbot', 'PF') RETURNING id`,
              [nomeCliente, celular, args.email || null]);
            clienteId = ins.rows[0].id;
          }
        }

        // Cria o PEDIDO pela mesma porta do painel (canal chatbot) → auto-orçamento em_orcamento
        // Múltiplos itens (um por produto); fallback para os campos achatados
        let itensBrutos = Array.isArray(args.itens) ? args.itens.filter(it => it && it.produto) : [];
        if (!itensBrutos.length) {
          itensBrutos = [{ produto: args.produto || args.tipo_servico, dimensoes: args.dimensoes, quantidade: args.quantidade, material: args.material, tem_arte: args.tem_arte }];
        }
        const itensDados = itensBrutos.map(it => ({
          produto: (it.produto || args.tipo_servico || 'Pedido via chatbot'),
          quantidade: parseInt(it.quantidade) || 1,
          especificacao: [it.dimensoes, it.material].filter(Boolean).join(' · ') || null,
          tem_arte: !!it.tem_arte,
          dimensoes: it.dimensoes || null,
          material: it.material || null,
        }));
        const dados = {
          origin_channel: 'chatbot',
          cliente_id: clienteId,
          email: args.email || null,
          itens: itensDados,
          observacoes: [
            args.entrega === 'entrega' ? `Entrega: ${args.endereco_entrega || ''}` : 'Retirada na loja',
            args.observacoes || '',
          ].filter(Boolean).join(' | ') || null,
        };

        const result = await ordersService.criarOrder(dados, null);
        if (result?.erro) {
          console.error('[CHATBOT-PEDIDO] Falha ao criar pedido:', result.erro.join('; '));
          cleanResponse = 'Recebi seus dados, mas tive um problema ao registrar o pedido agora. Nossa equipe da Gráfica LKL foi avisada e vai concluir o registro. 😊';
          history.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Falha ao registrar pedido (equipe avisada).' });
        } else {
          const pedidoNumero = result.order.numero_os;
          orderDetails.pedido_numero = pedidoNumero;

          const msgTemplate = args.mensagem_encerramento ||
            'Pedido registrado com sucesso! Seu número de acompanhamento é {NUMERO_PEDIDO}. Nossa equipe da Gráfica LKL entrará em contato em breve com o orçamento. Obrigado! 😊';
          cleanResponse = msgTemplate.replace('{NUMERO_PEDIDO}', `*#${pedidoNumero}*`);
          if (!cleanResponse.includes(`#${pedidoNumero}`)) {
            cleanResponse += `\n\n📋 *Número do seu pedido: #${pedidoNumero}*\nGuarde este número para consultar o status com nossa equipe!`;
          }

          await db.query(
            `UPDATE conversations
             SET needs_details = $1, service_type = $2, status = 'aguardando_humano',
                 pedido_numero = $3, pedido_status = 'em_orcamento', updated_at = NOW()
             WHERE id = $4`,
            [JSON.stringify(orderDetails), orderDetails.tipo_servico, pedidoNumero, conversationId]);

          if (orderDetails.nome_cliente) {
            await db.query(
              "UPDATE contacts SET name = $1 WHERE id = (SELECT contact_id FROM conversations WHERE id = $2)",
              [orderDetails.nome_cliente, conversationId]);
          }

          history.push({ role: 'tool', tool_call_id: toolCall.id, content: `Pedido #${pedidoNumero} registrado.` });
          console.log(`=== PEDIDO #${pedidoNumero} (chatbot) REGISTRADO ===`, JSON.stringify(orderDetails));
        }
      } catch (e) {
        console.error('Erro ao processar pedido:', e.message);
        cleanResponse = 'Ocorreu um erro ao registrar o pedido. Por favor, tente novamente.';
        // Adiciona resposta de erro à tool para não deixar o histórico corrompido
        history.push({ role: 'tool', tool_call_id: toolCall.id, content: 'Erro ao registrar pedido.' });
      }
    }
  } else {
    cleanResponse = assistantMessage.content || '';
  }

  await saveContext(conversationId, history);
  return { response: cleanResponse, isComplete, orderDetails };
}

module.exports = { processMessage, SYSTEM_PROMPT, normalizarTelefone, normalizarNome, dedupClientes, agruparClientes, escolherCanonicoCliente };
