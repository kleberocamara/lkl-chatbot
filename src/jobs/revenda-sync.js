require('dotenv').config();
const db = require('../db');
const parser = require('../modules/revenda/parser');
const scraper = require('../modules/revenda/scraper');

function log(m) { console.log(`[REVENDA-SYNC] ${new Date().toISOString()} ${m}`); }

async function upsertProduto(catId, p, tabela) {
  const r = await db.query(
    `INSERT INTO revenda_produtos (ref, nome, categoria_id, url, ativo, sincronizado_em)
     VALUES ($1,$2,$3,$4,TRUE,NOW())
     ON CONFLICT (ref) DO UPDATE SET nome=EXCLUDED.nome, categoria_id=EXCLUDED.categoria_id,
       url=EXCLUDED.url, ativo=TRUE, sincronizado_em=NOW()
     RETURNING id`,
    [p.ref, p.nome, catId, p.url]
  );
  const pid = r.rows[0].id;
  await db.query('DELETE FROM revenda_precos WHERE produto_id=$1', [pid]);
  for (const linha of tabela.linhas) {
    for (const h of [12, 24, 48]) {
      if (linha.precos[h] != null) {
        await db.query(
          'INSERT INTO revenda_precos (produto_id, quantidade, prazo_horas, preco_total) VALUES ($1,$2,$3,$4)',
          [pid, linha.quantidade, h, linha.precos[h]]
        );
      }
    }
  }
  await db.query('DELETE FROM revenda_acabamentos WHERE produto_id=$1', [pid]);
  for (const a of tabela.acabamentos) {
    await db.query(
      `INSERT INTO revenda_acabamentos (produto_id, nome, preco, tipo, prazo_extra_dias)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (produto_id, nome) DO UPDATE SET preco=EXCLUDED.preco`,
      [pid, a.nome, a.preco, a.tipo, a.prazo_extra_dias || 0]
    );
  }
}

async function runSync() {
  const logR = await db.query("INSERT INTO revenda_sync_log (status) VALUES ('rodando') RETURNING id");
  const logId = logR.rows[0].id;
  let count = 0;
  try {
    const cats = (await db.query("SELECT id, url FROM revenda_categorias WHERE ativo=TRUE AND COALESCE(sincronizavel,TRUE) AND url ILIKE 'http%'")).rows;
    await scraper.comCookie(async (page) => {
      for (const cat of cats) {
        const listaHtml = await scraper.fetchCategoria(page, cat.url);
        const produtos = parser.parseListaProdutos(listaHtml);
        log(`categoria ${cat.url}: ${produtos.length} produtos`);
        const refsVistos = [];
        for (const p of produtos) {
          try {
            const tabHtml = await scraper.fetchProduto(page, p.url);
            const tabela = parser.parseTabelaPreco(tabHtml);
            // Sem matriz (ex.: adesivo/vinil por m²): registra o produto como REFERÊNCIA (sem preços);
            // o atendente digita o preço manualmente no orçamento.
            if (!tabela.linhas.length) log(`produto ${p.ref} sem matriz — registrado como referência (preço manual)`);
            await upsertProduto(cat.id, p, tabela);
            refsVistos.push(p.ref);
            count++;
            await page.waitForTimeout(800);
          } catch (e) { log(`produto ${p.ref} falhou: ${e.message}`); }
        }
        if (refsVistos.length) {
          await db.query(
            `UPDATE revenda_produtos SET ativo=FALSE WHERE categoria_id=$1 AND ref <> ALL($2::varchar[])`,
            [cat.id, refsVistos]
          );
        }
      }
    });
    await db.query("UPDATE revenda_sync_log SET status='ok', finalizado_em=NOW(), produtos_atualizados=$2 WHERE id=$1", [logId, count]);
    log(`OK: ${count} produtos`);
  } catch (e) {
    await db.query("UPDATE revenda_sync_log SET status='erro', finalizado_em=NOW(), erro=$2 WHERE id=$1", [logId, String(e.message).slice(0, 500)]);
    log(`ERRO: ${e.message}`);
    throw e;
  }
}

module.exports = { runSync };

if (require.main === module) {
  runSync().then(() => process.exit(0)).catch(() => process.exit(1));
}
