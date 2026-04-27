const express = require('express');
const Message = require('../models/Message');
const User = require('../models/User');
const { connectDB } = require('../lib/db');
const { authRequired } = require('../lib/auth');

const router = express.Router();

function dmRoomFor(a, b) {
  return `dm-${[a, b].sort().join('-')}`;
}

// List all DM threads the current user is part of (computed by scanning
// recent messages with rooms starting with `dm-{me}` or `dm-...-{me}`).
router.get('/', authRequired, async (req, res) => {
  try {
    await connectDB();
    const me = req.user.id;
    const messages = await Message.aggregate([
      { $match: { room: { $regex: `^dm-.*${me}.*` } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$room',
          last: { $first: '$$ROOT' },
        },
      },
      { $sort: { 'last.createdAt': -1 } },
    ]);
    const otherIds = new Set();
    for (const t of messages) {
      const ids = t._id.replace(/^dm-/, '').split('-');
      const other = ids.find((x) => x !== me);
      if (other) otherIds.add(other);
    }
    const users = await User.find({ _id: { $in: [...otherIds] } });
    const usersById = new Map(users.map((u) => [u._id.toString(), u]));
    const threads = messages.map((t) => {
      const ids = t._id.replace(/^dm-/, '').split('-');
      const otherId = ids.find((x) => x !== me);
      const u = usersById.get(otherId);
      return {
        room: t._id,
        with: u
          ? {
              id: u._id.toString(),
              username: u.username,
              displayName: u.displayName,
              avatarUrl: u.avatarUrl,
              color: u.color,
              decoration: u.decoration,
              nameFont: u.nameFont,
            }
          : null,
        lastMessage: {
          text: t.last.text,
          createdAt: t.last.createdAt,
          fromUsername: t.last.author && t.last.author.username,
        },
      };
    }).filter((t) => t.with);
    res.json({ threads });
  } catch (err) {
    console.error('list dms', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// Open or create a DM with another user. Returns the room id and the
// other user's public profile.
router.post('/with/:username', authRequired, async (req, res) => {
  try {
    await connectDB();
    const target = await User.findOne({ username: String(req.params.username).toLowerCase() });
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target._id.toString() === req.user.id) {
      return res.status(400).json({ error: 'No puedes abrir un DM contigo mismo' });
    }
    const room = dmRoomFor(req.user.id, target._id.toString());
    res.json({
      room,
      with: target.toPublicJSON(),
    });
  } catch (err) {
    console.error('open dm', err);
    res.status(500).json({ error: 'Failed' });
  }
});

module.exports = router;
