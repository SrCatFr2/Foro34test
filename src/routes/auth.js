const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { connectDB } = require('../lib/db');
const { signToken, COOKIE_NAME, authRequired } = require('../lib/auth');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 24 * 60 * 60 * 1000,
  path: '/',
};

function pickRandomColor() {
  const palette = ['#7c5cff', '#ff5c8a', '#5cd0ff', '#5cffae', '#ffb95c', '#ff7a5c', '#c45cff', '#5c7aff'];
  return palette[Math.floor(Math.random() * palette.length)];
}

router.post('/register', authLimiter, async (req, res) => {
  try {
    await connectDB();
    const { username, email, password, displayName } = req.body || {};
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email, password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const uname = String(username).toLowerCase().trim();
    if (!/^[a-z0-9_]{3,24}$/.test(uname)) {
      return res.status(400).json({ error: 'Username: 3-24 chars, a-z 0-9 _' });
    }
    const existing = await User.findOne({ $or: [{ username: uname }, { email: String(email).toLowerCase().trim() }] });
    if (existing) {
      return res.status(409).json({ error: 'Username or email already taken' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      username: uname,
      displayName: displayName || uname,
      email: String(email).toLowerCase().trim(),
      passwordHash,
      color: pickRandomColor(),
    });
    const token = signToken({ id: user._id.toString(), username: user.username });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    return res.json({ token, user: user.toPublicJSON() });
  } catch (err) {
    console.error('register failed', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    await connectDB();
    const { identifier, password } = req.body || {};
    if (!identifier || !password) {
      return res.status(400).json({ error: 'identifier and password are required' });
    }
    const id = String(identifier).toLowerCase().trim();
    const user = await User.findOne({ $or: [{ username: id }, { email: id }] });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = signToken({ id: user._id.toString(), username: user.username });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    return res.json({ token, user: user.toPublicJSON() });
  } catch (err) {
    console.error('login failed', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', authRequired, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ user: user.toPublicJSON() });
  } catch (err) {
    console.error('me failed', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
