jest.mock('axios');
const axios = require('axios');
const { sendDocument } = require('../src/services/whatsapp');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok';
  axios.post.mockResolvedValue({});
});

test('monta o payload type=document com link, filename e caption', async () => {
  await sendDocument('5521999', 'https://x/arquivo.pdf', 'Proposta.pdf', 'Segue a proposta');

  const [url, payload, config] = axios.post.mock.calls[0];
  expect(url).toMatch(/123\/messages/);
  expect(payload.messaging_product).toBe('whatsapp');
  expect(payload.to).toBe('5521999');
  expect(payload.type).toBe('document');
  expect(payload.document).toEqual({ link: 'https://x/arquivo.pdf', filename: 'Proposta.pdf', caption: 'Segue a proposta' });
  expect(config.headers.Authorization).toBe('Bearer tok');
});

test('sem caption → envia string vazia; sem filename → omite o campo', async () => {
  await sendDocument('5521999', 'https://x/arquivo.pdf');

  const payload = axios.post.mock.calls[0][1];
  expect(payload.document.caption).toBe('');
  expect(payload.document.filename).toBeUndefined();
});
