/**
 * Quotation service — calculates order budget.
 */
const db = require('../db');

/**
 * @param {object} orderDetails
 * @returns {Promise<object>}
 */
async function calcularOrcamento(orderDetails) {
  // TODO: implement full quotation engine
  return { total: 0, items: [], orderDetails };
}

module.exports = { calcularOrcamento };
