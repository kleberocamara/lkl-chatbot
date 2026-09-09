# nfe_sidecar/dacce.py
"""DACCE — Documento Auxiliar da Carta de Correção Eletrônica.

Representação impressa do evento 110110, para enviar ao destinatário. Não tem
valor fiscal em si: o que vale é a CC-e registrada na SEFAZ, que este papel
apenas reproduz.
"""
import os
import xml.etree.ElementTree as ET
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

NS = 'http://www.portalfiscal.inf.br/nfe'
W, H = A4
M = 10 * mm
CW = W - 2 * M


def _find(el, tag):
    if el is None:
        return ''
    f = el.find(f'.//{{{NS}}}{tag}')
    return (f.text or '').strip() if f is not None and f.text else ''


def _fmt_chave(ch):
    return ' '.join(ch[i:i + 4] for i in range(0, len(ch), 4))


def _fmt_cnpj(v):
    v = ''.join(c for c in str(v) if c.isdigit())
    return f'{v[:2]}.{v[2:5]}.{v[5:8]}/{v[8:12]}-{v[12:]}' if len(v) == 14 else v


def _fmt_dh(iso):
    """2026-09-09T10:54:09-03:00 -> 09/09/2026 10:54:09"""
    try:
        d, h = iso.split('T')
        a, m, dia = d.split('-')
        return f'{dia}/{m}/{a} {h[:8]}'
    except Exception:
        return iso


def _bloco(c, y, altura, titulo):
    """Moldura com título; devolve o y do topo da área interna."""
    c.rect(M, y - altura, CW, altura)
    c.setFont('Helvetica-Bold', 6)
    c.drawString(M + 2 * mm, y - 4 * mm, titulo)
    return y - 7 * mm


def _texto_quebrado(c, texto, x, y, max_w, size=7.5, line_h=4 * mm, max_linhas=None):
    """Escreve com quebra por largura; devolve o y após a última linha."""
    c.setFont('Helvetica', size)
    linha, n = '', 0
    for palavra in (texto or '').split():
        teste = f'{linha} {palavra}'.strip()
        if c.stringWidth(teste, 'Helvetica', size) > max_w:
            c.drawString(x, y, linha)
            y -= line_h
            n += 1
            linha = palavra
            if max_linhas and n >= max_linhas:
                return y
        else:
            linha = teste
    if linha:
        c.drawString(x, y, linha)
        y -= line_h
    return y


def gerar_dacce(xml_evento, output_path, emitente=None, destinatario=None, protocolo=None):
    """Gera o PDF da carta de correção a partir do XML do evento enviado à SEFAZ.

    emitente/destinatario são dicts opcionais (razao_social, cnpj, endereco...);
    o XML do evento traz apenas o CNPJ do emitente e a chave da NF-e.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    root = ET.fromstring(xml_evento)
    inf = root.find(f'.//{{{NS}}}infEvento')

    chave = _find(inf, 'chNFe')
    cnpj_emit = _find(inf, 'CNPJ')
    dh = _fmt_dh(_find(inf, 'dhEvento'))
    n_seq = _find(inf, 'nSeqEvento')
    tp_evento = _find(inf, 'tpEvento')
    correcao = _find(inf, 'xCorrecao')
    cond_uso = _find(inf, 'xCondUso')
    tp_amb = _find(inf, 'tpAmb')

    # número e série saem da própria chave (posições fixas do layout)
    serie = chave[22:25].lstrip('0') or '0'
    numero = chave[25:34].lstrip('0') or '0'

    c = canvas.Canvas(output_path, pagesize=A4)
    c.setTitle(f'CC-e NF-e {numero}')
    y = H - M

    # ── cabeçalho ──
    c.setFont('Helvetica-Bold', 13)
    c.drawCentredString(W / 2, y - 6 * mm, 'CARTA DE CORREÇÃO ELETRÔNICA')
    c.setFont('Helvetica', 7)
    c.drawCentredString(W / 2, y - 11 * mm,
                        'Documento Auxiliar da Carta de Correção Eletrônica — sem valor fiscal')
    if tp_amb == '2':
        c.setFont('Helvetica-Bold', 9)
        c.drawCentredString(W / 2, y - 16 * mm, 'AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL')
    y -= 20 * mm

    # ── aviso legal ──
    alt = 14 * mm
    yi = _bloco(c, y, alt, 'AVISO')
    _texto_quebrado(c,
                    'Este documento é a representação impressa de um evento de Carta de Correção '
                    'registrado na SEFAZ. A validade jurídica está no evento eletrônico vinculado à '
                    'NF-e, consultável no portal nacional pela chave de acesso abaixo.',
                    M + 2 * mm, yi, CW - 4 * mm, size=7)
    y -= alt + 3 * mm

    # ── NF-e corrigida ──
    alt = 20 * mm
    yi = _bloco(c, y, alt, 'NOTA FISCAL ELETRÔNICA CORRIGIDA')
    c.setFont('Helvetica', 8)
    c.drawString(M + 2 * mm, yi, f'Número: {numero}          Série: {serie}')
    c.setFont('Helvetica-Bold', 8)
    c.drawString(M + 2 * mm, yi - 5 * mm, 'Chave de acesso:')
    c.setFont('Helvetica', 8)
    c.drawString(M + 32 * mm, yi - 5 * mm, _fmt_chave(chave))
    y -= alt + 3 * mm

    # ── emitente / destinatário ──
    alt = 26 * mm
    yi = _bloco(c, y, alt, 'EMITENTE')
    c.setFont('Helvetica', 8)
    linha_y = yi
    if emitente:
        c.setFont('Helvetica-Bold', 8)
        c.drawString(M + 2 * mm, linha_y, emitente.get('razao_social', ''))
        c.setFont('Helvetica', 7.5)
        linha_y -= 4.5 * mm
        end = f"{emitente.get('logradouro','')}, {emitente.get('numero','')} - {emitente.get('bairro','')}"
        c.drawString(M + 2 * mm, linha_y, end)
        linha_y -= 4 * mm
        c.drawString(M + 2 * mm, linha_y,
                     f"{emitente.get('municipio','')}/{emitente.get('uf','')}  CEP {emitente.get('cep','')}")
        linha_y -= 4 * mm
    c.drawString(M + 2 * mm, linha_y, f'CNPJ: {_fmt_cnpj(cnpj_emit)}'
                 + (f"   IE: {emitente.get('ie','')}" if emitente else ''))
    y -= alt + 3 * mm

    if destinatario:
        alt = 22 * mm
        yi = _bloco(c, y, alt, 'DESTINATÁRIO')
        c.setFont('Helvetica-Bold', 8)
        c.drawString(M + 2 * mm, yi, destinatario.get('nome', ''))
        c.setFont('Helvetica', 7.5)
        c.drawString(M + 2 * mm, yi - 4.5 * mm, f"CNPJ/CPF: {_fmt_cnpj(destinatario.get('cpf_cnpj',''))}")
        end = f"{destinatario.get('logradouro','')}, {destinatario.get('numero','')} - {destinatario.get('bairro','')}"
        c.drawString(M + 2 * mm, yi - 9 * mm, end)
        c.drawString(M + 2 * mm, yi - 13 * mm,
                     f"{destinatario.get('municipio','')}/{destinatario.get('uf','')}")
        y -= alt + 3 * mm

    # ── dados do evento ──
    alt = 20 * mm
    yi = _bloco(c, y, alt, 'DADOS DO EVENTO')
    c.setFont('Helvetica', 8)
    c.drawString(M + 2 * mm, yi, f'Evento: {tp_evento} — Carta de Correção')
    c.drawString(M + 90 * mm, yi, f'Sequência: {n_seq}')
    c.drawString(M + 2 * mm, yi - 5 * mm, f'Data/hora: {dh}')
    if protocolo:
        c.drawString(M + 90 * mm, yi - 5 * mm, f'Protocolo: {protocolo}')
    y -= alt + 3 * mm

    # ── correção (destaque) ──
    alt = 34 * mm
    yi = _bloco(c, y, alt, 'CORREÇÃO')
    _texto_quebrado(c, correcao, M + 2 * mm, yi, CW - 4 * mm, size=9, line_h=5 * mm)
    y -= alt + 3 * mm

    # ── condições de uso ──
    alt = 34 * mm
    yi = _bloco(c, y, alt, 'CONDIÇÕES DE USO')
    _texto_quebrado(c, cond_uso, M + 2 * mm, yi, CW - 4 * mm, size=6.5, line_h=3.2 * mm)

    c.showPage()
    c.save()
    return output_path
