/* global Pusher */

(() => {
  const state = {
    me: null,
    config: null,
    pusher: null,
    channel: null,
    presenceChannel: null,
    privateChannel: null,
    pendingFile: null,
    room: 'global',
    seen: new Set(),
    messages: new Map(),
    replyTo: null,
    editing: null,
    online: new Map(),
    typing: new Map(),
    notifications: [],
    servers: [],          // user's servers
    activeServer: null,   // server object, null = global
    activeChannel: null,  // channel id within active server
    dms: [],              // dm threads
    activeDm: null,       // { room, with: {...} } when in a DM
    stickers: [],         // user's stickers
    voice: { recorder: null, chunks: [], started: 0, stream: null, timerId: 0 },
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHTML(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Lightweight, intentionally-tiny markdown for bios. We HTML-escape first
  // so user content cannot inject tags, then unescape only the recognised
  // patterns into safe wrappers.
  function renderBioMarkdown(str) {
    if (!str) return '';
    let s = escapeHTML(str);
    // Links: [label](https://...)  http(s) only.
    s = s.replace(/\[([^\]]{1,80})\]\((https?:\/\/[^\s)]{1,200})\)/g,
      (_m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    // Bold then italic (greedy-safe-ish for short bios).
    s = s.replace(/\*\*([^*\n]{1,200})\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]{1,200})\*(?!\*)/g, '$1<em>$2</em>');
    // Inline code.
    s = s.replace(/`([^`\n]{1,120})`/g, '<code>$1</code>');
    // Paragraphs from blank lines, single newlines -> <br>.
    const paragraphs = s.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`);
    return paragraphs.join('');
  }

  const DECORATIONS = [
    'none', 'neon', 'fire', 'rainbow', 'stars', 'glow', 'gold', 'aurora', 'ice', 'shadow',
    'galaxy', 'sakura', 'cyber', 'royal', 'ocean', 'crown', 'halo', 'ember', 'lightning', 'matrix',
  ];
  const EFFECTS = [
    'none', 'pulse', 'sparkle', 'wave', 'shake',
    'glitch', 'rainbowHue', 'float', 'confetti', 'glow',
  ];
  const NAME_FONTS = ['default', 'pixel', 'serif', 'mono', 'cursive', 'marker', 'retro', 'fancy'];
  const DECO_LABELS = {
    none: 'Ninguna', neon: 'Neón', fire: 'Fuego', rainbow: 'Arcoíris',
    stars: 'Estrellas', glow: 'Brillo', gold: 'Oro', aurora: 'Aurora',
    ice: 'Hielo', shadow: 'Sombra',
    galaxy: 'Galaxia', sakura: 'Sakura', cyber: 'Cyberpunk', royal: 'Real',
    ocean: 'Océano', crown: 'Corona', halo: 'Halo', ember: 'Brasa',
    lightning: 'Rayo', matrix: 'Matrix',
  };
  const EFFECT_LABELS = {
    none: 'Ninguno', pulse: 'Pulso', sparkle: 'Chispas', wave: 'Onda', shake: 'Temblor',
    glitch: 'Glitch', rainbowHue: 'Arcoíris', float: 'Flotar', confetti: 'Confeti', glow: 'Resplandor',
  };
  const FONT_LABELS = {
    default: 'Aa Default', pixel: 'PIXEL', serif: 'Aa Serif', mono: '> mono',
    cursive: 'Aa Caveat', marker: 'Marker', retro: 'RETRO', fancy: 'Pacifico',
  };
  const QUICK_REACTIONS = ['👍', '❤️', '😂', '🔥', '🎉', '😮', '😢', '👀'];
  const COMMANDS = [
    { name: '/help', hint: 'lista de comandos' },
    { name: '/me', hint: 'acción en tercera persona' },
    { name: '/roll', hint: 'tirada de dados (NdS+M)' },
    { name: '/coin', hint: 'cara o cruz' },
    { name: '/8ball', hint: 'bola 8 mágica' },
    { name: '/poll', hint: 'crea encuesta: pregunta | A | B | …' },
    { name: '/shrug', hint: '¯\\_(ツ)_/¯' },
    { name: '/tableflip', hint: '(╯°□°）╯︵ ┻━┻' },
    { name: '/unflip', hint: '┬─┬ ノ( ゜-゜ノ)' },
    { name: '/lenny', hint: '( ͡° ͜ʖ ͡°)' },
    { name: '/ping', hint: 'comprueba latencia' },
  ];
  function decoClass(name) {
    return name && DECORATIONS.includes(name) && name !== 'none' ? `deco-wrap deco-${name}` : '';
  }
  function fontClass(name) {
    return name && NAME_FONTS.includes(name) ? `font-${name}` : 'font-default';
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  }

  async function api(path, options = {}) {
    const opts = { credentials: 'include', ...options };
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body === 'object') {
      opts.headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (_e) { /* ignore */ }
    if (!res.ok) {
      const msg = (data && data.error) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ----- Routing -----
  function go(path, replace = false) {
    if (replace) history.replaceState({}, '', path);
    else history.pushState({}, '', path);
    render();
  }

  function currentRoute() {
    const p = location.pathname;
    if (p === '/' || p === '') return '/';
    if (p === '/login') return '/login';
    if (p === '/register') return '/register';
    if (p === '/profile') return '/profile';
    if (p.startsWith('/u/')) return '/profile';
    return '/';
  }

  function render() {
    const route = currentRoute();
    $$('.view').forEach((v) => v.classList.add('hidden'));
    const target = $(`[data-view="${route}"]`);
    if (target) target.classList.remove('hidden');
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.route === route));

    if (route === '/') initChatView();
    if (route === '/profile') renderProfileView();
  }

  // ----- Auth UI -----
  function applyAuthUI() {
    const isAuth = Boolean(state.me);
    $$('[data-show-when="anon"]').forEach((el) => el.classList.toggle('hidden', isAuth));
    $$('[data-show-when="auth"]').forEach((el) => el.classList.toggle('hidden', !isAuth));
    $$('.js-only-auth').forEach((el) => el.classList.toggle('hidden', !isAuth));
    if (isAuth) {
      const a = $('.me-avatar');
      if (a) {
        a.src = state.me.avatarUrl || avatarFallback(state.me.displayName);
        a.onerror = () => { a.src = avatarFallback(state.me.displayName); };
        // Apply decoration to the dedicated avatar wrapper around the IMG only.
        const wrap = a.closest('.me-avatar-wrap') || a.parentElement;
        if (wrap) {
          DECORATIONS.forEach((d) => wrap.classList.remove(`deco-${d}`));
          wrap.classList.remove('deco-wrap');
          if (state.me.decoration && state.me.decoration !== 'none') {
            wrap.classList.add('deco-wrap', `deco-${state.me.decoration}`);
          }
        }
      }
      $$('[data-bind="me.displayName"]').forEach((e) => (e.textContent = state.me.displayName));
      $$('[data-bind="me.username"]').forEach((e) => (e.textContent = state.me.username));
    }
  }

  function avatarFallback(name) {
    const letter = encodeURIComponent((name || '?').charAt(0).toUpperCase());
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%237c5cff'/%3E%3Ctext x='50%25' y='52%25' text-anchor='middle' font-size='32' font-family='sans-serif' fill='white' dominant-baseline='middle'%3E${letter}%3C/text%3E%3C/svg%3E`;
  }

  // ----- Chat -----
  function initChatView() {
    if (initChatView.done) return;
    initChatView.done = true;
    loadMessages();
    setupRealtime();
  }

  async function loadMessages() {
    try {
      const data = await api(`/api/messages?limit=50&room=${encodeURIComponent(state.room)}`);
      const list = $('#messages');
      list.innerHTML = '';
      state.seen.clear();
      data.messages.forEach((m) => appendMessage(m, false));
      scrollToBottom();
    } catch (err) {
      console.error('load messages', err);
      const list = $('#messages');
      list.innerHTML = `<div class="muted">Error cargando mensajes: ${escapeHTML(err.message)}</div>`;
    }
  }

  // Highlight @mentions in already-escaped text. Mentions to *me* get a special class.
  function renderTextWithMentions(text) {
    if (!text) return '';
    const escaped = escapeHTML(text);
    const myUser = state.me && state.me.username;
    return escaped.replace(/@([a-z0-9_]{3,24})/gi, (_m, name) => {
      const lower = name.toLowerCase();
      const cls = myUser && lower === myUser.toLowerCase() ? 'mention me' : 'mention';
      return `<a class="${cls}" href="/u/${encodeURIComponent(lower)}" data-username="${escapeHTML(lower)}">@${escapeHTML(name)}</a>`;
    });
  }

  function isOwnMessage(m) {
    if (!m || !m.author) return false;
    if (state.me) return m.author.userId === state.me.id;
    // Anonymous: server sends back our hashed anonOwner; client doesn't know it,
    // so we mark messages we just sent as own via state.ownAnonIds.
    return !!(m.anonOwner && state.ownAnonIds && state.ownAnonIds.has(m.anonOwner));
  }

  function renderReactions(m) {
    if (!m.reactions || m.reactions.length === 0) return '';
    const myId = state.me ? state.me.id : null;
    const myAnon = state.myAnonId || '';
    const chips = m.reactions.map((r) => {
      const mine = (myId && r.userIds.includes(myId)) || (myAnon && r.anonIds.includes(myAnon));
      return `<button class="reaction ${mine ? 'mine' : ''}" data-emoji="${escapeHTML(r.emoji)}" type="button"><span>${escapeHTML(r.emoji)}</span><span class="count">${r.count}</span></button>`;
    }).join('');
    return `<div class="reactions">${chips}<button class="reaction add" data-add="1" type="button" title="Agregar reacción">+</button></div>`;
  }

  function renderPoll(m) {
    if (!m.poll) return '';
    const total = m.poll.options.reduce((s, o) => s + o.count, 0);
    const myId = state.me ? state.me.id : null;
    const myAnon = state.myAnonId || '';
    const opts = m.poll.options.map((o, i) => {
      const pct = total ? Math.round((o.count / total) * 100) : 0;
      const mine = (myId && o.voterIds.includes(myId)) || (myAnon && o.voterAnonIds.includes(myAnon));
      return `<button class="poll-opt ${mine ? 'mine' : ''}" data-vote="${i}" type="button">
        <span class="poll-bar" style="width:${pct}%"></span>
        <span class="poll-text">${escapeHTML(o.text)}</span>
        <span class="poll-pct">${o.count} · ${pct}%</span>
      </button>`;
    }).join('');
    return `<div class="poll-card">
      <div class="poll-q">📊 ${escapeHTML(m.poll.question)}</div>
      <div class="poll-opts">${opts}</div>
      <div class="poll-meta">${total} voto${total === 1 ? '' : 's'}</div>
    </div>`;
  }

  function renderReplyPreview(rt) {
    if (!rt) return '';
    const snippet = rt.snippet ? escapeHTML(rt.snippet) : (rt.snippetImage ? '🖼️ imagen' : '');
    return `<div class="msg-reply-preview" data-jump="${escapeHTML(rt.id || '')}" style="border-color:${escapeHTML(rt.authorColor || '#555')}">
      <span class="reply-name" style="color:${escapeHTML(rt.authorColor || '#aaa')}">↪ ${escapeHTML(rt.authorDisplayName || '')}</span>
      <span class="reply-snip">${snippet}</span>
    </div>`;
  }

  function appendMessage(m, animate = true) {
    if (state.seen.has(m.id)) return;
    state.seen.add(m.id);
    state.messages.set(m.id, m);
    const list = $('#messages');
    const wrap = document.createElement('div');
    wrap.dataset.msgId = m.id;
    renderMessageInto(wrap, m);
    if (animate) wrap.style.animation = 'fadeIn .15s ease';
    list.appendChild(wrap);
    scrollToBottom();
  }

  function updateMessage(m) {
    state.messages.set(m.id, m);
    const list = $('#messages');
    const existing = list.querySelector(`[data-msg-id="${m.id}"]`);
    if (!existing) return appendMessage(m);
    renderMessageInto(existing, m);
  }

  function renderMessageInto(wrap, m) {
    const a = m.author || {};
    const isAction = !!m.isAction;
    const isSystem = m.kind === 'system';
    const isPoll = m.kind === 'poll';
    const isDeleted = !!m.deletedAt;
    const isMine = isOwnMessage(m);
    wrap.className = 'msg' + (isAction ? ' is-action' : '') + (isSystem ? ' is-system' : '') + (isMine ? ' is-mine' : '');
    const avatar = a.avatarUrl
      ? `<img src="${escapeHTML(a.avatarUrl)}" alt="" />`
      : (a.bot ? '🤖' : escapeHTML((a.displayName || '?').charAt(0).toUpperCase()));
    const nameClass = `${a.anonymous ? 'msg-name anon' : 'msg-name clickable'} ${fontClass(a.nameFont)}`;
    const nameAttrs = a.anonymous ? '' : `data-username="${escapeHTML(a.username || '')}"`;
    const dClass = decoClass(a.decoration);
    const botBadge = a.bot ? '<span class="bot-badge">BOT</span>' : '';
    const editedBadge = m.editedAt ? '<span class="edited-badge" title="editado">(editado)</span>' : '';
    const replyHtml = renderReplyPreview(m.replyTo);
    let body;
    if (isDeleted) {
      body = '<div class="msg-text deleted">— mensaje eliminado —</div>';
    } else if (isPoll) {
      body = renderPoll(m);
    } else {
      const txt = m.text ? `<div class="msg-text${isAction ? ' action' : ''}">${renderTextWithMentions(m.text)}</div>` : '';
      const img = m.imageUrl ? `<img class="msg-image" src="${escapeHTML(m.imageUrl)}" alt="image" />` : '';
      const audio = m.audioUrl
        ? `<div class="msg-audio"><audio controls preload="metadata" src="${escapeHTML(m.audioUrl)}"></audio>${m.audioDuration ? `<span class="duration">${formatDuration(m.audioDuration)}</span>` : ''}</div>`
        : '';
      const sticker = m.sticker && m.sticker.url
        ? `<img class="msg-sticker" src="${escapeHTML(m.sticker.url)}" alt="${escapeHTML(m.sticker.name || 'sticker')}" title="${escapeHTML(m.sticker.name || '')}" />`
        : '';
      body = `${replyHtml}${txt}${img}${audio}${sticker}${renderReactions(m)}`;
    }
    const actions = isDeleted ? '' : `
      <div class="msg-actions">
        <button class="msg-act" data-act="react" title="Reaccionar">😊</button>
        <button class="msg-act" data-act="reply" title="Responder">↪</button>
        ${isMine && !isSystem && !isPoll ? '<button class="msg-act" data-act="edit" title="Editar">✏️</button>' : ''}
        ${isMine ? '<button class="msg-act" data-act="delete" title="Borrar">🗑️</button>' : ''}
        ${state.me && !isMine ? '<button class="msg-act" data-act="pin" title="Pinear en mi perfil">📌</button>' : ''}
      </div>`;
    wrap.innerHTML = `
      <div class="msg-avatar ${dClass}" style="background:${escapeHTML(a.color || '#7c5cff')}">${avatar}</div>
      <div class="msg-body">
        <div class="msg-head">
          <span class="${nameClass}" ${nameAttrs} style="color:${escapeHTML(a.color || '#fff')}">${escapeHTML(a.displayName || 'Anon')}</span>
          ${botBadge}
          <span class="msg-time">${fmtTime(m.createdAt)}</span>
          ${editedBadge}
        </div>
        ${body}
      </div>
      ${actions}`;
    bindMessageEvents(wrap, m);
  }

  function bindMessageEvents(wrap, m) {
    const a = m.author || {};
    if (!a.anonymous && a.username) {
      const nameEl = wrap.querySelector('.msg-name');
      if (nameEl) nameEl.addEventListener('click', () => go(`/u/${a.username}`));
    }
    const img = wrap.querySelector('.msg-image');
    if (img) img.addEventListener('click', () => window.open(m.imageUrl, '_blank'));
    wrap.querySelectorAll('.mention').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const u = el.dataset.username;
        if (u) go(`/u/${u}`);
      });
    });
    wrap.querySelectorAll('.reaction').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.add) openReactionPicker(m.id, btn);
        else toggleReaction(m.id, btn.dataset.emoji);
      });
    });
    wrap.querySelectorAll('.poll-opt').forEach((btn) => {
      btn.addEventListener('click', () => votePoll(m.id, parseInt(btn.dataset.vote, 10)));
    });
    wrap.querySelectorAll('.msg-act').forEach((btn) => {
      const act = btn.dataset.act;
      btn.addEventListener('click', () => {
        if (act === 'react') openReactionPicker(m.id, btn);
        else if (act === 'reply') startReply(m);
        else if (act === 'edit') startEdit(m);
        else if (act === 'delete') deleteMessage(m.id);
        else if (act === 'pin') pinMessage(m.id);
      });
    });
    const replyJump = wrap.querySelector('.msg-reply-preview');
    if (replyJump && replyJump.dataset.jump) {
      replyJump.addEventListener('click', () => {
        const target = $(`[data-msg-id="${replyJump.dataset.jump}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('flash');
          setTimeout(() => target.classList.remove('flash'), 1200);
        }
      });
    }
  }

  async function toggleReaction(msgId, emoji) {
    try {
      const data = await api(`/api/messages/${msgId}/reactions`, { method: 'POST', body: { emoji } });
      if (data && data.message) updateMessage(data.message);
    } catch (err) { console.warn('react', err); }
  }

  function openReactionPicker(msgId, anchorBtn) {
    closeReactionPicker();
    const picker = document.createElement('div');
    picker.className = 'reaction-picker';
    picker.innerHTML = QUICK_REACTIONS.map((e) => `<button type="button" data-e="${escapeHTML(e)}">${escapeHTML(e)}</button>`).join('') +
      '<input type="text" class="emoji-input" placeholder="otro" maxlength="4" />';
    document.body.appendChild(picker);
    const r = anchorBtn.getBoundingClientRect();
    picker.style.top = `${r.top + window.scrollY - picker.offsetHeight - 4}px`;
    picker.style.left = `${Math.min(window.innerWidth - 220, r.left)}px`;
    picker.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { toggleReaction(msgId, b.dataset.e); closeReactionPicker(); });
    });
    const inp = picker.querySelector('.emoji-input');
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && inp.value.trim()) {
        toggleReaction(msgId, inp.value.trim());
        closeReactionPicker();
      }
    });
    setTimeout(() => document.addEventListener('click', closeReactionPickerOutside, { once: true }), 0);
    state._reactionPicker = picker;
  }
  function closeReactionPicker() {
    if (state._reactionPicker) { state._reactionPicker.remove(); state._reactionPicker = null; }
  }
  function closeReactionPickerOutside(e) {
    if (!state._reactionPicker) return;
    if (!state._reactionPicker.contains(e.target)) closeReactionPicker();
    else setTimeout(() => document.addEventListener('click', closeReactionPickerOutside, { once: true }), 0);
  }

  async function votePoll(msgId, optionIndex) {
    try {
      const data = await api(`/api/messages/${msgId}/poll/vote`, { method: 'POST', body: { optionIndex } });
      if (data && data.message) updateMessage(data.message);
    } catch (err) { console.warn('vote', err); }
  }

  async function deleteMessage(msgId) {
    if (!confirm('¿Borrar este mensaje?')) return;
    try {
      const data = await api(`/api/messages/${msgId}`, { method: 'DELETE' });
      if (data && data.message) updateMessage(data.message);
    } catch (err) { alert('Error: ' + err.message); }
  }

  function startReply(m) {
    state.replyTo = m;
    state.editing = null;
    showComposerBanner();
    $('#textInput').focus();
  }
  function startEdit(m) {
    state.editing = m;
    state.replyTo = null;
    $('#textInput').value = m.text || '';
    showComposerBanner();
    $('#textInput').focus();
  }
  function cancelComposerMode() {
    state.replyTo = null;
    state.editing = null;
    showComposerBanner();
    if (state._editOriginalText !== undefined) {
      $('#textInput').value = '';
      state._editOriginalText = undefined;
    }
  }
  function showComposerBanner() {
    const banner = $('#composerBanner');
    if (!banner) return;
    if (state.editing) {
      banner.innerHTML = `<span>Editando mensaje · </span><button type="button" id="cancelMode">cancelar</button>`;
      banner.classList.remove('hidden');
    } else if (state.replyTo) {
      const rt = state.replyTo;
      const snip = (rt.text || '').slice(0, 80) || (rt.imageUrl ? '🖼️ imagen' : '');
      banner.innerHTML = `<span>Respondiendo a <b style="color:${escapeHTML(rt.author.color || '#fff')}">${escapeHTML(rt.author.displayName)}</b>: ${escapeHTML(snip)}</span><button type="button" id="cancelMode">×</button>`;
      banner.classList.remove('hidden');
    } else {
      banner.innerHTML = '';
      banner.classList.add('hidden');
    }
    const c = $('#cancelMode');
    if (c) c.addEventListener('click', cancelComposerMode);
  }

  async function pinMessage(msgId) {
    if (!state.me) { alert('Inicia sesión para pinear.'); return; }
    try {
      const r = await api(`/api/messages/${msgId}/pin`, { method: 'POST' });
      alert(`Pineado (${r.pinnedMessageIds.length}/5). Aparece en tu perfil.`);
    } catch (err) { alert('Error: ' + err.message); }
  }

  function scrollToBottom() {
    const list = $('#messages');
    list.scrollTop = list.scrollHeight;
  }

  function setBadge(kind, label) {
    const el = $('#rtBadge');
    if (!el) return;
    const ok = kind === 'connected';
    el.className = 'badge' + (ok ? ' connected' : (kind === 'connecting' ? '' : ' error'));
    // CSS shows a pulsing red dot on .badge.connected; otherwise a flat dot. The text is the label.
    el.textContent = label;
  }

  function debouncedBadge(kind, label, delay) {
    clearTimeout(state._badgeTimer);
    if (delay && delay > 0) {
      state._badgeTimer = setTimeout(() => setBadge(kind, label), delay);
    } else {
      setBadge(kind, label);
    }
  }

  async function setupRealtime() {
    if (!state.config || !state.config.pusher || !state.config.pusher.enabled) {
      setBadge('error', 'tiempo real desactivado');
      setInterval(loadMessages, 3000);
      return;
    }
    setBadge('connecting', 'conectando…');
    try {
      const p = new Pusher(state.config.pusher.key, {
        cluster: state.config.pusher.cluster,
        forceTLS: true,
        authEndpoint: '/api/realtime/auth',
        auth: { headers: {} },
      });
      state.pusher = p;
      const channel = p.subscribe(`room-${state.room}`);
      state.channel = channel;
      // Single state_change listener with debounce: don't flash "sin conexión" while
      // Pusher is just rotating transports (websocket -> xhr_streaming, etc.)
      p.connection.bind('state_change', (s) => {
        const cur = s && s.current;
        if (cur === 'connected') { debouncedBadge('connected', 'en vivo', 0); }
        else if (cur === 'connecting') { debouncedBadge('connecting', 'conectando…', 800); }
        else if (cur === 'unavailable') { debouncedBadge('error', 'sin red', 3500); }
        else if (cur === 'failed') { debouncedBadge('error', 'sin conexión', 3500); }
        else if (cur === 'disconnected') { debouncedBadge('error', 'desconectado', 3500); }
      });
      channel.bind('message:new', (msg) => appendMessage(msg));
      channel.bind('message:update', (msg) => updateMessage(msg));
      channel.bind('bot:typing', (data) => showBotTyping(data && data.botName));

      // Presence: who's online + typing indicator (client events).
      const pres = p.subscribe(`presence-room-${state.room}`);
      state.presenceChannel = pres;
      pres.bind('pusher:subscription_succeeded', (members) => {
        state.online.clear();
        members.each((m) => state.online.set(m.id, m.info));
        renderOnlineList();
      });
      pres.bind('pusher:member_added', (m) => { state.online.set(m.id, m.info); renderOnlineList(); });
      pres.bind('pusher:member_removed', (m) => { state.online.delete(m.id); renderOnlineList(); });
      pres.bind('client-typing', (data) => showTyping(data && data.displayName));

      // Personal channel for private notifications (mentions, etc.)
      if (state.me) {
        try {
          const priv = p.subscribe(`private-user-${state.me.id}`);
          state.privateChannel = priv;
          priv.bind('notification:new', (n) => addNotification(n));
        } catch (e) { console.warn('subscribe private', e); }
      }
    } catch (err) {
      console.error('pusher init', err);
      setBadge('error', 'sin tiempo real');
      setInterval(loadMessages, 3000);
    }
  }

  function showBotTyping(botName) {
    const el = $('#typingIndicator');
    if (!el) return;
    const name = botName || 'UbreBot';
    el.classList.remove('hidden');
    el.innerHTML = `<span class="bot-typing"><svg class="ic ic-xs"><use href="#i-zap"/></svg> ${escapeHTML(name)} está pensando<span class="dots"><i></i><i></i><i></i></span></span>`;
    clearTimeout(state._botTypingTimer);
    state._botTypingTimer = setTimeout(() => {
      el.classList.add('hidden');
      el.innerHTML = '';
    }, 12000);
  }

  function renderOnlineList() {
    const el = $('#onlineList');
    if (!el) return;
    const items = [...state.online.values()];
    el.innerHTML = `<div class="online-count">🟢 ${items.length} en línea</div>` +
      items.slice(0, 50).map((u) => `<div class="online-row ${u.username ? 'clickable' : ''}" data-username="${escapeHTML(u.username || '')}">
        <span class="online-dot" style="background:${escapeHTML(u.color || '#7c5cff')}"></span>
        <span class="online-name ${decoClass(u.decoration)}">${escapeHTML(u.displayName)}</span>
      </div>`).join('');
    el.querySelectorAll('.online-row.clickable').forEach((r) => {
      r.addEventListener('click', () => { const u = r.dataset.username; if (u) go(`/u/${u}`); });
    });
  }

  function showTyping(name) {
    if (!name) return;
    const el = $('#typingIndicator');
    if (!el) return;
    if (state.typing.has(name)) clearTimeout(state.typing.get(name));
    state.typing.set(name, setTimeout(() => { state.typing.delete(name); paintTyping(); }, 4000));
    paintTyping();
  }
  function paintTyping() {
    const el = $('#typingIndicator');
    if (!el) return;
    const names = [...state.typing.keys()];
    if (!names.length) { el.classList.add('hidden'); el.textContent = ''; return; }
    const phrase = names.length === 1 ? `${names[0]} está escribiendo…`
      : names.length === 2 ? `${names[0]} y ${names[1]} están escribiendo…`
      : `${names.length} personas están escribiendo…`;
    el.textContent = phrase;
    el.classList.remove('hidden');
  }

  function broadcastTyping() {
    const ch = state.presenceChannel;
    if (!ch || !ch.subscribed) return;
    const me = state.me ? state.me.displayName : null;
    const fallback = state.online.values().next().value; // gives any (own) info if anon
    const dn = me || (fallback && fallback.displayName) || 'Anon';
    try { ch.trigger('client-typing', { displayName: dn }); } catch (_e) { /* throttled */ }
  }

  // ----- Notifications dropdown -----
  function addNotification(n) {
    state.notifications.unshift(n);
    if (state.notifications.length > 50) state.notifications.length = 50;
    paintNotifBadge();
    flashToast(`@${n.fromDisplayName}: ${n.text || ''}`);
  }
  function paintNotifBadge() {
    const btn = $('#notifBtn');
    if (!btn) return;
    const unread = state.notifications.filter((n) => !n.read).length;
    btn.dataset.count = unread;
    btn.classList.toggle('has-unread', unread > 0);
    const dot = btn.querySelector('.notif-count');
    if (dot) dot.textContent = unread > 0 ? unread : '';
  }
  async function loadNotifications() {
    if (!state.me) return;
    try {
      const r = await api('/api/users/me/notifications');
      state.notifications = r.notifications || [];
      paintNotifBadge();
    } catch (_e) { /* ignore */ }
  }
  function toggleNotifPanel() {
    let panel = $('#notifPanel');
    if (panel) { panel.remove(); return; }
    panel = document.createElement('div');
    panel.id = 'notifPanel';
    panel.className = 'notif-panel';
    if (state.notifications.length === 0) {
      panel.innerHTML = '<div class="muted" style="padding:14px">Sin notificaciones</div>';
    } else {
      panel.innerHTML = state.notifications.slice(0, 30).map((n) => `
        <div class="notif-row ${n.read ? '' : 'unread'}">
          <b>@${escapeHTML(n.fromDisplayName)}</b>
          <div class="notif-text">${escapeHTML(n.text || '')}</div>
          <span class="muted">${fmtTime(n.createdAt)}</span>
        </div>`).join('');
    }
    document.body.appendChild(panel);
    api('/api/users/me/notifications/read', { method: 'POST' }).catch(() => {});
    state.notifications.forEach((n) => { n.read = true; });
    paintNotifBadge();
    setTimeout(() => document.addEventListener('click', closeNotifOutside, { once: true }), 0);
  }
  function closeNotifOutside(e) {
    const p = $('#notifPanel');
    if (!p) return;
    if (!p.contains(e.target) && e.target.id !== 'notifBtn' && !$('#notifBtn').contains(e.target)) p.remove();
    else setTimeout(() => document.addEventListener('click', closeNotifOutside, { once: true }), 0);
  }
  function flashToast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 3000);
  }

  function setupComposer() {
    const form = $('#composer');
    const text = $('#textInput');
    const fileInput = $('#imageInput');
    const previewBar = $('#previewBar');
    const previewImg = $('#previewImg');

    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) return;
      state.pendingFile = f;
      previewImg.src = URL.createObjectURL(f);
      previewBar.classList.remove('hidden');
    });

    $('#clearPreview').addEventListener('click', () => {
      state.pendingFile = null;
      fileInput.value = '';
      previewBar.classList.add('hidden');
    });

    text.addEventListener('paste', (e) => {
      const items = (e.clipboardData || {}).items || [];
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) {
            state.pendingFile = f;
            previewImg.src = URL.createObjectURL(f);
            previewBar.classList.remove('hidden');
          }
        }
      }
    });

    // Throttled typing event + command autocomplete + mention autocomplete.
    let typingThrottle = 0;
    text.addEventListener('input', () => {
      const now = Date.now();
      if (now - typingThrottle > 2000) { typingThrottle = now; broadcastTyping(); }
      maybeShowAutocomplete(text);
    });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') cancelComposerMode();
      handleAutocompleteKeys(e, text);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideAutocomplete();
      const value = text.value.trim();
      if (!value && !state.pendingFile && !state.editing) return;

      // Edit mode: PATCH the message.
      if (state.editing) {
        const targetId = state.editing.id;
        try {
          const data = await api(`/api/messages/${targetId}`, { method: 'PATCH', body: { text: value } });
          if (data && data.message) updateMessage(data.message);
          state.editing = null;
          text.value = '';
          showComposerBanner();
        } catch (err) { alert('Error: ' + err.message); }
        return;
      }

      const fd = new FormData();
      if (value) fd.append('text', value);
      if (state.pendingFile) fd.append('image', state.pendingFile);
      fd.append('room', state.room);
      if (state.replyTo) fd.append('replyToId', state.replyTo.id);
      const willInvokeBot = /(^|\s)@ubrebot(\s|$|[!?,.])/i.test(value);
      try {
        text.value = '';
        state.pendingFile = null;
        fileInput.value = '';
        previewBar.classList.add('hidden');
        state.replyTo = null;
        showComposerBanner();
        if (willInvokeBot) showBotTyping('UbreBot');
        const data = await api('/api/messages', { method: 'POST', body: fd });
        if (data && data.message) appendMessage(data.message);
        if (data && data.botReply) {
          // Hide typing indicator now that the reply is on its way.
          const ti = $('#typingIndicator');
          if (ti) { ti.classList.add('hidden'); ti.innerHTML = ''; }
          appendMessage(data.botReply);
        }
        // Track our own anon owner for self-recognition (own-message styling).
        if (data && data.message && data.message.anonOwner) {
          state.myAnonId = data.message.anonOwner;
          state.ownAnonIds = state.ownAnonIds || new Set();
          state.ownAnonIds.add(data.message.anonOwner);
        }
      } catch (err) {
        console.error('send', err);
        alert('No se pudo enviar: ' + err.message);
      }
    });
  }

  // ----- Autocomplete (slash commands + @mentions) -----
  let acState = { open: false, kind: null, items: [], cursor: 0, range: null };
  function maybeShowAutocomplete(textEl) {
    const v = textEl.value;
    const pos = textEl.selectionStart || v.length;
    // Slash command at start of line or whole input.
    if (v.startsWith('/') && !v.includes(' ')) {
      const term = v.slice(1).toLowerCase();
      const items = COMMANDS.filter((c) => c.name.slice(1).startsWith(term));
      if (!items.length) return hideAutocomplete();
      return showAutocomplete('cmd', items, { start: 0, end: v.length });
    }
    // @mention from online list.
    const upTo = v.slice(0, pos);
    const m = upTo.match(/(^|\s)@([a-z0-9_]{0,24})$/i);
    if (m) {
      const term = m[2].toLowerCase();
      const items = [...state.online.values()]
        .filter((u) => u.username && u.username.startsWith(term))
        .slice(0, 8)
        .map((u) => ({ name: '@' + u.username, hint: u.displayName }));
      if (!items.length) return hideAutocomplete();
      return showAutocomplete('mention', items, { start: pos - m[2].length - 1, end: pos });
    }
    hideAutocomplete();
  }
  function showAutocomplete(kind, items, range) {
    let el = $('#autocomplete');
    if (!el) {
      el = document.createElement('div');
      el.id = 'autocomplete';
      el.className = 'autocomplete';
      $('#composerWrap').appendChild(el);
    }
    acState = { open: true, kind, items, cursor: 0, range };
    paintAutocomplete();
  }
  function paintAutocomplete() {
    const el = $('#autocomplete');
    if (!el) return;
    el.innerHTML = acState.items.map((it, i) => `<div class="ac-row ${i === acState.cursor ? 'active' : ''}" data-i="${i}"><b>${escapeHTML(it.name)}</b><span class="muted">${escapeHTML(it.hint || '')}</span></div>`).join('');
    el.querySelectorAll('.ac-row').forEach((row) => {
      row.addEventListener('mousedown', (e) => { e.preventDefault(); acceptAutocomplete(parseInt(row.dataset.i, 10)); });
    });
  }
  function hideAutocomplete() { acState.open = false; const el = $('#autocomplete'); if (el) el.remove(); }
  function handleAutocompleteKeys(e, _textEl) {
    if (!acState.open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); acState.cursor = (acState.cursor + 1) % acState.items.length; paintAutocomplete(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); acState.cursor = (acState.cursor - 1 + acState.items.length) % acState.items.length; paintAutocomplete(); }
    else if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); acceptAutocomplete(acState.cursor); }
    else if (e.key === 'Escape') { e.preventDefault(); hideAutocomplete(); }
  }
  function acceptAutocomplete(i) {
    const it = acState.items[i];
    if (!it) return;
    const textEl = $('#textInput');
    const v = textEl.value;
    const before = v.slice(0, acState.range.start);
    const after = v.slice(acState.range.end);
    const insert = it.name + ' ';
    textEl.value = before + insert + after;
    const pos = before.length + insert.length;
    textEl.setSelectionRange(pos, pos);
    hideAutocomplete();
    textEl.focus();
  }

  // ----- Login / Register -----
  function setupAuthForms() {
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errorEl = $('#loginError');
      errorEl.textContent = '';
      try {
        const data = await api('/api/auth/login', {
          method: 'POST',
          body: { identifier: fd.get('identifier'), password: fd.get('password') },
        });
        state.me = data.user;
        applyAuthUI();
        loadNotifications().catch(() => {});
        loadServers().catch(() => {});
        loadDms().catch(() => {});
        loadStickers().catch(() => {});
        go('/');
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });

    $('#registerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errorEl = $('#registerError');
      errorEl.textContent = '';
      try {
        const data = await api('/api/auth/register', {
          method: 'POST',
          body: {
            displayName: fd.get('displayName'),
            username: fd.get('username'),
            email: fd.get('email'),
            password: fd.get('password'),
          },
        });
        state.me = data.user;
        applyAuthUI();
        loadNotifications().catch(() => {});
        loadServers().catch(() => {});
        loadDms().catch(() => {});
        loadStickers().catch(() => {});
        go('/');
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });

    $('#logoutBtn').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (_e) { /* ignore */ }
      state.me = null;
      state.servers = [];
      state.activeServer = null;
      state.activeChannel = null;
      renderServerRail();
      renderChannelList();
      applyAuthUI();
      go('/');
    });
  }

  // ----- Profile -----
  async function renderProfileView() {
    const container = $('#profileContainer');
    const path = location.pathname;
    let username = null;
    if (path.startsWith('/u/')) {
      username = path.slice(3);
    } else if (state.me) {
      username = state.me.username;
    }
    if (!username) {
      container.innerHTML = '<div class="form"><p>Inicia sesión para ver tu perfil.</p></div>';
      return;
    }

    container.innerHTML = '<div class="profile"><p class="muted" style="padding:24px">Cargando…</p></div>';
    let user;
    try {
      ({ user } = await api(`/api/users/${encodeURIComponent(username)}`));
    } catch (err) {
      container.innerHTML = `<div class="form"><p>Error: ${escapeHTML(err.message)}</p></div>`;
      return;
    }
    const isMe = state.me && state.me.username === user.username;

    const accent = user.color || '#7c5cff';
    const gradFrom = user.gradientFrom || '#7c5cff';
    const gradTo = user.gradientTo || '#ff5c8a';
    const bannerBg = user.bannerColor || '#1b1f27';
    const decoration = user.decoration && DECORATIONS.includes(user.decoration) ? user.decoration : 'none';
    const effect = user.effect && EFFECTS.includes(user.effect) ? user.effect : 'none';

    const styleVars =
      `--accent:${accent};--grad-from:${gradFrom};--grad-to:${gradTo};` +
      `--banner-bg:${bannerBg};` +
      (user.bannerUrl ? `--banner-image:url('${user.bannerUrl.replace(/'/g, "\\'")}');` : '');

    const bannerClass = user.bannerUrl ? 'profile-banner has-image' : 'profile-banner';
    const profileClass = `profile effect-${effect}`;

    const avatarTag = `<img class="profile-avatar" src="${escapeHTML(user.avatarUrl || avatarFallback(user.displayName))}" alt="" />`;
    const avatarFrameClasses = `avatar-frame ${decoration !== 'none' ? `deco-wrap deco-${decoration}` : ''}`;

    const pronounsHtml = user.pronouns
      ? `<span class="pronouns">${escapeHTML(user.pronouns)}</span>` : '';
    const statusHtml = user.status
      ? `<div class="status">${escapeHTML(user.status)}</div>` : '';
    const linksHtml = (user.links || []).filter((l) => l.url).map((l) => {
      const safeUrl = /^https?:\/\//i.test(l.url) ? l.url : `https://${l.url}`;
      return `<a href="${escapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${escapeHTML(l.label || safeUrl.replace(/^https?:\/\//, ''))}</a>`;
    }).join('');
    const bioHtml = renderBioMarkdown(user.bio || (isMe ? '_Edita tu perfil para añadir una bio._' : 'Sin bio.'));

    container.innerHTML = `
      <div class="${profileClass}" style="${styleVars}">
        <div class="${bannerClass}">
          ${isMe ? `<div class="profile-banner-edit"><label class="btn" for="bannerInput">📷 Cambiar banner</label><input type="file" id="bannerInput" accept="image/*,image/gif" class="file-input" /></div>` : ''}
        </div>
        <div class="profile-head">
          <div class="${avatarFrameClasses}">${avatarTag}</div>
          <div class="profile-info">
            ${user.title ? `<div class="title-badge">${escapeHTML(user.title)}</div>` : ''}
            <h2 class="${fontClass(user.nameFont)}" style="color:${escapeHTML(accent)}">${escapeHTML(user.displayName)} ${pronounsHtml}</h2>
            <div class="handle">@${escapeHTML(user.username)}</div>
            ${statusHtml}
          </div>
        </div>
        ${isMe ? `<div class="profile-actions">
          <label class="btn btn-primary" for="avatarInput">📸 Cambiar foto</label>
          <input type="file" id="avatarInput" accept="image/*,image/gif" class="file-input" />
          <button class="btn" id="copyProfileLink">🔗 Copiar enlace</button>
        </div>` : ''}
        <div class="profile-bio">${bioHtml}</div>
        ${linksHtml ? `<div class="profile-links">${linksHtml}</div>` : ''}
        <div id="pinnedSection" class="profile-pins"><h3>📌 Mensajes destacados</h3><div id="pinnedMessages" class="muted">Cargando…</div></div>
        <div id="achievementsSection" class="profile-achievements"><h3>🏆 Logros</h3><div id="achievementsGrid" class="achievement-grid"></div></div>
        ${isMe ? renderEditor(user) : ''}
      </div>`;

    loadPinnedMessages(user.username).catch(() => {});
    renderAchievements(user);
    if (isMe) wireEditor(user);
  }

  const ACHIEVEMENT_META = {
    first_message: { emoji: '\u270d\ufe0f', label: 'Primer mensaje' },
    ten_messages: { emoji: '\ud83d\udcac', label: 'Charlador (10)' },
    hundred_messages: { emoji: '\ud83d\udd25', label: 'Centuri\u00f3n (100)' },
    thousand_messages: { emoji: '\ud83d\udc51', label: 'Leyenda (1000)' },
    first_image: { emoji: '\ud83d\udcf8', label: 'Fot\u00f3grafo' },
    first_voice: { emoji: '\ud83c\udf99\ufe0f', label: 'Primera voz' },
    ten_voice: { emoji: '\ud83c\udfa7', label: 'Podcaster (10)' },
    first_poll: { emoji: '\ud83d\udcca', label: 'Encuestador' },
    first_sticker: { emoji: '\ud83c\udfa8', label: 'Sticker fan' },
    first_reaction: { emoji: '\u2764\ufe0f', label: 'Reaccionado' },
    ten_reactions: { emoji: '\ud83d\ude0d', label: 'Querido (10)' },
    fifty_reactions: { emoji: '\u2728', label: 'Carism\u00e1tico (50)' },
  };
  function renderAchievements(user) {
    const grid = $('#achievementsGrid');
    if (!grid) return;
    const have = new Map((user.achievements || []).map((a) => [a.key, a.unlockedAt]));
    grid.innerHTML = Object.keys(ACHIEVEMENT_META).map((k) => {
      const meta = ACHIEVEMENT_META[k];
      const got = have.get(k);
      return `<div class="achievement-card ${got ? '' : 'locked'}">
        <span class="emoji">${meta.emoji}</span>
        <div>
          <div class="label">${escapeHTML(meta.label)}</div>
          <div class="when">${got ? fmtTime(got) : 'Bloqueado'}</div>
        </div>
      </div>`;
    }).join('');
  }

  async function loadPinnedMessages(username) {
    const el = $('#pinnedMessages');
    if (!el) return;
    try {
      const r = await api(`/api/users/${encodeURIComponent(username)}/pinned`);
      const msgs = r.messages || [];
      if (!msgs.length) { el.innerHTML = '<div class="muted">Todav\u00eda no hay mensajes pineados.</div>'; return; }
      el.innerHTML = msgs.map((m) => {
        const a = m.author || {};
        const av = a.avatarUrl ? `<img src="${escapeHTML(a.avatarUrl)}" />` : escapeHTML((a.displayName || '?').charAt(0).toUpperCase());
        const txt = m.text ? `<div>${renderTextWithMentions(m.text)}</div>` : '';
        const img = m.imageUrl ? `<img class="pin-img" src="${escapeHTML(m.imageUrl)}" />` : '';
        return `<div class="pin-card">
          <div class="pin-head">
            <div class="pin-avatar ${decoClass(a.decoration)}" style="background:${escapeHTML(a.color || '#7c5cff')}">${av}</div>
            <span class="${fontClass(a.nameFont)}" style="color:${escapeHTML(a.color || '#fff')}">${escapeHTML(a.displayName || '')}</span>
            <span class="muted" style="font-size:11px">${fmtTime(m.createdAt)}</span>
          </div>
          ${txt}${img}
        </div>`;
      }).join('');
    } catch (e) { el.innerHTML = `<div class="muted">Error: ${escapeHTML(e.message)}</div>`; }
  }

  function renderEditor(user) {
    const decoCards = DECORATIONS.map((d) => `
      <label class="${user.decoration === d ? 'checked' : ''}" data-deco="${d}">
        <input type="radio" name="decoration" value="${d}" ${user.decoration === d ? 'checked' : ''} />
        <div class="preview ${d !== 'none' ? `deco-wrap deco-${d}` : ''}"></div>
        <div class="name">${escapeHTML(DECO_LABELS[d])}</div>
      </label>`).join('');
    const effectCards = EFFECTS.map((e) => `
      <label class="${user.effect === e ? 'checked' : ''}" data-effect="${e}">
        <input type="radio" name="effect" value="${e}" ${user.effect === e ? 'checked' : ''} />
        <div class="name">${escapeHTML(EFFECT_LABELS[e])}</div>
      </label>`).join('');
    const fontCards = NAME_FONTS.map((f) => `
      <label class="${user.nameFont === f ? 'checked' : ''}" data-font="${f}">
        <input type="radio" name="nameFont" value="${f}" ${user.nameFont === f ? 'checked' : ''} />
        <span class="font-sample ${fontClass(f)}">${escapeHTML(FONT_LABELS[f])}</span>
      </label>`).join('');

    const links = user.links && user.links.length ? user.links : [{ label: '', url: '' }];
    const linksRows = links.map((l, i) => `
      <div class="link-row" data-i="${i}">
        <input class="link-label" placeholder="Etiqueta" maxlength="30" value="${escapeHTML(l.label || '')}" />
        <input class="link-url" placeholder="https://…" maxlength="200" value="${escapeHTML(l.url || '')}" />
        <button type="button" class="btn btn-ghost link-del" title="Quitar">✕</button>
      </div>`).join('');

    return `
      <div class="profile-section">
        <h3>Editar perfil</h3>
        <form id="profileForm" class="profile-form">
          <div class="field-row">
            <label>Título (badge sobre el nombre)<input name="title" maxlength="30" placeholder="Founder, OG, MOD…" value="${escapeHTML(user.title || '')}" /></label>
            <label>Fuente del nombre
              <div class="font-grid" id="fontGrid">${fontCards}</div>
            </label>
          </div>
          <div class="field-row">
            <label>Nombre visible<input name="displayName" maxlength="40" value="${escapeHTML(user.displayName)}" /></label>
            <label>Pronombres<input name="pronouns" maxlength="30" placeholder="él / ella / they" value="${escapeHTML(user.pronouns || '')}" /></label>
          </div>
          <label>Estado<input name="status" maxlength="80" placeholder="¿qué estás haciendo?" value="${escapeHTML(user.status || '')}" /></label>
          <label>Bio (admite **negrita**, *cursiva*, [enlace](url) y \`código\`)
            <textarea name="bio" maxlength="500">${escapeHTML(user.bio || '')}</textarea>
          </label>
          <div class="field-row">
            <label>Color de acento<div class="color-row"><input type="color" name="color" value="${escapeHTML(user.color || '#7c5cff')}" /><span class="muted">Tu nombre y enlaces</span></div></label>
            <label>Color del banner (sin imagen)<div class="color-row"><input type="color" name="bannerColor" value="${escapeHTML(user.bannerColor || '#1b1f27')}" /></div></label>
          </div>
          <div class="field-row">
            <label>Gradient inicio<div class="color-row"><input type="color" name="gradientFrom" value="${escapeHTML(user.gradientFrom || '#7c5cff')}" /></div></label>
            <label>Gradient fin<div class="color-row"><input type="color" name="gradientTo" value="${escapeHTML(user.gradientTo || '#ff5c8a')}" /></div></label>
          </div>
          <label>Decoración del avatar
            <div class="deco-grid" id="decoGrid">${decoCards}</div>
          </label>
          <label>Efecto del perfil
            <div class="effect-grid" id="effectGrid">${effectCards}</div>
          </label>
          <label>Enlaces (max 5)
            <div class="links-editor" id="linksEditor">${linksRows}</div>
            <button type="button" class="btn btn-ghost" id="addLink" style="align-self:flex-start;margin-top:6px">+ Añadir enlace</button>
          </label>
          <button class="btn btn-primary" type="submit">Guardar cambios</button>
          <p class="form-error" id="profileError"></p>
        </form>
      </div>`;
  }

  function collectLinks(root) {
    return $$('.link-row', root).map((row) => ({
      label: row.querySelector('.link-label').value.trim(),
      url: row.querySelector('.link-url').value.trim(),
    })).filter((l) => l.url || l.label);
  }

  function wireEditor(user) {
    const form = $('#profileForm');

    // Decoration / effect picker styling.
    function refreshChecked(grid) {
      $$('label', grid).forEach((lbl) => {
        const input = lbl.querySelector('input');
        lbl.classList.toggle('checked', input && input.checked);
      });
    }
    const decoGrid = $('#decoGrid');
    const effGrid = $('#effectGrid');
    const fontGrid = $('#fontGrid');
    [decoGrid, effGrid, fontGrid].forEach((grid) => {
      if (!grid) return;
      grid.addEventListener('change', () => refreshChecked(grid));
    });

    // Live preview while typing.
    const profileEl = $('.profile');
    const bannerEl = profileEl.querySelector('.profile-banner');
    const avatarFrame = profileEl.querySelector('.avatar-frame');
    const nameEl = profileEl.querySelector('.profile-info h2');
    const pronounsEl = profileEl.querySelector('.profile-info .pronouns');
    const statusEl = profileEl.querySelector('.profile-info .status');
    const bioEl = profileEl.querySelector('.profile-bio');

    function applyPreview() {
      const fd = new FormData(form);
      const accent = fd.get('color') || '#7c5cff';
      profileEl.style.setProperty('--accent', accent);
      profileEl.style.setProperty('--grad-from', fd.get('gradientFrom') || '#7c5cff');
      profileEl.style.setProperty('--grad-to', fd.get('gradientTo') || '#ff5c8a');
      profileEl.style.setProperty('--banner-bg', fd.get('bannerColor') || '#1b1f27');
      if (nameEl) {
        nameEl.style.color = accent;
        const dn = fd.get('displayName') || user.displayName;
        const pron = fd.get('pronouns') || '';
        let html = escapeHTML(dn);
        if (pron) html += ` <span class="pronouns">${escapeHTML(pron)}</span>`;
        nameEl.innerHTML = html;
        // Update font class.
        NAME_FONTS.forEach((f) => nameEl.classList.remove(`font-${f}`));
        nameEl.classList.add(fontClass(fd.get('nameFont') || 'default'));
      }
      // Title badge: create / update / remove.
      const infoEl = profileEl.querySelector('.profile-info');
      let titleEl = infoEl && infoEl.querySelector('.title-badge');
      const titleVal = (fd.get('title') || '').trim();
      if (titleVal) {
        if (!titleEl) {
          titleEl = document.createElement('div');
          titleEl.className = 'title-badge';
          infoEl.insertBefore(titleEl, infoEl.firstChild);
        }
        titleEl.textContent = titleVal;
      } else if (titleEl) {
        titleEl.remove();
      }
      if (statusEl) {
        const v = fd.get('status') || '';
        statusEl.textContent = v;
        statusEl.style.display = v ? '' : 'none';
      } else if (fd.get('status')) {
        // create one if missing on initial render with no status
        const s = document.createElement('div');
        s.className = 'status';
        s.textContent = fd.get('status');
        profileEl.querySelector('.profile-info').appendChild(s);
      }
      if (bioEl) bioEl.innerHTML = renderBioMarkdown(fd.get('bio') || '');
      // Decoration class on avatar frame.
      if (avatarFrame) {
        DECORATIONS.forEach((d) => avatarFrame.classList.remove(`deco-${d}`));
        avatarFrame.classList.remove('deco-wrap');
        const newDeco = fd.get('decoration') || 'none';
        if (newDeco !== 'none') avatarFrame.classList.add('deco-wrap', `deco-${newDeco}`);
      }
      // Effect on profile container.
      EFFECTS.forEach((e) => profileEl.classList.remove(`effect-${e}`));
      profileEl.classList.add(`effect-${fd.get('effect') || 'none'}`);
      if (bannerEl && !bannerEl.classList.contains('has-image')) {
        // already drives via CSS vars.
      }
    }
    form.addEventListener('input', applyPreview);
    form.addEventListener('change', applyPreview);

    // Links editor.
    const linksEditor = $('#linksEditor');
    $('#addLink').addEventListener('click', () => {
      if ($$('.link-row', linksEditor).length >= 5) return;
      const div = document.createElement('div');
      div.className = 'link-row';
      div.innerHTML = `
        <input class="link-label" placeholder="Etiqueta" maxlength="30" />
        <input class="link-url" placeholder="https://…" maxlength="200" />
        <button type="button" class="btn btn-ghost link-del" title="Quitar">✕</button>`;
      linksEditor.appendChild(div);
    });
    linksEditor.addEventListener('click', (e) => {
      const btn = e.target.closest('.link-del');
      if (!btn) return;
      btn.closest('.link-row').remove();
    });

    // Submit.
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const errorEl = $('#profileError');
      errorEl.textContent = '';
      try {
        const data = await api('/api/users/me', {
          method: 'PATCH',
          body: {
            displayName: fd.get('displayName'),
            title: fd.get('title'),
            nameFont: fd.get('nameFont'),
            pronouns: fd.get('pronouns'),
            status: fd.get('status'),
            bio: fd.get('bio'),
            color: fd.get('color'),
            bannerColor: fd.get('bannerColor'),
            gradientFrom: fd.get('gradientFrom'),
            gradientTo: fd.get('gradientTo'),
            decoration: fd.get('decoration'),
            effect: fd.get('effect'),
            links: collectLinks(linksEditor),
          },
        });
        state.me = data.user;
        applyAuthUI();
        renderProfileView();
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });

    $('#avatarInput').addEventListener('change', (e) => uploadProfileMedia(e.target, 'avatar'));
    $('#bannerInput').addEventListener('change', (e) => uploadProfileMedia(e.target, 'banner'));

    const copyBtn = $('#copyProfileLink');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(`${location.origin}/u/${user.username}`);
          copyBtn.textContent = '✓ Copiado';
          setTimeout(() => { copyBtn.textContent = '🔗 Copiar enlace'; }, 1200);
        } catch (_e) { /* ignore */ }
      });
    }
  }

  async function uploadProfileMedia(input, kind) {
    const f = input.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    try {
      const data = await api(`/api/users/me/${kind}`, { method: 'POST', body: fd });
      state.me = data.user;
      applyAuthUI();
      renderProfileView();
    } catch (err) {
      alert('Upload failed: ' + err.message);
    }
  }

  // ----- Servers + channels -----
  async function loadServers() {
    if (!state.me) { state.servers = []; renderServerRail(); return; }
    try {
      const r = await api('/api/servers');
      state.servers = r.servers || [];
    } catch (_e) { state.servers = []; }
    renderServerRail();
  }
  function renderServerRail() {
    const list = $('#serverList');
    if (!list) return;
    list.innerHTML = state.servers.map((s) => {
      const active = state.activeServer && state.activeServer.id === s.id;
      const icon = s.icon || s.name.charAt(0).toUpperCase();
      return `<button class="server-icon ${active ? 'active' : ''}" data-server="${escapeHTML(s.id)}" title="${escapeHTML(s.name)}">${escapeHTML(icon)}</button>`;
    }).join('');
    list.querySelectorAll('.server-icon').forEach((b) => {
      b.addEventListener('click', () => switchServer(b.dataset.server));
    });
    const homeBtn = $('.server-rail .server-icon[data-server="global"]');
    if (homeBtn) {
      homeBtn.classList.toggle('active', !state.activeServer);
      homeBtn.onclick = () => switchServer('global');
    }
    const newBtn = $('#newServerBtn');
    if (newBtn) newBtn.onclick = openServerCreateModal;
  }
  function renderChannelList() {
    const wrap = $('#channelList');
    if (!wrap) return;
    if (!state.activeServer) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    $('#activeServerName').textContent = state.activeServer.name;
    const inv = $('#inviteCode');
    if (inv) {
      inv.textContent = state.activeServer.inviteCode || '';
      inv.onclick = () => {
        if (!state.activeServer.inviteCode) return;
        navigator.clipboard.writeText(state.activeServer.inviteCode).then(() => flashToast('C\u00f3digo copiado'));
      };
    }
    const channels = state.activeServer.channels || [];
    const wrap2 = $('#channels');
    wrap2.innerHTML = channels.map((c) => `<div class="channel-row ${c.id === state.activeChannel ? 'active' : ''}" data-channel="${escapeHTML(c.id)}"><span class="hash">#</span> ${escapeHTML(c.name)}</div>`).join('');
    wrap2.querySelectorAll('.channel-row').forEach((row) => {
      row.addEventListener('click', () => switchChannel(row.dataset.channel));
    });
    const newCh = $('#newChannelBtn');
    if (newCh) newCh.onclick = openCreateChannelPrompt;
    const leave = $('#leaveServerBtn');
    if (leave) leave.onclick = leaveActiveServer;
  }
  async function switchServer(id) {
    state.activeDm = null;
    if (id === 'global') {
      state.activeServer = null;
      state.activeChannel = null;
      changeRoom('global');
      renderServerRail();
      renderChannelList();
      renderDmList();
      return;
    }
    const s = state.servers.find((x) => x.id === id);
    if (!s) return;
    state.activeServer = s;
    state.activeChannel = (s.channels[0] || {}).id || null;
    renderDmList();
    renderServerRail();
    renderChannelList();
    if (state.activeChannel) changeRoom(`srv-${s.id}-${state.activeChannel}`);
  }
  function switchChannel(channelId) {
    if (!state.activeServer) return;
    state.activeChannel = channelId;
    renderChannelList();
    changeRoom(`srv-${state.activeServer.id}-${channelId}`);
  }
  async function changeRoom(room) {
    if (room === state.room) return;
    // Unsubscribe from old channels.
    if (state.pusher) {
      if (state.channel) state.pusher.unsubscribe(`room-${state.room}`);
      if (state.presenceChannel) state.pusher.unsubscribe(`presence-room-${state.room}`);
    }
    state.room = room;
    state.online.clear();
    state.typing.clear();
    paintTyping();
    renderOnlineList();
    const heading = $('.view-chat .view-head h1');
    if (heading) {
      if (room === 'global') heading.textContent = 'Chat global';
      else if (room.startsWith('dm-') && state.activeDm && state.activeDm.with) {
        heading.textContent = `\ud83d\udcac ${state.activeDm.with.displayName || state.activeDm.with.username}`;
      } else if (state.activeServer) {
        heading.textContent = `${state.activeServer.name} · #${(state.activeServer.channels.find((c) => c.id === state.activeChannel) || {}).name || ''}`;
      }
    }
    state.seen.clear();
    state.messages.clear();
    await loadMessages();
    if (state.pusher) {
      const ch = state.pusher.subscribe(`room-${state.room}`);
      state.channel = ch;
      ch.bind('message:new', (msg) => appendMessage(msg));
      ch.bind('message:update', (msg) => updateMessage(msg));
      ch.bind('bot:typing', (data) => showBotTyping(data && data.botName));
      const pres = state.pusher.subscribe(`presence-room-${state.room}`);
      state.presenceChannel = pres;
      pres.bind('pusher:subscription_succeeded', (members) => {
        state.online.clear();
        members.each((m) => state.online.set(m.id, m.info));
        renderOnlineList();
      });
      pres.bind('pusher:member_added', (m) => { state.online.set(m.id, m.info); renderOnlineList(); });
      pres.bind('pusher:member_removed', (m) => { state.online.delete(m.id); renderOnlineList(); });
      pres.bind('client-typing', (data) => showTyping(data && data.displayName));
    }
  }
  function openServerCreateModal() {
    if (!state.me) { alert('Inicia sesi\u00f3n para crear / unirte a un server'); return; }
    const choice = prompt('1) Crear nuevo server\n2) Unirme con c\u00f3digo de invitaci\u00f3n\n\nElige 1 o 2:');
    if (choice === '1') {
      const name = prompt('Nombre del server:');
      if (!name) return;
      const icon = prompt('Icono (1 emoji o letra, opcional):') || '';
      api('/api/servers', { method: 'POST', body: { name, icon } })
        .then((r) => { state.servers.push(r.server); switchServer(r.server.id); })
        .catch((e) => alert('Error: ' + e.message));
    } else if (choice === '2') {
      const code = prompt('C\u00f3digo de invitaci\u00f3n:');
      if (!code) return;
      api('/api/servers/join', { method: 'POST', body: { code } })
        .then((r) => {
          if (!state.servers.some((s) => s.id === r.server.id)) state.servers.push(r.server);
          switchServer(r.server.id);
        })
        .catch((e) => alert('Error: ' + e.message));
    }
  }
  function openCreateChannelPrompt() {
    if (!state.activeServer) return;
    if (state.activeServer.ownerId !== state.me.id) { alert('Solo el owner crea canales'); return; }
    const name = prompt('Nombre del canal (sin #):');
    if (!name) return;
    api(`/api/servers/${state.activeServer.id}/channels`, { method: 'POST', body: { name } })
      .then((r) => {
        const idx = state.servers.findIndex((s) => s.id === r.server.id);
        if (idx >= 0) state.servers[idx] = r.server;
        state.activeServer = r.server;
        state.activeChannel = r.server.channels[r.server.channels.length - 1].id;
        renderChannelList();
        changeRoom(`srv-${r.server.id}-${state.activeChannel}`);
      })
      .catch((e) => alert('Error: ' + e.message));
  }
  async function leaveActiveServer() {
    if (!state.activeServer) return;
    if (!confirm(`\u00bfSalir de ${state.activeServer.name}?`)) return;
    try {
      await api(`/api/servers/${state.activeServer.id}/leave`, { method: 'DELETE' });
      state.servers = state.servers.filter((s) => s.id !== state.activeServer.id);
      switchServer('global');
    } catch (e) { alert('Error: ' + e.message); }
  }

  // ----- DMs -----
  async function loadDms() {
    try {
      const r = await api('/api/dms');
      state.dms = r.threads || [];
    } catch (_e) { state.dms = []; }
    renderDmList();
  }
  function renderDmList() {
    const wrap = $('#dmThreads');
    if (!wrap) return;
    if (!state.me) { wrap.innerHTML = ''; return; }
    if (!state.dms.length) {
      wrap.innerHTML = '<div class="dm-empty" style="padding:8px;color:var(--muted);font-size:12px;">Sin DMs todav\u00eda</div>';
      return;
    }
    wrap.innerHTML = state.dms.map((t) => {
      const w = t.with || {};
      const av = w.avatarUrl
        ? `<img src="${escapeHTML(w.avatarUrl)}" alt="" />`
        : escapeHTML((w.displayName || '?').charAt(0).toUpperCase());
      const isActive = state.activeDm && state.activeDm.room === t.room;
      const last = t.lastMessage && t.lastMessage.text ? t.lastMessage.text.slice(0, 60) : '';
      return `<div class="dm-thread ${isActive ? 'active' : ''}" data-room="${escapeHTML(t.room)}" data-username="${escapeHTML(w.username || '')}">
        <span class="av" style="background:${escapeHTML(w.color || '#7c5cff')}">${av}</span>
        <div class="info">
          <div class="name">${escapeHTML(w.displayName || w.username || 'Usuario')}</div>
          <div class="last">${escapeHTML(last)}</div>
        </div>
      </div>`;
    }).join('');
    wrap.querySelectorAll('.dm-thread').forEach((el) => {
      el.addEventListener('click', () => openDm(el.dataset.username));
    });
  }
  async function openDm(username) {
    if (!username || !state.me) return;
    try {
      const r = await api(`/api/dms/with/${encodeURIComponent(username)}`, { method: 'POST' });
      state.activeDm = { room: r.room, with: r.with };
      state.activeServer = null;
      state.activeChannel = null;
      const heading = $('.view-chat .view-head h1');
      if (heading) heading.textContent = `\ud83d\udcac ${r.with.displayName || r.with.username}`;
      changeRoom(r.room);
      renderDmList();
      renderServerRail();
      renderChannelList();
      go('/');
    } catch (e) { alert('Error: ' + e.message); }
  }
  function setupDmControls() {
    const btn = $('#newDmBtn');
    if (btn) btn.addEventListener('click', async () => {
      const q = prompt('Username de la persona:');
      if (!q) return;
      try {
        await api(`/api/dms/with/${encodeURIComponent(q.trim().toLowerCase())}`, { method: 'POST' });
        await openDm(q.trim().toLowerCase());
        await loadDms();
      } catch (e) { alert('Error: ' + e.message); }
    });
  }

  // ----- Stickers -----
  async function loadStickers() {
    try {
      const r = await api('/api/stickers/me');
      state.stickers = r.stickers || [];
    } catch (_e) { state.stickers = []; }
    renderStickerGrid();
  }
  function renderStickerGrid() {
    const grid = $('#stickerGrid');
    if (!grid) return;
    if (!state.stickers.length) {
      grid.innerHTML = '<div style="grid-column:1/-1;padding:20px;text-align:center;color:var(--muted);font-size:12px;">Sub\u00ed tu primer sticker con \u201c+ Subir\u201d</div>';
      return;
    }
    grid.innerHTML = state.stickers.map((s) =>
      `<div class="sticker" data-id="${escapeHTML(s.id)}">
        <img src="${escapeHTML(s.url)}" alt="${escapeHTML(s.name)}" />
        <span class="name">${escapeHTML(s.name)}</span>
        <button class="del" data-del="${escapeHTML(s.id)}" title="Borrar">\u00d7</button>
      </div>`
    ).join('');
    grid.querySelectorAll('.sticker').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.matches('.del')) return;
        sendSticker(el.dataset.id);
      });
    });
    grid.querySelectorAll('.del').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('\u00bfBorrar este sticker?')) return;
        try {
          const r = await api(`/api/stickers/${btn.dataset.del}`, { method: 'DELETE' });
          state.stickers = r.stickers || [];
          renderStickerGrid();
        } catch (err) { alert('Error: ' + err.message); }
      });
    });
  }
  async function sendSticker(id) {
    const fd = new FormData();
    fd.append('stickerId', id);
    fd.append('room', state.room);
    try {
      const r = await api('/api/messages', { method: 'POST', body: fd });
      if (r && r.message) appendMessage(r.message);
      const panel = $('#stickerPanel'); if (panel) panel.classList.add('hidden');
    } catch (e) { alert('Error: ' + e.message); }
  }
  function setupStickerPicker() {
    const btn = $('#stickerBtn');
    const panel = $('#stickerPanel');
    if (btn && panel) {
      btn.addEventListener('click', () => panel.classList.toggle('hidden'));
    }
    const closeBtn = $('#stickerClose');
    if (closeBtn) closeBtn.addEventListener('click', () => panel.classList.add('hidden'));
    const upload = $('#stickerUpload');
    if (upload) upload.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const name = prompt('Nombre del sticker (corto):', f.name.replace(/\.[^.]+$/, ''));
      if (!name) return;
      const fd = new FormData();
      fd.append('image', f);
      fd.append('name', name.slice(0, 32));
      try {
        const r = await api('/api/stickers', { method: 'POST', body: fd });
        state.stickers = r.stickers || [];
        renderStickerGrid();
      } catch (err) { alert('Error: ' + err.message); }
      e.target.value = '';
    });
  }

  // ----- Voice notes -----
  function setupVoiceRecorder() {
    const btn = $('#voiceBtn');
    const stopBtn = $('#voiceStop');
    const cancelBtn = $('#voiceCancel');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!state.me) { alert('Inicia sesi\u00f3n para enviar notas de voz'); return; }
      if (state.voice.recorder) return; // already recording
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const rec = new MediaRecorder(stream);
        state.voice.recorder = rec;
        state.voice.chunks = [];
        state.voice.started = Date.now();
        state.voice.stream = stream;
        rec.ondataavailable = (e) => { if (e.data && e.data.size) state.voice.chunks.push(e.data); };
        rec.onstop = onVoiceStop;
        rec.start();
        $('#voicePreview').classList.remove('hidden');
        const t = $('#voiceTimer');
        state.voice.timerId = setInterval(() => {
          const s = Math.floor((Date.now() - state.voice.started) / 1000);
          if (t) t.textContent = formatDuration(s);
          if (s >= 120) state.voice.recorder && state.voice.recorder.stop();
        }, 250);
      } catch (e) { alert('No se puede acceder al micr\u00f3fono: ' + e.message); }
    });
    if (stopBtn) stopBtn.addEventListener('click', () => {
      const r = state.voice.recorder;
      if (r && r.state !== 'inactive') r.stop();
    });
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      const r = state.voice.recorder;
      if (r) {
        state.voice.cancelled = true;
        if (r.state !== 'inactive') r.stop();
      }
    });
  }
  async function onVoiceStop() {
    const v = state.voice;
    clearInterval(v.timerId);
    v.timerId = 0;
    $('#voicePreview').classList.add('hidden');
    if (v.stream) v.stream.getTracks().forEach((t) => t.stop());
    const cancelled = v.cancelled;
    v.cancelled = false;
    const blob = new Blob(v.chunks, { type: v.recorder && v.recorder.mimeType ? v.recorder.mimeType : 'audio/webm' });
    state.voice = { recorder: null, chunks: [], started: 0, stream: null, timerId: 0 };
    if (cancelled || !blob.size) return;
    const fd = new FormData();
    fd.append('audio', blob, 'voice.webm');
    fd.append('room', state.room);
    try {
      const r = await api('/api/messages', { method: 'POST', body: fd });
      if (r && r.message) appendMessage(r.message);
    } catch (e) { alert('Error enviando audio: ' + e.message); }
  }

  // ----- Wire up nav -----
  function setupNav() {
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-route]');
      if (!t) return;
      e.preventDefault();
      go(t.dataset.route);
    });
    window.addEventListener('popstate', render);
  }

  // ----- Mobile drawer -----
  function setupMobileDrawer() {
    const sidebar = $('#sidebar');
    const backdrop = $('#sidebarBackdrop');
    const open = () => {
      if (sidebar) sidebar.classList.add('open');
      if (backdrop) backdrop.classList.add('open');
    };
    const close = () => {
      if (sidebar) sidebar.classList.remove('open');
      if (backdrop) backdrop.classList.remove('open');
    };
    const menuBtn = $('#mobileMenuBtn');
    if (menuBtn) menuBtn.addEventListener('click', open);
    const backBtn = $('#mobileBackBtn');
    if (backBtn) backBtn.addEventListener('click', open);
    const closeBtn = $('#sidebarClose');
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (backdrop) backdrop.addEventListener('click', close);
    // Close drawer when navigating
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !sidebar || !sidebar.classList.contains('open')) return;
      if (t.closest('[data-route]') || t.closest('.dm-thread') || t.closest('.channel-row') || t.closest('[data-server]')) {
        close();
      }
    });
  }

  // ----- Boot -----
  async function boot() {
    setupNav();
    setupComposer();
    setupAuthForms();

    try {
      state.config = await api('/api/config');
    } catch (err) {
      console.warn('config load failed', err);
      state.config = { pusher: { enabled: false } };
    }

    try {
      const data = await api('/api/auth/me');
      state.me = data.user;
    } catch (_e) { /* not logged in */ }

    applyAuthUI();
    render();

    // Notifications + side panels.
    const notifBtn = $('#notifBtn');
    if (notifBtn) notifBtn.addEventListener('click', toggleNotifPanel);
    const onlineToggle = $('#onlineToggle');
    if (onlineToggle) {
      onlineToggle.addEventListener('click', () => {
        const p = $('#onlinePanel'); if (p) p.classList.toggle('open');
      });
    }
    if (state.me) {
      loadNotifications().catch(() => {});
      loadServers().catch(() => {});
      loadDms().catch(() => {});
      loadStickers().catch(() => {});
    }

    setupVoiceRecorder();
    setupStickerPicker();
    setupDmControls();
    setupMobileDrawer();
    setupHeaderSearch();
  }

  function setupHeaderSearch() {
    const input = document.getElementById('searchInput');
    if (!input) return;
    let timer;
    const apply = () => {
      const q = (input.value || '').trim().toLowerCase();
      const list = document.getElementById('messages');
      if (!list) return;
      const items = list.querySelectorAll('.msg');
      if (!q) { items.forEach((el) => { el.style.display = ''; }); return; }
      items.forEach((el) => {
        const txt = (el.textContent || '').toLowerCase();
        el.style.display = txt.includes(q) ? '' : 'none';
      });
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 100); });
  }

  boot();
})();
