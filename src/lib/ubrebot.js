// UbreBot — calls Google Gemini (preferred, faster with smaller maxOutputTokens)
// or Groq as fallback. Mentioned via "@UbreBot ..." anywhere in chat.
//
// Speed knobs:
//   - Aggressive timeout (8s default) so a slow upstream doesn't keep the user waiting forever.
//   - In-memory LRU cache by (provider, prompt) to instant-respond to repeated mentions.
//   - Lower maxOutputTokens (160) — most replies are 1-3 sentences anyway.
//
// Tone: latin-spanish, playful but not cringe, uses light emojis, never explains
// the punchline, calls out absurd questions but doesn't moralize.

const SYSTEM_PROMPT = [
  'Eres UbreBot, el bot oficial de Foro34, un chat tipo Discord en espa\u00f1ol latino.',
  'Personalidad: c\u00e1lido, sarc\u00e1stico amable, juguet\u00f3n, con humor seco. Sos como ese amigo que tira chistes pero te ayuda.',
  'Estilo: respondes en 1\u20133 oraciones cortas. Espa\u00f1ol latino casual (vos/te, "che", "dale", "posta", "qu\u00e9 onda"). Nada de tono corporativo ni "como modelo de IA".',
  'Emojis: usa 0 o 1 por respuesta. Preferidos: \ud83d\ude2c \ud83e\udd14 \ud83d\udd25 \u2728 \ud83e\udd20 \ud83d\udca9 \ud83d\ude44.',
  'Si te preguntan algo absurdo, segui la corriente con humor en vez de moralizar.',
  'NUNCA inventes datos personales de quien te habla.',
  'Si no sab\u00e9s algo, decilo con gracia.',
  'No expliques que sos una IA a menos que te pregunten directamente.',
].join(' ');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const TIMEOUT_MS = parseInt(process.env.UBREBOT_TIMEOUT_MS || '8000', 10);
const MAX_TOKENS = parseInt(process.env.UBREBOT_MAX_TOKENS || '160', 10);
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key -> { reply, exp }

function cacheKey(provider, prompt) {
  return `${provider}:${prompt.toLowerCase().replace(/\s+/g, ' ').trim()}`;
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

function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function callGemini(apiKey, prompt, userIntro) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { role: 'system', parts: [{ text: SYSTEM_PROMPT + (userIntro ? '\n' + userIntro : '') }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.85, maxOutputTokens: MAX_TOKENS, topP: 0.9 },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error('gemini failed', res.status, txt.slice(0, 300));
    return `Mi cerebro est\u00e1 con un problemita (HTTP ${res.status}). Intentalo en un toque.`;
  }
  const data = await res.json();
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const text = parts && parts.map((p) => p.text || '').join('').trim();
  return (text || 'Hmm, no se me ocurre nada \ud83d\ude05').slice(0, 1800);
}

async function callGroq(apiKey, prompt, userIntro) {
  const res = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.85,
      max_tokens: MAX_TOKENS,
      top_p: 0.9,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + (userIntro ? '\n' + userIntro : '') },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error('groq failed', res.status, txt.slice(0, 200));
    return `Mi cerebro est\u00e1 con un problemita (HTTP ${res.status}). Intentalo en un toque.`;
  }
  const data = await res.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return (content || 'Hmm, no se me ocurre nada \ud83d\ude05').slice(0, 1800);
}

async function ask(prompt, context = {}) {
  const cleaned = (prompt || '').toString().slice(0, 2000).trim();
  if (!cleaned) return 'Mencioname con una pregunta o algo que quieras decir y te respondo.';

  const userIntro = context.displayName
    ? `Te est\u00e1 hablando ${context.displayName}.`
    : '';

  // Try Groq first if available — it is significantly faster than Gemini for short replies.
  // Fall back to Gemini if Groq is missing.
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const preferGemini = process.env.UBREBOT_PROVIDER === 'gemini';

  const order = [];
  if (preferGemini && geminiKey) order.push(['gemini', () => callGemini(geminiKey, cleaned, userIntro)]);
  if (groqKey) order.push(['groq', () => callGroq(groqKey, cleaned, userIntro)]);
  if (geminiKey && !preferGemini) order.push(['gemini', () => callGemini(geminiKey, cleaned, userIntro)]);

  for (const [name, run] of order) {
    const ck = cacheKey(name, cleaned);
    const cached = fromCache(ck);
    if (cached) return cached;
    try {
      const reply = await run();
      toCache(ck, reply);
      return reply;
    } catch (err) {
      const msg = (err && err.name === 'AbortError') ? 'timeout' : (err && err.message) || 'unknown';
      console.error(`ubrebot ${name} error:`, msg);
      // try next provider
    }
  }
  if (!order.length) {
    return 'Hola, soy UbreBot. Mi cerebro a\u00fan no est\u00e1 conectado. Configur\u00e1 GROQ_API_KEY o GEMINI_API_KEY y respondo de verdad. \u2728';
  }
  return 'Se me cay\u00f3 el wifi mental, dame un toque y vuelvo a intentarlo \ud83e\udd2f';
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
