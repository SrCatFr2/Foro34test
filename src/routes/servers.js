const express = require('express');
const Server = require('../models/Server');
const { connectDB } = require('../lib/db');
const { authRequired } = require('../lib/auth');

const router = express.Router();

// List servers the current user belongs to.
router.get('/', authRequired, async (req, res) => {
  try {
    await connectDB();
    const servers = await Server.find({ members: req.user.id }).sort({ createdAt: 1 });
    res.json({ servers: servers.map((s) => s.toClientJSON()) });
  } catch (err) {
    console.error('list servers', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Create a new server. Owner is automatically the first member, and a
// default #general channel is created.
router.post('/', authRequired, async (req, res) => {
  try {
    await connectDB();
    const name = (req.body.name || '').toString().slice(0, 40).trim();
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    const icon = (req.body.icon || '').toString().slice(0, 8);
    const s = await Server.create({
      name,
      icon,
      ownerId: req.user.id,
      members: [req.user.id],
      channels: [{ name: 'general', type: 'text', topic: 'Canal por defecto' }],
    });
    res.json({ server: s.toClientJSON() });
  } catch (err) {
    console.error('create server', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Public preview of an invite link. Lets a logged-out user see the server
// name/icon/member count before being asked to log in or join.
router.get('/invite/:code', async (req, res) => {
  try {
    await connectDB();
    const code = (req.params.code || '').toString().trim();
    if (!code) return res.status(400).json({ error: 'Falta el c\u00f3digo' });
    const s = await Server.findOne({ inviteCode: code }).select('name icon members channels inviteCode');
    if (!s) return res.status(404).json({ error: 'Invitaci\u00f3n no v\u00e1lida o expirada' });
    res.json({
      invite: {
        code: s.inviteCode,
        serverId: s._id.toString(),
        name: s.name,
        icon: s.icon || '',
        memberCount: (s.members || []).length,
        channelCount: (s.channels || []).length,
      },
    });
  } catch (err) {
    console.error('preview invite', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Join a server by invite code. Accepts a raw code OR a full invite URL
// (e.g. https://foro34.com/invite/abc123) — we strip the URL and keep the
// trailing token, so users can paste either format.
router.post('/join', authRequired, async (req, res) => {
  try {
    await connectDB();
    let code = (req.body.code || '').toString().trim();
    if (!code) return res.status(400).json({ error: 'Falta el c\u00f3digo' });
    const urlMatch = code.match(/(?:\/invite\/|\?invite=)([a-f0-9]{6,32})/i);
    if (urlMatch) code = urlMatch[1];
    code = code.replace(/[^a-f0-9]/gi, '').toLowerCase();
    if (!code) return res.status(400).json({ error: 'C\u00f3digo no v\u00e1lido' });
    const s = await Server.findOne({ inviteCode: code });
    if (!s) return res.status(404).json({ error: 'Invitaci\u00f3n no v\u00e1lida' });
    if (!s.members.some((m) => m.toString() === req.user.id)) {
      s.members.push(req.user.id);
      await s.save();
    }
    res.json({ server: s.toClientJSON() });
  } catch (err) {
    console.error('join server', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Get one server (must be member).
router.get('/:id', authRequired, async (req, res) => {
  try {
    await connectDB();
    const s = await Server.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'No encontrado' });
    if (!s.members.some((m) => m.toString() === req.user.id)) {
      return res.status(403).json({ error: 'No eres miembro' });
    }
    res.json({ server: s.toClientJSON() });
  } catch (err) {
    console.error('get server', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Add a channel (owner only for now).
router.post('/:id/channels', authRequired, async (req, res) => {
  try {
    await connectDB();
    const s = await Server.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'No encontrado' });
    if (s.ownerId.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Solo el owner puede crear canales' });
    }
    const name = (req.body.name || '').toString().slice(0, 32).trim().replace(/\s+/g, '-').toLowerCase();
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    if (s.channels.some((c) => c.name === name)) {
      return res.status(409).json({ error: 'Ya existe un canal con ese nombre' });
    }
    const topic = (req.body.topic || '').toString().slice(0, 200);
    s.channels.push({ name, type: 'text', topic });
    await s.save();
    res.json({ server: s.toClientJSON() });
  } catch (err) {
    console.error('create channel', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Leave a server.
router.delete('/:id/leave', authRequired, async (req, res) => {
  try {
    await connectDB();
    const s = await Server.findById(req.params.id);
    if (!s) return res.status(404).json({ error: 'No encontrado' });
    if (s.ownerId.toString() === req.user.id) {
      return res.status(400).json({ error: 'El owner no puede salir; bor\u00ed el server' });
    }
    s.members = s.members.filter((m) => m.toString() !== req.user.id);
    await s.save();
    res.json({ ok: true });
  } catch (err) {
    console.error('leave server', err);
    res.status(500).json({ error: 'Failed' });
  }
});

module.exports = router;
