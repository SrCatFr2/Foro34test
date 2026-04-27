const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const Message = require('../models/Message');
const User = require('../models/User');
const { connectDB } = require('../lib/db');
const { authOptional, authRequired } = require('../lib/auth');
const { uploadBuffer } = require('../lib/cloudinary');
const { broadcast } = require('../lib/pusher');
const { anonIdFor, anonNameFor } = require('../lib/anonid');
const { processCommand, BOT } = require('../lib/commands');
const ubrebot = require('../lib/ubrebot');
const { bump } = require('../lib/achievements');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
}).fields([
  { name: 'image', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
]);

const sendLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`),
});

const reactLimiter = rateLimit({
  windowMs: 5 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`),
});

function makeBotAuthor() {
  return { ...BOT };
}

async function pushMentionNotifications(payload, mentions, broadcastRoom) {
  if (!mentions || mentions.length === 0) return;
  const users = await User.find({ username: { $in: mentions } });
  for (const u of users) {
    const note = {
      type: 'mention',
      msgId: payload.id,
      fromUsername: payload.author.username || '',
      fromDisplayName: payload.author.displayName,
      text: (payload.text || '').slice(0, 200),
      room: payload.room,
      read: false,
      createdAt: new Date(),
    };
    u.notifications = [note, ...(u.notifications || []).slice(0, 49)];
    try {
      await u.save();
    } catch (e) {
      console.warn('save notif', e.message);
    }
    // realtime push to that user only
    broadcast(`private-user-${u._id.toString()}`, 'notification:new', {
      ...note,
      msgId: note.msgId,
      createdAt: note.createdAt,
    }).catch((e) => console.warn('push notif', e.message));
  }
}

function extractMentions(text) {
  if (!text) return [];
  const re = /@([a-z0-9_]{3,24})/gi;
  const found = new Set();
  let m;
  while ((m = re.exec(text)) !== null) found.add(m[1].toLowerCase());
  return [...found];
}

function ownerCheck(msg, req) {
  if (req.user) return msg.author.userId && msg.author.userId.toString() === req.user.id;
  if (msg.author.anonymous && msg.anonOwner) return msg.anonOwner === anonIdFor(req);
  return false;
}

router.get('/', async (req, res) => {
  try {
    await connectDB();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const before = req.query.before ? new Date(req.query.before) : null;
    const room = req.query.room || 'global';
    const filter = { room };
    if (before && !Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };
    const items = await Message.find(filter).sort({ createdAt: -1 }).limit(limit);
    items.reverse();
    res.json({ messages: items.map((m) => m.toClientJSON()) });
  } catch (err) {
    console.error('list messages failed', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    await connectDB();
    const m = await Message.findById(req.params.id);
    if (!m) return res.status(404).json({ error: 'Not found' });
    res.json({ message: m.toClientJSON() });
  } catch (err) {
    res.status(400).json({ error: 'Bad id' });
  }
});

router.post('/', authOptional, sendLimiter, upload, async (req, res) => {
  try {
    await connectDB();
    const text = (req.body.text || '').toString().slice(0, 2000).trim();
    const room = (req.body.room || 'global').toString().slice(0, 80);
    const replyToId = (req.body.replyToId || '').toString();

    // Server channel access control: rooms `srv-{serverId}-{channelId}`
    // require the user to be a registered member of the server. Anons
    // can only post in `global` rooms.
    if (room.startsWith('srv-')) {
      if (!req.user) return res.status(403).json({ error: 'Inicia sesi\u00f3n' });
      const Server = require('../models/Server');
      const parts = room.split('-');
      if (parts.length < 3) return res.status(400).json({ error: 'Room inv\u00e1lido' });
      const serverId = parts[1];
      const channelId = parts[2];
      const s = await Server.findById(serverId).lean();
      if (!s) return res.status(404).json({ error: 'Server no encontrado' });
      if (!s.members.some((m) => m.toString() === req.user.id)) {
        return res.status(403).json({ error: 'No eres miembro' });
      }
      if (!s.channels.some((c) => c._id.toString() === channelId)) {
        return res.status(404).json({ error: 'Canal no encontrado' });
      }
    } else if (room.startsWith('dm-')) {
      if (!req.user) return res.status(403).json({ error: 'Inicia sesi\u00f3n para DMs' });
      const ids = room.replace(/^dm-/, '').split('-');
      if (ids.length !== 2) return res.status(400).json({ error: 'Room DM inv\u00e1lido' });
      if (!ids.includes(req.user.id)) return res.status(403).json({ error: 'No eres parte de este DM' });
    }

    let imageUrl = '';
    let imagePublicId = '';
    if (req.files && req.files.image && req.files.image[0]) {
      const f = req.files.image[0];
      const result = await uploadBuffer(f.buffer, { folder: 'foro34/messages' });
      imageUrl = result.secure_url;
      imagePublicId = result.public_id;
    }

    let audioUrl = '';
    let audioPublicId = '';
    let audioDuration = 0;
    if (req.files && req.files.audio && req.files.audio[0]) {
      if (!req.user) return res.status(403).json({ error: 'Inicia sesi\u00f3n para enviar notas de voz' });
      const f = req.files.audio[0];
      const result = await uploadBuffer(f.buffer, { folder: 'foro34/voice', resource_type: 'video' });
      audioUrl = result.secure_url;
      audioPublicId = result.public_id;
      audioDuration = Math.round(result.duration || 0);
    }

    // Sticker send: { stickerId, ownerUsername? } in body. Looks up the
    // sticker on the requesting user's record.
    let sticker = null;
    const stickerId = (req.body.stickerId || '').toString();
    if (stickerId) {
      if (!req.user) return res.status(403).json({ error: 'Inicia sesi\u00f3n para enviar stickers' });
      const u = await User.findById(req.user.id);
      const st = u && (u.stickers || []).find((s) => s._id.toString() === stickerId);
      if (!st) return res.status(404).json({ error: 'Sticker no encontrado' });
      sticker = { url: st.url, name: st.name, ownerUsername: u.username };
    }

    if (!text && !imageUrl && !audioUrl && !sticker) {
      return res.status(400).json({ error: 'Empty message' });
    }

    let author;
    let anonOwner = '';
    if (req.user) {
      const user = await User.findById(req.user.id);
      if (!user) return res.status(401).json({ error: 'User not found' });
      author = {
        userId: user._id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        color: user.color,
        decoration: user.decoration || 'none',
        effect: user.effect || 'none',
        nameFont: user.nameFont || 'default',
        anonymous: false,
        bot: false,
      };
    } else {
      anonOwner = anonIdFor(req);
      author = {
        userId: null,
        username: '',
        displayName: anonNameFor(req),
        avatarUrl: '',
        color: '#9aa0aa',
        decoration: 'none',
        effect: 'none',
        nameFont: 'default',
        anonymous: true,
        bot: false,
      };
    }

    // Resolve replyTo snapshot
    let replyTo = null;
    if (replyToId) {
      try {
        const orig = await Message.findById(replyToId).lean();
        if (orig) {
          replyTo = {
            id: orig._id,
            authorDisplayName: orig.author.displayName || '',
            authorColor: orig.author.color || '',
            snippet: (orig.text || '').slice(0, 140),
            snippetImage: orig.imageUrl || '',
          };
        }
      } catch (_e) { /* ignore bad ids */ }
    }

    // Slash command processing.
    let modText = text;
    let isAction = false;
    let pollData = null;
    let botReplyText = null;

    const cmd = processCommand(text);
    if (cmd && cmd.kind !== 'none') {
      if (cmd.kind === 'replace') {
        modText = cmd.text;
        isAction = !!cmd.isAction;
      } else if (cmd.kind === 'poll') {
        // Replace user message with the poll itself
        modText = '';
        pollData = {
          question: cmd.question,
          multiple: false,
          options: cmd.options.map((t) => ({ text: t, voterIds: [], voterAnonIds: [] })),
        };
      } else if (cmd.kind === 'bot') {
        // Save user msg as-is, then bot replies in a separate message.
        botReplyText = cmd.text;
      }
    }

    const mentions = extractMentions(modText);
    const isPoll = !!pollData;

    // Don't save an empty user message that was a /command-only.
    let userPayload = null;
    if (modText || imageUrl || audioUrl || sticker || isPoll) {
      const msg = await Message.create({
        text: modText,
        imageUrl,
        imagePublicId,
        audioUrl,
        audioPublicId,
        audioDuration,
        sticker,
        kind: isPoll ? 'poll' : 'message',
        isAction,
        author,
        anonOwner,
        room,
        replyTo,
        mentions,
        poll: pollData,
      });
      userPayload = msg.toClientJSON();
      await broadcast(`room-${room}`, 'message:new', userPayload);
      pushMentionNotifications(userPayload, mentions, room).catch((e) =>
        console.warn('mention notif', e.message),
      );
      // Stats + achievements (registered users only)
      if (req.user) {
        try {
          const u = await User.findById(req.user.id);
          if (u) {
            const deltas = { messages: 1 };
            if (imageUrl) deltas.images = 1;
            if (audioUrl) deltas.voiceNotes = 1;
            if (sticker) deltas.stickersUsed = 1;
            if (isPoll) deltas.polls = 1;
            const newly = await bump(u, deltas);
            for (const key of newly) {
              const note = {
                type: 'achievement',
                msgId: msg._id,
                fromUsername: '',
                fromDisplayName: 'Foro34',
                text: `\ud83c\udfc6 Logro desbloqueado: ${key}`,
                room,
                read: false,
                createdAt: new Date(),
              };
              u.notifications = [note, ...(u.notifications || []).slice(0, 49)];
              await u.save();
              broadcast(`private-user-${u._id.toString()}`, 'notification:new', { ...note }).catch(() => {});
            }
          }
        } catch (e) { console.warn('achievement bump', e.message); }
      }
    }

    // UbreBot trigger — runs before the static command bot.
    if (userPayload && ubrebot.isMentioned(modText)) {
      const prompt = ubrebot.stripMention(modText);
      // Tell the room UbreBot is "typing" so the UI shows the indicator immediately.
      broadcast(`room-${room}`, 'bot:typing', { botName: 'UbreBot', at: Date.now() }).catch(() => {});
      ubrebot.ask(prompt, { displayName: author.displayName }).then(async (reply) => {
        try {
          const ubre = {
            userId: null,
            username: ubrebot.UBREBOT_USERNAME,
            displayName: 'UbreBot',
            avatarUrl: '',
            color: '#22c55e',
            decoration: 'aurora',
            effect: 'pulse',
            nameFont: 'default',
            anonymous: false,
            bot: true,
          };
          const ubreMsg = await Message.create({
            text: reply,
            kind: 'system',
            author: ubre,
            room,
            replyTo: { id: userPayload.id, authorDisplayName: author.displayName, authorColor: author.color, snippet: (modText || '').slice(0, 140), snippetImage: '' },
          });
          await broadcast(`room-${room}`, 'message:new', ubreMsg.toClientJSON());
        } catch (e) { console.warn('ubrebot reply', e.message); }
      });
    }

    // Bot reply (system)
    let botPayload = null;
    if (botReplyText) {
      const botMsg = await Message.create({
        text: botReplyText,
        imageUrl: '',
        kind: 'system',
        isAction: false,
        author: makeBotAuthor(),
        room,
        replyTo: userPayload ? { id: userPayload.id, authorDisplayName: author.displayName, authorColor: author.color || '', snippet: text.slice(0, 140), snippetImage: '' } : null,
      });
      botPayload = botMsg.toClientJSON();
      await broadcast(`room-${room}`, 'message:new', botPayload);
    }

    res.status(201).json({
      message: userPayload,
      botReply: botPayload,
      broadcast: 'ok',
    });
  } catch (err) {
    console.error('send message failed', err);
    res.status(500).json({ error: 'Failed to send' });
  }
});

router.patch('/:id', authOptional, async (req, res) => {
  try {
    await connectDB();
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.deletedAt) return res.status(400).json({ error: 'Message deleted' });
    if (!ownerCheck(msg, req)) return res.status(403).json({ error: 'Not your message' });
    if (msg.kind !== 'message') return res.status(400).json({ error: 'Cannot edit this message' });

    const text = (req.body.text || '').toString().slice(0, 2000).trim();
    if (!text && !msg.imageUrl) return res.status(400).json({ error: 'Empty message' });
    msg.text = text;
    msg.editedAt = new Date();
    msg.mentions = extractMentions(text);
    await msg.save();
    const payload = msg.toClientJSON();
    await broadcast(`room-${msg.room}`, 'message:update', payload);
    res.json({ message: payload });
  } catch (err) {
    console.error('edit failed', err);
    res.status(500).json({ error: 'Edit failed' });
  }
});

router.delete('/:id', authOptional, async (req, res) => {
  try {
    await connectDB();
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (!ownerCheck(msg, req)) return res.status(403).json({ error: 'Not your message' });
    msg.deletedAt = new Date();
    await msg.save();
    const payload = msg.toClientJSON();
    await broadcast(`room-${msg.room}`, 'message:update', payload);
    res.json({ message: payload });
  } catch (err) {
    console.error('delete failed', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

router.post('/:id/reactions', authOptional, reactLimiter, async (req, res) => {
  try {
    await connectDB();
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.deletedAt) return res.status(400).json({ error: 'Message deleted' });
    const emoji = String(req.body.emoji || '').slice(0, 16);
    if (!emoji) return res.status(400).json({ error: 'Missing emoji' });

    let reaction = msg.reactions.find((r) => r.emoji === emoji);
    if (!reaction) {
      msg.reactions.push({ emoji, userIds: [], anonIds: [] });
      reaction = msg.reactions[msg.reactions.length - 1];
    }
    if (req.user) {
      const uid = req.user.id;
      const idx = reaction.userIds.findIndex((id) => id.toString() === uid);
      if (idx >= 0) reaction.userIds.splice(idx, 1);
      else reaction.userIds.push(uid);
    } else {
      const aid = anonIdFor(req);
      const idx = reaction.anonIds.indexOf(aid);
      if (idx >= 0) reaction.anonIds.splice(idx, 1);
      else reaction.anonIds.push(aid);
    }
    // Remove empty reactions
    msg.reactions = msg.reactions.filter((r) => (r.userIds || []).length + (r.anonIds || []).length > 0);
    await msg.save();
    const payload = msg.toClientJSON();
    await broadcast(`room-${msg.room}`, 'message:update', payload);

    // Track reactionsReceived for the author (skip bots and self-reactions)
    if (msg.author && msg.author.userId && !msg.author.bot) {
      const isSelf = req.user && msg.author.userId.toString() === req.user.id;
      if (!isSelf) {
        try {
          const author = await User.findById(msg.author.userId);
          if (author) await bump(author, { reactionsReceived: 1 });
        } catch (_e) { /* ignore */ }
      }
    }
    res.json({ message: payload });
  } catch (err) {
    console.error('react failed', err);
    res.status(500).json({ error: 'React failed' });
  }
});

router.post('/:id/poll/vote', authOptional, async (req, res) => {
  try {
    await connectDB();
    const msg = await Message.findById(req.params.id);
    if (!msg || !msg.poll) return res.status(404).json({ error: 'Poll not found' });
    const idx = parseInt(req.body.optionIndex, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= msg.poll.options.length) {
      return res.status(400).json({ error: 'Bad option' });
    }
    const opt = msg.poll.options[idx];
    if (req.user) {
      const uid = req.user.id;
      // Remove vote from all options for this user (single-vote polls)
      msg.poll.options.forEach((o) => {
        const i = o.voterIds.findIndex((id) => id.toString() === uid);
        if (i >= 0) o.voterIds.splice(i, 1);
      });
      opt.voterIds.push(uid);
    } else {
      const aid = anonIdFor(req);
      msg.poll.options.forEach((o) => {
        const i = o.voterAnonIds.indexOf(aid);
        if (i >= 0) o.voterAnonIds.splice(i, 1);
      });
      opt.voterAnonIds.push(aid);
    }
    msg.markModified('poll');
    await msg.save();
    const payload = msg.toClientJSON();
    await broadcast(`room-${msg.room}`, 'message:update', payload);
    res.json({ message: payload });
  } catch (err) {
    console.error('vote failed', err);
    res.status(500).json({ error: 'Vote failed' });
  }
});

router.post('/:id/pin', authRequired, async (req, res) => {
  try {
    await connectDB();
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: 'No user' });
    const idStr = msg._id.toString();
    const cur = (user.pinnedMessageIds || []).map((x) => x.toString());
    if (cur.includes(idStr)) {
      user.pinnedMessageIds = user.pinnedMessageIds.filter((x) => x.toString() !== idStr);
    } else {
      if (cur.length >= 5) return res.status(400).json({ error: 'Max 5 pinned' });
      user.pinnedMessageIds.push(msg._id);
    }
    await user.save();
    res.json({ pinnedMessageIds: user.pinnedMessageIds.map((x) => x.toString()) });
  } catch (err) {
    console.error('pin failed', err);
    res.status(500).json({ error: 'Pin failed' });
  }
});

module.exports = router;
