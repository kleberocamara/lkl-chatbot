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

module.exports = router;
