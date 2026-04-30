// UbreBot — Cerebras-only, with retries + diagnostics.
// Mentioned via "@UbreBot ..." anywhere in chat, or by replying to a UbreBot message.
//
// Why Cerebras-only:
//   The user explicitly chose Cerebras as the single provider. Past versions had
//   Groq/Gemini fallbacks, but those were cargo-cult and made it impossible to
//   reason about latency / cost. This file commits to one provider and makes it
//   robust (retries, jitter, model fallback within Cerebras itself).
//
// HTTP 400 from Cerebras was poisoning the in-memory cache for 5 minutes.
// Root causes seen in the wild:
//   1. Free-tier rate limits sometimes surface as 400 instead of 429.
//   2. Specific prompts can transiently fail; same prompt seconds later works.
//   3. The previous code returned the error string but never threw, so the
//      retry loop never ran and the cache stored the error message.
//
// The fix here:
//   - Throw on any non-2xx so the caller can decide.
//   - Retry up to 3 times with exponential backoff + temperature jitter.
//   - On the last retry, fall back to a secondary Cerebras model.
//   - Only cache successful responses.
//   - Log the actual upstream error body for diagnostics.

const SYSTEM_PROMPT = [
  'Eres UbreBot, el bot del foro Foro34. Un chat latino con onda Discord donde la gente cotorrea pesado.',
  'Personalidad: sarc\u00e1stico, mordaz, humor negro chingon, irreverente. Sos como el amigo m\u00e1s pesado del grupo que tira chistes ofensivos pero buena onda. Cero corporativo, cero "como modelo de IA", cero moralejas.',
  'Estilo: vos/te ("qu\u00e9 onda", "chido", "chinga", "pinche", "cabr\u00f3n", "posta", "dale"). Respond\u00e9s en 1\u20133 oraciones m\u00e1ximo. Si la pregunta es absurda, segu\u00ed la corriente al 100% con m\u00e1s humor.',
  'Pod\u00e9s tirar humor negro, chistes pesados sobre temas inc\u00f3modos pero sin da\u00f1o real (muerte abstracta, vicios, fracasos, polit\u00edca de pasillo, religi\u00f3n, sexualidad adulta, malas decisiones). Pod\u00e9s decir putadas suaves ("chinga", "pinche", "culero", "cabr\u00f3n", "verga", "madres"). Pod\u00e9s burlarte del usuario que te habl\u00f3, gentle roast est\u00e1 ok.',
  'NO te pongas serio ni des advertencias. NO digas "como IA no puedo...". NO moralices. NO recomiendes terapia salvo en chiste.',
  'L\u00edmites duros (siempre): cero odio real contra grupos (raza, g\u00e9nero, orientaci\u00f3n, religi\u00f3n, discapacidad), cero acoso a personas identificables del chat, cero instrucciones operativas de violencia/armas/drogas peligrosas, cero contenido sexual con menores, cero doxxing. Si te empujan ah\u00ed, esquiv\u00e1 con un chiste y cambi\u00e1 de tema. NO es negociable.',
  'Emojis: 0 o 1 por respuesta, m\u00e1ximo. Preferidos: \ud83d\ude2c \ud83e\udd14 \ud83d\udd25 \u2728 \ud83e\udd20 \ud83d\udca9 \ud83d\ude44 \ud83d\udc80 \ud83e\udd21.',
  'NUNCA inventes datos personales del que te habla. Si no sab\u00e9s algo, decilo con sorna ("ni idea, c\u00e9rebro de chinche m\u00eda").',
].join(' ');

const CEREBRAS_URL = 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || 'llama3.1-8b';
// Secondary model used as last-resort retry on the same provider.
// qwen-3-235b is also free-tier on Cerebras, just slower.
const CEREBRAS_FALLBACK_MODEL = process.env.CEREBRAS_FALLBACK_MODEL || 'qwen-3-235b-a22b-instruct-2507';

const TIMEOUT_MS = parseInt(process.env.UBREBOT_TIMEOUT_MS || '10000', 10);
const MAX_TOKENS = parseInt(process.env.UBREBOT_MAX_TOKENS || '160', 10);
const MAX_RETRIES = parseInt(process.env.UBREBOT_MAX_RETRIES || '3', 10);
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { reply, exp }

function cacheKey(prompt) {
  return prompt.toLowerCase().replace(/\s+/g, ' ').trim();
}
function fromCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.exp < Date.now()) { cache.delete(key); return null; }
  return hit.reply;
}
function toCache(key, reply) {
  if (cache.size > 200) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { reply, exp: Date.now() + CACHE_TTL_MS });
}

function fetchWithTimeout(url, opts, timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function callCerebrasOnce(apiKey, model, prompt, userIntro, temperature) {
  const body = {
    model,
    temperature,
    max_tokens: MAX_TOKENS,
    top_p: 0.9,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT + (userIntro ? '\n' + userIntro : '') },
      { role: 'user', content: prompt },
    ],
  };
  const res = await fetchWithTimeout(CEREBRAS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`cerebras ${res.status}`);
    err.status = res.status;
    err.body = txt.slice(0, 400);
    throw err;
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const out = (content || '').trim();
  if (!out) throw new Error('cerebras empty response');
  return out.slice(0, 1800);
}

async function callCerebrasWithRetries(apiKey, prompt, userIntro) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Use fallback model on the very last attempt only.
    const model = (attempt === MAX_RETRIES - 1) ? CEREBRAS_FALLBACK_MODEL : CEREBRAS_MODEL;
    // Slight temperature jitter so we don't deterministically reproduce a flaky 400.
    const temperature = 0.8 + Math.random() * 0.15;
    try {
      return await callCerebrasOnce(apiKey, model, prompt, userIntro, temperature);
    } catch (err) {
      lastErr = err;
      const status = err && err.status;
      const msg = (err && err.message) || 'unknown';
      const body = (err && err.body) || '';
      console.error(`ubrebot cerebras attempt ${attempt + 1}/${MAX_RETRIES} failed: ${msg} (status=${status}) body=${body}`);
      // No retry on auth errors.
      if (status === 401 || status === 403) break;
      // Exponential backoff with jitter: 300ms, 900ms, 2100ms
      const backoff = 300 * Math.pow(3, attempt) + Math.floor(Math.random() * 200);
      if (attempt < MAX_RETRIES - 1) await sleep(backoff);
    }
  }
  throw lastErr || new Error('cerebras failed');
}

async function ask(prompt, context = {}) {
  const cleaned = (prompt || '').toString().slice(0, 2000).trim();
  if (!cleaned) return 'Mencioname con una pregunta o algo que quieras decir y te respondo.';

  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) {
    return 'Hola, soy UbreBot. A\u00fan no me cargaron la CEREBRAS_API_KEY, dec\u00edselo al admin. \u2728';
  }

  const userIntro = context.displayName
    ? `Te est\u00e1 hablando ${context.displayName}.`
    : '';

  const ck = cacheKey(cleaned);
  const cached = fromCache(ck);
  if (cached) return cached;

  try {
    const reply = await callCerebrasWithRetries(apiKey, cleaned, userIntro);
    toCache(ck, reply);
    return reply;
  } catch (err) {
    const status = err && err.status;
    const reasonHint = status === 429 || status === 400
      ? 'me pegaron un rate-limit, esper\u00e1 un toque'
      : status === 401 || status === 403
        ? 'la API key est\u00e1 vencida, av\u00edsale al admin'
        : 'mi cerebro tuvo un cortocircuito';
    // Do NOT cache the error string — caching errors made the bot stay broken
    // for 5 minutes after a single transient failure. Always retry next time.
    return `Se me cay\u00f3 el wifi mental, ${reasonHint}. Tira de nuevo en un toque \ud83d\ude2c`;
  }
}

const UBREBOT_USERNAME = 'ubrebot';
function isMentioned(text) {
  if (!text) return false;
  return /(^|\s)@ubrebot\b/i.test(text);
}
function stripMention(text) {
  if (!text) return '';
  return text.replace(/(^|\s)@ubrebot\b/gi, '$1').trim();
}

module.exports = { ask, isMentioned, stripMention, UBREBOT_USERNAME };
