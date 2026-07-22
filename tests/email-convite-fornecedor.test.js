jest.mock('nodemailer', () => {
  const transports = {};
  return {
    createTransport: jest.fn((cfg) => {
      const t = { sendMail: jest.fn().mockResolvedValue({ messageId: 'msg-id-teste' }), _cfg: cfg };
      transports[cfg.auth.user] = t;
      return t;
    }),
    __transports: transports,
  };
});

process.env.SMTP_HOST = 'smtp.existing.com';
process.env.SMTP_PORT = '587';
process.env.SMTP_USER = 'orcamentos@graficalkl.com.br';
process.env.SMTP_PASS = 'senha-existente';
process.env.SMTP_FORNECEDOR_HOST = 'smtp.hostinger.com';
process.env.SMTP_FORNECEDOR_PORT = '587';
process.env.SMTP_FORNECEDOR_USER = 'fornecedores@graficalkl.com.br';
process.env.SMTP_FORNECEDOR_PASS = 'senha-fornecedores';
process.env.BASE_URL = 'https://app.graficalkl.com.br';

const nodemailer = require('nodemailer');
const email = require('../src/services/email');

describe('enviarConvitePortalFornecedor', () => {
  test('usa o transporter dedicado (SMTP_FORNECEDOR_*), não o transporter existente', async () => {
    await email.enviarConvitePortalFornecedor({
      email: 'contato@vinilline.com.br',
      nome: 'Vinil Line',
      conviteUrl: 'https://app.graficalkl.com.br/portal-fornecedor/definir-senha.html?token=abc123',
    });

    const transporterFornecedor = nodemailer.__transports['fornecedores@graficalkl.com.br'];
    expect(transporterFornecedor.sendMail).toHaveBeenCalledTimes(1);
    const chamada = transporterFornecedor.sendMail.mock.calls[0][0];
    expect(chamada.to).toBe('contato@vinilline.com.br');
    expect(chamada.from).toContain('fornecedores@graficalkl.com.br');
    expect(chamada.subject).toMatch(/Portal do Fornecedor/i);
    expect(chamada.html).toContain('Vinil Line');
    expect(chamada.html).toContain('https://app.graficalkl.com.br/portal-fornecedor/definir-senha.html?token=abc123');

    // O transporter existente é criado de forma eager no require() do módulo (código legado,
    // fora do escopo desta task), então ele sempre existirá — mas não deve ter sido USADO
    // neste fluxo, que é o que a asserção original pretendia verificar.
    const transporterExistente = nodemailer.__transports['orcamentos@graficalkl.com.br'];
    if (transporterExistente) {
      expect(transporterExistente.sendMail).not.toHaveBeenCalled();
    }
  });

  test('menciona validade de 7 dias no corpo do e-mail', async () => {
    await email.enviarConvitePortalFornecedor({
      email: 'x@y.com', nome: 'Fornecedor X', conviteUrl: 'https://x.com/token',
    });
    const transporterFornecedor = nodemailer.__transports['fornecedores@graficalkl.com.br'];
    const chamada = transporterFornecedor.sendMail.mock.calls.at(-1)[0];
    expect(chamada.html).toMatch(/7 dias/);
  });
});
