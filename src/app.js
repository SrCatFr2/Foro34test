const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { authOptional } = require('./lib/auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const messageRoutes = require('./routes/messages');
const configRoutes = require('./routes/config');
const realtimeRoutes = require('./routes/realtime');
const serverRoutes = require('./routes/servers');
const stickerRoutes = require('./routes/stickers');
const dmRoutes = require('./routes/dms');

// Asset version used for cache-busting. Computed once per cold start so
// served HTML always references the current deploy's JS/CSS.
function computeAssetVersion(publicDir) {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha) return sha.slice(0, 8);
  // Fall back to a hash of the asset files (changes whenever JS/CSS change).
  try {
    const h = crypto.createHash('sha1');
    for (const rel of ['js/app.js', 'css/style.css', 'index.html']) {
      const p = path.join(publicDir, rel);
      if (fs.existsSync(p)) h.update(fs.readFileSync(p));
    }
    return h.digest('hex').slice(0, 8);
  } catch (_e) {
    return String(Date.now());
  }
}

function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  // Security headers. CSP is permissive enough to allow Pusher CDN + Google Fonts
  // + Cloudinary/data: images while still blocking arbitrary inline scripts from
  // user-generated text.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", 'https://js.pusher.com'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com', 'https:'],
        'media-src': ["'self'", 'blob:', 'https://res.cloudinary.com', 'https:'],
        'connect-src': ["'self'", 'https://*.pusher.com', 'wss://*.pusher.com', 'wss://*.pusherapp.com'],
        'frame-ancestors': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());
  app.use(authOptional);

  // Rate limits — all keyed by IP. Numbers are intentionally generous so legit
  // chat usage is never blocked, but catastrophic spam/abuse is throttled.
  const messageLimiter = rateLimit({
    windowMs: 10 * 1000, max: 30,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiados mensajes, esperá un momento.' },
  });
  const authLimiter = rateLimit({
    windowMs: 60 * 1000, max: 8,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiados intentos de login. Intentá en un minuto.' },
  });
  const writeLimiter = rateLimit({
    windowMs: 60 * 1000, max: 60,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiadas operaciones, esperá un poco.' },
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      hasMongo: Boolean(process.env.MONGODB_URI),
      hasCloudinary: Boolean(process.env.CLOUDINARY_CLOUD_NAME),
      hasPusher: Boolean(process.env.PUSHER_APP_ID && process.env.PUSHER_KEY && process.env.PUSHER_SECRET && process.env.PUSHER_CLUSTER),
    });
  });

  app.use('/api/config', configRoutes);
  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/messages', messageLimiter, messageRoutes);
  app.use('/api/realtime', realtimeRoutes);
  app.use('/api/servers', writeLimiter, serverRoutes);
  app.use('/api/stickers', writeLimiter, stickerRoutes);
  app.use('/api/dms', dmRoutes);

  const publicDir = path.join(__dirname, '..', 'public');
  const assetVersion = computeAssetVersion(publicDir);

  // Static files (CSS/JS/images). On Vercel these may also be served
  // directly by the platform via vercel.json, but the SPA HTML routes
  // below always go through Express so the cache-busting stamp applies.
  app.use(express.static(publicDir, {
    index: false,
    extensions: false,
    setHeaders: (res, filePath) => {
      // The HTML itself must never be cached; always re-fetch to pick up
      // a new asset version. Other static files are fine to cache short-term;
      // the version query string ensures fresh content per deploy.
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=300');
      }
    },
  }));

  // Render index.html for SPA routes with cache-busting stamp injected.
  const indexPath = path.join(publicDir, 'index.html');
  app.get(['/', '/login', '/register', '/profile', '/u/:username'], (_req, res) => {
    let html;
    try {
      html = fs.readFileSync(indexPath, 'utf8');
    } catch (err) {
      console.error('failed to read index.html', err);
      return res.status(500).send('Internal error');
    }
    html = html.replace(/__ASSET_V__/g, assetVersion);
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  app.use((err, _req, res, _next) => {
    console.error('unhandled error', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
