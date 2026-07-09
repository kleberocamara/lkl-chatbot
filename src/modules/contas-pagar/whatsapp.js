const path = require('path');
const { format } = require('date-fns');
const db = require('../../db');
const { sendMessage } = require('../../services/whatsapp');
const fornecedorMatcher = require('./fornecedor-matcher');
const classificador = require('./classificador');
const ocr = require('./ocr');
const service = require('./service');

const JANELA_CONFIRMACAO_MINUTOS = 30;

const UPLOADS_DIR = path.join(__dirname, '../../../public/uploads');

function _numerosAutorizados() {
  return String(process.env.CONTAS_PAGAR_WHATSAPP_NUMEROS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function isNumeroAutorizado(phone) {
  return _numerosAutorizados().includes(phone);
}

async function _tipoDespesaNome(id) {
  if (!id) return 'não identificada — classifique no painel';
  const r = await db.query('SELECT nome FROM tipos_despesa WHERE id = $1', [id]);
  return r.rows[0]?.nome || 'não identificada — classifique no painel';
}

async function handleComprovanteDespesa(phone, mediaType, localUrl) {
  if (!['image', 'document'].includes(mediaType)) {
    await sendMessage(phone, 'Só consigo ler imagem ou PDF de comprovante. Lance manualmente no painel.');
    return;
  }
  const filename = path.basename(localUrl);
  const absPath = path.join(UPLOADS_DIR, filename);

  let dados;
  try {
    dados = await ocr.extrairDadosComprovante(absPath);
  } catch (err) {
    console.error('[CONTAS-PAGAR-WA] erro no OCR:', err.message);
    dados = null;
  }
  if (!dados) {
    await sendMessage(phone, 'Não consegui ler os dados dessa imagem, lance manualmente no painel.');
    return;
  }

  if (fornecedorMatcher.ehCnpjProprio(dados.cnpj)) {
    await sendMessage(phone, 'Não consegui identificar o fornecedor corretamente (os dados encontrados parecem ser da nossa própria empresa, não do fornecedor). Lance manualmente no painel financeiro.');
    return;
  }

  try {
    const fornecedor = await fornecedorMatcher.encontrarOuCriarFornecedor({ nome: dados.fornecedor, cnpj: dados.cnpj });
    const sugestao = await classificador.classificarDespesa({
      fornecedorId: fornecedor?.id || null,
      nomeFornecedor: dados.fornecedor,
      descricao: dados.descricao,
    });

    await db.query('DELETE FROM despesas_pendentes_confirmacao WHERE telefone = $1', [phone]);
    await db.query(
      `INSERT INTO despesas_pendentes_confirmacao (telefone, fornecedor_id, parcelas, data_entrega, descricao, tipo_despesa_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [phone, fornecedor?.id || null, JSON.stringify(dados.parcelas), dados.data_entrega, dados.descricao, sugestao.tipo_despesa_id]
    );

    const nomeTipo = await _tipoDespesaNome(sugestao.tipo_despesa_id);
    const dataEntregaFmt = format(new Date(`${dados.data_entrega}T00:00:00`), 'dd/MM/yyyy');
    const fmtValor = v => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

    let linhasParcelas;
    if (dados.parcelas.length === 1) {
      const p = dados.parcelas[0];
      const vencFmt = format(new Date(`${p.vencimento}T00:00:00`), 'dd/MM/yyyy');
      linhasParcelas = `*Valor:* ${fmtValor(p.valor)}\n*Vencimento:* ${vencFmt}`;
    } else {
      linhasParcelas = dados.parcelas.map((p, i) => {
        const vencFmt = format(new Date(`${p.vencimento}T00:00:00`), 'dd/MM/yyyy');
        return `${i + 1}ª parcela: ${fmtValor(p.valor)} — vence ${vencFmt}`;
      }).join('\n');
    }

    await sendMessage(phone,
      `📄 *Fornecedor:* ${dados.fornecedor}\n*Data de entrega:* ${dataEntregaFmt}\n*Categoria sugerida:* ${nomeTipo}\n\n${linhasParcelas}\n\nConfirma? Responda *sim* ou *não*.`
    );
  } catch (err) {
    console.error('[CONTAS-PAGAR-WA] erro ao classificar/gravar pendência:', err.message);
    await sendMessage(phone, 'Tive um problema ao processar esse comprovante. Tente de novo ou lance manualmente no painel.');
  }
}

async function processarRespostaDespesaWA(phone, texto) {
  const norm = String(texto || '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  const isSim = norm === 'SIM';
  const isNao = norm === 'NAO';
  if (!isSim && !isNao) return null;

  const r = await db.query(
    `SELECT * FROM despesas_pendentes_confirmacao WHERE telefone = $1 AND criado_em > NOW() - ($2 || ' minutes')::interval`,
    [phone, JANELA_CONFIRMACAO_MINUTOS]
  );
  if (!r.rows.length) return null;
  const pendente = r.rows[0];

  await db.query('DELETE FROM despesas_pendentes_confirmacao WHERE id = $1', [pendente.id]);

  if (isNao) {
    return { mensagem: 'Ok, não lancei. Você pode cadastrar manualmente no painel financeiro.' };
  }

  let fornecedorNome = null;
  if (pendente.fornecedor_id) {
    const f = await db.query('SELECT nome FROM fornecedores WHERE id=$1', [pendente.fornecedor_id]);
    fornecedorNome = f.rows[0]?.nome || null;
  }

  const parcelas = pendente.parcelas;
  if (parcelas.length === 1) {
    await service.criarOuReconciliarContaPagar({
      fornecedorId: pendente.fornecedor_id,
      fornecedorNome,
      descricao: pendente.descricao,
      valor: parcelas[0].valor,
      vencimento: parcelas[0].vencimento,
      competencia: pendente.data_entrega,
      tipoDespesaId: pendente.tipo_despesa_id,
      tipoEntrada: 'whatsapp_ocr',
      tipo: 'boleto',
    });
  } else {
    const resultado = await service.criarParcelado({
      descricao: pendente.descricao,
      fornecedor: fornecedorNome,
      fornecedor_id: pendente.fornecedor_id,
      tipo_despesa_id: pendente.tipo_despesa_id,
      competencia: pendente.data_entrega,
      tipo: 'boleto',
      parcelas,
    });
    if (resultado.erro) {
      console.error('[CONTAS-PAGAR-WA] erro ao criar parcelado:', resultado.erro.join('; '));
      return { mensagem: 'Não consegui lançar essas parcelas, lance manualmente no painel financeiro.' };
    }
  }

  return { mensagem: '✅ Lançado.' };
}

async function limparPendentesExpirados() {
  const r = await db.query(
    `DELETE FROM despesas_pendentes_confirmacao WHERE criado_em < NOW() - ($1 || ' minutes')::interval RETURNING id`,
    [JANELA_CONFIRMACAO_MINUTOS]
  );
  return { removidos: r.rowCount };
}

module.exports = { isNumeroAutorizado, handleComprovanteDespesa, processarRespostaDespesaWA, limparPendentesExpirados };
