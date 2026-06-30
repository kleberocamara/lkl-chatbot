const db = require('../../db');
const engine = require('./engine');

// Resolve a regra ativa do produto: prefere a específica do material, senão a default (material_id IS NULL).
async function regraDoProduto(produto, materialId) {
  const r = await db.query(
    `SELECT * FROM regras_preco
      WHERE ativo = TRUE AND produto = $1
        AND (material_id = $2 OR material_id IS NULL)
      ORDER BY (material_id = $2) DESC
      LIMIT 1`,
    [produto, materialId || null]
  );
  return r.rows[0] || null;
}

async function precificarItem({ produto, material_id, quantidade, largura_cm, altura_cm }) {
  if (!produto) return null;
  const regra = await regraDoProduto(produto, material_id);
  if (!regra || regra.metodo_calculo === 'manual') return null;

  const ctx = {};
  if (regra.metodo_calculo === 'faixa') {
    const f = await db.query(
      'SELECT qtd_min, qtd_max, preco_unitario FROM regras_preco_faixa WHERE regra_id = $1 ORDER BY qtd_min',
      [regra.id]
    );
    ctx.faixas = f.rows;
  }
  if (regra.metodo_calculo === 'm2_bobina') {
    if (!material_id) return null;
    const b = await db.query(
      'SELECT largura_cm FROM material_bobinas WHERE material_id = $1 AND ativo = TRUE',
      [material_id]
    );
    ctx.bobinas = b.rows;
  }
  if (regra.metodo_calculo === 'revenda') {
    const p = await db.query(
      'SELECT preco_unitario, sincronizado_em FROM precos_revenda WHERE produto = $1 ORDER BY sincronizado_em DESC LIMIT 1',
      [produto]
    );
    ctx.precoRevenda = p.rows[0] || null;
  }

  const calc = engine.calcularItem(regra, { quantidade, largura_cm, altura_cm }, ctx);
  if (!calc) return null;
  return { ...calc, metodo: regra.metodo_calculo };
}

// CRUD de regras
async function listarRegras() {
  const r = await db.query(
    `SELECT rp.*, m.nome AS material_nome
       FROM regras_preco rp LEFT JOIN materiais m ON m.id = rp.material_id
      ORDER BY rp.produto, m.nome NULLS FIRST`
  );
  return r.rows;
}
async function criarRegra(d) {
  if (!d.produto || !d.metodo_calculo) return { erro: ['produto e metodo_calculo são obrigatórios'] };
  const r = await db.query(
    `INSERT INTO regras_preco (produto, material_id, metodo_calculo, preco_base, m2_minimo, espaco_corte_cm, ativo)
     VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,TRUE)) RETURNING *`,
    [d.produto, d.material_id || null, d.metodo_calculo, d.preco_base ?? null,
     d.m2_minimo ?? null, d.espaco_corte_cm ?? 0, d.ativo]
  );
  return { item: r.rows[0] };
}
async function atualizarRegra(id, d) {
  const r = await db.query(
    `UPDATE regras_preco SET
       metodo_calculo=COALESCE($1,metodo_calculo), preco_base=$2, m2_minimo=$3,
       espaco_corte_cm=COALESCE($4,espaco_corte_cm), material_id=$5,
       ativo=COALESCE($6,ativo), updated_at=NOW()
     WHERE id=$7 RETURNING *`,
    [d.metodo_calculo ?? null, d.preco_base ?? null, d.m2_minimo ?? null,
     d.espaco_corte_cm ?? null, d.material_id ?? null, d.ativo, id]
  );
  if (!r.rows[0]) return { erro: ['Regra não encontrada'] };
  return { item: r.rows[0] };
}

// Faixas
async function listarFaixas(regraId) {
  const r = await db.query('SELECT * FROM regras_preco_faixa WHERE regra_id=$1 ORDER BY qtd_min', [regraId]);
  return r.rows;
}
async function criarFaixa(regraId, d) {
  if (d.preco_unitario == null) return { erro: ['preco_unitario é obrigatório'] };
  const r = await db.query(
    `INSERT INTO regras_preco_faixa (regra_id, qtd_min, qtd_max, preco_unitario)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [regraId, d.qtd_min ?? 1, d.qtd_max ?? null, d.preco_unitario]
  );
  return { item: r.rows[0] };
}
async function removerFaixa(id) { await db.query('DELETE FROM regras_preco_faixa WHERE id=$1', [id]); return { ok: true }; }

// Bobinas por material
async function listarBobinas(materialId) {
  const r = await db.query('SELECT * FROM material_bobinas WHERE material_id=$1 ORDER BY largura_cm', [materialId]);
  return r.rows;
}
async function criarBobina(materialId, d) {
  if (!(Number(d.largura_cm) > 0)) return { erro: ['largura_cm deve ser > 0'] };
  const r = await db.query(
    `INSERT INTO material_bobinas (material_id, largura_cm, ativo) VALUES ($1,$2,COALESCE($3,TRUE)) RETURNING *`,
    [materialId, d.largura_cm, d.ativo]
  );
  return { item: r.rows[0] };
}
async function removerBobina(id) { await db.query('DELETE FROM material_bobinas WHERE id=$1', [id]); return { ok: true }; }

module.exports = {
  precificarItem, regraDoProduto,
  listarRegras, criarRegra, atualizarRegra,
  listarFaixas, criarFaixa, removerFaixa,
  listarBobinas, criarBobina, removerBobina,
};
