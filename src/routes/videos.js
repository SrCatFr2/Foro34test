const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const Video = require('../models/Video');
const User = require('../models/User');
const { connectDB } = require('../lib/db');
const { authOptional, authRequired } = require('../lib/auth');
const { uploadBuffer, getCloudinary } = require('../lib/cloudinary');
const { anonIdFor, anonNameFor } = require('../lib/anonid');

const router = express.Router();

// 80 MB cap for short clips. Cloudinary free plan accepts up to 100 MB.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
}).single('video');

// Caps the rate at which uploads can be issued per user/IP.
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`),
  message: { error: 'Demasiadas subidas, esperá un minuto.' },
});

const interactLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`),
});

const commentLimiter = rateLimit({
  windowMs: 30 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`),
});

function viewerFromReq(req) {
  return {
    userId: req.user ? req.user.id : null,
    anonId: req.user ? '' : anonIdFor(req),
  };
}

function parseTags(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,\s]+/)
    .map((t) => t.replace(/^#/, '').toLowerCase().trim())
    .filter((t) => t && /^[a-z0-9_]{1,24}$/.test(t))
    .slice(0, 8);
}

// GET /api/videos/feed?limit=10&before=ISO
// Reverse-chronological feed; clients vertically scroll through these.
router.get('/feed', authOptional, async (req, res) => {
  try {
    await connectDB();
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 30);
    const before = req.query.before ? new Date(req.query.before) : null;
    const filter = { deletedAt: null };
    if (before && !Number.isNaN(before.getTime())) {
      filter.createdAt = { $lt: before };
    }
    const items = await Video.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit);
    const viewer = viewerFromReq(req);
    res.json({
      videos: items.map((v) => v.toClientJSON(viewer)),
      nextBefore: items.length ? items[items.length - 1].createdAt : null,
    });
  } catch (err) {
    console.error('list videos failed', err);
    res.status(500).json({ error: 'Failed to load videos' });
  }
});

// GET /api/videos/user/:username
router.get('/user/:username', authOptional, async (req, res) => {
  try {
    await connectDB();
    const username = String(req.params.username || '').toLowerCase();
    if (!username) return res.status(400).json({ error: 'Bad username' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 24, 60);
    const items = await Video.find({ 'author.username': username, deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(limit);
    const viewer = viewerFromReq(req);
    res.json({ videos: items.map((v) => v.toClientJSON(viewer)) });
  } catch (err) {
    console.error('list user videos failed', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// GET /api/videos/:id
router.get('/:id', authOptional, async (req, res) => {
  try {
    await connectDB();
    const v = await Video.findById(req.params.id);
    if (!v || v.deletedAt) return res.status(404).json({ error: 'Not found' });
    res.json({ video: v.toClientJSON(viewerFromReq(req)) });
  } catch (_err) {
    res.status(400).json({ error: 'Bad id' });
  }
});

// POST /api/videos  — multipart with `video`, `caption?`, `tags?`
router.post('/', authRequired, uploadLimiter, upload, async (req, res) => {
  try {
    await connectDB();
    if (!req.file) return res.status(400).json({ error: 'Falta el archivo de video' });
    if (!process.env.CLOUDINARY_CLOUD_NAME) {
      return res.status(503).json({ error: 'Cloudinary no está configurado' });
    }
    const caption = String(req.body.caption || '').trim().slice(0, 500);
    const tags = parseTags(req.body.tags);

    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Cloudinary auto-generates a JPG poster from the first frame when we
    // ask for `eager` transformations on a video upload.
    const result = await uploadBuffer(req.file.buffer, {
      folder: 'foro34/clips',
      resource_type: 'video',
      eager: [{ format: 'jpg', width: 720, crop: 'limit' }],
      eager_async: false,
    });

    const cld = getCloudinary();
    const thumbUrl = (result.eager && result.eager[0] && result.eager[0].secure_url)
      || cld.url(result.public_id, {
        resource_type: 'video',
        format: 'jpg',
        secure: true,
      });

    const video = await Video.create({
      caption,
      tags,
      videoUrl: result.secure_url,
      videoPublicId: result.public_id,
      thumbnailUrl: thumbUrl,
      duration: Math.round(result.duration || 0),
      width: result.width || 0,
      height: result.height || 0,
      bytes: result.bytes || 0,
      author: {
        userId: user._id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        color: user.color,
        decoration: user.decoration || 'none',
        nameFont: user.nameFont || 'default',
      },
    });

    res.status(201).json({ video: video.toClientJSON({ userId: user._id.toString() }) });
  } catch (err) {
    console.error('upload video failed', err);
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'El video excede 80 MB' });
    }
    res.status(500).json({ error: 'No se pudo subir el video' });
  }
});

// DELETE /api/videos/:id
router.delete('/:id', authRequired, async (req, res) => {
  try {
    await connectDB();
    const v = await Video.findById(req.params.id);
    if (!v || v.deletedAt) return res.status(404).json({ error: 'Not found' });
    if (!v.author.userId || v.author.userId.toString() !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    v.deletedAt = new Date();
    await v.save();
    if (v.videoPublicId) {
      try {
        await getCloudinary().uploader.destroy(v.videoPublicId, { resource_type: 'video' });
      } catch (e) {
        console.warn('cloudinary destroy failed', e.message);
      }
    }
    res.json({ ok: true });
  } catch (_err) {
    res.status(400).json({ error: 'Bad request' });
  }
});

// POST /api/videos/:id/like — toggle like.
router.post('/:id/like', authOptional, interactLimiter, async (req, res) => {
  try {
    await connectDB();
    const v = await Video.findById(req.params.id);
    if (!v || v.deletedAt) return res.status(404).json({ error: 'Not found' });
    let liked;
    if (req.user) {
      const idx = v.likedBy.findIndex((id) => id.toString() === req.user.id);
      if (idx >= 0) {
        v.likedBy.splice(idx, 1);
        liked = false;
      } else {
        v.likedBy.push(req.user.id);
        liked = true;
      }
    } else {
      const aid = anonIdFor(req);
      const idx = v.likedAnon.indexOf(aid);
      if (idx >= 0) {
        v.likedAnon.splice(idx, 1);
        liked = false;
      } else {
        v.likedAnon.push(aid);
        liked = true;
      }
    }
    v.likeCount = (v.likedBy || []).length + (v.likedAnon || []).length;
    await v.save();
    res.json({ liked, likeCount: v.likeCount });
  } catch (_err) {
    res.status(400).json({ error: 'Bad request' });
  }
});

// POST /api/videos/:id/view — bump view counter.
// Cheap and rate-limited so a single viewer can't farm views.
router.post('/:id/view', interactLimiter, async (req, res) => {
  try {
    await connectDB();
    const updated = await Video.findOneAndUpdate(
      { _id: req.params.id, deletedAt: null },
      { $inc: { viewCount: 1 } },
      { new: true, projection: { viewCount: 1 } },
    );
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json({ viewCount: updated.viewCount });
  } catch (_err) {
    res.status(400).json({ error: 'Bad request' });
  }
});

// GET /api/videos/:id/comments
router.get('/:id/comments', async (req, res) => {
  try {
    await connectDB();
    const v = await Video.findById(req.params.id).select('comments commentCount deletedAt');
    if (!v || v.deletedAt) return res.status(404).json({ error: 'Not found' });
    const items = (v.comments || []).slice().reverse().map((c) => ({
      id: c._id.toString(),
      text: c.text,
      author: {
        userId: c.author.userId ? c.author.userId.toString() : null,
        username: c.author.username || '',
        displayName: c.author.displayName,
        avatarUrl: c.author.avatarUrl || '',
        color: c.author.color || '#9aa0aa',
        anonymous: !!c.author.anonymous,
      },
      likeCount: (c.likedBy || []).length + (c.likedAnon || []).length,
      createdAt: c.createdAt,
    }));
    res.json({ comments: items, total: v.commentCount || items.length });
  } catch (_err) {
    res.status(400).json({ error: 'Bad request' });
  }
});

// POST /api/videos/:id/comments — add a comment (auth optional).
router.post('/:id/comments', authOptional, commentLimiter, async (req, res) => {
  try {
    await connectDB();
    const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
    if (!text) return res.status(400).json({ error: 'Comentario vacío' });
    const v = await Video.findById(req.params.id);
    if (!v || v.deletedAt) return res.status(404).json({ error: 'Not found' });

    let author;
    let anonOwner = '';
    if (req.user) {
      const u = await User.findById(req.user.id).select('username displayName avatarUrl color');
      if (!u) return res.status(401).json({ error: 'User not found' });
      author = {
        userId: u._id,
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        color: u.color,
        anonymous: false,
      };
    } else {
      anonOwner = anonIdFor(req);
      author = {
        userId: null,
        username: '',
        displayName: anonNameFor(req),
        avatarUrl: '',
        color: '#9aa0aa',
        anonymous: true,
      };
    }

    v.appendComment({ text, author, anonOwner, createdAt: new Date() });
    await v.save();
    const created = v.comments[v.comments.length - 1];
    res.status(201).json({
      comment: {
        id: created._id.toString(),
        text: created.text,
        author: {
          userId: created.author.userId ? created.author.userId.toString() : null,
          username: created.author.username,
          displayName: created.author.displayName,
          avatarUrl: created.author.avatarUrl,
          color: created.author.color,
          anonymous: created.author.anonymous,
        },
        likeCount: 0,
        createdAt: created.createdAt,
      },
      commentCount: v.commentCount,
    });
  } catch (err) {
    console.error('post comment failed', err);
    res.status(400).json({ error: 'Bad request' });
  }
});

module.exports = router;
