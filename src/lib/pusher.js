const Pusher = require('pusher');

let instance = null;

function getPusher() {
  if (instance) return instance;
  const trim = (v) => (v == null ? v : String(v).trim());
  const appId = trim(process.env.PUSHER_APP_ID);
  const key = trim(process.env.PUSHER_KEY);
  const secret = trim(process.env.PUSHER_SECRET);
  const cluster = trim(process.env.PUSHER_CLUSTER);
  if (!appId || !key || !secret || !cluster) return null;
  instance = new Pusher({ appId, key, secret, cluster, useTLS: true });
  return instance;
}

// Returns a status string useful for diagnostics:
//   'ok'         — trigger succeeded
//   'skipped'    — server not configured
//   'error: ...' — trigger threw
async function broadcast(channel, event, data) {
  const p = getPusher();
  if (!p) return 'skipped';
  try {
    await p.trigger(channel, event, data);
    return 'ok';
  } catch (err) {
    console.error('pusher trigger failed', err && err.message, err && err.stack);
    return 'error: ' + (err && err.message ? err.message : 'unknown');
  }
}

// Authorize a private/presence channel subscription. Throws if Pusher
// is not configured.
function authorizeChannel({ socketId, channel, presenceData }) {
  const p = getPusher();
  if (!p) return null;
  if (channel.startsWith('presence-')) {
    return p.authorizeChannel(socketId, channel, presenceData);
  }
  return p.authorizeChannel(socketId, channel);
}

module.exports = { getPusher, broadcast, authorizeChannel };
