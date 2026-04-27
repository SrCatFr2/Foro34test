// Achievements system. Tracked stat counters live on User.stats and we
// unlock named achievements when thresholds are met. Fire-and-forget
// (called by other routes after side effects).

const ACHIEVEMENTS = [
  { key: 'first_message', label: 'Primer mensaje', emoji: '\u270d\ufe0f', cond: (s) => s.messages >= 1 },
  { key: 'ten_messages', label: 'Charlador', emoji: '\ud83d\udcac', cond: (s) => s.messages >= 10 },
  { key: 'hundred_messages', label: 'Centurion', emoji: '\ud83d\udd25', cond: (s) => s.messages >= 100 },
  { key: 'thousand_messages', label: 'Leyenda', emoji: '\ud83d\udc51', cond: (s) => s.messages >= 1000 },
  { key: 'first_image', label: 'Fot\u00f3grafo', emoji: '\ud83d\udcf8', cond: (s) => s.images >= 1 },
  { key: 'first_voice', label: 'Voz!', emoji: '\ud83c\udf99\ufe0f', cond: (s) => s.voiceNotes >= 1 },
  { key: 'ten_voice', label: 'Podcaster', emoji: '\ud83c\udfa7', cond: (s) => s.voiceNotes >= 10 },
  { key: 'first_poll', label: 'Encuestador', emoji: '\ud83d\udcca', cond: (s) => s.polls >= 1 },
  { key: 'first_sticker', label: 'Sticker fan', emoji: '\ud83c\udfa8', cond: (s) => s.stickersUsed >= 1 },
  { key: 'first_reaction', label: 'Reaccionado', emoji: '\u2764\ufe0f', cond: (s) => s.reactionsReceived >= 1 },
  { key: 'ten_reactions', label: 'Querido', emoji: '\ud83d\ude0d', cond: (s) => s.reactionsReceived >= 10 },
  { key: 'fifty_reactions', label: 'Carism\u00e1tico', emoji: '\u2728', cond: (s) => s.reactionsReceived >= 50 },
];

function metaFor(key) {
  return ACHIEVEMENTS.find((a) => a.key === key) || null;
}

// Increment one or more stat counters atomically and unlock any newly
// achievable badges. Returns the list of newly unlocked achievement keys.
async function bump(user, deltas) {
  if (!user) return [];
  user.stats = user.stats || {};
  for (const k of Object.keys(deltas)) {
    user.stats[k] = (user.stats[k] || 0) + deltas[k];
  }
  const have = new Set((user.achievements || []).map((a) => a.key));
  const newly = [];
  for (const a of ACHIEVEMENTS) {
    if (have.has(a.key)) continue;
    if (a.cond(user.stats)) {
      user.achievements.push({ key: a.key, unlockedAt: new Date() });
      newly.push(a.key);
    }
  }
  user.markModified('stats');
  user.markModified('achievements');
  await user.save();
  return newly;
}

module.exports = { ACHIEVEMENTS, metaFor, bump };
