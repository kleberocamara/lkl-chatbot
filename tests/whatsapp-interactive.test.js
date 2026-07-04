jest.mock('axios');
const axios = require('axios');
const { sendInteractiveButtons } = require('../src/services/whatsapp');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123';
  process.env.WHATSAPP_ACCESS_TOKEN = 'tok';
  axios.post.mockResolvedValue({});
});

test('header de imagem + 2 botões monta o payload interactive/button', async () => {
  await sendInteractiveButtons('5521999', {
    headerImage: 'https://x/a.png',
    bodyText: 'corpo',
    buttons: [{ id: 'arte_aprovar', title: '✅ Aprovar' }, { id: 'arte_reprovar', title: '✏️ Reprovar' }],
  });
  const [url, payload] = axios.post.mock.calls[0];
  expect(url).toMatch(/123\/messages/);
  expect(payload.type).toBe('interactive');
  expect(payload.interactive.type).toBe('button');
  expect(payload.interactive.header).toEqual({ type: 'image', image: { link: 'https://x/a.png' } });
  expect(payload.interactive.body.text).toBe('corpo');
  expect(payload.interactive.action.buttons).toEqual([
    { type: 'reply', reply: { id: 'arte_aprovar', title: '✅ Aprovar' } },
    { type: 'reply', reply: { id: 'arte_reprovar', title: '✏️ Reprovar' } },
  ]);
});

test('sem headerImage → sem header no payload', async () => {
  await sendInteractiveButtons('5521999', { bodyText: 'corpo', buttons: [{ id: 'a', title: 'A' }] });
  const payload = axios.post.mock.calls[0][1];
  expect(payload.interactive.header).toBeUndefined();
});
