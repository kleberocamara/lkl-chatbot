# nfe_sidecar/danfe.py
import os
from lxml import etree
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

NS = 'http://www.portalfiscal.inf.br/nfe'

def _find(root, tag):
    el = root.find(f'.//{{{NS}}}{tag}')
    return el.text.strip() if el is not None and el.text else ''

def gerar_danfe(xml_str, output_path):
    """Gera DANFE simplificado em PDF a partir do XML autorizado."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    root = etree.fromstring(xml_str.encode('utf-8'))

    chave = _find(root, 'chNFe') or _find(root, 'Id').replace('NFe','')
    n_nf = _find(root, 'nNF')
    serie = _find(root, 'serie')
    dh_emi = _find(root, 'dhEmi')[:10] if _find(root, 'dhEmi') else ''
    nat_op = _find(root, 'natOp')
    protocolo = _find(root, 'nProt')
    v_nf = _find(root, 'vNF')

    chave_fmt = ' '.join(chave[i:i+4] for i in range(0, len(chave), 4)) if chave else ''

    c = canvas.Canvas(output_path, pagesize=A4)
    w, h = A4

    c.setFont('Helvetica-Bold', 10)
    c.drawString(15*mm, h - 20*mm, 'DANFE')
    c.setFont('Helvetica', 7)
    c.drawString(15*mm, h - 25*mm, 'DOCUMENTO AUXILIAR DA NOTA FISCAL ELETRÔNICA')

    c.setFont('Helvetica-Bold', 9)
    emit_names = root.findall(f'.//{{{NS}}}xNome')
    emit_name = emit_names[0].text if emit_names else ''
    c.drawString(60*mm, h - 20*mm, emit_name)

    c.setFont('Helvetica', 7)
    c.drawString(60*mm, h - 25*mm, f'NF-e Nº {n_nf.zfill(9)}  SÉRIE {serie.zfill(3)}')
    c.drawString(60*mm, h - 30*mm, f'CHAVE DE ACESSO: {chave_fmt}')
    c.drawString(60*mm, h - 35*mm, f'NATUREZA: {nat_op}')
    c.drawString(60*mm, h - 40*mm, f'PROTOCOLO: {protocolo}  DATA EMISSÃO: {dh_emi}')

    dest_names = root.findall(f'.//{{{NS}}}xNome')
    dest_name = dest_names[1].text if len(dest_names) > 1 else ''
    c.setFont('Helvetica-Bold', 8)
    c.drawString(15*mm, h - 55*mm, 'DESTINATÁRIO:')
    c.setFont('Helvetica', 8)
    c.drawString(50*mm, h - 55*mm, dest_name)

    y = h - 70*mm
    c.setFont('Helvetica-Bold', 7)
    c.drawString(15*mm, y, 'CÓDIGO')
    c.drawString(35*mm, y, 'DESCRIÇÃO')
    c.drawString(120*mm, y, 'QTD')
    c.drawString(140*mm, y, 'V.UNIT')
    c.drawString(160*mm, y, 'V.TOTAL')

    y -= 5*mm
    c.setFont('Helvetica', 7)
    dets = root.findall(f'.//{{{NS}}}det')
    for det in dets:
        prod = det.find(f'{{{NS}}}prod')
        if prod is None:
            continue
        c_prod = _find(prod, 'cProd')
        x_prod = _find(prod, 'xProd')[:50]
        q_com = _find(prod, 'qCom')
        v_un = _find(prod, 'vUnCom')
        v_prod_val = _find(prod, 'vProd')
        try:
            v_un_fmt = f"R$ {float(v_un):.4f}"
        except:
            v_un_fmt = v_un
        c.drawString(15*mm, y, c_prod)
        c.drawString(35*mm, y, x_prod)
        c.drawString(120*mm, y, q_com[:10])
        c.drawString(140*mm, y, v_un_fmt)
        c.drawString(160*mm, y, f"R$ {float(v_prod_val):.2f}")
        y -= 5*mm

    y -= 5*mm
    c.setFont('Helvetica-Bold', 9)
    c.drawString(130*mm, y, f'VALOR TOTAL DA NOTA: R$ {float(v_nf):.2f}')

    inf_adic = _find(root, 'infCpl')
    if inf_adic:
        y -= 10*mm
        c.setFont('Helvetica', 6)
        words = inf_adic.split()
        line = ''
        for word in words:
            if len(line) + len(word) > 120:
                c.drawString(15*mm, y, line)
                y -= 4*mm
                line = word + ' '
            else:
                line += word + ' '
        if line:
            c.drawString(15*mm, y, line)

    c.showPage()
    c.save()
    return output_path
