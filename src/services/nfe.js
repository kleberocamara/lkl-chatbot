// src/services/nfe.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SIDECAR_URL = process.env.NFE_SIDECAR_URL || 'http://127.0.0.1:3001';

async function emitirNfe(dados) {
  try {
    const res = await axios.post(`${SIDECAR_URL}/emitir`, dados, { timeout: 60000 });
    return res.data;
  } catch (e) {
    if (e.response?.data) return e.response.data;
    throw e;
  }
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

async function cancelarNfe(dados) {
  try {
    const res = await axios.post(`${SIDECAR_URL}/cancelar`, dados, { timeout: 30000 });
    return res.data;
  } catch (e) {
    if (e.response?.data) return e.response.data;
    throw e;
  }
}

async function corrigirNfe(dados) {
  try {
    const res = await axios.post(`${SIDECAR_URL}/corrigir`, dados, { timeout: 30000 });
    return res.data;
  } catch (e) {
    if (e.response?.data) return e.response.data;
    throw e;
  }
}

async function inutilizarNfe(dados) {
  try {
    const res = await axios.post(`${SIDECAR_URL}/inutilizar`, dados, { timeout: 30000 });
    return res.data;
  } catch (e) {
    if (e.response?.data) return e.response.data;
    throw e;
  }
}

module.exports = { emitirNfe, gerarDanfe, cancelarNfe, corrigirNfe, inutilizarNfe };
