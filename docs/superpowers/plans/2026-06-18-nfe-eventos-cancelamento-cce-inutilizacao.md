# NF-e Eventos: Cancelamento, CC-e e Inutilização — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar os três eventos fiscais pós-emissão de NF-e: Cancelamento (cód. 110111), Carta de Correção — CC-e (cód. 110110) e Inutilização de numeração, com backend Python+Node.js e interface no PWA admin.

**Architecture:** Cada operação é um endpoint novo no sidecar Flask (`/cancelar`, `/corrigir`, `/inutilizar`), chamado pelo Node.js via `src/services/nfe.js`. O módulo `src/modules/nfe/` ganha funções de service + rotas REST. O PWA admin recebe modais com formulários. Cancelamento e CC-e usam `NFeRetRecepcaoEvento4`; Inutilização usa `NfeInutilizacao4`. Uma migration adiciona a tabela `nfe_eventos` para registrar histórico.

**Tech Stack:** Python 3 + Flask + lxml + signxml + requests (sidecar); Node.js 20 + Express 4 + PostgreSQL 15 (backend); HTML/JS vanilla (PWA admin).

---

## File Structure

**Criar:**
- `nfe_sidecar/eventos.py` — funções `cancelar_nfe`, `corrigir_nfe`, `inutilizar_nfe`
- `sql/migrations/010_nfe_eventos.sql` — tabela `nfe_eventos`

**Modificar:**
- `nfe_sidecar/app.py` — 3 novas rotas: `/cancelar`, `/corrigir`, `/inutilizar`
- `src/services/nfe.js` — 3 novas funções: `cancelarNfe`, `corrigirNfe`, `inutilizarNfe`
- `src/modules/nfe/service.js` — funções `cancelar`, `corrigir`, `inutilizar`
- `src/modules/nfe/router.js` — 3 novas rotas POST
- `public/pwa/admin.html` — 3 botões e 3 modais

---

## Task 1: Migration — tabela nfe_eventos

**Files:**
- Create: `sql/migrations/010_nfe_eventos.sql`

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- sql/migrations/010_nfe_eventos.sql
BEGIN;

CREATE TABLE IF NOT EXISTS nfe_eventos (
  id           SERIAL PRIMARY KEY,
  nfe_id       INTEGER NOT NULL REFERENCES nfe(id),
  tipo         VARCHAR(20) NOT NULL CHECK (tipo IN ('cancelamento','cc_e','inutilizacao')),
  protocolo    VARCHAR(20),
  c_stat       VARCHAR(3),
  x_motivo     TEXT,
  justificativa TEXT,
  xml_evento   TEXT,
  criado_em    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nfe_eventos_nfe ON nfe_eventos(nfe_id);

-- Coluna para rastrear cancelamento direto na nfe
ALTER TABLE nfe ADD COLUMN IF NOT EXISTS cancelado_em TIMESTAMPTZ;
ALTER TABLE nfe ADD COLUMN IF NOT EXISTS cancelamento_protocolo VARCHAR(20);

COMMIT;
```

- [ ] **Step 2: Aplicar migration no VPS**

```bash
ssh root@2.25.147.243
DB=$(grep DATABASE_URL /var/www/lkl-chatbot/.env | cut -d= -f2-)
sudo -u postgres psql "$DB" -f /var/www/lkl-chatbot/sql/migrations/010_nfe_eventos.sql
```

Expected: `ALTER TABLE` (2x), `CREATE INDEX`, `CREATE TABLE`

- [ ] **Step 3: Commit**

```bash
git add sql/migrations/010_nfe_eventos.sql
git commit -m "feat: migration nfe_eventos — cancelamento, cc-e, inutilizacao"
```

---

## Task 2: Sidecar Python — eventos.py

**Files:**
- Create: `nfe_sidecar/eventos.py`

O SEFAZ usa o mesmo endpoint SOAP para Cancelamento e CC-e:
`https://nfe-homologacao.svrs.rs.gov.br/ws/NFeRecepcaoEvento/NFeRecepcaoEvento4.asmx`

Para Inutilização:
`https://nfe-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx`

- [ ] **Step 1: Criar `nfe_sidecar/eventos.py`**

```python
# nfe_sidecar/eventos.py
import os
import random
import datetime
import tempfile
from lxml import etree
from signxml import XMLSigner, methods
import requests
from emitir import _extrair_cert_key, _XMLSignerSHA1
from emitentes import EMITENTES, NFE_AMBIENTE

NS = 'http://www.portalfiscal.inf.br/nfe'

_URL_EVENTO_HOM = 'https://nfe-homologacao.svrs.rs.gov.br/ws/NFeRecepcaoEvento/NFeRecepcaoEvento4.asmx'
_URL_EVENTO_PRD = 'https://nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx'
_URL_INUT_HOM   = 'https://nfe-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx'
_URL_INUT_PRD   = 'https://nfe.fazenda.gov.br/NfeInutilizacao4/NfeInutilizacao4.asmx'

_CA_BUNDLE = os.path.join(os.path.dirname(__file__), 'sefaz_ca_bundle.pem')


def _now_br():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-3)))


def _texto(parent, tag, text):
    el = etree.SubElement(parent, f'{{{NS}}}{tag}')
    if text is not None:
        el.text = str(text)
    return el


def _parsear_retorno_evento(resp_xml):
    """Extrai cStat e xMotivo da resposta do receptor de eventos."""
    stripped = resp_xml.strip()
    if not stripped.startswith('<') or '403' in stripped[:300] or '401' in stripped[:300]:
        return '999', f'Erro HTTP SEFAZ: {stripped[:120]}', None
    root = etree.fromstring(resp_xml.encode('utf-8'))

    def find(tag):
        el = root.find(f'.//{{{NS}}}{tag}')
        return el.text if el is not None else None

    inf_evento = root.find(f'.//{{{NS}}}infEvento')
    if inf_evento is not None:
        return find('cStat'), find('xMotivo'), find('nProt')
    return find('cStat'), find('xMotivo'), None


def _assinar_evento(evento_el, cert_pem, key_pem, id_evento):
    """Assina o elemento infEvento com XMLDSIG."""
    signer = _XMLSignerSHA1(
        method=methods.enveloped,
        signature_algorithm='rsa-sha1',
        digest_algorithm='sha1',
        c14n_algorithm='http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    )
    signed = signer.sign(
        evento_el,
        key=key_pem,
        cert=cert_pem,
        reference_uri=id_evento,
    )
    return signed


def _montar_evento(chave, cnpj, tp_evento, n_seq, det_evento_el, dh_evento):
    """Monta o XML envEvento com um único evento."""
    id_evento = f'ID{tp_evento}{chave}{str(n_seq).zfill(2)}'

    evento = etree.Element(f'{{{NS}}}evento', versao='1.00')
    inf_ev = etree.SubElement(evento, f'{{{NS}}}infEvento', versao='1.00', Id=id_evento)
    _texto(inf_ev, 'cOrgao', '91')   # 91 = SVRS (ambiente nacional)
    _texto(inf_ev, 'tpAmb', NFE_AMBIENTE)
    _texto(inf_ev, 'CNPJ', cnpj)
    _texto(inf_ev, 'chNFe', chave)
    _texto(inf_ev, 'dhEvento', dh_evento.strftime('%Y-%m-%dT%H:%M:%S-03:00'))
    _texto(inf_ev, 'tpEvento', tp_evento)
    _texto(inf_ev, 'nSeqEvento', str(n_seq))
    _texto(inf_ev, 'verEvento', '1.00')
    inf_ev.append(det_evento_el)

    env = etree.Element(f'{{{NS}}}envEvento', versao='1.00')
    _texto(env, 'idLote', str(random.randint(1, 999999999999)))
    env.append(evento)

    return env, evento, id_evento


def _enviar_evento(env_el, evento_el, id_evento, emitente, cert_pem, key_pem,
                   cert_path_pem, key_path_pem):
    """Assina e transmite o evento."""
    evento_assinado = _assinar_evento(evento_el, cert_pem, key_pem, id_evento)
    # Substituir o evento não-assinado no envEvento pelo assinado
    env_el.remove(env_el.find(f'{{{NS}}}evento'))
    env_el.append(evento_assinado)

    env_bytes = etree.tostring(env_el, xml_declaration=True, encoding='UTF-8')
    env_str = env_bytes.decode('utf-8')
    if env_str.startswith('<?xml'):
        env_str = env_str[env_str.index('?>') + 2:].lstrip()

    url = _URL_EVENTO_PRD if NFE_AMBIENTE == '1' else _URL_EVENTO_HOM
    c_uf = emitente['c_uf']

    soap = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
        ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
        ' xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
        '<soap12:Header>'
        '<nfeCabecMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">'
        f'<cUF>{c_uf}</cUF><versaoDados>1.00</versaoDados>'
        '</nfeCabecMsg>'
        '</soap12:Header>'
        '<soap12:Body>'
        '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">'
        + env_str
        + '</nfeDadosMsg>'
        '</soap12:Body>'
        '</soap12:Envelope>'
    )

    resp = requests.post(
        url,
        data=soap.encode('utf-8'),
        headers={
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento',
        },
        cert=(cert_path_pem, key_path_pem),
        verify=_CA_BUNDLE,
        timeout=30,
    )
    return resp.text, env_bytes.decode('utf-8')


def cancelar_nfe(dados):
    """
    dados = {chave, cnpj_emitente, justificativa, protocolo_autorizacao}
    Retorna {status, c_stat, x_motivo, protocolo, xml_evento}
    """
    chave = dados['chave']
    cnpj  = dados['cnpj_emitente']
    just  = dados['justificativa'].strip()
    if len(just) < 15:
        return {'erro': 'Justificativa deve ter pelo menos 15 caracteres'}

    emitente = EMITENTES.get(cnpj)
    if not emitente:
        return {'erro': f'Emitente desconhecido: {cnpj}'}

    cert_pem_path, key_pem_path, cert_pem, key_pem = _extrair_cert_key(
        emitente['cert_path'], emitente['cert_password']
    )
    dh = _now_br()

    det = etree.Element(f'{{{NS}}}detEvento', versao='1.00')
    _texto(det, 'descEvento', 'Cancelamento')
    _texto(det, 'nProt', dados['protocolo_autorizacao'])
    _texto(det, 'xJust', just)

    env_el, evento_el, id_evento = _montar_evento(chave, cnpj, '110111', 1, det, dh)
    resp_text, xml_evento = _enviar_evento(
        env_el, evento_el, id_evento, emitente,
        cert_pem, key_pem, cert_pem_path, key_pem_path
    )

    c_stat, x_motivo, n_prot = _parsear_retorno_evento(resp_text)
    # cStat 135 = cancelamento homologado
    if c_stat in ('135', '155'):
        return {'status': 'cancelada', 'c_stat': c_stat, 'x_motivo': x_motivo,
                'protocolo': n_prot, 'xml_evento': xml_evento}
    return {'status': 'rejeitado', 'c_stat': c_stat, 'x_motivo': x_motivo, 'xml_evento': xml_evento}


def corrigir_nfe(dados):
    """
    dados = {chave, cnpj_emitente, correcao, n_seq_evento}
    Retorna {status, c_stat, x_motivo, protocolo, xml_evento}
    """
    chave    = dados['chave']
    cnpj     = dados['cnpj_emitente']
    correcao = dados['correcao'].strip()
    n_seq    = int(dados.get('n_seq_evento', 1))

    if len(correcao) < 15:
        return {'erro': 'Correção deve ter pelo menos 15 caracteres'}

    emitente = EMITENTES.get(cnpj)
    if not emitente:
        return {'erro': f'Emitente desconhecido: {cnpj}'}

    cert_pem_path, key_pem_path, cert_pem, key_pem = _extrair_cert_key(
        emitente['cert_path'], emitente['cert_password']
    )
    dh = _now_br()

    det = etree.Element(f'{{{NS}}}detEvento', versao='1.00')
    _texto(det, 'descEvento', 'Carta de Correcao')
    _texto(det, 'xCorrecao', correcao)
    _texto(det, 'xCondUso',
           'A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, '
           'de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido '
           'na emissao de documento fiscal, desde que o erro nao esteja relacionado com: '
           'I - as variaveis que determinam o valor do imposto tais como: base de calculo, '
           'aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; '
           'II - a correcao de dados cadastrais que implique mudanca do remetente ou do '
           'destinatario; III - a data de emissao ou de saida.')

    env_el, evento_el, id_evento = _montar_evento(chave, cnpj, '110110', n_seq, det, dh)
    resp_text, xml_evento = _enviar_evento(
        env_el, evento_el, id_evento, emitente,
        cert_pem, key_pem, cert_pem_path, key_pem_path
    )

    c_stat, x_motivo, n_prot = _parsear_retorno_evento(resp_text)
    # cStat 135 = evento registrado
    if c_stat in ('135', '155'):
        return {'status': 'registrada', 'c_stat': c_stat, 'x_motivo': x_motivo,
                'protocolo': n_prot, 'xml_evento': xml_evento}
    return {'status': 'rejeitado', 'c_stat': c_stat, 'x_motivo': x_motivo, 'xml_evento': xml_evento}


def inutilizar_nfe(dados):
    """
    dados = {cnpj_emitente, serie, n_nf_ini, n_nf_fin, justificativa}
    Retorna {status, c_stat, x_motivo, protocolo, xml}
    """
    cnpj      = dados['cnpj_emitente']
    serie     = str(dados['serie']).zfill(3)
    n_ini     = int(dados['n_nf_ini'])
    n_fin     = int(dados['n_nf_fin'])
    just      = dados['justificativa'].strip()

    if len(just) < 15:
        return {'erro': 'Justificativa deve ter pelo menos 15 caracteres'}
    if n_fin < n_ini:
        return {'erro': 'n_nf_fin deve ser >= n_nf_ini'}

    emitente = EMITENTES.get(cnpj)
    if not emitente:
        return {'erro': f'Emitente desconhecido: {cnpj}'}

    cert_pem_path, key_pem_path, cert_pem, key_pem = _extrair_cert_key(
        emitente['cert_path'], emitente['cert_password']
    )
    dh   = _now_br()
    aamm = dh.strftime('%y%m')
    c_uf = emitente['c_uf']

    id_inut = f'ID{c_uf}55{serie}{cnpj}{aamm}{str(n_ini).zfill(9)}{str(n_fin).zfill(9)}'

    inut_el = etree.Element(f'{{{NS}}}inutNFe', versao='4.00')
    inf = etree.SubElement(inut_el, f'{{{NS}}}infInut', Id=id_inut)
    _texto(inf, 'tpAmb', NFE_AMBIENTE)
    _texto(inf, 'xServ', 'INUTILIZAR')
    _texto(inf, 'cUF', c_uf)
    _texto(inf, 'ano', dh.strftime('%y'))
    _texto(inf, 'CNPJ', cnpj)
    _texto(inf, 'mod', '55')
    _texto(inf, 'serie', str(int(serie)))
    _texto(inf, 'nNFIni', str(n_ini))
    _texto(inf, 'nNFFin', str(n_fin))
    _texto(inf, 'xJust', just)
    _texto(inf, 'dhEvento', dh.strftime('%Y-%m-%dT%H:%M:%S-03:00'))

    signer = _XMLSignerSHA1(
        method=methods.enveloped,
        signature_algorithm='rsa-sha1',
        digest_algorithm='sha1',
        c14n_algorithm='http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    )
    inut_assinada = signer.sign(
        inut_el, key=key_pem, cert=cert_pem, reference_uri=id_inut
    )

    inut_bytes = etree.tostring(inut_assinada, xml_declaration=True, encoding='UTF-8')
    inut_str = inut_bytes.decode('utf-8')
    if inut_str.startswith('<?xml'):
        inut_str = inut_str[inut_str.index('?>') + 2:].lstrip()

    url = _URL_INUT_PRD if NFE_AMBIENTE == '1' else _URL_INUT_HOM

    soap = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
        ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
        ' xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
        '<soap12:Header>'
        '<nfeCabecMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NfeInutilizacao4">'
        f'<cUF>{c_uf}</cUF><versaoDados>4.00</versaoDados>'
        '</nfeCabecMsg>'
        '</soap12:Header>'
        '<soap12:Body>'
        '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NfeInutilizacao4">'
        + inut_str
        + '</nfeDadosMsg>'
        '</soap12:Body>'
        '</soap12:Envelope>'
    )

    resp = requests.post(
        url,
        data=soap.encode('utf-8'),
        headers={
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NfeInutilizacao4/nfeInutilizacaoNF',
        },
        cert=(cert_path_pem, key_path_pem),
        verify=_CA_BUNDLE,
        timeout=30,
    )

    resp_xml = resp.text
    stripped = resp_xml.strip()
    if not stripped.startswith('<') or '403' in stripped[:300]:
        return {'erro': f'Erro HTTP SEFAZ: {stripped[:120]}'}

    root = etree.fromstring(resp_xml.encode('utf-8'))
    def find(tag):
        el = root.find(f'.//{{{NS}}}{tag}')
        return el.text if el is not None else None

    c_stat   = find('cStat')
    x_motivo = find('xMotivo')
    n_prot   = find('nProt')
    # cStat 102 = inutilização homologada
    if c_stat in ('102',):
        return {'status': 'inutilizada', 'c_stat': c_stat, 'x_motivo': x_motivo,
                'protocolo': n_prot, 'xml': inut_bytes.decode('utf-8')}
    return {'status': 'rejeitado', 'c_stat': c_stat, 'x_motivo': x_motivo}
```

- [ ] **Step 2: Commit**

```bash
git add nfe_sidecar/eventos.py
git commit -m "feat: sidecar eventos — cancelamento, CC-e, inutilizacao NF-e"
```

---

## Task 3: Sidecar — novas rotas no app.py

**Files:**
- Modify: `nfe_sidecar/app.py`

- [ ] **Step 1: Adicionar import e 3 rotas ao app.py**

Substituir o conteúdo completo de `nfe_sidecar/app.py`:

```python
# nfe_sidecar/app.py
import os
import json
from flask import Flask, request, jsonify, send_file
from emitir import emitir_nfe
from danfe import gerar_danfe
from eventos import cancelar_nfe, corrigir_nfe, inutilizar_nfe

app = Flask(__name__)

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

@app.route('/emitir', methods=['POST'])
def emitir():
    try:
        dados = request.get_json(force=True)
        resultado = emitir_nfe(dados)
        return jsonify(resultado), (200 if resultado.get('status') == 'autorizada' else 422)
    except Exception as e:
        return jsonify({'erro': str(e)}), 500

@app.route('/danfe', methods=['POST'])
def danfe():
    try:
        dados = request.get_json(force=True)
        pdf_path = gerar_danfe(dados['xml'], dados['output_path'])
        return send_file(pdf_path, mimetype='application/pdf')
    except Exception as e:
        return jsonify({'erro': str(e)}), 500

@app.route('/cancelar', methods=['POST'])
def cancelar():
    try:
        dados = request.get_json(force=True)
        resultado = cancelar_nfe(dados)
        if resultado.get('erro'):
            return jsonify(resultado), 400
        ok = resultado.get('status') == 'cancelada'
        return jsonify(resultado), (200 if ok else 422)
    except Exception as e:
        return jsonify({'erro': str(e)}), 500

@app.route('/corrigir', methods=['POST'])
def corrigir():
    try:
        dados = request.get_json(force=True)
        resultado = corrigir_nfe(dados)
        if resultado.get('erro'):
            return jsonify(resultado), 400
        ok = resultado.get('status') == 'registrada'
        return jsonify(resultado), (200 if ok else 422)
    except Exception as e:
        return jsonify({'erro': str(e)}), 500

@app.route('/inutilizar', methods=['POST'])
def inutilizar():
    try:
        dados = request.get_json(force=True)
        resultado = inutilizar_nfe(dados)
        if resultado.get('erro'):
            return jsonify(resultado), 400
        ok = resultado.get('status') == 'inutilizada'
        return jsonify(resultado), (200 if ok else 422)
    except Exception as e:
        return jsonify({'erro': str(e)}), 500

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=3001, debug=False)
```

- [ ] **Step 2: Commit**

```bash
git add nfe_sidecar/app.py
git commit -m "feat: sidecar rotas /cancelar /corrigir /inutilizar"
```

---

## Task 4: Node.js — src/services/nfe.js

**Files:**
- Modify: `src/services/nfe.js`

- [ ] **Step 1: Adicionar as 3 funções ao serviço**

Substituir o conteúdo completo de `src/services/nfe.js`:

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/services/nfe.js
git commit -m "feat: nfe service — cancelarNfe, corrigirNfe, inutilizarNfe"
```

---

## Task 5: Node.js — src/modules/nfe/service.js

**Files:**
- Modify: `src/modules/nfe/service.js`

- [ ] **Step 1: Adicionar funções cancelar, corrigir, inutilizar**

Adicionar ao final de `src/modules/nfe/service.js` (antes do `module.exports`):

```javascript
async function cancelar(nfeId, body) {
  const { justificativa } = body;
  if (!justificativa || justificativa.trim().length < 15) {
    return { erro: ['Justificativa deve ter pelo menos 15 caracteres'] };
  }

  const r = await db.query(
    `SELECT id, chave, protocolo, status, cnpj_emitente FROM nfe WHERE id = $1`,
    [nfeId]
  );
  if (!r.rows[0]) return { erro: ['NF-e não encontrada'] };
  const nfe = r.rows[0];
  if (nfe.status !== 'autorizada') return { erro: ['Só é possível cancelar NF-e autorizada'] };
  if (!nfe.chave) return { erro: ['NF-e sem chave de acesso'] };

  const { cancelarNfe } = require('../../services/nfe');
  const resultado = await cancelarNfe({
    chave: nfe.chave,
    cnpj_emitente: nfe.cnpj_emitente,
    justificativa: justificativa.trim(),
    protocolo_autorizacao: nfe.protocolo,
  });

  if (resultado.status === 'cancelada') {
    await db.query(
      `UPDATE nfe SET status='cancelada', cancelado_em=NOW(),
       cancelamento_protocolo=$1, updated_at=NOW() WHERE id=$2`,
      [resultado.protocolo, nfeId]
    );
    await db.query(
      `INSERT INTO nfe_eventos (nfe_id, tipo, protocolo, c_stat, x_motivo, justificativa, xml_evento)
       VALUES ($1,'cancelamento',$2,$3,$4,$5,$6)`,
      [nfeId, resultado.protocolo, resultado.c_stat, resultado.x_motivo,
       justificativa.trim(), resultado.xml_evento]
    );
    return { status: 'cancelada', protocolo: resultado.protocolo, c_stat: resultado.c_stat };
  }
  return { erro: [`SEFAZ ${resultado.c_stat}: ${resultado.x_motivo}`] };
}

async function corrigir(nfeId, body) {
  const { correcao } = body;
  if (!correcao || correcao.trim().length < 15) {
    return { erro: ['Correção deve ter pelo menos 15 caracteres'] };
  }

  const r = await db.query(
    `SELECT id, chave, status, cnpj_emitente FROM nfe WHERE id = $1`, [nfeId]
  );
  if (!r.rows[0]) return { erro: ['NF-e não encontrada'] };
  const nfe = r.rows[0];
  if (nfe.status !== 'autorizada') return { erro: ['Só é possível corrigir NF-e autorizada'] };

  // Contar CC-e anteriores para definir n_seq_evento
  const seqR = await db.query(
    `SELECT COUNT(*) AS total FROM nfe_eventos WHERE nfe_id=$1 AND tipo='cc_e'`, [nfeId]
  );
  const n_seq = parseInt(seqR.rows[0].total) + 1;

  const { corrigirNfe } = require('../../services/nfe');
  const resultado = await corrigirNfe({
    chave: nfe.chave,
    cnpj_emitente: nfe.cnpj_emitente,
    correcao: correcao.trim(),
    n_seq_evento: n_seq,
  });

  if (resultado.status === 'registrada') {
    await db.query(
      `INSERT INTO nfe_eventos (nfe_id, tipo, protocolo, c_stat, x_motivo, justificativa, xml_evento)
       VALUES ($1,'cc_e',$2,$3,$4,$5,$6)`,
      [nfeId, resultado.protocolo, resultado.c_stat, resultado.x_motivo,
       correcao.trim(), resultado.xml_evento]
    );
    return { status: 'registrada', protocolo: resultado.protocolo, n_seq, c_stat: resultado.c_stat };
  }
  return { erro: [`SEFAZ ${resultado.c_stat}: ${resultado.x_motivo}`] };
}

async function inutilizar(body) {
  const { cnpj_emitente, serie, n_nf_ini, n_nf_fin, justificativa } = body;
  if (!cnpj_emitente || !serie || !n_nf_ini || !n_nf_fin || !justificativa) {
    return { erro: ['cnpj_emitente, serie, n_nf_ini, n_nf_fin e justificativa são obrigatórios'] };
  }
  if (justificativa.trim().length < 15) {
    return { erro: ['Justificativa deve ter pelo menos 15 caracteres'] };
  }

  const { inutilizarNfe } = require('../../services/nfe');
  const resultado = await inutilizarNfe({
    cnpj_emitente,
    serie,
    n_nf_ini: parseInt(n_nf_ini),
    n_nf_fin: parseInt(n_nf_fin),
    justificativa: justificativa.trim(),
  });

  if (resultado.status === 'inutilizada') {
    // Registrar sem nfe_id (é uma faixa de números, não uma NF específica)
    await db.query(
      `INSERT INTO nfe_eventos (nfe_id, tipo, protocolo, c_stat, x_motivo, justificativa)
       SELECT NULL, 'inutilizacao', $1, $2, $3, $4
       WHERE EXISTS (SELECT 1)`,  -- workaround: nfe_id NOT NULL constraint — ver nota abaixo
      [resultado.protocolo, resultado.c_stat, resultado.x_motivo, justificativa.trim()]
    );
    return { status: 'inutilizada', protocolo: resultado.protocolo, c_stat: resultado.c_stat };
  }
  return { erro: [`SEFAZ ${resultado.c_stat}: ${resultado.x_motivo}`] };
}
```

> **Nota sobre inutilização:** A tabela `nfe_eventos` tem `nfe_id NOT NULL`. Para inutilização (sem NF específica), a migration Task 1 deve alterar para `nfe_id INTEGER REFERENCES nfe(id)` (nullable). Verifique na migration se foi declarado sem `NOT NULL` — se não foi, adicione ao migration:
> ```sql
> ALTER TABLE nfe_eventos ALTER COLUMN nfe_id DROP NOT NULL;
> ```
> Execute no VPS antes de testar inutilização.

- [ ] **Step 2: Atualizar module.exports**

```javascript
module.exports = { emitir, listarPorOrcamento, cancelar, corrigir, inutilizar };
```

- [ ] **Step 3: Commit**

```bash
git add src/modules/nfe/service.js
git commit -m "feat: nfe module service — cancelar, corrigir, inutilizar"
```

---

## Task 6: Node.js — src/modules/nfe/router.js

**Files:**
- Modify: `src/modules/nfe/router.js`

- [ ] **Step 1: Adicionar 3 rotas**

Adicionar antes do `module.exports = router;`:

```javascript
// Cancelamento
router.post('/:nfe_id/cancelar', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.cancelar(req.params.nfe_id, req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) {
    console.error('[NFE-CANCELAR]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Carta de Correção
router.post('/:nfe_id/corrigir', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.corrigir(req.params.nfe_id, req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) {
    console.error('[NFE-CORRIGIR]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Inutilização (não é por NF-id, é por faixa)
router.post('/inutilizar', requireRole('admin'), async (req, res) => {
  try {
    const result = await service.inutilizar(req.body);
    if (result.erro) return res.status(400).json({ errors: result.erro });
    res.json(result);
  } catch (err) {
    console.error('[NFE-INUTILIZAR]', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});
```

> **Atenção à ordem das rotas:** A rota `/inutilizar` deve ser registrada **antes** de `/:nfe_id` para não colidir com o parâmetro dinâmico. Verifique o router.js — se já há rotas com `/:nfe_id` antes, coloque `/inutilizar` como primeira rota no arquivo.

- [ ] **Step 2: Commit**

```bash
git add src/modules/nfe/router.js
git commit -m "feat: nfe router — POST cancelar, corrigir, inutilizar"
```

---

## Task 7: PWA admin.html — botões e modais

**Files:**
- Modify: `public/pwa/admin.html`

### 7a — Botões na linha do orçamento

- [ ] **Step 1: Localizar o bloco de botões NF-e existente (linha ~233)**

Encontrar o bloco:
```javascript
${o.nfe_status === 'autorizada' && o.nfe_id ? `
  <div style="...">
    <div style="...">📋 NF-e AUTORIZADA</div>
    <div style="...">
      <a href="/api/v2/nfe/danfe/${o.nfe_id}" ...>📄 Download DANFE</a>
    </div>
  </div>
` : ''}
```

- [ ] **Step 2: Substituir por bloco com botões Cancelar e CC-e**

```javascript
${o.nfe_status === 'autorizada' && o.nfe_id ? `
  <div style="margin-top:8px;padding:8px;background:#f3e5f5;border-radius:6px;border-left:3px solid #7b1fa2">
    <div style="font-size:10px;color:#7b1fa2;font-weight:bold;margin-bottom:6px">📋 NF-e AUTORIZADA</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <a href="/api/v2/nfe/danfe/${o.nfe_id}" target="_blank"
         style="font-size:11px;padding:3px 8px;background:#7b1fa2;color:#fff;border-radius:4px;text-decoration:none">
        📄 DANFE
      </a>
      <button onclick="abrirModalCancelarNfe('${o.nfe_id}')"
              style="font-size:11px;padding:3px 8px;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer">
        ✕ Cancelar NF
      </button>
      <button onclick="abrirModalCceNfe('${o.nfe_id}')"
              style="font-size:11px;padding:3px 8px;background:#e65100;color:#fff;border:none;border-radius:4px;cursor:pointer">
        ✎ CC-e
      </button>
    </div>
  </div>
` : ''}
```

### 7b — Botão Inutilização no topo da tela

- [ ] **Step 3: Adicionar botão "Inutilizar NF-e" na barra de ações do admin**

Localizar na área de cabeçalho/filtros do admin onde há outros botões de ação, e adicionar:

```html
<button onclick="abrirModalInutilizar()"
        style="background:#4e342e;color:#fff;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px">
  🔒 Inutilizar NF-e
</button>
```

### 7c — Modal Cancelamento

- [ ] **Step 4: Adicionar modal de cancelamento antes do `</body>`**

```html
<!-- Modal Cancelamento NF-e -->
<div id="modalCancelarNfe" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1100;overflow:auto">
  <div style="background:#fff;max-width:480px;margin:60px auto;border-radius:8px;padding:24px">
    <h3 style="margin:0 0 16px;color:#c62828">✕ Cancelar NF-e</h3>
    <p style="font-size:13px;color:#555;margin:0 0 12px">
      O cancelamento só é aceito pelo SEFAZ em até <strong>24 horas</strong> após a autorização.
    </p>
    <form id="formCancelarNfe" onsubmit="submitCancelarNfe(event)">
      <input type="hidden" id="cancelarNfeId" value="">
      <div style="margin-bottom:12px">
        <label style="font-size:12px;font-weight:bold">Justificativa (mín. 15 caracteres) *</label>
        <textarea id="cancelarJustificativa" rows="4" required minlength="15"
          style="width:100%;margin-top:4px;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box"
          placeholder="Informe o motivo do cancelamento..."></textarea>
      </div>
      <div id="cancelarResultado"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
        <button type="button" onclick="fecharModalCancelarNfe()"
          style="padding:8px 16px;border:1px solid #ddd;border-radius:4px;cursor:pointer">Fechar</button>
        <button type="submit" id="btnCancelarNfe"
          style="padding:8px 16px;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer">
          Cancelar NF-e
        </button>
      </div>
    </form>
  </div>
</div>
```

### 7d — Modal CC-e

- [ ] **Step 5: Adicionar modal de carta de correção**

```html
<!-- Modal CC-e -->
<div id="modalCceNfe" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1100;overflow:auto">
  <div style="background:#fff;max-width:480px;margin:60px auto;border-radius:8px;padding:24px">
    <h3 style="margin:0 0 16px;color:#e65100">✎ Carta de Correção (CC-e)</h3>
    <p style="font-size:12px;color:#777;margin:0 0 12px">
      A CC-e <strong>não pode</strong> corrigir: valores, base de cálculo, alíquota, dados do remetente/destinatário ou data de emissão.
    </p>
    <form id="formCceNfe" onsubmit="submitCceNfe(event)">
      <input type="hidden" id="cceNfeId" value="">
      <div style="margin-bottom:12px">
        <label style="font-size:12px;font-weight:bold">Texto da correção (mín. 15 caracteres) *</label>
        <textarea id="cceCorrecao" rows="5" required minlength="15"
          style="width:100%;margin-top:4px;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box"
          placeholder="Descreva a correção a ser realizada..."></textarea>
      </div>
      <div id="cceResultado"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
        <button type="button" onclick="fecharModalCceNfe()"
          style="padding:8px 16px;border:1px solid #ddd;border-radius:4px;cursor:pointer">Fechar</button>
        <button type="submit" id="btnCceNfe"
          style="padding:8px 16px;background:#e65100;color:#fff;border:none;border-radius:4px;cursor:pointer">
          Enviar CC-e
        </button>
      </div>
    </form>
  </div>
</div>
```

### 7e — Modal Inutilização

- [ ] **Step 6: Adicionar modal de inutilização**

```html
<!-- Modal Inutilização -->
<div id="modalInutilizar" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1100;overflow:auto">
  <div style="background:#fff;max-width:480px;margin:60px auto;border-radius:8px;padding:24px">
    <h3 style="margin:0 0 16px;color:#4e342e">🔒 Inutilizar Numeração NF-e</h3>
    <p style="font-size:12px;color:#777;margin:0 0 12px">
      Use para inutilizar números de NF-e que não serão utilizados (ex: sequência pulada por erro de sistema).
    </p>
    <form id="formInutilizar" onsubmit="submitInutilizar(event)">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div>
          <label style="font-size:12px;font-weight:bold">Empresa Emitente *</label>
          <select id="inutEmitente" required
            style="width:100%;margin-top:4px;padding:6px;border:1px solid #ddd;border-radius:4px;font-size:12px">
            <option value="19296723000108">GRUPO LKL (19.296.723/0001-08)</option>
            <option value="44448899000185">FACTOR (44.448.899/0001-85)</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Série *</label>
          <input type="number" id="inutSerie" value="1" min="1" max="999" required
            style="width:100%;margin-top:4px;padding:6px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">NF Inicial *</label>
          <input type="number" id="inutNfIni" min="1" required
            style="width:100%;margin-top:4px;padding:6px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">NF Final *</label>
          <input type="number" id="inutNfFin" min="1" required
            style="width:100%;margin-top:4px;padding:6px;border:1px solid #ddd;border-radius:4px;font-size:12px;box-sizing:border-box">
        </div>
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:12px;font-weight:bold">Justificativa (mín. 15 caracteres) *</label>
        <textarea id="inutJustificativa" rows="3" required minlength="15"
          style="width:100%;margin-top:4px;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box"
          placeholder="Motivo da inutilização..."></textarea>
      </div>
      <div id="inutResultado"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
        <button type="button" onclick="fecharModalInutilizar()"
          style="padding:8px 16px;border:1px solid #ddd;border-radius:4px;cursor:pointer">Fechar</button>
        <button type="submit" id="btnInutilizar"
          style="padding:8px 16px;background:#4e342e;color:#fff;border:none;border-radius:4px;cursor:pointer">
          Inutilizar
        </button>
      </div>
    </form>
  </div>
</div>
```

### 7f — JavaScript dos modais

- [ ] **Step 7: Adicionar funções JS antes do `</script>` final**

```javascript
// ===== Cancelamento NF-e =====
function abrirModalCancelarNfe(nfeId) {
  document.getElementById('cancelarNfeId').value = nfeId;
  document.getElementById('cancelarJustificativa').value = '';
  document.getElementById('cancelarResultado').innerHTML = '';
  document.getElementById('btnCancelarNfe').disabled = false;
  document.getElementById('modalCancelarNfe').style.display = 'block';
}
function fecharModalCancelarNfe() {
  document.getElementById('modalCancelarNfe').style.display = 'none';
}
async function submitCancelarNfe(e) {
  e.preventDefault();
  const nfeId = document.getElementById('cancelarNfeId').value;
  const justificativa = document.getElementById('cancelarJustificativa').value;
  const btn = document.getElementById('btnCancelarNfe');
  const el = document.getElementById('cancelarResultado');
  btn.disabled = true; btn.textContent = 'Cancelando...';
  try {
    const res = await fetch(`/api/v2/nfe/${nfeId}/cancelar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
      body: JSON.stringify({ justificativa })
    });
    const data = await res.json();
    if (res.ok) {
      el.innerHTML = `<div style="background:#e8f5e9;padding:10px;border-radius:4px;font-size:12px">
        ✅ NF-e cancelada! Protocolo: <strong>${data.protocolo}</strong></div>`;
      await carregarOrcamentos();
    } else {
      el.innerHTML = `<div style="background:#fce4ec;padding:10px;border-radius:4px;font-size:12px">
        ❌ ${(data.errors || [data.error]).join(', ')}</div>`;
      btn.disabled = false; btn.textContent = 'Cancelar NF-e';
    }
  } catch (err) {
    el.innerHTML = `<div style="background:#fce4ec;padding:10px;border-radius:4px;font-size:12px">❌ Erro: ${err.message}</div>`;
    btn.disabled = false; btn.textContent = 'Cancelar NF-e';
  }
}

// ===== CC-e =====
function abrirModalCceNfe(nfeId) {
  document.getElementById('cceNfeId').value = nfeId;
  document.getElementById('cceCorrecao').value = '';
  document.getElementById('cceResultado').innerHTML = '';
  document.getElementById('btnCceNfe').disabled = false;
  document.getElementById('modalCceNfe').style.display = 'block';
}
function fecharModalCceNfe() {
  document.getElementById('modalCceNfe').style.display = 'none';
}
async function submitCceNfe(e) {
  e.preventDefault();
  const nfeId = document.getElementById('cceNfeId').value;
  const correcao = document.getElementById('cceCorrecao').value;
  const btn = document.getElementById('btnCceNfe');
  const el = document.getElementById('cceResultado');
  btn.disabled = true; btn.textContent = 'Enviando...';
  try {
    const res = await fetch(`/api/v2/nfe/${nfeId}/corrigir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
      body: JSON.stringify({ correcao })
    });
    const data = await res.json();
    if (res.ok) {
      el.innerHTML = `<div style="background:#e8f5e9;padding:10px;border-radius:4px;font-size:12px">
        ✅ CC-e registrada! Protocolo: <strong>${data.protocolo}</strong> (Seq. ${data.n_seq})</div>`;
    } else {
      el.innerHTML = `<div style="background:#fce4ec;padding:10px;border-radius:4px;font-size:12px">
        ❌ ${(data.errors || [data.error]).join(', ')}</div>`;
      btn.disabled = false; btn.textContent = 'Enviar CC-e';
    }
  } catch (err) {
    el.innerHTML = `<div style="background:#fce4ec;padding:10px;border-radius:4px;font-size:12px">❌ Erro: ${err.message}</div>`;
    btn.disabled = false; btn.textContent = 'Enviar CC-e';
  }
}

// ===== Inutilização =====
function abrirModalInutilizar() {
  document.getElementById('inutResultado').innerHTML = '';
  document.getElementById('btnInutilizar').disabled = false;
  document.getElementById('btnInutilizar').textContent = 'Inutilizar';
  document.getElementById('modalInutilizar').style.display = 'block';
}
function fecharModalInutilizar() {
  document.getElementById('modalInutilizar').style.display = 'none';
}
async function submitInutilizar(e) {
  e.preventDefault();
  const btn = document.getElementById('btnInutilizar');
  const el = document.getElementById('inutResultado');
  btn.disabled = true; btn.textContent = 'Enviando...';
  const body = {
    cnpj_emitente: document.getElementById('inutEmitente').value,
    serie: document.getElementById('inutSerie').value,
    n_nf_ini: document.getElementById('inutNfIni').value,
    n_nf_fin: document.getElementById('inutNfFin').value,
    justificativa: document.getElementById('inutJustificativa').value,
  };
  try {
    const res = await fetch('/api/v2/nfe/inutilizar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (res.ok) {
      el.innerHTML = `<div style="background:#e8f5e9;padding:10px;border-radius:4px;font-size:12px">
        ✅ Inutilização registrada! Protocolo: <strong>${data.protocolo}</strong></div>`;
    } else {
      el.innerHTML = `<div style="background:#fce4ec;padding:10px;border-radius:4px;font-size:12px">
        ❌ ${(data.errors || [data.error]).join(', ')}</div>`;
      btn.disabled = false; btn.textContent = 'Inutilizar';
    }
  } catch (err) {
    el.innerHTML = `<div style="background:#fce4ec;padding:10px;border-radius:4px;font-size:12px">❌ Erro: ${err.message}</div>`;
    btn.disabled = false; btn.textContent = 'Inutilizar';
  }
}
```

> **Atenção:** A função `getToken()` deve já existir no admin.html (recupera o JWT do localStorage). Se não existir, use `localStorage.getItem('token')` diretamente no lugar de `getToken()`.

- [ ] **Step 8: Commit**

```bash
git add public/pwa/admin.html
git commit -m "feat: admin PWA — modais cancelamento, CC-e e inutilizacao NF-e"
```

---

## Task 8: Deploy e testes no VPS

- [ ] **Step 1: Sincronizar arquivos para o VPS**

```bash
rsync -av nfe_sidecar/eventos.py nfe_sidecar/app.py \
  root@2.25.147.243:/var/www/lkl-chatbot/nfe_sidecar/

rsync -av src/modules/nfe/service.js src/modules/nfe/router.js \
  root@2.25.147.243:/var/www/lkl-chatbot/src/modules/nfe/

rsync -av src/services/nfe.js \
  root@2.25.147.243:/var/www/lkl-chatbot/src/services/

rsync -av public/pwa/admin.html \
  root@2.25.147.243:/var/www/lkl-chatbot/public/pwa/

rsync -av sql/migrations/010_nfe_eventos.sql \
  root@2.25.147.243:/var/www/lkl-chatbot/sql/migrations/
```

- [ ] **Step 2: Aplicar migration no banco**

```bash
ssh root@2.25.147.243
DB=$(grep DATABASE_URL /var/www/lkl-chatbot/.env | cut -d= -f2-)
sudo -u postgres psql "$DB" -f /var/www/lkl-chatbot/sql/migrations/010_nfe_eventos.sql
# Tornar nfe_id nullable para inutilização:
sudo -u postgres psql "$DB" -c "ALTER TABLE nfe_eventos ALTER COLUMN nfe_id DROP NOT NULL;"
```

- [ ] **Step 3: Reiniciar sidecar e Node.js**

```bash
ssh root@2.25.147.243
# Reiniciar sidecar Python
pkill -f 'python3.*app.py' || true
sleep 1
cd /var/www/lkl-chatbot/nfe_sidecar
nohup /var/www/lkl-chatbot/nfe_sidecar/venv/bin/python3 app.py >> /var/log/lkl-sidecar.log 2>&1 &

# Reiniciar Node.js
pm2 restart lkl-chatbot

# Verificar
sleep 3
curl -s http://127.0.0.1:3001/health
ps aux | grep python3 | grep -v grep
```

Expected: `{"status": "ok"}` + processo python3 listado.

- [ ] **Step 4: Teste de cancelamento via curl**

```bash
# Obter token
TOKEN=$(curl -s -X POST http://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@lklgrafica.com.br","password":"Admin@2024"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Obter nfe_id de uma NF autorizada (substituir pelo ID real)
NFE_ID=<id_da_nfe_autorizada>

curl -s -X POST http://localhost/api/v2/nfe/$NFE_ID/cancelar \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"justificativa":"Cancelamento realizado para teste do sistema"}' | python3 -m json.tool
```

Expected: `{"status": "cancelada", "protocolo": "...", "c_stat": "135"}`

- [ ] **Step 5: Teste de CC-e via curl**

```bash
NFE_ID=<id_de_outra_nfe_autorizada>

curl -s -X POST http://localhost/api/v2/nfe/$NFE_ID/corrigir \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"correcao":"Correcao do campo complemento do endereco do destinatario"}' | python3 -m json.tool
```

Expected: `{"status": "registrada", "protocolo": "...", "n_seq": 1, "c_stat": "135"}`

- [ ] **Step 6: Teste de inutilização via curl**

```bash
curl -s -X POST http://localhost/api/v2/nfe/inutilizar \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "cnpj_emitente": "19296723000108",
    "serie": "1",
    "n_nf_ini": 900,
    "n_nf_fin": 900,
    "justificativa":"Numero inutilizado por falha do sistema durante testes"
  }' | python3 -m json.tool
```

Expected: `{"status": "inutilizada", "protocolo": "...", "c_stat": "102"}`

- [ ] **Step 7: Commit final**

```bash
git add -A
git commit -m "feat: deploy NF-e eventos — cancelamento, CC-e, inutilizacao"
```
