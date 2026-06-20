const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const LOGO_PATH = path.join(__dirname, '../../public/logo.png');
const AZUL = '#1a237e';
const AZUL_CLARO = '#3949ab';
const CINZA = '#f5f6fa';

function formatBRL(value) {
  if (value == null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('pt-BR');
}

function gerarOrcamentoPDF(orc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = 595.28;   // A4 width pts
    const L = 40;       // left margin
    const R = W - 40;   // right margin
    const CW = R - L;   // content width

    // ── CABEÇALHO ──────────────────────────────────────────────────────────
    const HDR_H = 95;
    doc.rect(0, 0, W, HDR_H).fill(AZUL);

    // Logo maior, mais à esquerda
    const logoSize = 84;
    const logoX = 14;
    const logoY = (HDR_H - logoSize) / 2;
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, logoX, logoY, { width: logoSize, height: logoSize });
    } else {
      doc.fontSize(28).fillColor('#ffffff').font('Helvetica-Bold').text('LKL', logoX, logoY + 20);
    }

    // Texto da empresa — começa depois do logo
    const txtX = logoX + logoSize + 12;
    const txtTop = 20;
    doc.fontSize(15).fillColor('#ffffff').font('Helvetica-Bold')
       .text('GRUPO DE GRAFICAS LKL LTDA', txtX, txtTop);
    doc.fontSize(8).fillColor('#c5cae9').font('Helvetica')
       .text('Conectando Imaginação, Qualidade & Tecnologia', txtX, txtTop + 20);
    doc.fontSize(7.5).fillColor('#9fa8da')
       .text('RUA DR. WALDIR DE SOUZA MEDEIROS, 315 - PARQUE DUQUE - DUQUE DE CAXIAS/RJ', txtX, txtTop + 32)
       .text('comercialgraficalkl@gmail.com  |  WhatsApp: (21) 98047-5671', txtX, txtTop + 44);

    // Número do orçamento (canto direito)
    doc.fontSize(19).fillColor('#ffffff').font('Helvetica-Bold')
       .text(`Nº ${String(orc.numero).padStart(6, '0')}`, 0, txtTop, { align: 'right', width: W - 18 });
    doc.fontSize(9).fillColor('#c5cae9').font('Helvetica')
       .text('PROPOSTA / ORÇAMENTO', 0, txtTop + 22, { align: 'right', width: W - 18 })
       .text(`Emissão: ${formatDate(orc.created_at)}`, 0, txtTop + 35, { align: 'right', width: W - 18 });

    // ── CLIENTE ────────────────────────────────────────────────────────────
    let y = HDR_H + 10;
    doc.fontSize(8).fillColor('#888').font('Helvetica')
       .text('DESTINATÁRIO / CLIENTE', L, y);
    y += 12;
    doc.fontSize(13).fillColor(AZUL).font('Helvetica-Bold')
       .text((orc.cliente_nome || 'CLIENTE NÃO IDENTIFICADO').toUpperCase(), L, y, { width: CW });
    y += 18;

    // Linha de info do cliente
    const infos = [];
    if (orc.cliente_celular) infos.push(`Fone: ${orc.cliente_celular}`);
    if (orc.cpf_cnpj)       infos.push(`CNPJ/CPF: ${orc.cpf_cnpj}`);
    if (infos.length) {
      doc.fontSize(9).fillColor('#444').font('Helvetica')
         .text(infos.join('   |   '), L, y, { width: CW });
      y += 14;
    }

    // Linha separadora
    doc.moveTo(L, y).lineTo(R, y).strokeColor('#dde').lineWidth(0.5).stroke();
    y += 10;

    // Intro
    doc.fontSize(9).fillColor('#555').font('Helvetica-Oblique')
       .text('Conforme solicitação, vimos por meio desta apresentar nossa proposta orçamentária para confecção do(s) serviço(s) conforme especificações abaixo:', L, y, { width: CW });
    y += 30;

    // ── TABELA ─────────────────────────────────────────────────────────────
    // Colunas ajustadas para caber exatamente de L até R (515px total)
    // CÓD(45) | DESCRIÇÃO(240) | QTDE(55) | VL.UNIT(85) | VL.TOTAL(90)
    const colW = { cod: 45, desc: 240, qtde: 55, unit: 85, total: 90 };
    const COL = {
      cod:   L,
      desc:  L + colW.cod,
      qtde:  L + colW.cod + colW.desc,
      unit:  L + colW.cod + colW.desc + colW.qtde,
      total: L + colW.cod + colW.desc + colW.qtde + colW.unit,
    };

    // Header
    doc.rect(L, y, CW, 20).fill(AZUL);
    doc.fontSize(8.5).fillColor('#ffffff').font('Helvetica-Bold');
    doc.text('CÓD.',        COL.cod,   y+6, { width: colW.cod });
    doc.text('DADOS DO(S) SERVIÇO(S)', COL.desc, y+6, { width: colW.desc });
    doc.text('QTDE',        COL.qtde,  y+6, { width: colW.qtde,  align: 'right' });
    doc.text('VL. UNIT.',   COL.unit,  y+6, { width: colW.unit,  align: 'right' });
    doc.text('VL. TOTAL',   COL.total, y+6, { width: colW.total, align: 'right' });
    y += 20;

    let totalGeral = 0;
    const itens = orc.itens || [];

    for (let i = 0; i < itens.length; i++) {
      const item = itens[i];
      const bg = i % 2 === 0 ? CINZA : '#ffffff';

      const descH = doc.fontSize(9).heightOfString(item.descricao || '', { width: colW.desc - 4 });
      const rowH = Math.max(descH + 12, 22);

      // Verificar se cabe na página
      if (y + rowH > 770) {
        doc.addPage({ size: 'A4', margin: 0 });
        y = 40;
      }

      doc.rect(L, y, CW, rowH).fill(bg);

      // Linha de separação sutil
      doc.moveTo(L, y + rowH).lineTo(R, y + rowH).strokeColor('#e0e0e0').lineWidth(0.3).stroke();

      doc.fontSize(9).fillColor(AZUL_CLARO).font('Helvetica-Bold')
         .text(String(item.codigo || ''), COL.cod, y + 6, { width: colW.cod });

      doc.fillColor('#222').font('Helvetica')
         .text(item.descricao || '', COL.desc, y + 6, { width: colW.desc - 4 });

      doc.fillColor('#333').font('Helvetica')
         .text(String(item.quantidade || 0), COL.qtde, y + 6, { width: colW.qtde, align: 'right' })
         .text(formatBRL(item.valor_unitario), COL.unit, y + 6, { width: colW.unit, align: 'right' })
         .text(formatBRL(item.valor_total), COL.total, y + 6, { width: colW.total, align: 'right' });

      totalGeral += Number(item.valor_total) || 0;
      y += rowH;
    }

    // Linha total
    doc.rect(L, y, CW, 24).fill(AZUL);
    // Label e valor em chamadas SEPARADAS para evitar sobreposição
    doc.fontSize(10).fillColor('#ffffff').font('Helvetica-Bold')
       .text('Total da Proposta', COL.cod, y + 7, { width: colW.cod + colW.desc + colW.qtde + colW.unit - 8, align: 'right' });
    doc.fontSize(10).fillColor('#ffffff').font('Helvetica-Bold')
       .text(formatBRL(totalGeral), COL.total, y + 7, { width: colW.total, align: 'right' });
    y += 24;

    // ── CONDIÇÕES ──────────────────────────────────────────────────────────
    y += 14;
    if (y > 750) { doc.addPage({ size: 'A4', margin: 0 }); y = 40; }

    const conds = [
      `Condição de pagamento : ${orc.condicao_pagamento || '—'}`,
      `Validade da proposta .... : ${orc.validade_dias || 35} dias úteis`,
      `Prazo de entrega .......... : ${orc.prazo_entrega || 'A Combinar'}`,
    ];
    if (orc.observacao) conds.push(`Observação ................... : ${orc.observacao}`);

    doc.fontSize(9.5).fillColor('#333').font('Helvetica');
    for (const linha of conds) {
      doc.text(linha, L, y, { width: CW });
      y += 15;
    }

    // ── ASSINATURAS ────────────────────────────────────────────────────────
    y += 20;
    if (y > 720) { doc.addPage({ size: 'A4', margin: 0 }); y = 40; }

    doc.fontSize(9).fillColor('#555').font('Helvetica-Oblique').text('Atenciosamente,', L, y);
    y += 40;

    const sigW = (CW - 20) / 2;

    // Assinatura LKL
    doc.moveTo(L, y).lineTo(L + sigW, y).strokeColor('#888').lineWidth(0.5).stroke();
    doc.fontSize(8.5).fillColor('#333').font('Helvetica-Bold')
       .text('DIRETORIA', L, y + 4);
    doc.font('Helvetica').fillColor('#555')
       .text('GRUPO DE GRAFICAS LKL LTDA', L, y + 15);

    // Assinatura cliente
    const sigX2 = L + sigW + 20;
    doc.moveTo(sigX2, y).lineTo(R, y).strokeColor('#888').lineWidth(0.5).stroke();
    doc.fontSize(8.5).fillColor('#555').font('Helvetica-Oblique')
       .text('Autorizo a confecção do(s) item(ns) acima assinalados', sigX2, y + 4, { width: sigW });
    doc.fillColor('#333').font('Helvetica-Bold')
       .text((orc.cliente_nome || '').toUpperCase(), sigX2, y + 24, { width: sigW });

    // ── RODAPÉ ─────────────────────────────────────────────────────────────
    const pageBottom = 841.89;
    doc.rect(0, pageBottom - 28, W, 28).fill(AZUL);
    doc.fontSize(7.5).fillColor('#9fa8da').font('Helvetica')
       .text('GRUPO DE GRAFICAS LKL LTDA  |  Conectando Imaginação, Qualidade & Tecnologia', 0, pageBottom - 18, { align: 'center', width: W });

    doc.end();
  });
}

module.exports = { gerarOrcamentoPDF };
