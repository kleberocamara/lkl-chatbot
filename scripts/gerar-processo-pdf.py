#!/usr/bin/env python3
"""Gera o PDF de um Processo Operacional a partir do Markdown em docs/processos/.

O Markdown e a fonte da verdade: fica versionado, com autor e historico de cada
revisao. O PDF e so a copia distribuida a colaboradores e fornecedores, e por isso
carimba a versao e a data de vigencia em toda pagina — quem tiver um PDF antigo
em maos consegue perceber que existe versao mais nova.

Uso:  python3 scripts/gerar-processo-pdf.py docs/processos/PO-01-portal-fornecedor.md [saida.pdf]
"""
import os
import re
import sys
from datetime import date

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether)

AZUL = HexColor('#1F4E78')
CINZA = HexColor('#666666')
CINZA_CLARO = HexColor('#D9D9D9')
FUNDO_CAB = HexColor('#EEF3F9')
ATENCAO = HexColor('#FFF8E1')

# Arial quando disponivel (macOS); Helvetica tem as mesmas metricas e serve de reserva.
FONTE, FONTE_B = 'Helvetica', 'Helvetica-Bold'
for base, bold in [('/System/Library/Fonts/Supplemental/Arial.ttf',
                    '/System/Library/Fonts/Supplemental/Arial Bold.ttf')]:
    if os.path.exists(base) and os.path.exists(bold):
        pdfmetrics.registerFont(TTFont('Arial', base))
        pdfmetrics.registerFont(TTFont('Arial-Bold', bold))
        # Sem registrar a familia, a tag <b> dentro do paragrafo nao encontra a
        # variante negrito da TTF e o texto sai igual ao normal, em silencio.
        pdfmetrics.registerFontFamily('Arial', normal='Arial', bold='Arial-Bold',
                                      italic='Arial', boldItalic='Arial-Bold')
        FONTE, FONTE_B = 'Arial', 'Arial-Bold'
        break

M = 20 * mm
LARG = A4[0] - 2 * M

E = {
    'titulo': ParagraphStyle('t', fontName=FONTE_B, fontSize=16, leading=20, textColor=AZUL,
                             spaceAfter=2 * mm),
    'codigo': ParagraphStyle('c', fontName=FONTE_B, fontSize=9.5, leading=12, textColor=CINZA,
                             spaceAfter=6 * mm),
    'h1': ParagraphStyle('h1', fontName=FONTE_B, fontSize=11.5, leading=15, textColor=AZUL,
                         spaceBefore=6 * mm, spaceAfter=2.5 * mm),
    'h2': ParagraphStyle('h2', fontName=FONTE_B, fontSize=10, leading=13, textColor=HexColor('#333333'),
                         spaceBefore=4 * mm, spaceAfter=2 * mm),
    'p': ParagraphStyle('p', fontName=FONTE, fontSize=9.5, leading=14, alignment=TA_JUSTIFY,
                        spaceAfter=2.5 * mm),
    'li': ParagraphStyle('li', fontName=FONTE, fontSize=9.5, leading=14, leftIndent=6 * mm,
                         bulletIndent=1.5 * mm, spaceAfter=1.5 * mm),
    'cel': ParagraphStyle('cel', fontName=FONTE, fontSize=8.5, leading=11.5),
    'celb': ParagraphStyle('celb', fontName=FONTE_B, fontSize=8.5, leading=11.5, textColor=HexColor('#FFFFFF')),
}


def _inline(t):
    """Negrito, codigo e escapes do Markdown para as tags do reportlab."""
    t = t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    t = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'`(.+?)`', r'<font face="Courier" size="8.5">\1</font>', t)
    return t


def ler(caminho):
    """Separa o front matter YAML simples do corpo em Markdown."""
    texto = open(caminho, encoding='utf-8').read()
    meta = {}
    if texto.startswith('---'):
        _, bruto, texto = texto.split('---', 2)
        for linha in bruto.strip().split('\n'):
            if ':' in linha:
                k, v = linha.split(':', 1)
                meta[k.strip()] = v.strip().strip('"')
    return meta, texto.strip()


def _data_br(iso):
    try:
        a, m, d = iso.split('-')
        return f'{d}/{m}/{a}'
    except Exception:
        return iso


def cabecalho(meta):
    """Bloco de identificacao: o que um documento de processo precisa provar."""
    linhas = [
        ('Código', meta.get('codigo', ''), 'Versão', meta.get('versao', '')),
        ('Vigência', _data_br(meta.get('vigencia', '')), 'Revisão prevista', _data_br(meta.get('revisao_prevista', ''))),
        ('Responsável', meta.get('responsavel', ''), 'Aprovado por', meta.get('aprovado_por', '')),
    ]
    dados = []
    for r1, v1, r2, v2 in linhas:
        dados.append([Paragraph(f'<b>{r1}</b>', E['cel']), Paragraph(_inline(v1), E['cel']),
                      Paragraph(f'<b>{r2}</b>', E['cel']), Paragraph(_inline(v2), E['cel'])])
    t = Table(dados, colWidths=[26 * mm, LARG / 2 - 26 * mm, 30 * mm, LARG / 2 - 30 * mm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), FUNDO_CAB),
        ('BOX', (0, 0), (-1, -1), 0.5, CINZA_CLARO),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, CINZA_CLARO),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 3 * mm),
        ('TOPPADDING', (0, 0), (-1, -1), 1.8 * mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 1.8 * mm),
    ]))
    bloco = [t]
    if meta.get('publico'):
        bloco += [Spacer(1, 2 * mm),
                  Paragraph(f"<font color='#666666' size='8'><b>Público:</b> "
                            f"{_inline(meta['publico'])}</font>", E['cel'])]
    return bloco


def tabela(linhas):
    """Tabela Markdown -> tabela do reportlab, com a 1a linha como cabecalho."""
    cab, corpo = linhas[0], linhas[2:]   # linhas[1] e o separador |---|
    n = len(cab)
    largs = [LARG / n] * n
    dados = [[Paragraph(_inline(c), E['celb']) for c in cab]]
    for l in corpo:
        dados.append([Paragraph(_inline(c), E['cel']) for c in (l + [''] * n)[:n]])
    t = Table(dados, colWidths=largs, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), AZUL),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [HexColor('#FFFFFF'), HexColor('#F7F9FC')]),
        ('BOX', (0, 0), (-1, -1), 0.5, CINZA_CLARO),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, CINZA_CLARO),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 2.5 * mm),
        ('RIGHTPADDING', (0, 0), (-1, -1), 2.5 * mm),
        ('TOPPADDING', (0, 0), (-1, -1), 1.8 * mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 1.8 * mm),
    ]))
    return t


def destaque(texto):
    """Paragrafo que abre em negrito vira caixa de atencao — sao as regras que
    nao podem passar batido numa leitura rapida."""
    t = Table([[Paragraph(_inline(texto), E['p'])]], colWidths=[LARG])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), ATENCAO),
        ('BOX', (0, 0), (-1, -1), 0.5, HexColor('#E6C200')),
        ('LEFTPADDING', (0, 0), (-1, -1), 4 * mm),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4 * mm),
        ('TOPPADDING', (0, 0), (-1, -1), 3 * mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 1 * mm),
    ]))
    return t


def corpo_para_flowables(md):
    """Converte o corpo Markdown. Linhas em branco separam blocos; uma linha que
    continua a anterior pertence ao mesmo bloco — inclusive dentro de item de
    lista, senao a continuacao vira paragrafo solto e perde o recuo."""
    fl, buf_tab, buf_par = [], [], []
    marcador = [None]   # bullet do bloco atual, quando ele e item de lista
    titulo_pendente = [None]

    def add(flowable):
        # Titulo nunca fica sozinho no pe da pagina: sai junto do bloco seguinte.
        if titulo_pendente[0] is not None:
            fl.append(KeepTogether([titulo_pendente[0], flowable]))
            titulo_pendente[0] = None
        else:
            fl.append(flowable)

    def add_titulo(flowable):
        if titulo_pendente[0] is not None:
            fl.append(titulo_pendente[0])
        titulo_pendente[0] = flowable

    def fecha_par():
        if buf_par:
            txt = ' '.join(buf_par)
            if marcador[0] is not None:
                add(Paragraph(_inline(txt), E['li'], bulletText=marcador[0]))
            elif txt.startswith('**') and '.' in txt:
                add(destaque(txt))
            else:
                add(Paragraph(_inline(txt), E['p']))
            buf_par.clear()
        marcador[0] = None

    def fecha_tab():
        if buf_tab:
            add(tabela(buf_tab))
            fl.append(Spacer(1, 3 * mm))
            buf_tab.clear()

    for linha in md.split('\n'):
        s = linha.rstrip()
        if s.startswith('|'):
            fecha_par()
            buf_tab.append([c.strip() for c in s.strip('|').split('|')])
            continue
        fecha_tab()
        if not s.strip():
            fecha_par()
        elif s.startswith('### '):
            fecha_par(); add_titulo(Paragraph(_inline(s[4:]), E['h2']))
        elif s.startswith('## '):
            fecha_par(); add_titulo(Paragraph(_inline(s[3:]), E['h1']))
        elif re.match(r'^\d+\.\s', s):
            fecha_par()
            marcador[0] = s.split('.')[0] + '.'
            buf_par.append(s.split('. ', 1)[1])
        elif s.startswith('- '):
            fecha_par()
            marcador[0] = '\u2022'
            buf_par.append(s[2:])
        else:
            buf_par.append(s.strip())
    fecha_par(); fecha_tab()
    if titulo_pendente[0] is not None:
        fl.append(titulo_pendente[0])
    return fl


def gerar(entrada, saida=None):
    meta, md = ler(entrada)
    saida = saida or os.path.splitext(entrada)[0] + '.pdf'
    titulo = f"{meta.get('codigo', '')} — {meta.get('titulo', '')}"

    def moldura(canvas, doc):
        canvas.saveState()
        canvas.setFont(FONTE, 7.5)
        canvas.setFillColor(CINZA)
        canvas.drawString(M, A4[1] - 12 * mm, 'GRÁFICA LKL · Processo Operacional')
        canvas.drawRightString(A4[0] - M, A4[1] - 12 * mm, meta.get('codigo', ''))
        canvas.setStrokeColor(CINZA_CLARO)
        canvas.line(M, A4[1] - 14 * mm, A4[0] - M, A4[1] - 14 * mm)
        canvas.line(M, 14 * mm, A4[0] - M, 14 * mm)
        canvas.drawString(M, 10 * mm,
                          f"Versão {meta.get('versao', '')} · vigente desde "
                          f"{_data_br(meta.get('vigencia', ''))} · "
                          f"revisão prevista {_data_br(meta.get('revisao_prevista', ''))}")
        canvas.drawRightString(A4[0] - M, 10 * mm, f'Página {doc.page}')
        canvas.restoreState()

    doc = BaseDocTemplate(saida, pagesize=A4, title=titulo,
                          author='Gráfica LKL', subject=meta.get('titulo', ''),
                          leftMargin=M, rightMargin=M, topMargin=20 * mm, bottomMargin=20 * mm)
    doc.addPageTemplates([PageTemplate(id='pad', frames=[
        Frame(M, 20 * mm, LARG, A4[1] - 40 * mm, id='f',
              leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)],
        onPage=moldura)])

    fl = [Paragraph(_inline(meta.get('titulo', '')), E['titulo']),
          Paragraph(f"Processo Operacional {meta.get('codigo', '').replace('PO-', '')}", E['codigo'])]
    fl += cabecalho(meta)
    fl += [Spacer(1, 4 * mm)]
    fl += corpo_para_flowables(md)
    doc.build(fl)
    return saida


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    print('gerado:', gerar(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None))
