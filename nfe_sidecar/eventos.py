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
    if c_stat in ('102',):
        return {'status': 'inutilizada', 'c_stat': c_stat, 'x_motivo': x_motivo,
                'protocolo': n_prot, 'xml': inut_bytes.decode('utf-8')}
    return {'status': 'rejeitado', 'c_stat': c_stat, 'x_motivo': x_motivo}
