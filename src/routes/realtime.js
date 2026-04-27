const express = require('express');
const { authOptional } = require('../lib/auth');
const { authorizeChannel } = require('../lib/pusher');
const { anonIdFor, anonNameFor } = require('../lib/anonid');
const User = require('../models/User');
const { connectDB } = require('../lib/db');

const router = express.Router();

// Pusher private/presence channel auth. Required for presence channels
// used for the online users list and typing indicator.
router.post('/auth', authOptional, async (req, res) => {
  try {
    const socketId = req.body.socket_id;
    const channel = req.body.channel_name;
    if (!socketId || !channel) {
      return res.status(400).json({ error: 'Missing socket_id or channel_name' });
    }

    let presenceData = null;
    if (channel.startsWith('presence-')) {
      let id;
      let info;
      if (req.user) {
        await connectDB();
        const u = await User.findById(req.user.id).lean();
        id = req.user.id;
        info = {
          username: u && u.username,
          displayName: u ? u.displayName : 'User',
          avatarUrl: u ? u.avatarUrl : '',
          color: u ? u.color : '#7c5cff',
          decoration: u ? u.decoration : 'none',
          anonymous: false,
        };
      } else {
        id = `anon-${anonIdFor(req)}`;
        info = {
          username: '',
          displayName: anonNameFor(req),
          avatarUrl: '',
          color: '#9aa0aa',
          decoration: 'none',
          anonymous: true,
        };
      }
      presenceData = { user_id: id, user_info: info };
    } else if (channel.startsWith('private-user-')) {
      // Only the user themselves can subscribe to their own private channel.
      const wanted = channel.replace('private-user-', '');
      if (!req.user || req.user.id !== wanted) {
        return res.status(403).json({ error: 'Not your channel' });
      }
    }

    const auth = authorizeChannel({ socketId, channel, presenceData });
    if (!auth) return res.status(503).json({ error: 'Realtime not configured' });
    res.send(auth);
  } catch (err) {
    console.error('pusher auth failed', err);
    res.status(500).json({ error: 'Auth failed' });
  }
});

module.exports = router;
