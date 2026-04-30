// Spotify + Brawl Stars integrations.
//
// Spotify: standard OAuth Authorization Code flow. Tokens stored on the user
// doc and refreshed on demand. Public endpoint exposes only "now playing"
// (current track or last-played) and a profile chip.
//
// Brawl Stars: no OAuth — user pastes their player tag (#XXXXX) and we hit
// the official Brawl Stars API to validate and snapshot stats. Cached for
// PROFILE_CACHE_TTL_MS to avoid rate-limit thrashing.

const express = require('express');
const crypto = require('crypto');
const User = require('../models/User');
const { connectDB } = require('../lib/db');
const { authRequired } = require('../lib/auth');

const router = express.Router();

// ------------------------------------------------------------------
// Spotify
// ------------------------------------------------------------------
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const SPOTIFY_SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-read-playback-state',
].join(' ');

function spotifyConfigured() {
  return !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

function spotifyRedirectUri(req) {
  // Allow override via env (production), otherwise mirror the host that
  // Express received the request on. This keeps localhost dev working.
  if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI;
  const proto = req.protocol;
  const host = req.get('host');
  return `${proto}://${host}/api/integrations/spotify/callback`;
}

router.get('/spotify/status', async (req, res) => {
  res.json({
    configured: spotifyConfigured(),
    clientId: spotifyConfigured() ? process.env.SPOTIFY_CLIENT_ID : '',
  });
});

// Begin OAuth: redirect to Spotify with state cookie.
router.get('/spotify/connect', authRequired, async (req, res) => {
  if (!spotifyConfigured()) {
    return res.status(503).json({ error: 'Spotify no está configurado en el servidor' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  // Stash userId in a signed cookie so we know who is connecting on callback.
  res.cookie('spotify_oauth', JSON.stringify({ state, uid: req.user.id }), {
    httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', maxAge: 10 * 60 * 1000,
  });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES,
    redirect_uri: spotifyRedirectUri(req),
    state,
  });
  res.redirect(`${SPOTIFY_AUTH_URL}?${params.toString()}`);
});

// OAuth callback: exchange code for tokens, fetch profile, save.
router.get('/spotify/callback', async (req, res) => {
  if (!spotifyConfigured()) return res.status(503).send('Spotify no configurado');
  const { code, state, error } = req.query;
  let payload;
  try { payload = JSON.parse(req.cookies.spotify_oauth || '{}'); } catch (_e) { payload = {}; }
  res.clearCookie('spotify_oauth');
  if (error) return res.redirect(`/profile?spotify=error&reason=${encodeURIComponent(error)}`);
  if (!code || !state || state !== payload.state || !payload.uid) {
    return res.redirect('/profile?spotify=error&reason=state');
  }
  try {
    const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: spotifyRedirectUri(req),
      }),
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      console.error('spotify token exchange failed', tokenRes.status, txt);
      return res.redirect('/profile?spotify=error&reason=token');
    }
    const tok = await tokenRes.json();

    const meRes = await fetch(`${SPOTIFY_API_BASE}/me`, {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    if (!meRes.ok) return res.redirect('/profile?spotify=error&reason=me');
    const me = await meRes.json();

    await connectDB();
    const user = await User.findById(payload.uid);
    if (!user) return res.redirect('/profile?spotify=error&reason=user');

    user.integrations = user.integrations || {};
    user.integrations.spotify = {
      connected: true,
      spotifyId: me.id,
      displayName: me.display_name || me.id,
      profileUrl: (me.external_urls && me.external_urls.spotify) || '',
      avatarUrl: (me.images && me.images[0] && me.images[0].url) || '',
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || (user.integrations.spotify && user.integrations.spotify.refreshToken) || '',
      expiresAt: new Date(Date.now() + (tok.expires_in - 60) * 1000),
      scope: tok.scope || '',
    };
    user.markModified('integrations');
    await user.save();
    return res.redirect('/profile?spotify=ok');
  } catch (err) {
    console.error('spotify callback failed', err);
    return res.redirect('/profile?spotify=error&reason=exception');
  }
});

router.post('/spotify/disconnect', authRequired, async (req, res) => {
  await connectDB();
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  user.integrations = user.integrations || {};
  user.integrations.spotify = { connected: false };
  user.markModified('integrations');
  await user.save();
  res.json({ ok: true });
});

async function refreshSpotifyToken(user) {
  if (!user.integrations || !user.integrations.spotify || !user.integrations.spotify.refreshToken) {
    return null;
  }
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${basic}` },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user.integrations.spotify.refreshToken,
    }),
  });
  if (!r.ok) {
    console.warn('spotify refresh failed', r.status);
    return null;
  }
  const tok = await r.json();
  user.integrations.spotify.accessToken = tok.access_token;
  user.integrations.spotify.expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000);
  if (tok.refresh_token) user.integrations.spotify.refreshToken = tok.refresh_token;
  if (tok.scope) user.integrations.spotify.scope = tok.scope;
  user.markModified('integrations');
  await user.save();
  return tok.access_token;
}

async function ensureSpotifyToken(user) {
  const sp = user.integrations && user.integrations.spotify;
  if (!sp || !sp.connected || !sp.accessToken) return null;
  const exp = sp.expiresAt ? new Date(sp.expiresAt).getTime() : 0;
  if (Date.now() >= exp) return refreshSpotifyToken(user);
  return sp.accessToken;
}

// Public — anyone can see what a user is listening to (only what they
// connected with their account; if they don't want to share, they disconnect).
router.get('/spotify/now-playing/:username', async (req, res) => {
  try {
    await connectDB();
    const user = await User.findOne({ username: String(req.params.username).toLowerCase() });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const sp = user.integrations && user.integrations.spotify;
    if (!sp || !sp.connected) return res.json({ connected: false });

    const token = await ensureSpotifyToken(user);
    if (!token) return res.json({ connected: true, error: 'token' });

    // Try /me/player/currently-playing first.
    let trackData = null;
    let isPlaying = false;
    const cur = await fetch(`${SPOTIFY_API_BASE}/me/player/currently-playing`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (cur.status === 200) {
      const j = await cur.json();
      if (j && j.item) {
        trackData = j.item;
        isPlaying = !!j.is_playing;
      }
    }
    // Fall back to recently-played for the chip when nothing is on.
    if (!trackData) {
      const rp = await fetch(`${SPOTIFY_API_BASE}/me/player/recently-played?limit=1`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (rp.ok) {
        const j = await rp.json();
        if (j && j.items && j.items[0] && j.items[0].track) {
          trackData = j.items[0].track;
          isPlaying = false;
        }
      }
    }
    if (!trackData) {
      return res.json({
        connected: true, isPlaying: false, track: null,
        profile: { displayName: sp.displayName, profileUrl: sp.profileUrl, avatarUrl: sp.avatarUrl },
      });
    }
    const track = {
      id: trackData.id || '',
      name: trackData.name,
      url: (trackData.external_urls && trackData.external_urls.spotify) || '',
      artists: (trackData.artists || []).map((a) => ({ name: a.name, url: (a.external_urls && a.external_urls.spotify) || '' })),
      album: trackData.album && { name: trackData.album.name, image: (trackData.album.images && trackData.album.images[0] && trackData.album.images[0].url) || '' },
      durationMs: trackData.duration_ms || 0,
      previewUrl: trackData.preview_url || '',
    };
    res.json({
      connected: true, isPlaying, track,
      profile: { displayName: sp.displayName, profileUrl: sp.profileUrl, avatarUrl: sp.avatarUrl },
    });
  } catch (err) {
    console.error('spotify now-playing failed', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ------------------------------------------------------------------
// Brawl Stars
// ------------------------------------------------------------------
// Use the RoyaleAPI proxy by default — it forwards from a fixed IP that the
// user only needs to whitelist once when they create their dev key. This lets
// us call from any (serverless) environment without IP whitelisting per host.
const BS_BASE = process.env.BRAWLSTARS_API_BASE || 'https://bsproxy.royaleapi.dev/v1';
const BS_CACHE_TTL_MS = 5 * 60 * 1000;

function brawlStarsConfigured() {
  return !!process.env.BRAWLSTARS_API_KEY;
}

function normalizeBsTag(raw) {
  // Strip leading #, uppercase, trim. Map common look-alikes (O→0).
  let t = String(raw || '').trim().toUpperCase().replace(/^#/, '');
  t = t.replace(/O/g, '0'); // common OCR/typo
  if (!/^[0289PYLQGRJCUV]{3,15}$/.test(t)) return null;
  return `#${t}`;
}

async function fetchBsPlayer(tag) {
  if (!brawlStarsConfigured()) {
    const e = new Error('Brawl Stars API key not configured'); e.status = 503; throw e;
  }
  const encoded = encodeURIComponent(tag); // -> %23TAG
  const r = await fetch(`${BS_BASE}/players/${encoded}`, {
    headers: { authorization: `Bearer ${process.env.BRAWLSTARS_API_KEY}` },
  });
  if (r.status === 404) {
    const e = new Error('Tag no encontrado en Brawl Stars'); e.status = 404; throw e;
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    console.warn('bs api failed', r.status, txt.slice(0, 200));
    const e = new Error('Brawl Stars API error'); e.status = r.status; throw e;
  }
  return r.json();
}

// Build the integration snapshot stored on the user. Centralizes the shape so
// connect / refresh / public-cache-refresh all agree.
function buildBsSnapshot(tag, data) {
  const brawlers = Array.isArray(data.brawlers) ? data.brawlers : [];
  const topBrawlers = brawlers
    .slice()
    .sort((a, b) => (b.trophies || 0) - (a.trophies || 0))
    .slice(0, 5)
    .map((b) => ({
      id: b.id || 0,
      name: b.name || '',
      power: b.power || 0,
      rank: b.rank || 0,
      trophies: b.trophies || 0,
      highestTrophies: b.highestTrophies || 0,
    }));
  return {
    connected: true,
    tag,
    name: data.name || '',
    trophies: data.trophies || 0,
    highestTrophies: data.highestTrophies || 0,
    expLevel: data.expLevel || 0,
    brawlersUnlocked: brawlers.length,
    threeVsThreeVictories: data['3vs3Victories'] || data.threeVsThreeVictories || 0,
    soloVictories: data.soloVictories || 0,
    duoVictories: data.duoVictories || 0,
    club: data.club ? { tag: data.club.tag || '', name: data.club.name || '' } : { tag: '', name: '' },
    iconId: (data.icon && data.icon.id) || 0,
    topBrawlers,
    fetchedAt: new Date(),
  };
}

router.post('/brawlstars/connect', authRequired, async (req, res) => {
  try {
    const tag = normalizeBsTag(req.body && req.body.tag);
    if (!tag) return res.status(400).json({ error: 'Tag inválido' });
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const data = await fetchBsPlayer(tag);
    user.integrations = user.integrations || {};
    user.integrations.brawlStars = buildBsSnapshot(tag, data);
    user.markModified('integrations');
    await user.save();
    res.json({ ok: true, brawlStars: user.toPublicJSON().integrations.brawlStars });
  } catch (err) {
    console.error('bs connect failed', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed' });
  }
});

router.post('/brawlstars/disconnect', authRequired, async (req, res) => {
  await connectDB();
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  user.integrations = user.integrations || {};
  user.integrations.brawlStars = { connected: false };
  user.markModified('integrations');
  await user.save();
  res.json({ ok: true });
});

router.post('/brawlstars/refresh', authRequired, async (req, res) => {
  try {
    await connectDB();
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const bs = user.integrations && user.integrations.brawlStars;
    if (!bs || !bs.connected || !bs.tag) return res.status(400).json({ error: 'Not connected' });
    const data = await fetchBsPlayer(bs.tag);
    user.integrations.brawlStars = buildBsSnapshot(bs.tag, data);
    user.markModified('integrations');
    await user.save();
    res.json({ ok: true, brawlStars: user.toPublicJSON().integrations.brawlStars });
  } catch (err) {
    console.error('bs refresh failed', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed' });
  }
});

// Public — refreshes from API if cache is stale.
router.get('/brawlstars/profile/:username', async (req, res) => {
  try {
    await connectDB();
    const user = await User.findOne({ username: String(req.params.username).toLowerCase() });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const bs = user.integrations && user.integrations.brawlStars;
    if (!bs || !bs.connected || !bs.tag) return res.json({ connected: false });

    const fetchedAt = bs.fetchedAt ? new Date(bs.fetchedAt).getTime() : 0;
    const stale = Date.now() - fetchedAt > BS_CACHE_TTL_MS;
    if (stale && brawlStarsConfigured()) {
      try {
        const data = await fetchBsPlayer(bs.tag);
        user.integrations.brawlStars = buildBsSnapshot(bs.tag, data);
        user.markModified('integrations');
        await user.save();
      } catch (e) {
        // soft fail — return last cached snapshot
        console.warn('bs background refresh failed', e.message);
      }
    }
    const out = user.toPublicJSON().integrations.brawlStars;
    res.json({ connected: true, ...out });
  } catch (err) {
    console.error('bs profile failed', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/brawlstars/status', (req, res) => {
  res.json({ configured: brawlStarsConfigured() });
});

module.exports = router;
