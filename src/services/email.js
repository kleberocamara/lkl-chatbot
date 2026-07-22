const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// Logo embutido como base64 para garantir exibição em todos os clientes de e-mail
function getLogoBase64() {
  try {
    const logoPath = path.join(__dirname, '../../public/logo-email.png');
    return 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64');
  } catch { return ''; }
}

const SMTP_PORT = parseInt(process.env.SMTP_PORT);
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const SMTP_FORNECEDOR_PORT = parseInt(process.env.SMTP_FORNECEDOR_PORT);
const transporterFornecedor = nodemailer.createTransport({
  host: process.env.SMTP_FORNECEDOR_HOST,
  port: SMTP_FORNECEDOR_PORT,
  secure: SMTP_FORNECEDOR_PORT === 465,
  auth: {
    user: process.env.SMTP_FORNECEDOR_USER,
    pass: process.env.SMTP_FORNECEDOR_PASS,
  },
});

async function enviarConvitePortalFornecedor({ email, nome, conviteUrl }) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <div style="background:#1a237e;padding:20px 24px;text-align:center">
        <img src="${getLogoBase64()}" alt="Gráfica LKL" style="height:56px;display:inline-block">
        <div style="color:white;font-size:16px;font-weight:700;margin-top:8px">Portal do Fornecedor</div>
      </div>
      <div style="padding:28px;background:#f9f9f9">
        <p style="font-size:15px">Olá, <strong>${nome}</strong>!</p>
        <p>A Gráfica LKL liberou seu acesso ao Portal do Fornecedor. Por lá você pode declarar Notas Fiscais, itens e forma de pagamento antes da entrega da mercadoria.</p>
        <div style="margin:28px 0;text-align:center">
          <a href="${conviteUrl}"
             style="background:#1a237e;color:white;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:bold;display:inline-block">
            Definir minha senha e acessar
          </a>
        </div>
        <p style="font-size:13px;color:#555">Este link é válido por 7 dias. Se expirar, peça um novo convite à Gráfica LKL.</p>
      </div>
      <div style="padding:12px;text-align:center;color:#aaa;font-size:11px">
        Gráfica LKL — Portal do Fornecedor
      </div>
    </div>`;

  const info = await transporterFornecedor.sendMail({
    from: `"Gráfica LKL — Fornecedores" <${process.env.SMTP_FORNECEDOR_USER}>`,
    to: email,
    subject: 'Acesso ao Portal do Fornecedor — Gráfica LKL',
    html,
  });
  console.log(`[EMAIL] Convite do portal do fornecedor enviado para ${email} (messageId: ${info.messageId})`);
}

async function notifyAnalyst({ contact, conversation, orderDetails }) {
  const detailsHtml = orderDetails
    ? Object.entries(orderDetails)
        .map(([k, v]) => `<tr><td style="padding:4px 8px;font-weight:bold">${k}</td><td style="padding:4px 8px">${v}</td></tr>`)
        .join('')
    : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1a237e;padding:20px;text-align:center">
        <h1 style="color:white;margin:0">Gráfica LKL</h1>
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
        Gráfica LKL Chatbot — Notificação automática
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

async function enviarOrcamentoCliente({ clienteNome, clienteEmail, numero, numeroPedido, total, validade_dias, prazo_entrega, itens, token, pdfBuffer }) {
  const baseUrl = process.env.BASE_URL || 'https://app.graficalkl.com.br';
  const urlConfirmar = `${baseUrl}/api/v2/orcamentos/resposta?token=${token}`;
  const urlAprovar  = urlConfirmar;
  const urlReprovar = urlConfirmar;

  const itensHtml = (itens || []).map(it => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">${it.descricao}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${it.quantidade}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right">R$ ${parseFloat(it.valor_unitario||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:bold">R$ ${parseFloat(it.valor_total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
    </tr>`).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#222">
      <div style="background:#1a237e;padding:20px 24px;display:table;width:100%;box-sizing:border-box">
        <!-- Lado esquerdo: logo + dados da empresa -->
        <div style="display:table-cell;vertical-align:middle;width:70%">
          <table cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="vertical-align:middle;padding-right:14px">
                <img src="${getLogoBase64()}" alt="Gráfica LKL" style="height:64px;display:block">
              </td>
              <td style="vertical-align:middle">
                <div style="color:white;font-size:17px;font-weight:700;letter-spacing:.5px">GRUPO DE GRÁFICAS LKL LTDA</div>
                <div style="color:#90caf9;font-size:11px;margin-top:3px">Conectando Imaginação, Qualidade &amp; Tecnologia</div>
                <div style="color:#c5cae9;font-size:10px;margin-top:4px">RUA DR. WALDIR DE SOUZA MEDEIROS, 315 - PARQUE DUQUE - DUQUE DE CAXIAS/RJ</div>
                <div style="color:#c5cae9;font-size:10px;margin-top:2px">comercialgraficalkl@gmail.com &nbsp;|&nbsp; WhatsApp: (21) 98047-5671</div>
              </td>
            </tr>
          </table>
        </div>
        <!-- Lado direito: número e tipo -->
        <div style="display:table-cell;vertical-align:middle;text-align:right;width:30%">
          <div style="color:white;font-size:22px;font-weight:700">Nº ${String(numero).padStart(6,'0')}</div>
          <div style="color:#90caf9;font-size:11px;font-weight:600;letter-spacing:.5px;margin-top:2px">PROPOSTA / ORÇAMENTO</div>
          <div style="color:#c5cae9;font-size:11px;margin-top:4px">Emissão: ${new Date().toLocaleDateString('pt-BR')}</div>
        </div>
      </div>
      <div style="padding:28px;background:#f9f9f9">
        <p style="font-size:15px">Olá, <strong>${clienteNome}</strong>!</p>
        <p>Segue seu orçamento Gráfica LKL. Confira os itens abaixo e clique em <strong>Aprovar</strong> ou <strong>Reprovar</strong>.</p>

        <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;margin:16px 0">
          <thead>
            <tr style="background:#1a237e;color:white">
              <th style="padding:10px 12px;text-align:left">Descrição</th>
              <th style="padding:10px 12px;text-align:center">Qtd</th>
              <th style="padding:10px 12px;text-align:right">Unit.</th>
              <th style="padding:10px 12px;text-align:right">Total</th>
            </tr>
          </thead>
          <tbody>${itensHtml}</tbody>
          <tfoot>
            <tr style="background:#e8eaf6">
              <td colspan="3" style="padding:10px 12px;font-weight:bold;text-align:right">TOTAL</td>
              <td style="padding:10px 12px;font-weight:bold;text-align:right;font-size:16px">R$ ${parseFloat(total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
            </tr>
          </tfoot>
        </table>

        <p style="font-size:13px;color:#555">⏰ Validade: ${validade_dias ? validade_dias + ' dias' : '30 dias'}</p>
        <p style="font-size:13px;color:#555">🗓 Prazo de entrega: ${prazo_entrega || 'a combinar'}</p>

        <div style="margin-top:32px;text-align:center">
          <a href="${urlAprovar}"
             style="background:#2e7d32;color:white;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:bold;display:inline-block;margin-right:12px">
            ✅ Aprovar
          </a>
          <a href="${urlReprovar}"
             style="background:#c62828;color:white;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:bold;display:inline-block">
            ❌ Reprovar
          </a>
        </div>
        <p style="font-size:12px;color:#999;margin-top:20px;text-align:center">
          Você também pode responder esta mensagem ou contatar nossa equipe pelo WhatsApp.
        </p>
      </div>
      <div style="padding:12px;text-align:center;color:#aaa;font-size:11px">
        Gráfica LKL — contato: comercialgraficalkl@gmail.com
      </div>
    </div>`;

  const attachments = pdfBuffer
    ? [{ filename: `orcamento-${numero}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
    : [];

  const info = await transporter.sendMail({
    from: `"Gráfica LKL" <${process.env.SMTP_USER}>`,
    to: clienteEmail,
    bcc: process.env.SMTP_USER,
    subject: `Pedido Gráfica LKL #${numeroPedido || numero} — aguardando sua aprovação`,
    html,
    attachments,
  });
  console.log(`[EMAIL] Orçamento #${numero} enviado para ${clienteEmail} (messageId: ${info.messageId})`);
}

module.exports = { notifyAnalyst, enviarOrcamentoCliente, enviarConvitePortalFornecedor };
