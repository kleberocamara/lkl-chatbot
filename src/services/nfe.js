// src/services/nfe.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SIDECAR_URL = process.env.NFE_SIDECAR_URL || 'http://127.0.0.1:3001';

async function emitirNfe(dados) {
  const res = await axios.post(`${SIDECAR_URL}/emitir`, dados, { timeout: 60000 });
  return res.data;
}

async function gerarDanfe(xml, chave) {
  const outputPath = path.join(__dirname, '../../public/uploads/nfe', `${chave}.pdf`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const res = await axios.post(
    `${SIDECAR_URL}/danfe`,
    { xml, output_path: outputPath },
    { timeout: 30000, responseType: 'arraybuffer' }
  );

  fs.writeFileSync(outputPath, res.data);
  return `/uploads/nfe/${chave}.pdf`;
}

module.exports = { emitirNfe, gerarDanfe };
