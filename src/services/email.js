const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function notifyAnalyst({ contact, conversation, orderDetails }) {
  const detailsHtml = orderDetails
    ? Object.entries(orderDetails)
        .map(([k, v]) => `<tr><td style="padding:4px 8px;font-weight:bold">${k}</td><td style="padding:4px 8px">${v}</td></tr>`)
        .join('')
    : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1a237e;padding:20px;text-align:center">
        <h1 style="color:white;margin:0">LKL Gráfica</h1>
        <p style="color:#90caf9;margin:4px 0">Novo pedido aguardando atendimento</p>
      </div>
      <div style="padding:24px;background:#f5f5f5">
        <h2 style="color:#333">📋 Pedido Completo Recebido</h2>
        <p><strong>Cliente:</strong> ${contact.name || contact.profile_name || 'Sem nome'}</p>
        <p><strong>WhatsApp:</strong> ${contact.phone}</p>
        <p><strong>Conversa ID:</strong> ${conversation.id}</p>

        ${orderDetails ? `
        <h3 style="color:#1a237e">Detalhes do Pedido</h3>
        <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px">
          ${detailsHtml}
        </table>` : ''}

        <div style="margin-top:24px;text-align:center">
          <a href="${process.env.BASE_URL}/dashboard/conversations/${conversation.id}"
             style="background:#1a237e;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">
            Ver Conversa no Painel
          </a>
        </div>
      </div>
      <div style="padding:12px;text-align:center;color:#999;font-size:12px">
        LKL Gráfica Chatbot — Notificação automática
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"LKL Chatbot" <${process.env.SMTP_USER}>`,
    to: process.env.NOTIFY_EMAIL,
    subject: `🎯 Novo pedido: ${orderDetails?.tipo_servico || 'Ver conversa'} — ${contact.phone}`,
    html,
  });
}

module.exports = { notifyAnalyst };
