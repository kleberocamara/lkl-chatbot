const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.redirect('/login');

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.redirect('/login');
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
    next();
  });
}

// Rotas liberadas mesmo com troca de senha pendente (sem elas o usuário fica trancado pra sempre)
const ROTAS_LIVRES_TROCA_SENHA = ['/auth/change-password', '/auth/logout'];

function requireAuthApi(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Não autenticado' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    if (req.user.tipo === 'fornecedor') return res.status(401).json({ error: 'Token inválido' });
    if (req.user.mustChangePassword && !ROTAS_LIVRES_TROCA_SENHA.includes(req.path)) {
      return res.status(403).json({ error: 'Troca de senha obrigatória', code: 'MUST_CHANGE_PASSWORD' });
    }
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    const token = req.cookies?.token || req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Não autenticado' });
    try {
      req.user = require('jsonwebtoken').verify(token, process.env.JWT_SECRET);
      if (req.user.tipo === 'fornecedor') return res.status(401).json({ error: 'Token inválido' });
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Acesso negado para este perfil' });
      }
      next();
    } catch {
      res.status(401).json({ error: 'Token inválido' });
    }
  };
}

function requireAuthFornecedor(req, res, next) {
  // Nunca usa req.cookies?.token: esse cookie é do login de FUNCIONÁRIO (src/dashboard/api.js)
  // e é enviado automaticamente em toda requisição same-origin. Se um funcionário estiver logado
  // no painel no mesmo navegador, o cookie dele sobrescreveria o Bearer token do fornecedor.
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.tipo !== 'fornecedor') return res.status(401).json({ error: 'Token inválido' });
    req.fornecedor = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

module.exports = { requireAuth, requireAdmin, requireAuthApi, requireRole, requireAuthFornecedor };
