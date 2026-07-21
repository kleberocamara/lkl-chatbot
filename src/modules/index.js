const express = require('express');
const { requireAuthApi } = require('../middleware/auth');

const utilsRouter = require('./utils/router');

const router = express.Router();

router.use('/utils', utilsRouter);

router.use('/clientes', requireAuthApi, require('./clientes/router'));
router.use('/fornecedores', requireAuthApi, require('./fornecedores/router'));
router.use('/materiais', requireAuthApi, require('./materiais/router'));
router.use('/funcionarios', requireAuthApi, require('./funcionarios/router'));
router.use('/maquinas', requireAuthApi, require('./maquinas/router'));
router.use('/entradas', requireAuthApi, require('./entradas/router'));
router.use('/price-table', requireAuthApi, require('./price-table/router'));
router.use('/precificacao', requireAuthApi, require('./precificacao/router'));
router.use('/revenda', requireAuthApi, require('./revenda/router'));
router.use('/revenda-compras', requireAuthApi, require('./revenda-compras/router'));
router.use('/orders', requireAuthApi, require('./orders/router'));
router.use('/notifications', requireAuthApi, require('./notifications/router'));
// /orcamentos/resposta e /orcamentos/arte-resposta são públicas (links de aprovação: GET mostra a página, POST executa); demais rotas exigem auth
const ORCAMENTOS_ROTAS_PUBLICAS = ['/resposta', '/arte-resposta'];
router.use('/orcamentos',
  (req, res, next) => (ORCAMENTOS_ROTAS_PUBLICAS.includes(req.path) && ['GET', 'POST'].includes(req.method)) ? next() : requireAuthApi(req, res, next),
  require('./orcamentos/router'));
router.use('/os', requireAuthApi, require('./os/router'));
router.use('/especificacoes', requireAuthApi, require('./especificacoes/router'));
router.use('/formatos', requireAuthApi, require('./formatos/router'));
router.use('/nfe', requireAuthApi, require('./nfe/router'));
router.use('/contas-pagar', requireAuthApi, require('./contas-pagar/router'));
router.use('/analises', requireAuthApi, require('./analises/router'));
router.use('/users', requireAuthApi, require('./users/router'));
router.use('/portal-fornecedor', require('./portal-fornecedor/router'));
router.use('/fornecedor-submissoes', requireAuthApi, require('./fornecedor-submissoes/router'));

module.exports = router;
