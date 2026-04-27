const express = require('express');
const multer = require('multer');
const User = require('../models/User');
const { connectDB } = require('../lib/db');
const { authRequired } = require('../lib/auth');
const { uploadBuffer, getCloudinary } = require('../lib/cloudinary');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
});

const MAX_STICKERS = 30;

router.get('/me', authRequired, async (req, res) => {
  await connectDB();
  const u = await User.findById(req.user.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ stickers: u.stickersForClient() });
});

router.post('/', authRequired, upload.single('image'), async (req, res) => {
  try {
    await connectDB();
    const u = await User.findById(req.user.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    const name = (req.body.name || '').toString().slice(0, 32).trim();
    if (!name) return res.status(400).json({ error: 'Falta el nombre' });
    if (!req.file) return res.status(400).json({ error: 'Falta la imagen' });
    if ((u.stickers || []).length >= MAX_STICKERS) {
      return res.status(400).json({ error: `M\u00e1ximo ${MAX_STICKERS} stickers` });
    }
    const result = await uploadBuffer(req.file.buffer, {
      folder: `foro34/stickers/${u.username}`,
      transformation: [{ width: 320, height: 320, crop: 'limit' }],
    });
    u.stickers.push({
      name,
      url: result.secure_url,
      publicId: result.public_id,
    });
    await u.save();
    res.json({ stickers: u.stickersForClient() });
  } catch (err) {
    console.error('create sticker', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.delete('/:id', authRequired, async (req, res) => {
  try {
    await connectDB();
    const u = await User.findById(req.user.id);
    if (!u) return res.status(404).json({ error: 'Not found' });
    const idx = (u.stickers || []).findIndex((s) => s._id.toString() === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Not found' });
    const s = u.stickers[idx];
    if (s.publicId) {
      try { await getCloudinary().uploader.destroy(s.publicId); } catch (_e) { /* ignore */ }
    }
    u.stickers.splice(idx, 1);
    await u.save();
    res.json({ stickers: u.stickersForClient() });
  } catch (err) {
    console.error('delete sticker', err);
    res.status(500).json({ error: 'Failed' });
  }
});

module.exports = router;
