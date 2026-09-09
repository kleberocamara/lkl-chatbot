# nfe_sidecar/emitir.py
import os
import re
import random
import hashlib
import datetime
import tempfile
from lxml import etree
from cryptography.hazmat.primitives.serialization import pkcs12
from signxml import XMLSigner, methods

class _XMLSignerSHA1(XMLSigner):
    """Subclasse que permite RSA-SHA1, exigido pelo padrão NF-e 4.0."""
    def check_deprecated_methods(self):
        pass
import requests
from emitentes import EMITENTES, SEFAZ_URL, NFE_AMBIENTE

NS = 'http://www.portalfiscal.inf.br/nfe'

def _calcular_dv(chave43):
    """Calcula dígito verificador da chave de acesso NF-e (Módulo 11, da direita para esquerda)."""
    soma = sum(int(c) * (i % 8 + 2) for i, c in enumerate(reversed(chave43)))
    resto = soma % 11
    return '0' if resto < 2 else str(11 - resto)

def _montar_chave(c_uf, dh_emi, cnpj, mod, serie, n_nf, tp_emis, c_nf):
    """Monta a chave de acesso de 44 dígitos."""
    aamm = dh_emi.strftime('%y%m')
    chave43 = f"{c_uf}{aamm}{cnpj}{mod:02d}{serie:03d}{n_nf:09d}{tp_emis}{c_nf:08d}"
    dv = _calcular_dv(chave43)
    return chave43 + dv

def _extrair_cert_key(cert_path, cert_password):
    """Extrai certificado e chave privada do .pfx para arquivos temporários."""
    with open(cert_path, 'rb') as f:
        pfx_data = f.read()
    private_key, certificate, _ = pkcs12.load_key_and_certificates(
        pfx_data, cert_password.encode()
    )
    from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, NoEncryption
    cert_pem = certificate.public_bytes(Encoding.PEM)
    key_pem = private_key.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL, NoEncryption())

    cert_file = tempfile.NamedTemporaryFile(delete=False, suffix='.pem')
    cert_file.write(cert_pem)
    cert_file.flush()

    key_file = tempfile.NamedTemporaryFile(delete=False, suffix='.pem')
    key_file.write(key_pem)
    key_file.flush()

    return cert_file.name, key_file.name, cert_pem, key_pem

# Transliterações de caracteres tipográficos comuns para ASCII aceito pela SEFAZ.
# A NF-e usa o tipo TString, cujo pattern só admite [!-ÿ] (0x21..0xFF); caracteres
# acima de 0xFF (— … " ' etc.) causam Rejeição 225 (Falha no Schema XML).
_TRANSLITERACOES = {
    '—': '-', '–': '-', '‒': '-', '―': '-', '−': '-',  # travessões/dashes → hífen
    '‘': "'", '’': "'", '‚': "'", '′': "'",                  # aspas simples → '
    '“': '"', '”': '"', '„': '"', '″': '"',                  # aspas duplas → "
    '…': '...',                                                             # reticências
    ' ': ' ', ' ': ' ', ' ': ' ',                                # espaços especiais → espaço
}

def _sanitizar(text):
    """Limpa texto para o pattern TString da NF-e ([!-ÿ], sem controle, sem borda em branco)."""
    s = str(text)
    for orig, subst in _TRANSLITERACOES.items():
        s = s.replace(orig, subst)
    # Remove qualquer caractere fora da faixa aceita (controle < 0x20 ou > 0xFF),
    # preservando acentuados Latin-1 (á, ç, ã…). Tab/quebra viram espaço.
    s = ''.join(' ' if c in '\t\n\r' else c for c in s)
    s = ''.join(c for c in s if 0x20 <= ord(c) <= 0xFF)
    # Colapsa espaços e remove borda (o pattern proíbe iniciar/terminar com espaço)
    return re.sub(r'\s+', ' ', s).strip()

def _texto(parent, tag, text, ns=NS):
    el = etree.SubElement(parent, f'{{{ns}}}{tag}')
    if text is not None:
        el.text = _sanitizar(text)
    return el

def _montar_xml(dados, emitente, n_nf, c_nf, dh_emi, tp_amb):
    """Monta o XML infNFe completo."""
    c_uf = emitente['c_uf']
    chave = _montar_chave(int(c_uf), dh_emi, emitente['cnpj'], 55, 1, n_nf, 1, c_nf)

    nfe = etree.Element(f'{{{NS}}}NFe', nsmap={None: NS})
    inf = etree.SubElement(nfe, f'{{{NS}}}infNFe', versao='4.00', Id=f'NFe{chave}')

    # ide
    ide = etree.SubElement(inf, f'{{{NS}}}ide')
    _texto(ide, 'cUF', c_uf)
    _texto(ide, 'cNF', str(c_nf).zfill(8))
    _texto(ide, 'natOp', 'VENDA DE PRODUCAO DO ESTABELECIMENTO')
    _texto(ide, 'mod', '55')
    _texto(ide, 'serie', '1')
    _texto(ide, 'nNF', str(n_nf))
    _texto(ide, 'dhEmi', dh_emi.strftime('%Y-%m-%dT%H:%M:%S-03:00'))
    _texto(ide, 'dhSaiEnt', dh_emi.strftime('%Y-%m-%dT%H:%M:%S-03:00'))
    _texto(ide, 'tpNF', '1')
    cfop = dados['cfop']
    id_dest = '1' if cfop.startswith('5') else '2'
    _texto(ide, 'idDest', id_dest)
    _texto(ide, 'cMunFG', emitente['c_mun'])
    _texto(ide, 'tpImp', '1')
    _texto(ide, 'tpEmis', '1')
    _texto(ide, 'cDV', chave[-1])
    _texto(ide, 'tpAmb', tp_amb)
    _texto(ide, 'finNFe', '1')
    # indFinal=1 para consumidor final (CPF ou CNPJ sem IE); =0 para B2B com IE
    dest_cpf_cnpj = (dados.get('destinatario', {}).get('cpf_cnpj') or '').replace('.','').replace('/','').replace('-','')
    dest_ie = (dados.get('destinatario', {}).get('ie') or '').strip().upper()
    ind_final_cnpj_com_ie = len(dest_cpf_cnpj) == 14 and dest_ie and dest_ie not in ('', 'ISENTO', 'NA')
    _texto(ide, 'indFinal', '0' if ind_final_cnpj_com_ie else '1')
    _texto(ide, 'indPres', '0')
    _texto(ide, 'procEmi', '0')
    _texto(ide, 'verProc', '1.0')

    # emit
    emit = etree.SubElement(inf, f'{{{NS}}}emit')
    _texto(emit, 'CNPJ', emitente['cnpj'])
    _texto(emit, 'xNome', emitente['razao_social'])
    end_emit = etree.SubElement(emit, f'{{{NS}}}enderEmit')
    _texto(end_emit, 'xLgr', emitente['logradouro'])
    _texto(end_emit, 'nro', emitente['numero'])
    _texto(end_emit, 'xCpl', emitente['complemento'])
    _texto(end_emit, 'xBairro', emitente['bairro'])
    _texto(end_emit, 'cMun', emitente['c_mun'])
    _texto(end_emit, 'xMun', emitente['municipio'])
    _texto(end_emit, 'UF', emitente['uf'])
    _texto(end_emit, 'CEP', emitente['cep'])
    _texto(end_emit, 'cPais', '1058')
    _texto(end_emit, 'xPais', 'Brasil')
    _texto(emit, 'IE', emitente['ie'])
    _texto(emit, 'CRT', '1')  # Simples Nacional

    # dest
    dest = dados['destinatario']
    el_dest = etree.SubElement(inf, f'{{{NS}}}dest')
    cpf_cnpj = dest['cpf_cnpj'].replace('.','').replace('/','').replace('-','')
    if len(cpf_cnpj) == 14:
        _texto(el_dest, 'CNPJ', cpf_cnpj)
    else:
        _texto(el_dest, 'CPF', cpf_cnpj)
    # Em homologação, SEFAZ exige este nome exato (cStat=598 se diferente)
    xnome = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' if tp_amb == '2' else dest['nome'][:60]
    _texto(el_dest, 'xNome', xnome)
    end_dest = etree.SubElement(el_dest, f'{{{NS}}}enderDest')
    _texto(end_dest, 'xLgr', dest.get('logradouro', 'NAO INFORMADO')[:60])
    _texto(end_dest, 'nro', dest.get('numero', 'SN'))
    if dest.get('complemento'):
        _texto(end_dest, 'xCpl', dest['complemento'][:60])
    _texto(end_dest, 'xBairro', dest.get('bairro', 'NAO INFORMADO')[:60])
    _texto(end_dest, 'cMun', dest.get('c_mun', '3301702'))
    _texto(end_dest, 'xMun', dest.get('municipio', 'Duque de Caxias')[:60])
    _texto(end_dest, 'UF', dest.get('uf', 'RJ'))
    _texto(end_dest, 'CEP', dest.get('cep', '').replace('-',''))
    _texto(end_dest, 'cPais', '1058')
    _texto(end_dest, 'xPais', 'Brasil')
    if dest.get('fone'):
        _texto(end_dest, 'fone', dest['fone'].replace('(','').replace(')','').replace('-','').replace(' ',''))
    ie_dest = (dest.get('ie') or '').strip().upper()
    if len(cpf_cnpj) == 14 and ie_dest and ie_dest not in ('', 'ISENTO', 'NA'):
        # CNPJ com IE numérica: contribuinte do ICMS
        _texto(el_dest, 'indIEDest', '1')
        _texto(el_dest, 'IE', ie_dest)
    elif len(cpf_cnpj) == 14:
        # CNPJ sem IE numérica: não contribuinte — sem elemento IE (schema SVRS rejeita IE=ISENTO)
        _texto(el_dest, 'indIEDest', '9')
    else:
        # CPF: não contribuinte (sem elemento IE)
        _texto(el_dest, 'indIEDest', '9')

    # det (itens)
    frete_valor = float(dados.get('frete_valor') or 0)

    valor_total = 0
    for idx, item in enumerate(dados['itens'], 1):
        ncm = dados['ncm_por_item'].get(str(item['id']), dados['ncm_por_item'].get(str(idx), '49111090'))
        det = etree.SubElement(inf, f'{{{NS}}}det', nItem=str(idx))
        prod = etree.SubElement(det, f'{{{NS}}}prod')
        _texto(prod, 'cProd', str(item.get('codigo', idx)).zfill(3))
        _texto(prod, 'cEAN', 'SEM GTIN')
        _texto(prod, 'xProd', item['descricao'][:120])
        _texto(prod, 'NCM', ncm)
        _texto(prod, 'CFOP', cfop)
        _texto(prod, 'uCom', item.get('unidade', 'UN'))
        qtd = float(item['quantidade'])
        v_prod = round(float(item['valor_total']), 2)
        # Derivar vUnCom de vProd/qtd garante qCom*vUnCom==vProd (evita cStat=629)
        v_unit = v_prod / qtd if qtd else float(item['valor_unitario'])
        _texto(prod, 'qCom', f"{qtd:.4f}")
        _texto(prod, 'vUnCom', f"{v_unit:.10f}")
        _texto(prod, 'vProd', f"{v_prod:.2f}")
        _texto(prod, 'cEANTrib', 'SEM GTIN')
        _texto(prod, 'uTrib', item.get('unidade', 'UN'))
        _texto(prod, 'qTrib', f"{qtd:.4f}")
        _texto(prod, 'vUnTrib', f"{v_unit:.10f}")
        _texto(prod, 'indTot', '1')

        imposto = etree.SubElement(det, f'{{{NS}}}imposto')
        icms = etree.SubElement(imposto, f'{{{NS}}}ICMS')
        csosn = emitente['csosn'].lstrip('0') or '0'
        if csosn == '101':
            icms_sn = etree.SubElement(icms, f'{{{NS}}}ICMSSN101')
            _texto(icms_sn, 'orig', '0')
            _texto(icms_sn, 'pCredSN', '2.84')
            _texto(icms_sn, 'vCredICMSSN', '0.00')
            _texto(icms_sn, 'CSOSN', '101')
        elif csosn == '500':
            icms_sn = etree.SubElement(icms, f'{{{NS}}}ICMSSN500')
            _texto(icms_sn, 'orig', '0')
            _texto(icms_sn, 'CSOSN', '500')
        elif csosn == '900':
            icms_sn = etree.SubElement(icms, f'{{{NS}}}ICMSSN900')
            _texto(icms_sn, 'orig', '0')
            _texto(icms_sn, 'modBC', '3')
            _texto(icms_sn, 'vBC', '0.00')
            _texto(icms_sn, 'pRedBC', '0.00')
            _texto(icms_sn, 'pICMS', '0.00')
            _texto(icms_sn, 'vICMS', '0.00')
            _texto(icms_sn, 'CSOSN', '900')
        else:  # 102, 103, 300, 400 → ICMSSN102
            icms_sn = etree.SubElement(icms, f'{{{NS}}}ICMSSN102')
            _texto(icms_sn, 'orig', '0')
            _texto(icms_sn, 'CSOSN', csosn)

        # PIS — CST=07 (isento) para Simples Nacional
        pis = etree.SubElement(imposto, f'{{{NS}}}PIS')
        pis_nt = etree.SubElement(pis, f'{{{NS}}}PISNT')
        _texto(pis_nt, 'CST', '07')

        # COFINS — CST=07 (isento) para Simples Nacional
        cofins = etree.SubElement(imposto, f'{{{NS}}}COFINS')
        cofins_nt = etree.SubElement(cofins, f'{{{NS}}}COFINSNT')
        _texto(cofins_nt, 'CST', '07')

        valor_total += v_prod

    # total (frete não é incluído no NF-e — preço já inclui frete)
    v_nf = round(valor_total, 2)
    total = etree.SubElement(inf, f'{{{NS}}}total')
    ice = etree.SubElement(total, f'{{{NS}}}ICMSTot')
    for tag, val in [('vBC','0.00'),('vICMS','0.00'),('vICMSDeson','0.00'),
                     ('vFCPUFDest','0.00'),('vICMSUFDest','0.00'),('vICMSUFRemet','0.00'),
                     ('vFCP','0.00'),('vBCST','0.00'),('vST','0.00'),('vFCPST','0.00'),
                     ('vFCPSTRet','0.00'),('vProd', f'{valor_total:.2f}'),
                     ('vFrete','0.00'),('vSeg','0.00'),('vDesc','0.00'),
                     ('vII','0.00'),('vIPI','0.00'),('vIPIDevol','0.00'),
                     ('vPIS','0.00'),('vCOFINS','0.00'),('vOutro','0.00'),
                     ('vNF', f'{v_nf:.2f}')]:
        _texto(ice, tag, val)

    # transp
    transp = etree.SubElement(inf, f'{{{NS}}}transp')
    _texto(transp, 'modFrete', dados.get('frete_por_conta', '9'))
    t_dados = dados.get('transportador') or {}
    if t_dados.get('razao_social'):
        el_transp = etree.SubElement(transp, f'{{{NS}}}transporta')
        if t_dados.get('cnpj'):
            _texto(el_transp, 'CNPJ', t_dados['cnpj'].replace('.','').replace('/','').replace('-',''))
        _texto(el_transp, 'xNome', t_dados['razao_social'][:60])
        if t_dados.get('ie'):
            _texto(el_transp, 'IE', t_dados['ie'])
        if t_dados.get('municipio'):
            _texto(el_transp, 'xMun', t_dados['municipio'])
        if t_dados.get('uf'):
            _texto(el_transp, 'UF', t_dados['uf'])
    vol = etree.SubElement(transp, f'{{{NS}}}vol')
    _texto(vol, 'qVol', str(t_dados.get('quantidade', 1)))
    _texto(vol, 'esp', t_dados.get('especie', 'VOLUME'))
    if t_dados.get('marca'):
        _texto(vol, 'marca', t_dados['marca'])
    if t_dados.get('peso_bruto'):
        _texto(vol, 'pesoB', f"{float(t_dados['peso_bruto']):.3f}")
    if t_dados.get('peso_liquido'):
        _texto(vol, 'pesoL', f"{float(t_dados['peso_liquido']):.3f}")

    # cobr (duplicatas)
    if dados.get('duplicatas'):
        cobr = etree.SubElement(inf, f'{{{NS}}}cobr')
        fat = etree.SubElement(cobr, f'{{{NS}}}fat')
        _texto(fat, 'nFat', str(dados['duplicatas'][0].get('numero', '001')).zfill(3))
        _texto(fat, 'vOrig', f'{v_nf:.2f}')
        _texto(fat, 'vDesc', '0.00')
        _texto(fat, 'vLiq', f'{v_nf:.2f}')
        for dup in dados['duplicatas']:
            el_dup = etree.SubElement(cobr, f'{{{NS}}}dup')
            _texto(el_dup, 'nDup', str(dup['numero']).zfill(3))
            _texto(el_dup, 'dVenc', dup['vencimento'])
            _texto(el_dup, 'vDup', f"{float(dup['valor']):.2f}")

    # pag
    # SEFAZ rejeita (853) quando o bloco <cobr>/duplicatas é enviado junto com uma
    # forma de pagamento que indica venda à vista (ex: dinheiro, pix, cartão) — nesses
    # casos não pode haver cobr. Com duplicatas, usa tPag=15 (Boleto, a prazo); sem
    # duplicatas, usa a forma de pagamento à vista informada pelo atendente.
    # xPag (descrição livre) só é aceito quando tPag=99 "Outros" (rejeição 442
    # "Descricao do pagamento nao permitida" nos demais códigos padronizados).
    pag = etree.SubElement(inf, f'{{{NS}}}pag')
    det_pag = etree.SubElement(pag, f'{{{NS}}}detPag')
    if dados.get('duplicatas'):
        _texto(det_pag, 'tPag', '15')  # boleto bancário
    else:
        t_pag = dados.get('forma_pagamento') or '90'
        _texto(det_pag, 'tPag', t_pag)
    _texto(det_pag, 'vPag', f'{v_nf:.2f}')

    # infAdic
    inf_adic = etree.SubElement(inf, f'{{{NS}}}infAdic')
    info = ('I- "DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL" '
            'II-"PERMITE O APROVEITAMENTO DO CREDITO DE ICMS NO VALOR DE R$ '
            f'{v_nf * 0.0284:.2f} CORRESPONDENTE A ALICOTA DE 2,84 %, NOS TERMOS '
            'DO ART 23 DA LEI COMPLEMENTAR 123".')
    if dados.get('info_complementar'):
        info += ' ' + dados['info_complementar']
    # Venda à vista em PIX (tPag=17): imprime os dados bancários do emitente para
    # o cliente pagar. Só entra se o emitente tiver esses dados cadastrados.
    if dados.get('forma_pagamento') == '17' and emitente.get('dados_bancarios'):
        info += ' | ' + emitente['dados_bancarios']
    _texto(inf_adic, 'infCpl', info)

    return nfe, chave

def _assinar(nfe, cert_pem, key_pem, chave):
    """Assina o XML NF-e com XMLDSIG."""
    signer = _XMLSignerSHA1(
        method=methods.enveloped,
        signature_algorithm='rsa-sha1',
        digest_algorithm='sha1',
        c14n_algorithm='http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
    )
    signed = signer.sign(
        nfe,
        key=key_pem,
        cert=cert_pem,
        reference_uri=f'NFe{chave}',
    )
    return signed

def _transmitir(nfe_xml_bytes, emitente, cert_path_pem, key_path_pem, tp_amb):
    """Envia NF-e para SEFAZ via SOAP e retorna resposta."""
    url = SEFAZ_URL[tp_amb]
    c_uf = emitente['c_uf']

    nfe_str = nfe_xml_bytes.decode('utf-8')
    if nfe_str.startswith('<?xml'):
        nfe_str = nfe_str[nfe_str.index('?>') + 2:].lstrip()

    soap_body = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
        ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
        ' xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
        '<soap12:Header>'
        '<nfeCabecMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">'
        f'<cUF>{c_uf}</cUF><versaoDados>4.00</versaoDados>'
        '</nfeCabecMsg>'
        '</soap12:Header>'
        '<soap12:Body>'
        '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">'
        '<enviNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">'
        '<idLote>1</idLote><indSinc>1</indSinc>'
        + nfe_str
        + '</enviNFe>'
        '</nfeDadosMsg>'
        '</soap12:Body>'
        '</soap12:Envelope>'
    )

    import sys; print('[SOAP-URL]', url, '[SIZE]', len(soap_body), file=sys.stderr, flush=True)
    resp = requests.post(
        url,
        data=soap_body.encode('utf-8'),
        headers={
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote',
        },
        cert=(cert_path_pem, key_path_pem),
        verify=os.path.join(os.path.dirname(__file__), 'sefaz_ca_bundle.pem'),
        timeout=30,
    )
    return resp.text

def _parsear_retorno(resp_xml):
    """Extrai cStat, xMotivo, chave, protocolo do retorno SEFAZ."""
    # Detectar resposta HTTP de erro (não XML)
    stripped = resp_xml.strip()
    if not stripped.startswith('<') or '403' in stripped[:200] or '401' in stripped[:200]:
        return '999', f'Erro HTTP SEFAZ: {stripped[:120]}', None, None
    root = etree.fromstring(resp_xml.encode('utf-8'))

    def find_in(el, tag):
        found = el.find(f'.//{{{NS}}}{tag}')
        return found.text if found is not None else None

    # Resultado real da NF-e está em protNFe/infProt (processamento síncrono)
    inf_prot = root.find(f'.//{{{NS}}}infProt')
    if inf_prot is not None:
        c_stat = find_in(inf_prot, 'cStat')
        x_motivo = find_in(inf_prot, 'xMotivo')
        ch_nfe = find_in(inf_prot, 'chNFe')
        n_prot = find_in(inf_prot, 'nProt')
    else:
        # Fallback: erro antes do processamento (ex: schema inválido no lote)
        c_stat = find_in(root, 'cStat')
        x_motivo = find_in(root, 'xMotivo')
        ch_nfe = None
        n_prot = None
    return c_stat, x_motivo, ch_nfe, n_prot

def emitir_nfe(dados):
    """
    dados = {
        cnpj_emitente, numero, cfop, ncm_por_item, frete_por_conta, frete_valor,
        transportador, duplicatas, info_complementar,
        destinatario: {nome, cpf_cnpj, logradouro, numero, bairro, cep, municipio, uf, c_mun, fone},
        itens: [{id, codigo, descricao, unidade, quantidade, valor_unitario, valor_total}]
    }
    """
    cnpj = dados['cnpj_emitente']
    emitente = EMITENTES.get(cnpj)
    if not emitente:
        return {'erro': f'Emitente desconhecido: {cnpj}'}

    tp_amb = NFE_AMBIENTE
    n_nf = dados['numero']
    c_nf = random.randint(10000000, 99999999)
    dh_emi = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-3)))

    cert_pem_path, key_pem_path, cert_pem, key_pem = _extrair_cert_key(
        emitente['cert_path'], emitente['cert_password']
    )

    try:
        nfe_el, chave = _montar_xml(dados, emitente, n_nf, c_nf, dh_emi, tp_amb)
        nfe_assinada = _assinar(nfe_el, cert_pem, key_pem, chave)
        nfe_bytes = etree.tostring(nfe_assinada, xml_declaration=True, encoding='UTF-8')
        resp_text = _transmitir(nfe_bytes, emitente, cert_pem_path, key_pem_path, tp_amb)
        import sys; print('[SEFAZ-RAW]', resp_text[:800], file=sys.stderr, flush=True)
        c_stat, x_motivo, ch_nfe, n_prot = _parsear_retorno(resp_text)

        if c_stat == '100':
            return {
                'status': 'autorizada',
                'chave': ch_nfe or chave,
                'protocolo': n_prot,
                'xml': nfe_bytes.decode('utf-8'),
                'c_stat': c_stat,
                'x_motivo': x_motivo,
            }
        else:
            return {
                'status': 'rejeitada',
                'c_stat': c_stat,
                'x_motivo': x_motivo,
                'erro': f'Rejeição {c_stat}: {x_motivo}',
            }
    finally:
        os.unlink(cert_pem_path)
        os.unlink(key_pem_path)
