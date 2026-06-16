const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const LOGO_PATH = path.join(__dirname, '../../public/assets/logo-lkl.png');
const AZUL_LKL = '#1a237e';

function formatBRL(value) {
  if (value == null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('pt-BR');
}

/**
 * Gera PDF do orçamento e retorna um Buffer.
 * @param {object} orc — resultado de buscarPorId()
 * @returns {Promise<Buffer>}
 */
function gerarOrcamentoPDF(orc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // HEADER
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, 50, 40, { height: 55 });
    } else {
      doc.fontSize(22).fillColor(AZUL_LKL).font('Helvetica-Bold').text('LKL', 50, 45);
      doc.fontSize(8).fillColor('#555').font('Helvetica').text('GRÁFICA E COMUNICAÇÃO VISUAL', 50, 70);
    }

    doc.fontSize(15).fillColor(AZUL_LKL).font('Helvetica-Bold')
       .text(`PROPOSTA / ORÇAMENTO ${orc.numero}`, 200, 45, { align: 'right', width: 345 });
    doc.fontSize(10).fillColor('#333').font('Helvetica')
       .text(`Data Emissão: ${formatDate(orc.created_at)}`, 200, 65, { align: 'right', width: 345 });

    doc.moveTo(50, 110).lineTo(545, 110).strokeColor('#cccccc').lineWidth(1).stroke();

    // RECIPIENT
    doc.fontSize(10).fillColor('#333').font('Helvetica').text('À', 50, 120);
    doc.fontSize(13).fillColor(AZUL_LKL).font('Helvetica-Bold')
       .text((orc.cliente_nome || 'CLIENTE NÃO IDENTIFICADO').toUpperCase(), 50, 134);
    if (orc.cliente_celular) {
      doc.fontSize(10).fillColor('#333').font('Helvetica')
         .text(`FONE: ${orc.cliente_celular}`, 50, 152);
    }
    const introY = orc.cliente_celular ? 170 : 155;
    doc.fontSize(10).fillColor('#555').font('Helvetica-Oblique')
       .text('Conforme solicitação vimos através desta apresentar nossa proposta orçamentária para confecção do(s) serviço(s) conforme especificações abaixo:', 50, introY, { width: 495 });

    // ITEMS TABLE
    const tableTop = introY + 40;

    // Table header
    doc.rect(50, tableTop, 495, 20).fill(AZUL_LKL);
    doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold');
    doc.text('CÓD.',    55, tableTop + 6, { width: 40 });
    doc.text('DADOS DO(S) SERVIÇO(S)', 100, tableTop + 6, { width: 225 });
    doc.text('QTDE',   330, tableTop + 6, { width: 55, align: 'right' });
    doc.text('VL. UNIT.',390, tableTop + 6, { width: 75, align: 'right' });
    doc.text('VL. TOTAL',470, tableTop + 6, { width: 70, align: 'right' });

    let rowY = tableTop + 20;
    let totalGeral = 0;

    for (let i = 0; i < (orc.itens || []).length; i++) {
      const item = orc.itens[i];
      const bg = i % 2 === 0 ? '#f5f5f5' : '#ffffff';

      // estimate row height
      const descH = doc.heightOfString(item.descricao || '', { width: 220 });
      const specs = [item.tipo_insumo, item.cores, item.impressao].filter(Boolean).join(' | ');
      const specsH = specs ? doc.fontSize(8).heightOfString(specs, { width: 220 }) : 0;
      const rowH = Math.max(descH + specsH + 10, 22);

      doc.rect(50, rowY, 495, rowH).fill(bg);

      doc.fontSize(9).fillColor('#1a237e').font('Helvetica-Bold')
         .text(String(item.codigo || ''), 55, rowY + 5, { width: 40 });

      doc.fillColor('#222').font('Helvetica')
         .text(item.descricao || '', 100, rowY + 5, { width: 225 });

      if (specs) {
        doc.fontSize(8).fillColor('#666')
           .text(specs, 100, rowY + 5 + descH, { width: 225 });
      }

      doc.fontSize(9).fillColor('#222').font('Helvetica')
         .text(String(item.quantidade || ''), 330, rowY + 5, { width: 55, align: 'right' })
         .text(formatBRL(item.valor_unitario), 390, rowY + 5, { width: 75, align: 'right' })
         .text(formatBRL(item.valor_total), 470, rowY + 5, { width: 70, align: 'right' });

      totalGeral += Number(item.valor_total) || 0;
      rowY += rowH;
    }

    // Total row
    doc.rect(50, rowY, 495, 22).fill(AZUL_LKL);
    doc.fontSize(10).fillColor('#ffffff').font('Helvetica-Bold')
       .text('Total da Proposta', 50, rowY + 6, { width: 460, align: 'right' })
       .text(formatBRL(totalGeral), 470, rowY + 6, { width: 70, align: 'right' });
    rowY += 22;

    // FOOTER CONDITIONS
    const footY = rowY + 18;
    doc.fontSize(10).fillColor('#333').font('Helvetica')
       .text(`Condição de pagamento :  ${orc.condicao_pagamento || '—'}`, 50, footY)
       .text(`Validade da proposta .... :  ${orc.validade_dias || 35}  Dias úteis`, 50, footY + 16)
       .text(`Prazo Entrega ................ :  ${orc.prazo_entrega || 'A Combinar'}`, 50, footY + 32);
    if (orc.observacao) {
      doc.text(`Observação ................... :  ${orc.observacao}`, 50, footY + 48);
    }

    // SIGNATURES
    const sigY = footY + (orc.observacao ? 90 : 65);
    doc.fontSize(9).fillColor('#555').font('Helvetica-Oblique').text('Atenciosamente', 50, sigY);

    // Left signature — LKL
    doc.moveTo(50, sigY + 45).lineTo(235, sigY + 45).strokeColor('#333').lineWidth(0.5).stroke();
    doc.fontSize(9).fillColor('#333').font('Helvetica-Bold').text('DIRETORIA', 50, sigY + 49);
    doc.font('Helvetica').text('GRUPODE GRAFICAS LKL LTDA', 50, sigY + 62)
       .fillColor('#666').text('sisgraf@sisgraf.com.br', 50, sigY + 75);

    // Right signature — client
    doc.moveTo(310, sigY + 45).lineTo(545, sigY + 45).strokeColor('#333').lineWidth(0.5).stroke();
    doc.fontSize(9).fillColor('#555').font('Helvetica-Oblique')
       .text('Autorizo a confecção do(s) item(ns) acima assinalados', 310, sigY + 49, { width: 235 });
    doc.fillColor('#333').font('Helvetica-Bold')
       .text((orc.cliente_nome || '').toUpperCase(), 310, sigY + 75, { width: 235 });

    doc.end();
  });
}

module.exports = { gerarOrcamentoPDF };
