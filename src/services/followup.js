const db = require('../db');
const { sendMessage } = require('./whatsapp');
const { log } = require('./logger');

// São Paulo é sempre UTC-3 (sem horário de verão desde 2019)
const SP_OFFSET_MS = 3 * 3600 * 1000;

function utcToSP(utcDate) {
  // Retorna Date onde getUTC*() dá os valores no horário de SP
  return new Date(utcDate.getTime() - SP_OFFSET_MS);
}

function spToUTC(spRepr) {
  return new Date(spRepr.getTime() + SP_OFFSET_MS);
}

function isWeekendSP(utcDate) {
  const day = utcToSP(utcDate).getUTCDay(); // 0=Dom, 6=Sáb
  return day === 0 || day === 6;
}

function getHourSP(utcDate) {
  return utcToSP(utcDate).getUTCHours();
}

// Avança para o próximo dia útil às 10:00 SP
function nextBizDayAt10(utcDate) {
  const sp = utcToSP(utcDate);
  sp.setUTCDate(sp.getUTCDate() + 1);
  sp.setUTCHours(10, 0, 0, 0);
  while (sp.getUTCDay() === 0 || sp.getUTCDay() === 6) {
    sp.setUTCDate(sp.getUTCDate() + 1);
  }
  return spToUTC(sp);
}

// Calcula o horário agendado para cada tentativa conforme regras da LKL
function calcScheduledAt(sentAtUtc, attempt) {
  if (attempt === 1) {
    let scheduled = new Date(sentAtUtc.getTime() + 4 * 3600 * 1000);
    // Se ultrapassar 20:00 SP ou cair no fim de semana → próximo dia útil às 10:00
    if (getHourSP(scheduled) >= 20 || isWeekendSP(scheduled)) {
      scheduled = nextBizDayAt10(scheduled);
    }
    return scheduled;
  }

  // Tentativas 2-5: N dias após o envio do orçamento às 10:00 SP
  const dayOffsets = { 2: 1, 3: 3, 4: 5, 5: 10 };
  const offset = dayOffsets[attempt];

  const sp = utcToSP(sentAtUtc);
  sp.setUTCDate(sp.getUTCDate() + offset);
  sp.setUTCHours(10, 0, 0, 0);
  // Se cair no fim de semana → avança para próximo dia útil
  while (sp.getUTCDay() === 0 || sp.getUTCDay() === 6) {
    sp.setUTCDate(sp.getUTCDate() + 1);
  }
  return spToUTC(sp);
}

const FOLLOW_UP_MESSAGES = [
  (nome) => `Olá${nome ? ' ' + nome : ''}! 😊 Passando para verificar se recebeu nosso orçamento da Gráfica LKL. Ficou alguma dúvida? Estamos à disposição!`,
  (nome) => `Oi${nome ? ' ' + nome : ''}! Gostaria de saber se você teve a chance de analisar o orçamento que enviamos. Podemos ajudar com alguma informação adicional? 🙂`,
  (nome) => `Olá${nome ? ' ' + nome : ''}! Nossa equipe está disponível caso queira ajustar algum detalhe do orçamento ou tirar dúvidas. É só chamar! 😊`,
  (nome) => `Oi${nome ? ' ' + nome : ''}! Passando mais uma vez pela Gráfica LKL — seu orçamento ainda está disponível. Qualquer dúvida, estamos aqui!`,
  (nome) => `Olá${nome ? ' ' + nome : ''}! Esta é nossa última mensagem sobre o orçamento enviado. Quando quiser retomar, basta nos chamar. Obrigado! 😊`,
];

// Agenda os 5 follow-ups para uma conversa logo após o orçamento ser enviado
async function scheduleFollowUps(conversationId, sentAt) {
  const sentAtUtc = new Date(sentAt);

  const values = [];
  const params = [];
  let paramIndex = 1;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const scheduledAt = calcScheduledAt(sentAtUtc, attempt);
    values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
    params.push(conversationId, attempt, scheduledAt.toISOString());
  }

  await db.query(
    `INSERT INTO follow_ups (conversation_id, attempt, scheduled_at) VALUES ${values.join(', ')}`,
    params
  );
}

// Cancela todos os follow-ups pendentes de uma conversa (cliente respondeu)
async function cancelPendingFollowUps(conversationId) {
  const result = await db.query(
    `UPDATE follow_ups SET status = 'cancelled'
     WHERE conversation_id = $1 AND status = 'pending'
     RETURNING id`,
    [conversationId]
  );
  return result.rowCount;
}

// Processa todos os follow-ups vencidos — chamado pelo scheduler
async function processFollowUps() {
  const due = await db.query(`
    SELECT f.id, f.conversation_id, f.attempt,
           c.orcamento_enviado_at,
           ct.phone, ct.name, ct.profile_name
    FROM follow_ups f
    JOIN conversations c ON c.id = f.conversation_id
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE f.status = 'pending'
      AND f.scheduled_at <= NOW()
      AND c.status = 'orcamento_enviado'
    ORDER BY f.scheduled_at ASC
  `);

  for (const row of due.rows) {
    try {
      const nome = row.name || row.profile_name || '';
      const msgFn = FOLLOW_UP_MESSAGES[row.attempt - 1];
      const message = msgFn(nome);

      await sendMessage(row.phone, message);

      // Salva a mensagem enviada
      await db.query(
        `INSERT INTO messages (conversation_id, contact_id, content, direction, sent_by)
         SELECT $1, c.contact_id, $2, 'outbound', 'system'
         FROM conversations c WHERE c.id = $1`,
        [row.conversation_id, message]
      );

      // Marca follow-up como enviado
      await db.query(
        `UPDATE follow_ups SET status = 'sent', sent_at = NOW() WHERE id = $1`,
        [row.id]
      );

      // Incrementa contador
      await db.query(
        `UPDATE conversations SET follow_up_count = follow_up_count + 1, updated_at = NOW()
         WHERE id = $1`,
        [row.conversation_id]
      );

      await log('follow_up_sent', `Follow-up ${row.attempt}/5 enviado para ${row.phone}`, {
        conversationId: row.conversation_id,
        metadata: { attempt: row.attempt },
      });

      // Após a 5ª tentativa → fecha sem retorno e notifica analista
      if (row.attempt === 5) {
        await db.query(
          `UPDATE conversations SET status = 'orcamento_sem_retorno', updated_at = NOW()
           WHERE id = $1`,
          [row.conversation_id]
        );

        await log('orcamento_sem_retorno', `Sem retorno após 5 tentativas — ${row.phone}`, {
          conversationId: row.conversation_id,
        });

        if (global.io) {
          global.io.emit('orcamento_sem_retorno', {
            conversationId: row.conversation_id,
            phone: row.phone,
            nome,
          });
        }
      }

      if (global.io) {
        global.io.emit('follow_up_sent', {
          conversationId: row.conversation_id,
          attempt: row.attempt,
        });
      }
    } catch (err) {
      console.error(`[follow-up] Erro ao processar tentativa ${row.attempt} para conversa ${row.conversation_id}:`, err.message);
    }
  }
}

const REENGAJAR_APOS_MS = 48 * 3600 * 1000;

// Função pura: a conversa deve ser reengajada pelo bot? (após 2 dias parada em aguardando_humano,
// sem pedido registrado — o próximo passo é do cliente).
function deveReengajar(conv, agora) {
  if (!conv || conv.status !== 'aguardando_humano') return false;
  if (conv.pedido_numero != null) return false;   // pedido já registrado → espera a equipe
  if (conv.reengajado_em != null) return false;    // já reengajado nesta parada
  if (!conv.ultima_msg_at) return false;
  const ultima = new Date(conv.ultima_msg_at).getTime();
  return (agora.getTime() - ultima) > REENGAJAR_APOS_MS;
}

// Inicia o scheduler — verifica a cada minuto
function startScheduler() {
  console.log('🔔 Follow-up scheduler iniciado (verifica a cada 60s)');
  processFollowUps().catch(err => console.error('[follow-up] Erro inicial:', err.message));
  setInterval(() => {
    processFollowUps().catch(err => console.error('[follow-up] Erro no scheduler:', err.message));
  }, 60 * 1000);
}

module.exports = { scheduleFollowUps, cancelPendingFollowUps, processFollowUps, startScheduler, calcScheduledAt, deveReengajar };
