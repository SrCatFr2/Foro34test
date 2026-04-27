// System bot for slash commands. Returns either:
//   - { kind: 'replace', text, isAction }  → modify the user's message before saving
//   - { kind: 'bot', text }                 → save user's message AND a separate bot reply
//   - { kind: 'poll', question, options }   → save the user's message as a poll
//   - { kind: 'none' }                      → no command matched
//   - null                                  → not a slash command at all
//
// The bot username is reserved (`bot` is used).

const BOT = {
  username: 'foro34bot',
  displayName: 'Foro34 Bot',
  avatarUrl: '',
  color: '#7c5cff',
  decoration: 'glow',
  effect: 'none',
  nameFont: 'default',
  bot: true,
  anonymous: false,
};

function rollDice(spec) {
  // `1d20`, `3d6+2`, `d100`, etc.
  const m = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(spec);
  if (!m) return null;
  const n = Math.max(1, Math.min(parseInt(m[1] || '1', 10), 30));
  const sides = Math.max(2, Math.min(parseInt(m[2], 10), 1000));
  const mod = parseInt(m[3] || '0', 10);
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
  const sum = rolls.reduce((a, b) => a + b, 0) + mod;
  return { rolls, mod, sum, sides, n };
}

const EIGHT_BALL = [
  'Sí, definitivamente.', 'Es cierto.', 'Sin duda.',
  'Probablemente.', 'Las señales apuntan a sí.',
  'Mejor no te lo digo ahora.', 'Pregunta de nuevo más tarde.',
  'No cuento con ello.', 'Mis fuentes dicen que no.',
  'Muy dudoso.', 'No.',
];

function help() {
  return [
    '**Comandos disponibles**',
    '`/me <accion>` — habla en tercera persona',
    '`/roll [NdS+M]` — tirada de dados (ej: /roll 2d6+1)',
    '`/coin` — cara o cruz',
    '`/8ball <pregunta>` — bola 8 mágica',
    '`/shrug` `/tableflip` `/unflip` `/lenny` — acciones rápidas',
    '`/poll Pregunta? | opción1 | opción2 | …` — crea encuesta',
    '`/ping` — comprobar latencia',
    '`/help` — esta ayuda',
    'Próximamente: `@UbreBot ...` para conversar con la IA.',
  ].join('\n');
}

function processCommand(rawText) {
  if (!rawText || rawText[0] !== '/') return null;
  const space = rawText.indexOf(' ');
  const cmd = (space === -1 ? rawText.slice(1) : rawText.slice(1, space)).toLowerCase();
  const args = space === -1 ? '' : rawText.slice(space + 1).trim();

  switch (cmd) {
    case 'me':
      if (!args) return { kind: 'none' };
      return { kind: 'replace', text: args.slice(0, 1500), isAction: true };

    case 'shrug':
      return { kind: 'replace', text: args ? `${args} ¯\\_(ツ)_/¯` : '¯\\_(ツ)_/¯', isAction: false };
    case 'tableflip':
      return { kind: 'replace', text: args ? `${args} (╯°□°）╯︵ ┻━┻` : '(╯°□°）╯︵ ┻━┻', isAction: false };
    case 'unflip':
      return { kind: 'replace', text: args ? `${args} ┬─┬ ノ( ゜-゜ノ)` : '┬─┬ ノ( ゜-゜ノ)', isAction: false };
    case 'lenny':
      return { kind: 'replace', text: args ? `${args} ( ͡° ͜ʖ ͡°)` : '( ͡° ͜ʖ ͡°)', isAction: false };

    case 'roll': {
      const r = rollDice(args || '1d20');
      if (!r) return { kind: 'bot', text: 'Formato: `/roll 2d6+1` (NdS+M).' };
      const detail = r.n > 1 ? ` (${r.rolls.join(' + ')}${r.mod ? (r.mod >= 0 ? ` + ${r.mod}` : ` - ${-r.mod}`) : ''})` : '';
      return { kind: 'bot', text: `🎲 Tiraste **${r.n}d${r.sides}** y sacaste **${r.sum}**${detail}.` };
    }

    case 'coin': {
      const r = Math.random() < 0.5 ? '🟡 Cara' : '⚪ Cruz';
      return { kind: 'bot', text: `Lancé la moneda… ${r}.` };
    }

    case '8ball': {
      if (!args) return { kind: 'bot', text: 'Pregúntale algo a la bola 8: `/8ball ¿llueve hoy?`' };
      const ans = EIGHT_BALL[Math.floor(Math.random() * EIGHT_BALL.length)];
      return { kind: 'bot', text: `🎱 *${args}* → **${ans}**` };
    }

    case 'ping':
      return { kind: 'bot', text: `🏓 pong (${new Date().toLocaleTimeString()})` };

    case 'help':
      return { kind: 'bot', text: help() };

    case 'poll': {
      if (!args.includes('|')) {
        return { kind: 'bot', text: 'Uso: `/poll Pregunta? | opción 1 | opción 2 | …` (2 a 6 opciones).' };
      }
      const parts = args.split('|').map((s) => s.trim()).filter(Boolean);
      if (parts.length < 3) {
        return { kind: 'bot', text: 'Necesitas una pregunta y al menos 2 opciones.' };
      }
      const question = parts[0].slice(0, 200);
      const options = parts.slice(1, 7).map((t) => t.slice(0, 80));
      return { kind: 'poll', question, options };
    }

    default:
      return { kind: 'bot', text: `Comando desconocido: \`/${cmd}\`. Probá \`/help\`.` };
  }
}

module.exports = { processCommand, BOT };
