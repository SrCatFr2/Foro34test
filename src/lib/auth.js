const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'foro34_token';
const TOKEN_TTL = '30d';

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}

function signToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, getSecret());
  } catch (_e) {
    return null;
  }
}

function readToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7);
  }
  if (req.cookies && req.cookies[COOKIE_NAME]) {
    return req.cookies[COOKIE_NAME];
  }
  return null;
}

function authOptional(req, _res, next) {
  const token = readToken(req);
  if (token) {
    const data = verifyToken(token);
    if (data) req.user = data;
  }
  next();
}

function authRequired(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: 'Invalid token' });
  req.user = data;
  next();
}

module.exports = {
  COOKIE_NAME,
  signToken,
  verifyToken,
  authOptional,
  authRequired,
};
