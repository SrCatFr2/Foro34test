const crypto = require('crypto');

// Stable per-(IP+UA) opaque ID so anonymous users can react / vote / edit
// their own things without exposing IP or needing accounts.
function anonIdFor(req) {
  const ip = (req.headers['x-forwarded-for'] || req.ip || 'anon').toString().split(',')[0].trim();
  const ua = (req.headers['user-agent'] || '').toString();
  return crypto.createHash('sha256').update(`${ip}|${ua}`).digest('hex').slice(0, 24);
}

function anonNameFor(req) {
  const id = anonIdFor(req);
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `Anon-${Math.abs(h) % 9000 + 1000}`;
}

module.exports = { anonIdFor, anonNameFor };
