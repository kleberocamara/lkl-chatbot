# nfe_sidecar/eventos.py
import os
import random
import datetime
import tempfile
from lxml import etree
from signxml import XMLSigner, methods
import requests
from emitir import _extrair_cert_key, _XMLSignerSHA1, _sanitizar
from emitentes import EMITENTES, NFE_AMBIENTE

NS = 'http://www.portalfiscal.inf.br/nfe'

_URL_EVENTO_HOM   = 'https://nfe-homologacao.svrs.rs.gov.br/ws/NFeRecepcaoEvento/NFeRecepcaoEvento4.asmx'
_URL_EVENTO_PRD   = 'https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx'
_URL_INUT_HOM     = 'https://nfe-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx'
_URL_INUT_PRD     = 'https://nfe.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx'
_URL_CONSULTA_HOM = 'https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx'
_URL_CONSULTA_PRD = 'https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx'

_CA_BUNDLE = os.path.join(os.path.dirname(__file__), 'sefaz_ca_bundle.pem')


def _now_br():
    return datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-3)))


def _texto_livre(texto, minimo, maximo, rotulo, separador=' '):
    """Prepara texto digitado pelo usuario para um campo livre de evento.

    xCorrecao e xJust seguem o pattern TString da SEFAZ: sem caractere de
    controle. Quebra de linha do textarea derrubava o evento com Rejeicao 493
    (CC-e da NF 840, com uma correcao por linha). Cada linha e limpa como no
    xProd da emissao e as linhas sao unidas pelo separador — na CC-e, ' | ',
    que preserva a leitura item a item e e o que o DACCE usa para quebrar linha.

    Devolve (texto, erro). Texto acima do limite e recusado, nunca cortado: um
    texto legal truncado registraria na SEFAZ uma correcao pela metade.
    """
    linhas = [_sanitizar(l) for l in str(texto or '').splitlines()]
    final = separador.join(l for l in linhas if l)
    if len(final) < minimo:
        return None, f'{rotulo} deve ter pelo menos {minimo} caracteres'
    if len(final) > maximo:
        return None, (f'{rotulo} tem {len(final)} caracteres; o limite da SEFAZ e {maximo}. '
                      'Abrevie o texto — uma CC-e posterior substitui a anterior por inteiro, '
                      'entao nao da para dividir as correcoes em varias cartas.'
                      if rotulo == 'Correção' else
                      f'{rotulo} tem {len(final)} caracteres; o limite da SEFAZ e {maximo}.')
    return final, None


def _texto(parent, tag, text):
    el = etree.SubElement(parent, f'{{{NS}}}{tag}')
    if text is not None:
        el.text = str(text)
    return el


def _parsear_retorno_evento(resp_xml):
    """Extrai cStat e xMotivo da resposta do receptor de eventos."""
    stripped = resp_xml.strip()
    if not stripped.startswith('<'):
        return '999', f'Erro HTTP SEFAZ: {stripped[:120]}', None
    if '403' in stripped[:300] or '401' in stripped[:300] or '<html' in stripped[:200].lower():
        return '999', f'Erro HTTP SEFAZ: {stripped[:120]}', None
    try:
        root = etree.fromstring(resp_xml.encode('utf-8'))
    except etree.XMLSyntaxError as e:
        return '999', f'XML inválido SEFAZ: {e}', None

    def find(scope, tag):
        el = scope.find(f'.//{{{NS}}}{tag}')
        return el.text if el is not None else None

    # cStat do lote (retEnvEvento) é só "recebido/processado" — o resultado real do
    # evento em si fica dentro de retEvento/infEvento, que precisa ser buscado à parte.
    inf_evento = root.find(f'.//{{{NS}}}retEvento/{{{NS}}}infEvento')
    if inf_evento is not None:
        return find(inf_evento, 'cStat'), find(inf_evento, 'xMotivo'), find(inf_evento, 'nProt')
    return find(root, 'cStat'), find(root, 'xMotivo'), None


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


def _montar_evento(chave, cnpj, tp_evento, n_seq, det_evento_el, dh_evento, c_uf):
    """Monta o XML envEvento com um único evento."""
    id_evento = f'ID{tp_evento}{chave}{str(n_seq).zfill(2)}'

    evento = etree.Element(f'{{{NS}}}evento', versao='1.00', nsmap={None: NS})
    inf_ev = etree.SubElement(evento, f'{{{NS}}}infEvento', Id=id_evento)
    _texto(inf_ev, 'cOrgao', c_uf)   # código da UF do emitente (mesmo valor usado em cUF na autorização/inutilização)
    _texto(inf_ev, 'tpAmb', NFE_AMBIENTE)
    _texto(inf_ev, 'CNPJ', cnpj)
    _texto(inf_ev, 'chNFe', chave)
    _texto(inf_ev, 'dhEvento', dh_evento.strftime('%Y-%m-%dT%H:%M:%S-03:00'))
    _texto(inf_ev, 'tpEvento', tp_evento)
    _texto(inf_ev, 'nSeqEvento', str(n_seq))
    _texto(inf_ev, 'verEvento', '1.00')
    inf_ev.append(det_evento_el)

    env = etree.Element(f'{{{NS}}}envEvento', versao='1.00', nsmap={None: NS})
    _texto(env, 'idLote', str(random.randint(1, 999999999999)))
    env.append(evento)

    return env, evento, id_evento


def _enviar_evento(env_el, evento_el, id_evento, emitente, cert_pem, key_pem,
                   cert_path_pem, key_path_pem):
    """Assina e transmite o evento."""
    evento_assinado = _assinar_evento(evento_el, cert_pem, key_pem, id_evento)
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


def consultar_situacao(chave, cnpj):
    """
    Consulta a situação atual da NF-e direto na SEFAZ (NfeConsulta4).
    Usada como fallback quando um evento retorna rejeição ambígua (573/580) —
    nesses casos o evento pode já ter sido registrado numa tentativa anterior
    e a rejeição só está confirmando isso, não indicando falha real.
    Retorna {c_stat, x_motivo, cancelamento: {c_stat, x_motivo, protocolo} | None}
    """
    emitente = EMITENTES.get(cnpj)
    if not emitente:
        return None
    cert_pem_path, key_pem_path, _, _ = _extrair_cert_key(emitente['cert_path'], emitente['cert_password'])

    cons = (
        f'<consSitNFe xmlns="{NS}" versao="4.00">'
        f'<tpAmb>{NFE_AMBIENTE}</tpAmb><xServ>CONSULTAR</xServ><chNFe>{chave}</chNFe>'
        f'</consSitNFe>'
    )
    soap = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
        ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
        ' xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
        '<soap12:Header>'
        '<nfeCabecMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">'
        f'<cUF>{emitente["c_uf"]}</cUF><versaoDados>4.00</versaoDados>'
        '</nfeCabecMsg>'
        '</soap12:Header>'
        '<soap12:Body>'
        '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">'
        + cons +
        '</nfeDadosMsg>'
        '</soap12:Body>'
        '</soap12:Envelope>'
    )
    url = _URL_CONSULTA_PRD if NFE_AMBIENTE == '1' else _URL_CONSULTA_HOM
    resp = requests.post(
        url,
        data=soap.encode('utf-8'),
        headers={
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4/nfeConsultaNF',
        },
        cert=(cert_pem_path, key_pem_path),
        verify=_CA_BUNDLE,
        timeout=30,
    )
    try:
        root = etree.fromstring(resp.text.encode('utf-8'))
    except etree.XMLSyntaxError:
        return None

    def find(scope, tag):
        el = scope.find(f'.//{{{NS}}}{tag}')
        return el.text if el is not None else None

    ret = root.find(f'.//{{{NS}}}retConsSitNFe')
    if ret is None:
        return None
    resultado = {'c_stat': find(ret, 'cStat'), 'x_motivo': find(ret, 'xMotivo'), 'cancelamento': None}
    ret_evento = root.find(f'.//{{{NS}}}retEvento/{{{NS}}}infEvento')
    if ret_evento is not None and find(ret_evento, 'tpEvento') == '110111':
        resultado['cancelamento'] = {
            'c_stat': find(ret_evento, 'cStat'),
            'x_motivo': find(ret_evento, 'xMotivo'),
            'protocolo': find(ret_evento, 'nProt'),
        }
    return resultado


def cancelar_nfe(dados):
    """
    dados = {chave, cnpj_emitente, justificativa, protocolo_autorizacao}
    Retorna {status, c_stat, x_motivo, protocolo, xml_evento}
    """
    chave = dados['chave']
    cnpj  = dados['cnpj_emitente']
    just, erro = _texto_livre(dados.get('justificativa'), 15, 255, 'Justificativa')
    if erro:
        return {'erro': erro}

    emitente = EMITENTES.get(cnpj)
    if not emitente:
        return {'erro': f'Emitente desconhecido: {cnpj}'}

    cert_pem_path, key_pem_path, cert_pem, key_pem = _extrair_cert_key(
        emitente['cert_path'], emitente['cert_password']
    )
    dh = _now_br()

    n_seq = int(dados.get('n_seq_evento', 1))
    for _tentativa in range(3):
        det = etree.Element(f'{{{NS}}}detEvento', versao='1.00', nsmap={None: NS})
        _texto(det, 'descEvento', 'Cancelamento')
        _texto(det, 'nProt', dados['protocolo_autorizacao'])
        _texto(det, 'xJust', just)

        env_el, evento_el, id_evento = _montar_evento(chave, cnpj, '110111', n_seq, det, dh, emitente['c_uf'])
        resp_text, xml_evento = _enviar_evento(
            env_el, evento_el, id_evento, emitente,
            cert_pem, key_pem, cert_pem_path, key_pem_path
        )

        c_stat, x_motivo, n_prot = _parsear_retorno_evento(resp_text)
        if c_stat == '573':   # Duplicidade de Evento: já existe registro com este nSeqEvento — tenta o próximo
            n_seq += 1
            continue
        if c_stat in ('135', '155'):
            return {'status': 'cancelada', 'c_stat': c_stat, 'x_motivo': x_motivo,
                    'protocolo': n_prot, 'xml_evento': xml_evento}
        # Rejeição ambígua (ex: 573 esgotado, 580 "exige NF-e autorizada" porque já
        # foi cancelada numa tentativa anterior) — confirma a situação real na SEFAZ
        # antes de reportar falha.
        if c_stat in ('573', '580'):
            situacao = consultar_situacao(chave, cnpj)
            canc = situacao and situacao.get('cancelamento')
            if canc and canc.get('c_stat') in ('135', '155'):
                return {'status': 'cancelada', 'c_stat': canc['c_stat'], 'x_motivo': canc['x_motivo'],
                        'protocolo': canc['protocolo'], 'xml_evento': xml_evento}
        return {'status': 'rejeitado', 'c_stat': c_stat, 'x_motivo': x_motivo, 'xml_evento': xml_evento}
    return {'status': 'rejeitado', 'c_stat': c_stat, 'x_motivo': x_motivo, 'xml_evento': xml_evento}


def corrigir_nfe(dados):
    """
    dados = {chave, cnpj_emitente, correcao, n_seq_evento}
    Retorna {status, c_stat, x_motivo, protocolo, xml_evento}
    """
    chave    = dados['chave']
    cnpj     = dados['cnpj_emitente']
    n_seq    = int(dados.get('n_seq_evento', 1))
    correcao, erro = _texto_livre(dados.get('correcao'), 15, 1000, 'Correção', separador=' | ')
    if erro:
        return {'erro': erro}

    emitente = EMITENTES.get(cnpj)
    if not emitente:
        return {'erro': f'Emitente desconhecido: {cnpj}'}

    cert_pem_path, key_pem_path, cert_pem, key_pem = _extrair_cert_key(
        emitente['cert_path'], emitente['cert_password']
    )
    dh = _now_br()

    det = etree.Element(f'{{{NS}}}detEvento', versao='1.00', nsmap={None: NS})
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

    env_el, evento_el, id_evento = _montar_evento(chave, cnpj, '110110', n_seq, det, dh, emitente['c_uf'])
    resp_text, xml_evento = _enviar_evento(
        env_el, evento_el, id_evento, emitente,
        cert_pem, key_pem, cert_pem_path, key_pem_path
    )

    c_stat, x_motivo, n_prot = _parsear_retorno_evento(resp_text)
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
    just, erro = _texto_livre(dados.get('justificativa'), 15, 255, 'Justificativa')
    if erro:
        return {'erro': erro}
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
            'Content-Type': 'application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NfeInutilizacao4/nfeInutilizacaoNF"',
        },
        cert=(cert_pem_path, key_pem_path),
        verify=_CA_BUNDLE,
        timeout=30,
    )

    resp_xml = resp.text
    stripped = resp_xml.strip()
    if not stripped.startswith('<') or '403' in stripped[:300] or '<html' in stripped[:200].lower():
        return {'erro': f'Erro HTTP SEFAZ: {stripped[:120]}'}

    try:
        root = etree.fromstring(resp_xml.encode('utf-8'))
    except etree.XMLSyntaxError as e:
        return {'erro': f'XML inválido SEFAZ: {e}'}

    # Check for SOAP Fault
    SOAP_NS = 'http://www.w3.org/2003/05/soap-envelope'
    fault = root.find(f'.//{{{SOAP_NS}}}Fault')
    if fault is not None:
        reason = root.find(f'.//{{{SOAP_NS}}}Text')
        msg = reason.text if reason is not None else 'SOAP Fault'
        return {'erro': f'SEFAZ SOAP Fault: {msg}'}

    def find(tag):
        el = root.find(f'.//{{{NS}}}{tag}')
        return el.text if el is not None else None

    c_stat   = find('cStat')
    x_motivo = find('xMotivo')
    n_prot   = find('nProt')
    if c_stat in ('102',):
        return {'status': 'inutilizada', 'c_stat': c_stat, 'x_motivo': x_motivo,
                'protocolo': n_prot, 'xml': inut_bytes.decode('utf-8')}
    return {'status': 'rejeitado', 'c_stat': c_stat, 'x_motivo': x_motivo}
