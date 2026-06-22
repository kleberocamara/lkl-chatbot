const express = require('express');
const { requireAuthApi } = require('../middleware/auth');

const utilsRouter = require('./utils/router');

const router = express.Router();

router.use('/utils', utilsRouter);

router.use('/clientes', requireAuthApi, require('./clientes/router'));
router.use('/fornecedores', requireAuthApi, require('./fornecedores/router'));
router.use('/materiais', requireAuthApi, require('./materiais/router'));
router.use('/funcionarios', requireAuthApi, require('./funcionarios/router'));
router.use('/price-table', requireAuthApi, require('./price-table/router'));
router.use('/orders', requireAuthApi, require('./orders/router'));
router.use('/notifications', requireAuthApi, require('./notifications/router'));
// GET /orcamentos/resposta é público (link de aprovação/reprovação por e-mail); demais rotas exigem auth
router.use('/orcamentos',
  (req, res, next) => (req.method === 'GET' && req.path === '/resposta') ? next() : requireAuthApi(req, res, next),
  require('./orcamentos/router'));
router.use('/os', requireAuthApi, require('./os/router'));
router.use('/especificacoes', requireAuthApi, require('./especificacoes/router'));
router.use('/formatos', requireAuthApi, require('./formatos/router'));
router.use('/nfe', requireAuthApi, require('./nfe/router'));
router.use('/contas-pagar', requireAuthApi, require('./contas-pagar/router'));
router.use('/users', requireAuthApi, require('./users/router'));

module.exports = router;
