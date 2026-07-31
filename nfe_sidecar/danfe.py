# nfe_sidecar/danfe.py — DANFE layout visual completo
import os
from lxml import etree
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.graphics.barcode import code128
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader

_LOGO_DIR = os.path.join(os.path.dirname(__file__), '..', 'public')

_LOGOS_BY_CNPJ = {
    '44448899000185': os.path.join(_LOGO_DIR, 'logo_factor.png'),  # Factor
    '19296723000108': os.path.join(_LOGO_DIR, 'logo_lkl.png'),     # Grupo LKL
}
_LOGO_PATH_DEFAULT = os.path.join(_LOGO_DIR, 'logo.png')


def _logo_for_cnpj(cnpj):
    cnpj_digits = (cnpj or '').replace('.', '').replace('/', '').replace('-', '')
    path = _LOGOS_BY_CNPJ.get(cnpj_digits, _LOGO_PATH_DEFAULT)
    return path if os.path.exists(path) else _LOGO_PATH_DEFAULT

NS = 'http://www.portalfiscal.inf.br/nfe'
W, H = A4          # 595.28 x 841.89 pt
M = 5 * mm         # margem
CW = W - 2 * M    # largura útil ~200mm


def _find(el, tag):
    if el is None:
        return ''
    node = el.find(f'.//{{{NS}}}{tag}')
    return (node.text or '').strip() if node is not None else ''


def _fmt_cnpj(v):
    v = (v or '').replace('.', '').replace('/', '').replace('-', '')
    if len(v) == 14:
        return f'{v[:2]}.{v[2:5]}.{v[5:8]}/{v[8:12]}-{v[12:]}'
    if len(v) == 11:
        return f'{v[:3]}.{v[3:6]}.{v[6:9]}-{v[9:]}'
    return v


def _fmt_cep(v):
    v = (v or '').replace('-', '')
    return f'{v[:5]}-{v[5:]}' if len(v) == 8 else v


def _fmt_val(v):
    try:
        n = float(v)
        return f'{n:,.2f}'.replace(',', 'X').replace('.', ',').replace('X', '.')
    except Exception:
        return v or '0,00'


def _fmt_data(iso):
    """Converte data ISO 'AAAA-MM-DD' (com ou sem hora) para 'DD/MM/AAAA'."""
    s = (iso or '')[:10]
    partes = s.split('-')
    if len(partes) == 3 and all(partes):
        return f'{partes[2]}/{partes[1]}/{partes[0]}'
    return s


def _fmt_chave(ch):
    return ' '.join((ch or '')[i:i+4] for i in range(0, 44, 4))


def _lbl(c, x, y, w, h, label, size=4.5):
    """Desenha label pequeno no canto superior esquerdo de uma célula."""
    c.setFont('Helvetica', size)
    c.drawString(x + 0.8 * mm, y + h - size * 0.37 * mm - 0.3 * mm, label)


def _val(c, x, y, w, h, text, size=6.5, align='left'):
    c.setFont('Helvetica', size)
    text = str(text or '')
    if align == 'right':
        c.drawRightString(x + w - 1 * mm, y + 1.5 * mm, text)
    elif align == 'center':
        c.drawCentredString(x + w / 2, y + 1.5 * mm, text)
    else:
        c.drawString(x + 0.8 * mm, y + 1.5 * mm, text)


def _cell(c, x, y, w, h, label='', value='', lsize=4.5, vsize=6.5, align='left'):
    c.rect(x, y, w, h, stroke=1, fill=0)
    if label:
        _lbl(c, x, y, w, h, label, lsize)
    if value is not None:
        _val(c, x, y, w, h, str(value), vsize, align)


def _wrap_text(c, text, x, y, max_w, max_h, size=5.5, line_h=3.5 * mm):
    """Desenha texto com quebra de linha dentro de uma área."""
    c.setFont('Helvetica', size)
    words = (text or '').split()
    line = ''
    cur_y = y + max_h - size * 0.37 * mm - 1 * mm
    for word in words:
        test = (line + ' ' + word).strip()
        if c.stringWidth(test, 'Helvetica', size) > max_w - 2 * mm:
            if cur_y > y + 1 * mm:
                c.drawString(x + 1 * mm, cur_y, line)
                cur_y -= line_h
            line = word
        else:
            line = test
    if line and cur_y > y + 1 * mm:
        c.drawString(x + 1 * mm, cur_y, line)


def gerar_danfe(xml_str, output_path):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    root = etree.fromstring(xml_str.encode('utf-8'))

    # ---- Extração de dados ----
    inf = root.find(f'.//{{{NS}}}infNFe')
    chave = (inf.get('Id', '') if inf is not None else '').replace('NFe', '')
    if not chave:
        chave = _find(root, 'chNFe')

    n_nf   = _find(root, 'nNF').zfill(9)
    serie  = _find(root, 'serie').zfill(3)
    tp_nf  = _find(root, 'tpNF') or '1'
    nat_op = _find(root, 'natOp')
    protocolo = _find(root, 'nProt')
    _rec_raw  = (_find(root, 'dhRecbto') or '')[:19]
    dh_rec    = (f'{_fmt_data(_rec_raw)} {_rec_raw[11:19]}'.strip()) if _rec_raw else ''
    dh_emi    = _fmt_data(_find(root, 'dhEmi'))
    dh_sai    = _fmt_data(_find(root, 'dhSaiEnt')) or dh_emi

    emit = root.find(f'.//{{{NS}}}emit')
    emit_nome   = _find(emit, 'xNome')
    emit_fant   = _find(emit, 'xFant')
    emit_cnpj   = _find(emit, 'CNPJ')
    emit_ie     = _find(emit, 'IE')
    emit_lgr    = _find(emit, 'xLgr')
    emit_nro    = _find(emit, 'nro')
    emit_comp   = _find(emit, 'xCpl')
    emit_bairro = _find(emit, 'xBairro')
    emit_mun    = _find(emit, 'xMun')
    emit_uf     = _find(emit, 'UF')
    emit_cep    = _find(emit, 'CEP')
    emit_fone   = _find(emit, 'fone')

    dest = root.find(f'.//{{{NS}}}dest')
    dest_nome   = _find(dest, 'xNome')
    dest_cnpj   = _find(dest, 'CNPJ')
    dest_cpf    = _find(dest, 'CPF')
    dest_ie     = _find(dest, 'IE')
    dest_lgr    = _find(dest, 'xLgr')
    dest_nro    = _find(dest, 'nro')
    dest_bairro = _find(dest, 'xBairro')
    dest_mun    = _find(dest, 'xMun')
    dest_uf     = _find(dest, 'UF')
    dest_cep    = _find(dest, 'CEP')
    dest_fone   = _find(dest, 'fone')
    dest_cpfcnpj = _fmt_cnpj(dest_cnpj or dest_cpf)

    itot = root.find(f'.//{{{NS}}}ICMSTot')
    v_bc    = _find(itot, 'vBC')
    v_icms  = _find(itot, 'vICMS')
    v_bcst  = _find(itot, 'vBCST')
    v_st    = _find(itot, 'vST')
    v_ipi   = _find(itot, 'vIPI')
    v_prod  = _find(itot, 'vProd')
    v_frete = _find(itot, 'vFrete')
    v_seg   = _find(itot, 'vSeg')
    v_desc  = _find(itot, 'vDesc')
    v_outro = _find(itot, 'vOutro')
    v_nf    = _find(itot, 'vNF')

    transp     = root.find(f'.//{{{NS}}}transp')
    mod_frete  = _find(transp, 'modFrete')
    frete_desc = {'0': '0 - EMITENTE', '1': '1 - DESTINATARIO', '2': '2 - TERCEIROS', '9': '9 - SEM FRETE'}.get(mod_frete, mod_frete)
    t_nome  = _find(transp, 'xNome')
    t_antt  = _find(transp, 'RNTC')
    t_placa = _find(transp, 'placa')
    t_uf    = _find(transp, 'UF')
    t_cnpj  = _find(transp, 'CNPJ')
    t_ie    = _find(transp, 'IE')
    t_end   = _find(transp, 'xEnder')
    t_mun   = _find(transp, 'xMun')
    vol     = root.find(f'.//{{{NS}}}vol')
    v_qtd   = _find(vol, 'qVol')
    v_esp   = _find(vol, 'esp')
    v_marca = _find(vol, 'marca')
    v_num   = _find(vol, 'nVol')
    v_pb    = _find(vol, 'pesoB')
    v_pl    = _find(vol, 'pesoL')

    cobr = root.find(f'.//{{{NS}}}cobr')
    dups = []
    if cobr is not None:
        for dup in cobr.findall(f'{{{NS}}}dup'):
            dups.append((_find(dup, 'nDup'), _fmt_data(_find(dup, 'dVenc')), _fmt_val(_find(dup, 'vDup'))))

    inf_adic = _find(root, 'infCpl')

    itens = []
    for det in root.findall(f'.//{{{NS}}}det'):
        prod = det.find(f'{{{NS}}}prod')
        if prod is None:
            continue
        imp = det.find(f'{{{NS}}}imposto')
        csosn = ''
        if imp is not None:
            for tag in ('CSOSN', 'CST'):
                el = imp.find(f'.//{{{NS}}}{tag}')
                if el is not None:
                    csosn = el.text or ''
                    break
        q  = _find(prod, 'qCom')
        vu = _find(prod, 'vUnCom')
        vp = _find(prod, 'vProd')
        vd = _find(prod, 'vDesc') or '0'
        try:
            q_fmt  = f'{float(q):.4f}'
            vu_fmt = f'{float(vu):.4f}'
        except Exception:
            q_fmt, vu_fmt = q, vu
        itens.append({
            'cod':   _find(prod, 'cProd'),
            'desc':  _find(prod, 'xProd'),
            'ncm':   _find(prod, 'NCM'),
            'csosn': csosn,
            'cfop':  _find(prod, 'CFOP'),
            'un':    _find(prod, 'uCom'),
            'qtd':   q_fmt,
            'v_unit': vu_fmt,
            'v_desc': _fmt_val(vd),
            'v_prod': _fmt_val(vp),
        })

    # ===== DESENHO =====
    c = canvas.Canvas(output_path, pagesize=A4)
    c.setLineWidth(0.3)

    # ---- CANHOTO (faixa inferior, ~20mm) ----
    can_h = 20 * mm
    can_y = M
    c.rect(M, can_y, CW, can_h)
    stub_w = 48 * mm
    stub_x = M + CW - stub_w
    c.line(stub_x, can_y, stub_x, can_y + can_h)
    c.line(M, can_y + 9 * mm, stub_x, can_y + 9 * mm)
    c.line(M + 42 * mm, can_y, M + 42 * mm, can_y + 9 * mm)

    c.setFont('Helvetica', 5)
    c.drawString(M + 1 * mm, can_y + 16 * mm,
                 f'RECEBEMOS DE {emit_nome} OS PRODUTOS / SERVIÇOS CONSTANTES DA NOTA FISCAL INDICADO AO LADO')
    c.drawString(M + 1 * mm, can_y + 11 * mm, 'DATA DE RECEBIMENTO')
    c.drawString(M + 44 * mm, can_y + 11 * mm, 'IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR')

    c.setFont('Helvetica-Bold', 7)
    c.drawCentredString(stub_x + stub_w / 2, can_y + 16 * mm, 'NF-e')
    c.setFont('Helvetica', 6.5)
    c.drawCentredString(stub_x + stub_w / 2, can_y + 11 * mm, f'Nº {n_nf}')
    c.drawCentredString(stub_x + stub_w / 2, can_y + 7 * mm, f'SÉRIE {serie}')
    c.drawCentredString(stub_x + stub_w / 2, can_y + 3 * mm,
                        f'EMISSÃO: {dh_emi}')

    # ---- CABEÇALHO (header box) ----
    hdr_h = 43 * mm
    hdr_y = H - M - hdr_h

    # Seções: emitente | DANFE central | chave de acesso
    emit_w  = 90 * mm
    mid_w   = 35 * mm
    right_w = CW - emit_w - mid_w
    mid_x   = M + emit_w
    right_x = mid_x + mid_w

    c.rect(M, hdr_y, CW, hdr_h)
    c.line(mid_x,   hdr_y, mid_x,   hdr_y + hdr_h)
    c.line(right_x, hdr_y, right_x, hdr_y + hdr_h)

    # Label "fl. 1/1"
    c.setFont('Helvetica', 5.5)
    c.drawRightString(M + CW - 1 * mm, hdr_y + hdr_h - 3 * mm, 'fl. 1 /1')

    # Emitente — logo centralizado no topo, texto abaixo centralizado na área toda
    logo_w = 28 * mm
    logo_h = 18 * mm
    logo_x = M + (emit_w - logo_w) / 2
    logo_y = hdr_y + 26 * mm
    try:
        img = ImageReader(_logo_for_cnpj(emit_cnpj))
        c.drawImage(img, logo_x, logo_y, width=logo_w, height=logo_h,
                    preserveAspectRatio=True, mask='auto')
    except Exception:
        pass
    txt_cx = M + emit_w / 2
    name_text = (emit_fant or emit_nome)
    name_max_w = emit_w - 4 * mm
    for name_fs in (7.5, 7.0, 6.5, 6.0, 5.5):
        if c.stringWidth(name_text, 'Helvetica-Bold', name_fs) <= name_max_w:
            break
    c.setFont('Helvetica-Bold', name_fs)
    c.drawCentredString(txt_cx, hdr_y + 23 * mm, name_text)
    c.setFont('Helvetica', 5.5)
    # Linha 1: logradouro + número
    c.drawCentredString(txt_cx, hdr_y + 18.5 * mm, f'{emit_lgr}, {emit_nro}')
    # Linha 2: complemento + bairro (se houver complemento, fica na própria linha)
    if emit_comp:
        c.drawCentredString(txt_cx, hdr_y + 14.5 * mm, f'{emit_comp} - {emit_bairro}')
        c.drawCentredString(txt_cx, hdr_y + 10.5 * mm,
                            f'CEP: {_fmt_cep(emit_cep)} - {emit_mun} - {emit_uf}')
        if emit_fone:
            c.drawCentredString(txt_cx, hdr_y + 6.5 * mm, f'Fone: {emit_fone}')
    else:
        c.drawCentredString(txt_cx, hdr_y + 14.5 * mm,
                            f'{emit_bairro} - CEP: {_fmt_cep(emit_cep)}')
        c.drawCentredString(txt_cx, hdr_y + 10.5 * mm, f'{emit_mun} - {emit_uf}')
        if emit_fone:
            c.drawCentredString(txt_cx, hdr_y + 6.5 * mm, f'Fone: {emit_fone}')

    # Centro: DANFE
    c.setFont('Helvetica-Bold', 11)
    c.drawCentredString(mid_x + mid_w / 2, hdr_y + 36 * mm, 'DANFE')
    c.setFont('Helvetica', 6)
    c.drawCentredString(mid_x + mid_w / 2, hdr_y + 32 * mm, 'DOCUMENTO AUXILIAR DA')
    c.drawCentredString(mid_x + mid_w / 2, hdr_y + 29 * mm, 'NOTA FISCAL ELETRÔNICA')

    # Caixa entrada/saída
    box_x = mid_x + 3 * mm
    box_y = hdr_y + 17 * mm
    box_w = mid_w - 6 * mm
    box_h = 11 * mm
    c.rect(box_x, box_y, box_w, box_h)
    c.setFont('Helvetica', 5.5)
    c.drawString(box_x + 1 * mm, box_y + box_h - 3 * mm, '0 - ENTRADA')
    c.drawString(box_x + 1 * mm, box_y + box_h - 6.5 * mm, '1 - SAÍDA')
    c.setFont('Helvetica-Bold', 18)
    c.drawRightString(box_x + box_w - 1.5 * mm, box_y + 2 * mm, tp_nf)

    c.setFont('Helvetica', 7)
    c.drawCentredString(mid_x + mid_w / 2, hdr_y + 13 * mm, f'Nº {n_nf}')
    c.drawCentredString(mid_x + mid_w / 2, hdr_y + 9 * mm, f'SÉRIE {serie}')

    # Direita: código de barras + chave
    c.setFont('Helvetica', 5)
    c.drawCentredString(right_x + right_w / 2, hdr_y + hdr_h - 3 * mm, 'CHAVE DE ACESSO')

    if chave:
        try:
            bc = code128.Code128(chave, barHeight=14 * mm, barWidth=0.57, humanReadable=False)
            bc_w = bc.width
            bc_x = right_x + (right_w - bc_w) / 2
            bc_y = hdr_y + 19 * mm
            bc.drawOn(c, bc_x, bc_y)
        except Exception:
            pass

    # Chave formatada em 2 linhas de ~22 dígitos cada (grupos de 4)
    ch_fmt = _fmt_chave(chave)  # 11 grupos "XXXX " = 54 chars
    # Quebra entre grupos: primeiros 6 grupos (29 chars) | últimos 5 grupos (24 chars)
    groups = [chave[i:i+4] for i in range(0, 44, 4)]  # 11 grupos
    line1 = ' '.join(groups[:5])   # primeiros 5 grupos (20 dígitos)
    line2 = ' '.join(groups[5:])   # últimos 6 grupos (24 dígitos)
    c.setFont('Helvetica', 5)
    c.drawCentredString(right_x + right_w / 2, hdr_y + 14.5 * mm, line1)
    c.drawCentredString(right_x + right_w / 2, hdr_y + 11.5 * mm, line2)

    c.setFont('Helvetica', 4.5)
    c.drawCentredString(right_x + right_w / 2, hdr_y + 8 * mm,
                        'Consulta de autenticidade no portal nacional da NF-e')
    c.drawCentredString(right_x + right_w / 2, hdr_y + 5.5 * mm,
                        'www.nfe.fazenda.gov.br/portal')
    c.drawCentredString(right_x + right_w / 2, hdr_y + 3 * mm,
                        'ou no site da Sefaz Autorizadora')

    y = hdr_y  # cursor Y (topo da próxima seção)

    # ---- NATUREZA DE OPERAÇÃO + PROTOCOLO ----
    rh = 10 * mm
    y -= rh
    c.rect(M, y, CW, rh)
    nat_w = 100 * mm
    c.line(M + nat_w, y, M + nat_w, y + rh)
    _lbl(c, M, y, nat_w, rh, 'NATUREZA DE OPERAÇÃO')
    _val(c, M, y, nat_w, rh, nat_op, 7)
    _lbl(c, M + nat_w, y, CW - nat_w, rh, 'PROTOCOLO DE AUTORIZAÇÃO DE USO')
    prot_txt = f'{protocolo}  {dh_rec}' if protocolo else ''
    _val(c, M + nat_w, y, CW - nat_w, rh, prot_txt, 7)

    # ---- IE + IE SUBST + CNPJ ----
    rh = 10 * mm
    y -= rh
    c.rect(M, y, CW, rh)
    ie_w, iest_w = 60 * mm, 60 * mm
    c.line(M + ie_w, y, M + ie_w, y + rh)
    c.line(M + ie_w + iest_w, y, M + ie_w + iest_w, y + rh)
    _lbl(c, M, y, ie_w, rh, 'INSCRIÇÃO ESTADUAL')
    _val(c, M, y, ie_w, rh, emit_ie, 7)
    _lbl(c, M + ie_w, y, iest_w, rh, 'INSCRIÇÃO ESTADUAL DO SUBST. TRIB.')
    _lbl(c, M + ie_w + iest_w, y, CW - ie_w - iest_w, rh, 'CNPJ / CPF')
    _val(c, M + ie_w + iest_w, y, CW - ie_w - iest_w, rh, _fmt_cnpj(emit_cnpj), 7)

    # ---- DESTINATÁRIO ----
    dest_h = 30 * mm
    y -= dest_h
    c.rect(M, y, CW, dest_h)
    c.setFont('Helvetica-Bold', 6)
    c.drawString(M + 1 * mm, y + dest_h - 3.5 * mm, 'DESTINATÁRIO / REMETENTE')
    c.line(M, y + dest_h - 5.5 * mm, M + CW, y + dest_h - 5.5 * mm)

    # Linha 1: Nome | CNPJ | Data emissão
    r1_top = y + dest_h - 5.5 * mm
    r1_h   = 9 * mm
    r1_bot = r1_top - r1_h
    c.line(M, r1_bot, M + CW, r1_bot)
    nome_w  = 120 * mm
    cnpj_dest_w = 50 * mm
    data_w  = CW - nome_w - cnpj_dest_w
    c.line(M + nome_w, r1_bot, M + nome_w, r1_top)
    c.line(M + nome_w + cnpj_dest_w, r1_bot, M + nome_w + cnpj_dest_w, r1_top)
    _lbl(c, M, r1_bot, nome_w, r1_h, 'NOME / RAZÃO SOCIAL')
    _val(c, M, r1_bot, nome_w, r1_h, dest_nome[:55], 7)
    _lbl(c, M + nome_w, r1_bot, cnpj_dest_w, r1_h, 'CNPJ / CPF')
    _val(c, M + nome_w, r1_bot, cnpj_dest_w, r1_h, dest_cpfcnpj, 7)
    _lbl(c, M + nome_w + cnpj_dest_w, r1_bot, data_w, r1_h, 'DATA DA EMISSÃO')
    _val(c, M + nome_w + cnpj_dest_w, r1_bot, data_w, r1_h, dh_emi, 7)

    # Linha 2: Endereço | Bairro | CEP | Município | UF
    r2_top = r1_bot
    r2_h   = 9 * mm
    r2_bot = r2_top - r2_h
    c.line(M, r2_bot, M + CW, r2_bot)
    end_w   = 90 * mm
    bair_w  = 40 * mm
    cep_w   = 25 * mm
    mun_w   = 35 * mm
    uf_dest_w = CW - end_w - bair_w - cep_w - mun_w
    for dx in (end_w, end_w + bair_w, end_w + bair_w + cep_w, end_w + bair_w + cep_w + mun_w):
        c.line(M + dx, r2_bot, M + dx, r2_top)
    _lbl(c, M, r2_bot, end_w, r2_h, 'ENDEREÇO')
    _val(c, M, r2_bot, end_w, r2_h, f'{dest_lgr}, {dest_nro}'[:45], 7)
    _lbl(c, M + end_w, r2_bot, bair_w, r2_h, 'BAIRRO / DISTRITO')
    _val(c, M + end_w, r2_bot, bair_w, r2_h, dest_bairro[:20], 7)
    _lbl(c, M + end_w + bair_w, r2_bot, cep_w, r2_h, 'CEP')
    _val(c, M + end_w + bair_w, r2_bot, cep_w, r2_h, _fmt_cep(dest_cep), 7)
    _lbl(c, M + end_w + bair_w + cep_w, r2_bot, mun_w, r2_h, 'MUNICÍPIO')
    _val(c, M + end_w + bair_w + cep_w, r2_bot, mun_w, r2_h, dest_mun[:18], 7)
    uf_x = M + end_w + bair_w + cep_w + mun_w
    _lbl(c, uf_x, r2_bot, uf_dest_w, r2_h, 'UF')
    _val(c, uf_x, r2_bot, uf_dest_w, r2_h, dest_uf, 7)

    # Linha 3: Fone | IE | Data Saída/Entrada | Hora Saída
    r3_top = r2_bot
    r3_h   = y + dest_h - 5.5 * mm - r1_h - r2_h - r3_top + r3_top
    r3_h   = r2_bot - y
    c.line(M, y, M + CW, y)  # bottom of dest block (already drawn by rect)
    fone_w = 45 * mm
    ie_d_w = 55 * mm
    dsai_w = 35 * mm
    hsai_w = CW - fone_w - ie_d_w - dsai_w
    for dx in (fone_w, fone_w + ie_d_w, fone_w + ie_d_w + dsai_w):
        c.line(M + dx, y, M + dx, r3_top)
    _lbl(c, M, y, fone_w, r3_h, 'FONE / FAX')
    _val(c, M, y, fone_w, r3_h, dest_fone, 7)
    _lbl(c, M + fone_w, y, ie_d_w, r3_h, 'INSCRIÇÃO ESTADUAL')
    _val(c, M + fone_w, y, ie_d_w, r3_h, dest_ie, 7)
    _lbl(c, M + fone_w + ie_d_w, y, dsai_w, r3_h, 'DATA SAÍDA / ENTRADA')
    _val(c, M + fone_w + ie_d_w, y, dsai_w, r3_h, dh_sai, 7)
    _lbl(c, M + fone_w + ie_d_w + dsai_w, y, hsai_w, r3_h, 'HORA DA SAÍDA')

    # ---- DUPLICATAS ----
    dup_h = 14 * mm
    y -= dup_h
    c.rect(M, y, CW, dup_h)
    c.setFont('Helvetica-Bold', 5.5)
    c.drawString(M + 1 * mm, y + dup_h - 3.5 * mm, 'DUPLICATAS')
    c.line(M, y + dup_h - 5.5 * mm, M + CW, y + dup_h - 5.5 * mm)

    if dups:
        max_cols = 4
        col_dup_w = CW / max_cols
        shown = dups[:max_cols * 2]
        for i, (nd, dv, vd) in enumerate(shown):
            col = i % max_cols
            row = i // max_cols
            dx = M + col * col_dup_w
            dy = y + dup_h - 5.5 * mm - row * (dup_h - 5.5 * mm)
            if col > 0:
                c.line(dx, y, dx, y + dup_h - 5.5 * mm)
            nw, vencw = 18 * mm, 26 * mm
            c.line(dx + nw, dy - (dup_h - 5.5 * mm), dx + nw, dy)
            c.line(dx + nw + vencw, dy - (dup_h - 5.5 * mm), dx + nw + vencw, dy)
            c.setFont('Helvetica', 4.5)
            c.drawString(dx + 1 * mm, dy - 3 * mm, 'Nº DUPLICATA')
            c.drawString(dx + nw + 1 * mm, dy - 3 * mm, 'VENC.')
            c.drawString(dx + nw + vencw + 1 * mm, dy - 3 * mm, 'VALOR')
            c.setFont('Helvetica', 6.5)
            c.drawString(dx + 1 * mm, dy - 8 * mm, nd)
            c.drawString(dx + nw + 1 * mm, dy - 8 * mm, dv)
            c.drawString(dx + nw + vencw + 1 * mm, dy - 8 * mm, vd)

    # ---- CÁLCULO DO IMPOSTO ----
    imp_h = 20 * mm
    y -= imp_h
    c.rect(M, y, CW, imp_h)
    c.setFont('Helvetica-Bold', 5.5)
    c.drawString(M + 1 * mm, y + imp_h - 3.5 * mm, 'CÁLCULO DO IMPOSTO')
    c.line(M, y + imp_h - 5.5 * mm, M + CW, y + imp_h - 5.5 * mm)

    split_y = y + (imp_h - 5.5 * mm) / 2
    c.line(M, split_y, M + CW, split_y)

    row1_cols = [
        ('BASE DE CÁLCULO DO ICMS', _fmt_val(v_bc)),
        ('VALOR DO ICMS', _fmt_val(v_icms)),
        ('BASE CÁLC. ICMS SUBST.', _fmt_val(v_bcst)),
        ('VALOR DO ICMS SUBST.', _fmt_val(v_st)),
        ('VALOR TOTAL DOS PRODUTOS', _fmt_val(v_prod)),
    ]
    row2_cols = [
        ('VALOR DO FRETE', _fmt_val(v_frete)),
        ('VALOR DO SEGURO', _fmt_val(v_seg)),
        ('DESCONTO', _fmt_val(v_desc)),
        ('OUTRAS DESP. ACESS.', _fmt_val(v_outro)),
        ('VALOR DO IPI', _fmt_val(v_ipi)),
        ('VALOR TOTAL DA NOTA', _fmt_val(v_nf)),
    ]

    cw1 = CW / len(row1_cols)
    for i, (lbl, val) in enumerate(row1_cols):
        ix = M + i * cw1
        if i > 0:
            c.line(ix, split_y, ix, y + imp_h - 5.5 * mm)
        _lbl(c, ix, split_y, cw1, (imp_h - 5.5 * mm) / 2, lbl)
        _val(c, ix, split_y, cw1, (imp_h - 5.5 * mm) / 2, val, 7, 'right')

    cw2 = CW / len(row2_cols)
    for i, (lbl, val) in enumerate(row2_cols):
        ix = M + i * cw2
        if i > 0:
            c.line(ix, y, ix, split_y)
        _lbl(c, ix, y, cw2, (imp_h - 5.5 * mm) / 2, lbl)
        _val(c, ix, y, cw2, (imp_h - 5.5 * mm) / 2, val, 7, 'right')

    # ---- TRANSPORTADOR (3 linhas) ----
    tr_h = 27 * mm
    y -= tr_h
    c.rect(M, y, CW, tr_h)
    c.setFont('Helvetica-Bold', 5.5)
    c.drawString(M + 1 * mm, y + tr_h - 3.5 * mm, 'TRANSPORTADOR / VOLUMES TRANSPORTADOS')
    c.line(M, y + tr_h - 5.5 * mm, M + CW, y + tr_h - 5.5 * mm)

    row_h   = (tr_h - 5.5 * mm) / 3
    tr1_top = y + tr_h - 5.5 * mm          # topo da linha 1
    tr1_bot = tr1_top - row_h               # divisa linha1/linha2
    tr2_bot = tr1_bot - row_h               # divisa linha2/linha3 (= y + row_h)
    c.line(M, tr1_bot, M + CW, tr1_bot)
    c.line(M, tr2_bot, M + CW, tr2_bot)

    # Linha 1: Nome | Frete | ANTT | Placa | UF | CNPJ
    tn_w = 65 * mm
    tf_w = 32 * mm
    ta_w = 28 * mm
    tp_w = 18 * mm
    tu_w = 10 * mm
    tc_w = CW - tn_w - tf_w - ta_w - tp_w - tu_w
    for dx in (tn_w, tn_w+tf_w, tn_w+tf_w+ta_w, tn_w+tf_w+ta_w+tp_w, tn_w+tf_w+ta_w+tp_w+tu_w):
        c.line(M + dx, tr1_bot, M + dx, tr1_top)
    _lbl(c, M,                              tr1_bot, tn_w, row_h, 'RAZÃO SOCIAL')
    _val(c, M,                              tr1_bot, tn_w, row_h, t_nome[:32], 6.5)
    _lbl(c, M+tn_w,                         tr1_bot, tf_w, row_h, 'FRETE POR CONTA')
    _val(c, M+tn_w,                         tr1_bot, tf_w, row_h, frete_desc, 6.5)
    _lbl(c, M+tn_w+tf_w,                    tr1_bot, ta_w, row_h, 'CÓDIGO ANTT')
    _val(c, M+tn_w+tf_w,                    tr1_bot, ta_w, row_h, t_antt, 6.5)
    _lbl(c, M+tn_w+tf_w+ta_w,              tr1_bot, tp_w, row_h, 'PLACA DO VEÍCULO')
    _val(c, M+tn_w+tf_w+ta_w,              tr1_bot, tp_w, row_h, t_placa, 6.5)
    _lbl(c, M+tn_w+tf_w+ta_w+tp_w,         tr1_bot, tu_w, row_h, 'UF')
    _val(c, M+tn_w+tf_w+ta_w+tp_w,         tr1_bot, tu_w, row_h, t_uf, 6.5)
    _lbl(c, M+tn_w+tf_w+ta_w+tp_w+tu_w,   tr1_bot, tc_w, row_h, 'CNPJ / CPF')
    _val(c, M+tn_w+tf_w+ta_w+tp_w+tu_w,   tr1_bot, tc_w, row_h, _fmt_cnpj(t_cnpj), 6.5)

    # Linha 2: Endereço | Município | UF | IE
    te_w  = 80 * mm
    tm_w  = 60 * mm
    tuf_w = 12 * mm
    tie_w = CW - te_w - tm_w - tuf_w
    for dx in (te_w, te_w+tm_w, te_w+tm_w+tuf_w):
        c.line(M + dx, tr2_bot, M + dx, tr1_bot)
    _lbl(c, M,                      tr2_bot, te_w, row_h, 'ENDEREÇO')
    _val(c, M,                      tr2_bot, te_w, row_h, t_end[:40], 6.5)
    _lbl(c, M+te_w,                 tr2_bot, tm_w, row_h, 'MUNICÍPIO')
    _val(c, M+te_w,                 tr2_bot, tm_w, row_h, t_mun[:28], 6.5)
    _lbl(c, M+te_w+tm_w,            tr2_bot, tuf_w, row_h, 'UF')
    _val(c, M+te_w+tm_w,            tr2_bot, tuf_w, row_h, t_uf, 6.5)
    _lbl(c, M+te_w+tm_w+tuf_w,     tr2_bot, tie_w, row_h, 'INSCRIÇÃO ESTADUAL')
    _val(c, M+te_w+tm_w+tuf_w,     tr2_bot, tie_w, row_h, t_ie, 6.5)

    # Linha 3: Qtd | Esp | Marca | Numeração | Peso Bruto | Peso Líquido
    vol_cols = [
        ('QUANT.', v_qtd), ('ESPÉCIE', v_esp), ('MARCA', v_marca),
        ('NUMERAÇÃO', v_num), ('PESO BRUTO', v_pb), ('PESO LÍQUIDO', v_pl),
    ]
    vc_w = CW / len(vol_cols)
    for i in range(1, len(vol_cols)):
        c.line(M + i * vc_w, y, M + i * vc_w, tr2_bot)
    for i, (lbl, val) in enumerate(vol_cols):
        _lbl(c, M + i * vc_w, y, vc_w, row_h, lbl)
        _val(c, M + i * vc_w, y, vc_w, row_h, val, 6.5, 'center')

    # ---- DADOS DO PRODUTO / SERVIÇOS ----
    prod_lbl_h = 6 * mm
    y -= prod_lbl_h
    c.rect(M, y, CW, prod_lbl_h)
    c.setFont('Helvetica-Bold', 5.5)
    c.drawString(M + 1 * mm, y + prod_lbl_h - 3.5 * mm, 'DADOS DO PRODUTO / SERVIÇOS')

    # Cabeçalho das colunas
    COL_DEFS = [
        # (label, largura, key, align)
        ('CÓDIGO DO\nPROD. / SERV.', 15*mm, 'cod',    'center'),
        ('DESCRIÇÃO DO PRODUTO / SERVIÇO', 64*mm, 'desc',   'left'),
        ('NCM / SH',  14*mm, 'ncm',    'center'),
        ('CSOSN',     10*mm, 'csosn',  'center'),
        ('CFOP',      10*mm, 'cfop',   'center'),
        ('UNID.',      9*mm, 'un',     'center'),
        ('QUANT.',    19*mm, 'qtd',    'right'),
        ('VALOR\nUNITÁRIO', 21*mm, 'v_unit', 'right'),
        ('DESCONTO',  15*mm, 'v_desc', 'right'),
        ('VALOR\nLÍQUIDO',  19*mm, 'v_prod', 'right'),
    ]
    # Ajusta última coluna para preencher exatamente CW
    total_col_w = sum(w for _, w, _, _ in COL_DEFS)
    diff = CW - total_col_w
    COL_DEFS[-1] = (COL_DEFS[-1][0], COL_DEFS[-1][1] + diff, COL_DEFS[-1][2], COL_DEFS[-1][3])

    col_xs = [M]
    for _, w, _, _ in COL_DEFS:
        col_xs.append(col_xs[-1] + w)

    hdr_col_h = 8 * mm
    y -= hdr_col_h
    c.rect(M, y, CW, hdr_col_h)
    c.setFont('Helvetica', 4.5)
    for i, (lbl, w, key, align) in enumerate(COL_DEFS):
        cx = col_xs[i]
        if i > 0:
            c.line(cx, y, cx, y + hdr_col_h)
        lines = lbl.split('\n')
        lh = 3.5 * mm
        start_y = y + hdr_col_h / 2 + (len(lines) - 1) * lh / 2
        for j, ln in enumerate(lines):
            c.drawCentredString(cx + w / 2, start_y - j * lh, ln)

    # Linhas de itens — a descrição quebra em várias linhas (sem truncar) e a
    # altura da linha do item cresce conforme necessário para caber o texto inteiro.
    from reportlab.pdfbase.pdfmetrics import stringWidth
    desc_font, desc_size, desc_line_h = 'Helvetica', 6, 2.8 * mm
    desc_col_w = COL_DEFS[1][1]

    def _quebrar_desc(texto, max_w):
        palavras = texto.split(' ')
        linhas, atual = [], ''
        for palavra in palavras:
            candidato = f'{atual} {palavra}'.strip()
            if stringWidth(candidato, desc_font, desc_size) <= max_w:
                atual = candidato
            else:
                if atual:
                    linhas.append(atual)
                atual = palavra
        if atual:
            linhas.append(atual)
        return linhas or ['']

    min_item_h = 5 * mm
    # Espaço disponível até o bloco de dados adicionais (reservar ~28mm)
    adic_reserve = 28 * mm
    y_min = can_y + can_h + adic_reserve + 2 * mm

    for item in itens:
        desc_linhas = _quebrar_desc(str(item.get('desc', '')), desc_col_w - 2 * mm)
        item_h = max(min_item_h, len(desc_linhas) * desc_line_h + 2 * mm)
        if y - item_h < y_min:
            # TODO: multi-página (simplificado: continua na mesma)
            break
        y -= item_h
        c.rect(M, y, CW, item_h)
        vals = {k: item.get(k, '') for _, _, k, _ in COL_DEFS}
        for i, (lbl, w, key, align) in enumerate(COL_DEFS):
            cx = col_xs[i]
            if i > 0:
                c.line(cx, y, cx, y + item_h)
            if key == 'desc':
                c.setFont(desc_font, desc_size)
                start_y = y + item_h - desc_line_h
                for j, ln in enumerate(desc_linhas):
                    c.drawString(cx + 1 * mm, start_y - j * desc_line_h, ln)
                continue
            txt = vals[key]
            c.setFont('Helvetica', 6)
            ty = y + item_h / 2 - 1 * mm
            if align == 'right':
                c.drawRightString(cx + w - 1 * mm, ty, txt)
            elif align == 'center':
                c.drawCentredString(cx + w / 2, ty, txt)
            else:
                c.drawString(cx + 1 * mm, ty, txt)

    # ---- DADOS ADICIONAIS ----
    adic_h = y - (can_y + can_h + 2 * mm)
    y_adic = can_y + can_h + 2 * mm
    c.rect(M, y_adic, CW, adic_h)
    c.setFont('Helvetica-Bold', 5.5)
    c.drawString(M + 1 * mm, y_adic + adic_h - 3.5 * mm, 'DADOS ADICIONAIS')
    c.line(M, y_adic + adic_h - 5.5 * mm, M + CW, y_adic + adic_h - 5.5 * mm)

    inf_w = 140 * mm
    c.line(M + inf_w, y_adic, M + inf_w, y_adic + adic_h - 5.5 * mm)
    c.setFont('Helvetica', 5)
    c.drawString(M + 1 * mm, y_adic + adic_h - 8.5 * mm, 'INFORMAÇÕES COMPLEMENTARES')
    c.drawString(M + inf_w + 1 * mm, y_adic + adic_h - 8.5 * mm, 'RESERVADO AO FISCO')

    if inf_adic:
        _wrap_text(c, inf_adic, M, y_adic, inf_w, adic_h - 9 * mm, size=5.5, line_h=3.5 * mm)

    # Rodapé de impressão
    c.setFont('Helvetica', 5)
    emit_info = f'EMISSÃO: {dh_emi} - DEST. / REM.: {dest_nome} - VALOR TOTAL: R$ {_fmt_val(v_nf)}'
    c.drawString(M, can_y + can_h + 0.5 * mm, emit_info[:110])

    c.showPage()
    c.save()
    return output_path
