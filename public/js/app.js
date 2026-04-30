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
    profileEditing: false,        // when true, profile shows the edit panel
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
    if (p === '/clips' || p.startsWith('/clips/')) return '/clips';
    if (p.startsWith('/invite/')) return '/invite';
    return '/';
  }
  function inviteCodeFromPath() {
    const p = location.pathname;
    if (!p.startsWith('/invite/')) return '';
    return p.slice('/invite/'.length).split(/[?#/]/)[0];
  }

  function render() {
    const route = currentRoute();
    $$('.view').forEach((v) => v.classList.add('hidden'));
    const target = $(`[data-view="${route}"]`);
    if (target) target.classList.remove('hidden');
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.route === route));

    if (route === '/') initChatView();
    if (route === '/clips') initClipsView();
    if (route === '/profile') renderProfileView();
    if (route === '/invite') openInvitePreview(inviteCodeFromPath());
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
      <div class="poll-q"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-bar-chart"/></svg> ${escapeHTML(m.poll.question)}</div>
      <div class="poll-opts">${opts}</div>
      <div class="poll-meta">${total} voto${total === 1 ? '' : 's'}</div>
    </div>`;
  }

  function renderReplyPreview(rt) {
    if (!rt) return '';
    const snippet = rt.snippet ? escapeHTML(rt.snippet) : (rt.snippetImage ? '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-image"/></svg> imagen' : '');
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
    tw(wrap);
    scrollToBottom();
  }

  function updateMessage(m) {
    state.messages.set(m.id, m);
    const list = $('#messages');
    const existing = list.querySelector(`[data-msg-id="${m.id}"]`);
    if (!existing) return appendMessage(m);
    renderMessageInto(existing, m);
    tw(existing);
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
      : (a.bot ? '<svg class="ic" aria-hidden="true" style="width:60%;height:60%"><use href="#i-bot"/></svg>' : escapeHTML((a.displayName || '?').charAt(0).toUpperCase()));
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
        <button class="msg-act" data-act="react" title="Reaccionar" aria-label="Reaccionar"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-smile"/></svg></button>
        <button class="msg-act" data-act="reply" title="Responder" aria-label="Responder"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-reply"/></svg></button>
        ${isMine && !isSystem && !isPoll ? '<button class="msg-act" data-act="edit" title="Editar" aria-label="Editar"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-edit"/></svg></button>' : ''}
        ${isMine ? '<button class="msg-act" data-act="delete" title="Borrar" aria-label="Borrar"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-trash"/></svg></button>' : ''}
        ${state.me && !isMine ? '<button class="msg-act" data-act="pin" title="Pinear en mi perfil" aria-label="Pinear"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-pin"/></svg></button>' : ''}
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
      if (nameEl) {
        // Bot: clicking the name inserts a mention into the composer
        // (so users can talk to UbreBot with one tap, without typing @).
        if (a.bot || a.username === 'ubrebot') {
          nameEl.title = 'Mencionar a UbreBot';
          nameEl.addEventListener('click', () => insertMention(a.displayName || 'UbreBot'));
        } else {
          nameEl.addEventListener('click', () => go(`/u/${a.username}`));
        }
      }
      // Bot avatar also inserts the mention.
      if (a.bot || a.username === 'ubrebot') {
        const av = wrap.querySelector('.msg-avatar');
        if (av) {
          av.style.cursor = 'pointer';
          av.title = 'Mencionar a UbreBot';
          av.addEventListener('click', () => insertMention(a.displayName || 'UbreBot'));
        }
      }
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
    tw(picker);
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
    const ti = $('#textInput');
    // If replying to UbreBot, prefix the mention so the bot actually sees it
    // and answers. (Bot replies are gated by isMentioned() server-side.)
    const a = m && m.author;
    if (ti && a && (a.bot || a.username === 'ubrebot')) {
      const cur = ti.value || '';
      if (!/(^|\s)@ubrebot\b/i.test(cur)) {
        ti.value = ('@UbreBot ' + cur).trimStart();
      }
    }
    if (ti) {
      ti.focus();
      try { ti.setSelectionRange(ti.value.length, ti.value.length); } catch (_) { /* noop */ }
    }
  }
  function insertMention(displayName) {
    const ti = $('#textInput');
    if (!ti) return;
    const handle = (displayName || 'UbreBot').replace(/\s+/g, '');
    const token = '@' + handle + ' ';
    const cur = ti.value || '';
    // If the same mention already at the start, just focus.
    const re = new RegExp('(^|\\s)@' + handle + '\\b', 'i');
    if (!re.test(cur)) ti.value = (token + cur).trimStart();
    ti.focus();
    try { ti.setSelectionRange(ti.value.length, ti.value.length); } catch (_) { /* noop */ }
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
      const snip = (rt.text || '').slice(0, 80) || (rt.imageUrl ? '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-image"/></svg> imagen' : '');
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
    el.innerHTML = `<div class="online-count">${items.length} en línea</div>` +
      items.slice(0, 50).map((u) => `<div class="online-row ${u.username ? 'clickable' : ''}" data-username="${escapeHTML(u.username || '')}">
        <span class="online-dot" style="background:${escapeHTML(u.color || '#7c5cff')}"></span>
        <span class="online-name ${decoClass(u.decoration)}">${escapeHTML(u.displayName)}</span>
      </div>`).join('');
    el.querySelectorAll('.online-row.clickable').forEach((r) => {
      r.addEventListener('click', () => { const u = r.dataset.username; if (u) go(`/u/${u}`); });
    });
    tw(el);
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
        // UbreBot is the AI bot; if Pusher delivered it before us, appendMessage
        // dedupes via state.seen so this is safe.
        if (data && data.ubreReply) {
          const ti = $('#typingIndicator');
          if (ti) { ti.classList.add('hidden'); ti.innerHTML = ''; }
          appendMessage(data.ubreReply);
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
        // Await loadServers before consumePendingInvite. Otherwise the GET
        // /api/servers response could resolve *after* the join and clobber
        // state.servers with a stale snapshot, dropping the freshly joined
        // server from the rail.
        await loadServers().catch(() => {});
        loadDms().catch(() => {});
        loadStickers().catch(() => {});
        await consumePendingInvite();
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
        // See login handler — must await before consumePendingInvite to
        // avoid clobbering state.servers with a pre-join snapshot.
        await loadServers().catch(() => {});
        loadDms().catch(() => {});
        loadStickers().catch(() => {});
        await consumePendingInvite();
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

    const editing = isMe && state.profileEditing;
    if (!isMe) state.profileEditing = false;
    const bannerClass = user.bannerUrl ? 'profile-banner has-image' : 'profile-banner';
    const profileClass = `profile effect-${effect}${editing ? ' is-editing' : ''}`;

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

    const stats = user.stats || {};
    const integ = user.integrations || { spotify: { connected: false }, brawlStars: { connected: false } };
    const memberSince = user.createdAt ? new Date(user.createdAt) : null;
    const memberSinceLabel = memberSince ? memberSince.toLocaleDateString('es-MX', { year: 'numeric', month: 'long', day: 'numeric' }) : '';

    const editToggleBtn = isMe ? `
      <button class="btn ${editing ? '' : 'btn-primary'} profile-edit-toggle" id="profileEditToggle">
        <svg class="ic ic-sm" aria-hidden="true"><use href="#${editing ? 'i-eye' : 'i-edit'}"/></svg>
        ${editing ? 'Volver al perfil' : 'Editar perfil'}
      </button>` : '';

    const bannerEditOverlay = (isMe && editing)
      ? `<div class="profile-banner-edit"><label class="btn" for="bannerInput"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-camera"/></svg> Cambiar banner</label><input type="file" id="bannerInput" accept="image/*,image/gif" class="file-input" /></div>`
      : '';

    const avatarEditOverlay = (isMe && editing)
      ? `<label class="avatar-edit-fab" for="avatarInput" title="Cambiar foto"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-camera"/></svg><input type="file" id="avatarInput" accept="image/*,image/gif" class="file-input" /></label>`
      : '';

    const shareRow = isMe ? `
      <div class="profile-share-row">
        <button class="btn btn-ghost btn-sm" id="copyProfileLink"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-link"/></svg> Copiar enlace</button>
      </div>` : (state.me ? `
      <div class="profile-share-row">
        <button class="btn btn-primary btn-sm" id="profileSendDmBtn"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-message"/></svg> Enviar DM</button>
        <button class="btn btn-ghost btn-sm" id="copyProfileLink"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-link"/></svg> Copiar enlace</button>
      </div>` : '');

    container.innerHTML = `
      <div class="${profileClass}" style="${styleVars}">
        ${editToggleBtn}
        <div class="${bannerClass}">
          <div class="profile-banner-aura" aria-hidden="true"></div>
          ${bannerEditOverlay}
        </div>
        <div class="profile-head">
          <div class="avatar-halo ${decoration !== 'none' ? `deco-halo-${decoration}` : ''}">
            <div class="${avatarFrameClasses}">${avatarTag}${avatarEditOverlay}</div>
          </div>
          <div class="profile-info">
            ${user.title ? `<div class="title-badge"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-zap"/></svg>${escapeHTML(user.title)}</div>` : ''}
            <h2 class="${fontClass(user.nameFont)}" style="color:${escapeHTML(accent)}">${escapeHTML(user.displayName)} ${pronounsHtml}</h2>
            <div class="handle">@${escapeHTML(user.username)}</div>
            <div class="profile-meta-row">
              ${memberSinceLabel ? `<span class="meta-chip"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-calendar"/></svg>Miembro desde ${escapeHTML(memberSinceLabel)}</span>` : ''}
              <span class="meta-chip"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-message"/></svg>${stats.messages || 0} msgs</span>
              ${stats.reactionsReceived ? `<span class="meta-chip"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-flame"/></svg>${stats.reactionsReceived} reacciones</span>` : ''}
            </div>
            ${statusHtml}
          </div>
        </div>
        ${shareRow}
        <div class="profile-bio">${bioHtml}</div>
        ${linksHtml ? `<div class="profile-links">${linksHtml}</div>` : ''}
        <div class="profile-stats-grid">
          <div class="stat-card"><div class="stat-icon"><svg class="ic" aria-hidden="true"><use href="#i-message"/></svg></div><div class="stat-num">${stats.messages || 0}</div><div class="stat-label">Mensajes</div></div>
          <div class="stat-card"><div class="stat-icon"><svg class="ic" aria-hidden="true"><use href="#i-image"/></svg></div><div class="stat-num">${stats.images || 0}</div><div class="stat-label">Imágenes</div></div>
          <div class="stat-card"><div class="stat-icon"><svg class="ic" aria-hidden="true"><use href="#i-mic"/></svg></div><div class="stat-num">${stats.voiceNotes || 0}</div><div class="stat-label">Notas de voz</div></div>
          <div class="stat-card"><div class="stat-icon"><svg class="ic" aria-hidden="true"><use href="#i-bar-chart"/></svg></div><div class="stat-num">${stats.polls || 0}</div><div class="stat-label">Encuestas</div></div>
          <div class="stat-card"><div class="stat-icon"><svg class="ic" aria-hidden="true"><use href="#i-flame"/></svg></div><div class="stat-num">${stats.reactionsReceived || 0}</div><div class="stat-label">Reacciones</div></div>
          <div class="stat-card"><div class="stat-icon"><svg class="ic" aria-hidden="true"><use href="#i-trophy"/></svg></div><div class="stat-num">${(user.achievements || []).length}</div><div class="stat-label">Logros</div></div>
        </div>
        <div class="profile-integrations" id="profileIntegrations">
          ${renderSpotifyCard(integ.spotify, user.username, isMe)}
          ${renderBrawlStarsCard(integ.brawlStars, isMe)}
        </div>
        <div id="pinnedSection" class="profile-pins"><h3><svg class="ic ic-sm" aria-hidden="true"><use href="#i-pin"/></svg> Mensajes destacados</h3><div id="pinnedMessages" class="muted">Cargando…</div></div>
        <div id="achievementsSection" class="profile-achievements"><h3><svg class="ic ic-sm" aria-hidden="true"><use href="#i-trophy"/></svg> Logros</h3><div id="achievementsGrid" class="achievement-grid"></div></div>
        ${editing ? renderEditor(user) : ''}
      </div>`;
    tw(container);

    // CSP-safe image fallbacks: hide BS CDN images that fail to load. Inline
    // onerror= attributes would be silently dropped by our CSP (no
    // 'unsafe-inline' on script-src).
    container.querySelectorAll('img.bs-player-icon, img.bs-brawler-img').forEach((img) => {
      img.onerror = () => { img.style.display = 'none'; };
    });

    if (isMe) {
      const editBtn = $('#profileEditToggle');
      if (editBtn) editBtn.addEventListener('click', () => {
        state.profileEditing = !state.profileEditing;
        renderProfileView();
        if (state.profileEditing) {
          // scroll editor into view so it's obvious where to edit
          setTimeout(() => {
            const ed = $('.profile-section');
            if (ed) ed.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 0);
        } else {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }

    loadPinnedMessages(user.username).catch(() => {});
    renderAchievements(user);
    loadSpotifyNowPlaying(user.username).catch(() => {});
    if (isMe) {
      if (editing) wireEditor(user);
      wireIntegrations();
      // Avatar / banner inputs only exist while editing.
      const avatarIn = $('#avatarInput');
      if (avatarIn) avatarIn.addEventListener('change', (e) => uploadProfileMedia(e.target, 'avatar'));
      const bannerIn = $('#bannerInput');
      if (bannerIn) bannerIn.addEventListener('change', (e) => uploadProfileMedia(e.target, 'banner'));
    }
    const copyBtn = $('#copyProfileLink');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(`${location.origin}/u/${user.username}`);
          copyBtn.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-check"/></svg> Copiado';
          setTimeout(() => { copyBtn.innerHTML = '<svg class="ic ic-sm" aria-hidden="true"><use href="#i-link"/></svg> Copiar enlace'; }, 1200);
        } catch (_e) { /* ignore */ }
      });
    }
    const dmBtn = $('#profileSendDmBtn');
    if (dmBtn) {
      dmBtn.addEventListener('click', async () => {
        try {
          await openDm(user.username);
          await loadDms();
        } catch (e) { alert('Error: ' + e.message); }
      });
    }
    handleSpotifyCallbackToast();
  }

  // ------- Integrations rendering -------
  function renderSpotifyCard(sp, username, isMe) {
    if (!sp || !sp.connected) {
      if (!isMe) return '';
      return `<div class="integ-card integ-spotify is-empty">
        <div class="integ-head"><svg class="ic" aria-hidden="true"><use href="#i-music"/></svg><span>Spotify</span></div>
        <p class="muted" style="margin:6px 0 12px">Conectá tu cuenta para mostrar lo que estás escuchando.</p>
        <a class="btn btn-spotify" href="/api/integrations/spotify/connect"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-music"/></svg> Conectar Spotify</a>
      </div>`;
    }
    return `<div class="integ-card integ-spotify" data-username="${escapeHTML(username)}">
      <div class="integ-head"><svg class="ic" aria-hidden="true"><use href="#i-music"/></svg><span>Spotify</span>
        ${sp.profileUrl ? `<a class="integ-badge" href="${escapeHTML(sp.profileUrl)}" target="_blank" rel="noopener">${escapeHTML(sp.displayName || 'Perfil')}</a>` : ''}
      </div>
      <div class="integ-body" id="spotifyNowPlaying">
        <div class="muted">Cargando…</div>
      </div>
      ${isMe ? `<div class="integ-foot">
        <button class="btn btn-ghost btn-sm" id="spotifyDisconnect"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-link-off"/></svg> Desconectar</button>
      </div>` : ''}
    </div>`;
  }

  function renderBrawlStarsCard(bs, isMe) {
    if (!bs || !bs.connected) {
      if (!isMe) return '';
      return `<div class="integ-card integ-bs is-empty">
        <div class="integ-head"><svg class="ic" aria-hidden="true"><use href="#i-gamepad"/></svg><span>Brawl Stars</span></div>
        <p class="muted" style="margin:6px 0 12px">Pegá tu tag (ej: <code>#YYY1234</code>) para mostrar tus trofeos, club y mejores brawlers.</p>
        <form id="bsConnectForm" class="bs-connect-row">
          <input type="text" id="bsTagInput" placeholder="#YOURTAG" maxlength="16" autocomplete="off" />
          <button class="btn btn-bs" type="submit"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-gamepad"/></svg> Conectar</button>
        </form>
        <p class="form-error" id="bsError"></p>
      </div>`;
    }
    const trophyPct = bs.highestTrophies > 0 ? Math.min(100, Math.round((bs.trophies / bs.highestTrophies) * 100)) : 0;
    const playerIcon = bs.iconId
      ? `<img class="bs-player-icon" src="https://cdn.brawlify.com/profile-icons/regular/${bs.iconId}.png" alt="" loading="lazy" />`
      : `<div class="bs-player-icon bs-icon-fallback"><svg class="ic" aria-hidden="true"><use href="#i-gamepad"/></svg></div>`;

    const topBrawlers = Array.isArray(bs.topBrawlers) ? bs.topBrawlers : [];
    const topBrawlersHtml = topBrawlers.slice(0, 3).map((b, i) => {
      const slug = String(b.name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const img = slug
        ? `<img class="bs-brawler-img" src="https://cdn.brawlify.com/brawlers/borderless/${slug}.png" alt="" loading="lazy" />`
        : '';
      const rankBadge = b.rank ? `<span class="bs-brawler-rank" data-rank="${Math.min(35, b.rank)}">R${b.rank}</span>` : '';
      const medal = ['gold', 'silver', 'bronze'][i] || '';
      return `<div class="bs-brawler-card ${medal ? `is-${medal}` : ''}">
        <div class="bs-brawler-medal">${i + 1}</div>
        <div class="bs-brawler-img-wrap">${img}</div>
        <div class="bs-brawler-name">${escapeHTML(b.name || '?')}</div>
        <div class="bs-brawler-meta">
          <span class="bs-brawler-trophies"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-trophy"/></svg>${b.trophies}</span>
          <span class="bs-brawler-power" title="Power level">⚡${b.power}</span>
        </div>
        ${rankBadge}
      </div>`;
    }).join('');

    const clubHtml = bs.club && bs.club.name
      ? `<div class="bs-club">
          <svg class="ic ic-sm" aria-hidden="true"><use href="#i-shield"/></svg>
          <span class="bs-club-label">Club</span>
          <strong>${escapeHTML(bs.club.name)}</strong>
        </div>`
      : '';

    return `<div class="integ-card integ-bs">
      <div class="integ-head"><svg class="ic" aria-hidden="true"><use href="#i-gamepad"/></svg><span>Brawl Stars</span>
        <span class="integ-badge">${escapeHTML(bs.tag)}</span>
      </div>
      <div class="integ-body">
        <div class="bs-hero">
          <div class="bs-hero-icon">${playerIcon}<span class="bs-hero-level">Lv ${bs.expLevel}</span></div>
          <div class="bs-hero-info">
            <div class="bs-name">${escapeHTML(bs.name || '')}</div>
            <div class="bs-hero-trophies">
              <svg class="ic" aria-hidden="true"><use href="#i-trophy"/></svg>
              <span class="bs-hero-trophies-num">${bs.trophies.toLocaleString('es-MX')}</span>
              <span class="bs-hero-trophies-label">trofeos</span>
            </div>
            <div class="bs-progress" title="Trofeos actuales / récord histórico">
              <div class="bs-progress-bar" style="width:${trophyPct}%"></div>
              <div class="bs-progress-meta"><span>${bs.trophies.toLocaleString('es-MX')}</span><span>récord ${bs.highestTrophies.toLocaleString('es-MX')}</span></div>
            </div>
          </div>
        </div>
        ${topBrawlersHtml ? `<div class="bs-top-brawlers"><div class="bs-section-title">Top brawlers</div><div class="bs-brawlers-row">${topBrawlersHtml}</div></div>` : ''}
        <div class="bs-stats">
          <div class="bs-stat"><div class="bs-stat-num">${bs.brawlersUnlocked}</div><div class="bs-stat-label"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-shield"/></svg>Brawlers</div></div>
          <div class="bs-stat"><div class="bs-stat-num">${bs.threeVsThreeVictories || 0}</div><div class="bs-stat-label"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-flame"/></svg>3v3</div></div>
          <div class="bs-stat"><div class="bs-stat-num">${bs.soloVictories || 0}</div><div class="bs-stat-label"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-zap"/></svg>Solo</div></div>
          <div class="bs-stat"><div class="bs-stat-num">${bs.duoVictories || 0}</div><div class="bs-stat-label"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-message"/></svg>Dúo</div></div>
        </div>
        ${clubHtml}
      </div>
      ${isMe ? `<div class="integ-foot">
        <button class="btn btn-ghost btn-sm" id="bsRefresh"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-zap"/></svg> Actualizar</button>
        <button class="btn btn-ghost btn-sm" id="bsDisconnect"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-link-off"/></svg> Desconectar</button>
      </div>` : ''}
    </div>`;
  }

  async function loadSpotifyNowPlaying(username) {
    const target = $('#spotifyNowPlaying');
    if (!target) return;
    try {
      const data = await api(`/api/integrations/spotify/now-playing/${encodeURIComponent(username)}`);
      if (!data.connected || !data.track) {
        target.innerHTML = '<div class="np-empty"><div class="np-empty-ic"><svg class="ic" aria-hidden="true"><use href="#i-music"/></svg></div><div class="np-empty-text"><strong>Nada sonando</strong><span class="muted">Cuando empiece a reproducir algo, se mostrará acá.</span></div></div>';
        return;
      }
      const t = data.track;
      const artists = (t.artists || []).map((a) => escapeHTML(a.name)).join(', ');
      const cover = t.album && t.album.image ? `<img class="np-cover" src="${escapeHTML(t.album.image)}" alt="" />` : '';
      const playingChip = data.isPlaying
        ? '<span class="np-chip is-live"><span class="np-dot"></span> Sonando ahora</span>'
        : '<span class="np-chip">Última escuchada</span>';
      const embed = t.id
        ? `<iframe class="np-embed" src="https://open.spotify.com/embed/track/${encodeURIComponent(t.id)}?utm_source=generator&theme=0" width="100%" height="80" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; picture-in-picture" loading="lazy"></iframe>`
        : '';
      const album = t.album && t.album.name ? `<div class="np-album">${escapeHTML(t.album.name)}</div>` : '';
      target.innerHTML = `
        <div class="np">
          ${cover}
          <div class="np-meta">
            ${playingChip}
            <a class="np-title" href="${escapeHTML(t.url || '#')}" target="_blank" rel="noopener">${escapeHTML(t.name)}</a>
            <div class="np-artist">${artists}</div>
            ${album}
          </div>
        </div>
        ${embed}
        <div class="np-actions">
          ${t.url ? `<a class="btn btn-spotify btn-sm" href="${escapeHTML(t.url)}" target="_blank" rel="noopener"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-music"/></svg> Abrir en Spotify</a>` : ''}
        </div>`;
    } catch (e) {
      target.innerHTML = `<div class="muted">No se pudo cargar Spotify.</div>`;
    }
  }

  function wireIntegrations() {
    // Spotify disconnect
    const spDisc = $('#spotifyDisconnect');
    if (spDisc) {
      spDisc.addEventListener('click', async () => {
        try {
          await api('/api/integrations/spotify/disconnect', { method: 'POST', body: {} });
          const r = await api(`/api/users/${encodeURIComponent(state.me.username)}`);
          state.me = { ...state.me, integrations: r.user.integrations };
          renderProfileView();
        } catch (err) { alert(err.message); }
      });
    }
    // BS connect form
    const bsForm = $('#bsConnectForm');
    if (bsForm) {
      bsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const tag = $('#bsTagInput').value.trim();
        const errorEl = $('#bsError');
        errorEl.textContent = '';
        try {
          await api('/api/integrations/brawlstars/connect', { method: 'POST', body: { tag } });
          const r = await api(`/api/users/${encodeURIComponent(state.me.username)}`);
          state.me = { ...state.me, integrations: r.user.integrations };
          renderProfileView();
        } catch (err) { errorEl.textContent = err.message; }
      });
    }
    // BS refresh / disconnect
    const bsRefresh = $('#bsRefresh');
    if (bsRefresh) {
      bsRefresh.addEventListener('click', async () => {
        try {
          await api('/api/integrations/brawlstars/refresh', { method: 'POST', body: {} });
          const r = await api(`/api/users/${encodeURIComponent(state.me.username)}`);
          state.me = { ...state.me, integrations: r.user.integrations };
          renderProfileView();
        } catch (err) { alert(err.message); }
      });
    }
    const bsDisc = $('#bsDisconnect');
    if (bsDisc) {
      bsDisc.addEventListener('click', async () => {
        try {
          await api('/api/integrations/brawlstars/disconnect', { method: 'POST', body: {} });
          const r = await api(`/api/users/${encodeURIComponent(state.me.username)}`);
          state.me = { ...state.me, integrations: r.user.integrations };
          renderProfileView();
        } catch (err) { alert(err.message); }
      });
    }
  }

  function handleSpotifyCallbackToast() {
    const params = new URLSearchParams(location.search);
    const sp = params.get('spotify');
    if (!sp) return;
    if (sp === 'ok') {
      console.log('Spotify conectado.');
    } else {
      console.warn('Spotify: ' + (params.get('reason') || sp));
    }
    // clean url
    history.replaceState({}, '', location.pathname);
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
    tw(grid);
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
        <button type="button" class="btn btn-ghost link-del" title="Quitar" aria-label="Quitar"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-x"/></svg></button>
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
        <button type="button" class="btn btn-ghost link-del" title="Quitar" aria-label="Quitar"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-x"/></svg></button>`;
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
        state.profileEditing = false;        // auto-return to view mode after save
        applyAuthUI();
        renderProfileView();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch (err) {
        errorEl.textContent = err.message;
      }
    });

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
    const inviteBtn = $('#inviteShareBtn');
    if (inviteBtn) inviteBtn.onclick = () => openInviteShareModal(state.activeServer);
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
  // ----- Modal helpers -----
  function showModal(id) {
    const m = $(id);
    if (m) m.classList.remove('hidden');
  }
  function hideModal(id) {
    const m = $(id);
    if (m) m.classList.add('hidden');
  }
  function bindModalDismiss(backdropId, closeBtnId) {
    const backdrop = $(backdropId);
    const close = $(closeBtnId);
    if (close) close.onclick = () => hideModal(backdropId);
    if (backdrop) backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) hideModal(backdropId);
    });
  }

  function openServerCreateModal() {
    if (!state.me) { alert('Inicia sesi\u00f3n para crear / unirte a un server'); return; }
    const setActiveTab = (which) => {
      $$('#serverModal .modal-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === which));
      $$('#serverModal .modal-tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== which));
    };
    setActiveTab('create');
    $$('#serverModal .modal-tab').forEach((b) => b.onclick = () => setActiveTab(b.dataset.tab));
    const nameI = $('#srvCreateName'); if (nameI) nameI.value = '';
    const iconI = $('#srvCreateIcon'); if (iconI) iconI.value = '';
    const codeI = $('#srvJoinCode'); if (codeI) codeI.value = '';
    const cErr = $('#srvCreateError'); if (cErr) cErr.textContent = '';
    const jErr = $('#srvJoinError'); if (jErr) jErr.textContent = '';
    const cBtn = $('#srvCreateBtn');
    if (cBtn) cBtn.onclick = async () => {
      const name = (nameI && nameI.value || '').trim();
      const icon = (iconI && iconI.value || '').trim();
      if (!name) { if (cErr) cErr.textContent = 'Pon\u00e9 un nombre'; return; }
      cBtn.disabled = true;
      try {
        const r = await api('/api/servers', { method: 'POST', body: { name, icon } });
        state.servers.push(r.server);
        hideModal('#serverModal');
        switchServer(r.server.id);
        // Open the invite-share modal so the user can immediately share the link.
        setTimeout(() => openInviteShareModal(r.server), 200);
      } catch (e) { if (cErr) cErr.textContent = 'Error: ' + e.message; }
      cBtn.disabled = false;
    };
    const jBtn = $('#srvJoinBtn');
    if (jBtn) jBtn.onclick = async () => {
      const code = (codeI && codeI.value || '').trim();
      if (!code) { if (jErr) jErr.textContent = 'Pon\u00e9 el c\u00f3digo o link'; return; }
      jBtn.disabled = true;
      try {
        const r = await api('/api/servers/join', { method: 'POST', body: { code } });
        if (!state.servers.some((s) => s.id === r.server.id)) state.servers.push(r.server);
        hideModal('#serverModal');
        switchServer(r.server.id);
        flashToast(`Te uniste a ${r.server.name}`);
      } catch (e) { if (jErr) jErr.textContent = 'Error: ' + e.message; }
      jBtn.disabled = false;
    };
    bindModalDismiss('#serverModal', '#serverModalClose');
    showModal('#serverModal');
    setTimeout(() => nameI && nameI.focus(), 50);
  }

  function openInviteShareModal(server) {
    if (!server || !server.inviteCode) {
      flashToast('Este server no tiene invitaci\u00f3n');
      return;
    }
    const url = `${location.origin}/invite/${server.inviteCode}`;
    const nameEl = $('#inviteShareName'); if (nameEl) nameEl.textContent = server.name;
    const urlEl = $('#inviteShareUrl'); if (urlEl) urlEl.value = url;
    const codeEl = $('#inviteShareCode'); if (codeEl) codeEl.textContent = server.inviteCode;
    const copyBtn = $('#inviteShareCopyBtn');
    if (copyBtn) copyBtn.onclick = () => {
      if (urlEl) { urlEl.select(); urlEl.setSelectionRange(0, 999); }
      navigator.clipboard.writeText(url)
        .then(() => flashToast('Link copiado'))
        .catch(() => flashToast('No se pudo copiar'));
    };
    const nativeBtn = $('#inviteShareNativeBtn');
    if (nativeBtn) {
      const canShare = typeof navigator.share === 'function';
      nativeBtn.style.display = canShare ? '' : 'none';
      nativeBtn.onclick = () => {
        navigator.share({ title: `Únete a ${server.name}`, text: `Te invito a ${server.name} en Foro34`, url })
          .catch(() => {});
      };
    }
    const waBtn = $('#inviteShareWhatsappBtn');
    if (waBtn) waBtn.onclick = () => {
      const text = encodeURIComponent(`Te invito a ${server.name} en Foro34: ${url}`);
      window.open(`https://wa.me/?text=${text}`, '_blank', 'noopener');
    };
    bindModalDismiss('#inviteShareModal', '#inviteShareClose');
    showModal('#inviteShareModal');
  }

  async function openInvitePreview(code) {
    // The /invite/:code route has no matching .view section, so dismissing
    // the modal would leave the user on a blank page. Bind a custom
    // backdrop handler that also navigates home, instead of using the
    // generic bindModalDismiss helper.
    const backdrop = $('#invitePreviewModal');
    if (backdrop) {
      backdrop.onclick = (e) => {
        if (e.target !== backdrop) return;
        hideModal('#invitePreviewModal');
        go('/', true);
      };
    }
    const content = $('#invitePreviewContent');
    if (!content) return;
    content.innerHTML = '<p class="muted" style="text-align:center;padding:20px">Cargando…</p>';
    showModal('#invitePreviewModal');
    let invite = null;
    try {
      const r = await api(`/api/servers/invite/${encodeURIComponent(code)}`);
      invite = r.invite;
    } catch (e) {
      content.innerHTML = `
        <div class="invite-preview-error">
          <h3>Invitación no válida</h3>
          <p class="muted">El link expiró o ya no existe.</p>
          <button class="btn btn-primary" id="invitePreviewBack">Volver al inicio</button>
        </div>`;
      const back = $('#invitePreviewBack');
      if (back) back.onclick = () => { hideModal('#invitePreviewModal'); go('/', true); };
      return;
    }
    if (!state.me) {
      content.innerHTML = `
        <div class="invite-preview-card">
          <div class="invite-preview-icon">${escapeHTML(invite.icon || invite.name.charAt(0).toUpperCase())}</div>
          <h3>${escapeHTML(invite.name)}</h3>
          <p class="muted"><strong>${invite.memberCount}</strong> miembro${invite.memberCount === 1 ? '' : 's'} · <strong>${invite.channelCount}</strong> canal${invite.channelCount === 1 ? '' : 'es'}</p>
          <p>Iniciá sesión o creá una cuenta para unirte.</p>
          <div class="invite-preview-actions">
            <button class="btn btn-primary" id="invitePreviewLogin">Iniciar sesión</button>
            <button class="btn btn-ghost" id="invitePreviewRegister">Crear cuenta</button>
          </div>
        </div>`;
      const login = $('#invitePreviewLogin');
      const reg = $('#invitePreviewRegister');
      // Stash the code so we auto-join after auth.
      try { sessionStorage.setItem('pendingInviteCode', code); } catch (_) { /* sessionStorage unavailable */ }
      if (login) login.onclick = () => { hideModal('#invitePreviewModal'); go('/login'); };
      if (reg) reg.onclick = () => { hideModal('#invitePreviewModal'); go('/register'); };
      return;
    }
    // Already a member?
    const existing = state.servers.find((s) => s.id === invite.serverId);
    if (existing) {
      hideModal('#invitePreviewModal');
      switchServer(existing.id);
      go('/', true);
      flashToast(`Ya sos miembro de ${invite.name}`);
      return;
    }
    content.innerHTML = `
      <div class="invite-preview-card">
        <div class="invite-preview-icon">${escapeHTML(invite.icon || invite.name.charAt(0).toUpperCase())}</div>
        <h3>${escapeHTML(invite.name)}</h3>
        <p class="muted"><strong>${invite.memberCount}</strong> miembro${invite.memberCount === 1 ? '' : 's'} · <strong>${invite.channelCount}</strong> canal${invite.channelCount === 1 ? '' : 'es'}</p>
        <div class="invite-preview-actions">
          <button class="btn btn-primary" id="invitePreviewJoin">Unirme</button>
          <button class="btn btn-ghost" id="invitePreviewCancel">Cancelar</button>
        </div>
        <p class="form-error" id="invitePreviewError"></p>
      </div>`;
    const cancel = $('#invitePreviewCancel');
    if (cancel) cancel.onclick = () => { hideModal('#invitePreviewModal'); go('/', true); };
    const join = $('#invitePreviewJoin');
    if (join) join.onclick = async () => {
      join.disabled = true;
      try {
        const r = await api('/api/servers/join', { method: 'POST', body: { code } });
        if (!state.servers.some((s) => s.id === r.server.id)) state.servers.push(r.server);
        hideModal('#invitePreviewModal');
        switchServer(r.server.id);
        go('/', true);
        flashToast(`Te uniste a ${r.server.name}`);
      } catch (e) {
        const err = $('#invitePreviewError');
        if (err) err.textContent = 'Error: ' + e.message;
        join.disabled = false;
      }
    };
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
    if (btn) btn.addEventListener('click', () => openDmPicker());
  }

  // Live-search modal to start a DM. Replaces the old prompt() flow with a
  // proper picker that hits /api/users?q=... so users don't need to know the
  // exact username up front.
  function openDmPicker() {
    if (!state.me) { alert('Inicia sesi\u00f3n para enviar DMs'); return; }
    const input = $('#dmPickerInput');
    const results = $('#dmPickerResults');
    if (!input || !results) return;
    input.value = '';
    results.innerHTML = '<p class="muted" style="padding:14px;text-align:center">Empez\u00e1 a escribir un username…</p>';
    let lastQuery = '';
    let debounceT = null;
    const runSearch = async (q) => {
      if (q === lastQuery) return;
      lastQuery = q;
      if (q.length < 2) {
        results.innerHTML = '<p class="muted" style="padding:14px;text-align:center">Escrib\u00ed al menos 2 letras…</p>';
        return;
      }
      try {
        const r = await api(`/api/users?q=${encodeURIComponent(q)}`);
        const users = (r.users || []).filter((u) => u.username !== (state.me && state.me.username));
        if (!users.length) {
          results.innerHTML = '<p class="muted" style="padding:14px;text-align:center">Sin resultados</p>';
          return;
        }
        results.innerHTML = users.map((u) => {
          const av = u.avatarUrl
            ? `<img src="${escapeHTML(u.avatarUrl)}" alt="" />`
            : escapeHTML((u.displayName || u.username || '?').charAt(0).toUpperCase());
          return `<button class="dm-picker-row" data-username="${escapeHTML(u.username)}">
            <span class="av" style="background:${escapeHTML(u.color || '#7c5cff')}">${av}</span>
            <span class="info">
              <span class="name">${escapeHTML(u.displayName || u.username)}</span>
              <span class="handle muted">@${escapeHTML(u.username)}</span>
            </span>
          </button>`;
        }).join('');
        results.querySelectorAll('.dm-picker-row').forEach((row) => {
          row.addEventListener('click', async () => {
            const uname = row.dataset.username;
            try {
              await openDm(uname);
              await loadDms();
              hideModal('#dmPickerModal');
            } catch (e) { alert('Error: ' + e.message); }
          });
        });
        // Avatars that 404 should not blast a broken-image icon (CSP-safe).
        results.querySelectorAll('.dm-picker-row .av img').forEach((img) => {
          img.onerror = () => { img.style.display = 'none'; };
        });
      } catch (e) {
        results.innerHTML = `<p class="form-error" style="padding:14px;text-align:center">${escapeHTML(e.message)}</p>`;
      }
    };
    input.oninput = () => {
      const q = input.value.trim().toLowerCase();
      clearTimeout(debounceT);
      debounceT = setTimeout(() => runSearch(q), 200);
    };
    bindModalDismiss('#dmPickerModal', '#dmPickerClose');
    showModal('#dmPickerModal');
    setTimeout(() => input.focus(), 50);
  }

  // After login/register, if the user clicked a /invite/<code> link before
  // authenticating, finalize the join silently.
  async function consumePendingInvite() {
    let code = '';
    try { code = sessionStorage.getItem('pendingInviteCode') || ''; } catch (_) { return; }
    if (!code) return;
    try { sessionStorage.removeItem('pendingInviteCode'); } catch (_) { /* sessionStorage unavailable */ }
    try {
      const r = await api('/api/servers/join', { method: 'POST', body: { code } });
      if (!state.servers.some((s) => s.id === r.server.id)) state.servers.push(r.server);
      switchServer(r.server.id);
      flashToast(`Te uniste a ${r.server.name}`);
    } catch (e) {
      flashToast('No pude unirte: ' + e.message);
    }
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
    setupOnlinePanelToggle();
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

  // ============================================================
  // Online panel toggle (visibilidad persistida en localStorage).
  // En desktop colapsa la columna del grid, en mobile abre/cierra
  // el drawer (.open). Refleja estado en aria-pressed para a11y.
  // ============================================================
  function setupOnlinePanelToggle() {
    const btn = $('#onlineToggle');
    const panel = $('#onlinePanel');
    const grid = document.querySelector('.chat-grid');
    if (!btn || !panel || !grid) return;
    const KEY = 'foro34.onlinePanelHidden';
    const isMobile = () => window.matchMedia('(max-width: 900px)').matches;
    const apply = () => {
      const hidden = localStorage.getItem(KEY) === '1';
      if (isMobile()) {
        // En mobile el panel arranca cerrado siempre; localStorage no aplica.
        panel.classList.remove('open');
        grid.classList.remove('online-collapsed');
        btn.setAttribute('aria-pressed', 'false');
      } else {
        grid.classList.toggle('online-collapsed', hidden);
        panel.classList.remove('open');
        btn.setAttribute('aria-pressed', String(!hidden));
      }
    };
    btn.addEventListener('click', () => {
      if (isMobile()) {
        const open = panel.classList.toggle('open');
        btn.setAttribute('aria-pressed', String(open));
      } else {
        const nowHidden = !grid.classList.contains('online-collapsed');
        grid.classList.toggle('online-collapsed', nowHidden);
        if (nowHidden) localStorage.setItem(KEY, '1');
        else localStorage.removeItem(KEY);
        btn.setAttribute('aria-pressed', String(!nowHidden));
      }
    });
    window.addEventListener('resize', apply);
    apply();
  }

  // ============================================================
  // Twemoji: reemplaza emojis nativos por SVGs estilo Twitter/Discord
  // (consistencia visual cross-platform). Se llama después de cada
  // render que pueda contener emojis (mensajes, online list, perfil…).
  // ============================================================
  function tw(el) {
    if (!el || !window.twemoji) return;
    try {
      window.twemoji.parse(el, {
        folder: 'svg',
        ext: '.svg',
        base: 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/',
        className: 'emoji',
      });
    } catch (_) { /* parser opcional, no bloquea */ }
  }

  // =====================================================
  // ===== CLIPS (TikTok-style vertical video feed) =====
  // =====================================================
  const clips = {
    videos: [],
    loading: false,
    noMore: false,
    observer: null,
    activeVideo: null,
    commentVideoId: null,
  };

  function initClipsView() {
    const feed = $('#clipsFeed');
    if (!feed) return;
    if (!clips.observer) {
      clips.observer = new IntersectionObserver(onClipVisible, {
        root: feed,
        threshold: 0.6,
      });
    }
    if (clips.videos.length === 0) loadClips(true);
    setupClipsUpload();
    setupClipsComments();
  }

  async function loadClips(reset) {
    if (clips.loading) return;
    clips.loading = true;
    const feed = $('#clipsFeed');
    if (reset) {
      clips.videos = [];
      clips.noMore = false;
      if (feed) feed.innerHTML = '<div class="clips-loader muted">Cargando clips...</div>';
    }
    try {
      const before = clips.videos.length ? clips.videos[clips.videos.length - 1].createdAt : '';
      const url = '/api/videos/feed?limit=10' + (before ? '&before=' + encodeURIComponent(before) : '');
      const data = await api(url);
      if (reset && feed) feed.innerHTML = '';
      if (!data.videos || data.videos.length === 0) {
        clips.noMore = true;
        if (clips.videos.length === 0 && feed) {
          feed.innerHTML = '<div class="clips-empty muted">No hay clips todavía. ¡Subí el primero!</div>';
        }
        return;
      }
      data.videos.forEach((v) => {
        clips.videos.push(v);
        const card = buildClipCard(v);
        if (feed) feed.appendChild(card);
      });
    } catch (err) {
      console.error('loadClips', err);
      if (feed && clips.videos.length === 0) {
        feed.innerHTML = '<div class="clips-empty muted">Error cargando clips.</div>';
      }
    } finally {
      clips.loading = false;
    }
  }

  function buildClipCard(v) {
    const card = document.createElement('div');
    card.className = 'clip-card';
    card.dataset.videoId = v.id;
    const liked = v.liked ? ' liked' : '';
    card.innerHTML = `
      <video class="clip-video" src="${escapeHTML(v.videoUrl)}" poster="${escapeHTML(v.thumbnailUrl)}"
             playsinline loop muted preload="metadata"></video>
      <div class="clip-tap-overlay"></div>
      <div class="clip-sidebar">
        <button class="clip-sb-btn clip-like-btn${liked}" data-id="${v.id}">
          <svg class="ic"><use href="#i-heart"/></svg>
          <span class="clip-like-count">${formatCount(v.likeCount)}</span>
        </button>
        <button class="clip-sb-btn clip-comment-btn" data-id="${v.id}">
          <svg class="ic"><use href="#i-message"/></svg>
          <span>${formatCount(v.commentCount)}</span>
        </button>
        <button class="clip-sb-btn clip-share-btn" data-id="${v.id}">
          <svg class="ic"><use href="#i-share"/></svg>
          <span>Compartir</span>
        </button>
      </div>
      <div class="clip-info">
        <a class="clip-author" href="/u/${escapeHTML(v.author.username)}" data-route="/u/${escapeHTML(v.author.username)}">
          <img class="clip-author-avatar" src="${v.author.avatarUrl || avatarFallback(v.author.displayName)}" alt="" />
          <span class="clip-author-name" style="color:${escapeHTML(v.author.color)}">${escapeHTML(v.author.displayName)}</span>
        </a>
        ${v.caption ? `<p class="clip-caption">${escapeHTML(v.caption)}</p>` : ''}
        ${v.tags && v.tags.length ? `<div class="clip-tags">${v.tags.map((t) => `<span class="clip-tag">#${escapeHTML(t)}</span>`).join(' ')}</div>` : ''}
      </div>
      <button class="clip-mute-btn" aria-label="Silenciar/Activar sonido">
        <svg class="ic"><use href="#i-volume-x"/></svg>
      </button>
    `;
    const video = card.querySelector('.clip-video');
    const muteBtn = card.querySelector('.clip-mute-btn');
    const tapOverlay = card.querySelector('.clip-tap-overlay');

    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      video.muted = !video.muted;
      muteBtn.innerHTML = video.muted
        ? '<svg class="ic"><use href="#i-volume-x"/></svg>'
        : '<svg class="ic"><use href="#i-volume"/></svg>';
    });

    tapOverlay.addEventListener('click', () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
      card.classList.toggle('paused', video.paused);
    });

    card.querySelector('.clip-like-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleClipLike(v.id, card);
    });
    card.querySelector('.clip-comment-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openClipComments(v.id);
    });
    card.querySelector('.clip-share-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      shareClip(v.id);
    });

    if (clips.observer) clips.observer.observe(card);

    return card;
  }

  function formatCount(n) {
    if (!n) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  function onClipVisible(entries) {
    entries.forEach((entry) => {
      const card = entry.target;
      const video = card.querySelector('.clip-video');
      if (!video) return;
      if (entry.isIntersecting) {
        if (clips.activeVideo && clips.activeVideo !== video) {
          clips.activeVideo.pause();
          clips.activeVideo.currentTime = 0;
        }
        clips.activeVideo = video;
        video.play().catch(() => {});
        card.classList.remove('paused');
        bumpView(card.dataset.videoId);
        // Infinite scroll: if near the end, load more.
        const idx = clips.videos.findIndex((v) => v.id === card.dataset.videoId);
        if (!clips.noMore && idx >= clips.videos.length - 3) loadClips(false);
      } else {
        video.pause();
      }
    });
  }

  const viewedClips = new Set();
  function bumpView(videoId) {
    if (viewedClips.has(videoId)) return;
    viewedClips.add(videoId);
    api(`/api/videos/${videoId}/view`, { method: 'POST' }).catch(() => {});
  }

  async function toggleClipLike(videoId, card) {
    try {
      const data = await api(`/api/videos/${videoId}/like`, { method: 'POST' });
      const btn = card.querySelector('.clip-like-btn');
      const count = card.querySelector('.clip-like-count');
      if (data.liked) btn.classList.add('liked');
      else btn.classList.remove('liked');
      if (count) count.textContent = formatCount(data.likeCount);
      const v = clips.videos.find((x) => x.id === videoId);
      if (v) { v.liked = data.liked; v.likeCount = data.likeCount; }
    } catch (e) { console.warn('like error', e); }
  }

  function shareClip(videoId) {
    const url = location.origin + '/clips/' + videoId;
    if (navigator.share) {
      navigator.share({ title: 'Foro34 Clip', url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => alert('Link copiado!')).catch(() => {});
    }
  }

  // ----- Clip comments -----
  function openClipComments(videoId) {
    clips.commentVideoId = videoId;
    const sheet = $('#clipCommentsSheet');
    if (!sheet) return;
    sheet.classList.remove('hidden');
    const list = $('#clipCommentsList');
    if (list) list.innerHTML = '<div class="muted" style="padding:12px">Cargando...</div>';
    loadClipComments(videoId);
  }

  function closeClipComments() {
    const sheet = $('#clipCommentsSheet');
    if (sheet) sheet.classList.add('hidden');
    clips.commentVideoId = null;
  }

  async function loadClipComments(videoId) {
    try {
      const data = await api(`/api/videos/${videoId}/comments`);
      const list = $('#clipCommentsList');
      const countEl = $('#clipCommentCount');
      if (countEl) countEl.textContent = data.total ? `(${data.total})` : '';
      if (!list) return;
      if (!data.comments || data.comments.length === 0) {
        list.innerHTML = '<div class="muted" style="padding:12px">Sin comentarios. ¡Sé el primero!</div>';
        return;
      }
      list.innerHTML = data.comments.map((c) => `
        <div class="clip-comment">
          <img class="clip-comment-avatar" src="${c.author.avatarUrl || avatarFallback(c.author.displayName)}" alt="" />
          <div class="clip-comment-body">
            <span class="clip-comment-name" style="color:${escapeHTML(c.author.color)}">${escapeHTML(c.author.displayName)}</span>
            <span class="clip-comment-text">${escapeHTML(c.text)}</span>
            <span class="clip-comment-time muted">${timeAgo(c.createdAt)}</span>
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.error('load comments', err);
    }
  }

  function timeAgo(dateStr) {
    const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
    if (diff < 60) return 'ahora';
    if (diff < 3600) return Math.floor(diff / 60) + ' min';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h';
    return Math.floor(diff / 86400) + ' d';
  }

  async function postClipComment() {
    const input = $('#clipCommentInput');
    if (!input || !clips.commentVideoId) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await api(`/api/videos/${clips.commentVideoId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      loadClipComments(clips.commentVideoId);
    } catch (e) {
      alert('Error: ' + (e.message || 'no se pudo comentar'));
    }
  }

  function setupClipsComments() {
    const closeBtn = $('#clipCommentsClose');
    if (closeBtn) closeBtn.onclick = closeClipComments;
    const sendBtn = $('#clipCommentSend');
    if (sendBtn) sendBtn.onclick = postClipComment;
    const input = $('#clipCommentInput');
    if (input) input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postClipComment(); }
    });
  }

  // ----- Clip upload -----
  let clipFile = null;

  function setupClipsUpload() {
    const btn = $('#clipsUploadBtn');
    const modal = $('#clipUploadModal');
    const closeBtn = $('#clipUploadClose');
    const fileInput = $('#clipFileInput');
    const fileDrop = $('#clipFileDrop');
    const preview = $('#clipPreviewVideo');
    const submitBtn = $('#clipSubmitBtn');

    if (!btn || !modal) return;
    btn.onclick = () => { if (!state.me) { go('/login'); return; } modal.classList.remove('hidden'); };
    if (closeBtn) closeBtn.onclick = () => { modal.classList.add('hidden'); resetClipForm(); };
    modal.addEventListener('click', (e) => { if (e.target === modal) { modal.classList.add('hidden'); resetClipForm(); } });

    if (fileInput) fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (f) setClipFile(f, preview, submitBtn, fileDrop);
    });
    if (fileDrop) {
      fileDrop.addEventListener('dragover', (e) => { e.preventDefault(); fileDrop.classList.add('dragover'); });
      fileDrop.addEventListener('dragleave', () => { fileDrop.classList.remove('dragover'); });
      fileDrop.addEventListener('drop', (e) => {
        e.preventDefault();
        fileDrop.classList.remove('dragover');
        const f = e.dataTransfer.files[0];
        if (f && f.type.startsWith('video/')) setClipFile(f, preview, submitBtn, fileDrop);
      });
    }
    if (submitBtn) submitBtn.onclick = submitClip;
  }

  function setClipFile(file, preview, submitBtn, fileDrop) {
    clipFile = file;
    if (preview) {
      preview.src = URL.createObjectURL(file);
      preview.classList.remove('hidden');
      preview.play().catch(() => {});
    }
    if (fileDrop) fileDrop.classList.add('hidden');
    if (submitBtn) submitBtn.disabled = false;
  }

  function resetClipForm() {
    clipFile = null;
    const preview = $('#clipPreviewVideo');
    if (preview) { preview.src = ''; preview.classList.add('hidden'); }
    const fileDrop = $('#clipFileDrop');
    if (fileDrop) fileDrop.classList.remove('hidden');
    const caption = $('#clipCaption');
    if (caption) caption.value = '';
    const tags = $('#clipTags');
    if (tags) tags.value = '';
    const submitBtn = $('#clipSubmitBtn');
    if (submitBtn) submitBtn.disabled = true;
    const progress = $('#clipProgress');
    if (progress) progress.classList.add('hidden');
  }

  async function submitClip() {
    if (!clipFile) return;
    const submitBtn = $('#clipSubmitBtn');
    const progress = $('#clipProgress');
    const progressText = $('#clipProgressText');
    if (submitBtn) submitBtn.disabled = true;
    if (progress) progress.classList.remove('hidden');
    if (progressText) progressText.textContent = 'Subiendo...';

    const fd = new FormData();
    fd.append('video', clipFile);
    const caption = ($('#clipCaption') || {}).value || '';
    const tags = ($('#clipTags') || {}).value || '';
    if (caption) fd.append('caption', caption);
    if (tags) fd.append('tags', tags);

    try {
      const data = await api('/api/videos', { method: 'POST', body: fd });
      if (data && data.video) {
        clips.videos.unshift(data.video);
        const feed = $('#clipsFeed');
        if (feed) {
          const empty = feed.querySelector('.clips-empty');
          if (empty) empty.remove();
          feed.prepend(buildClipCard(data.video));
        }
      }
      const modal = $('#clipUploadModal');
      if (modal) modal.classList.add('hidden');
      resetClipForm();
    } catch (e) {
      alert('Error subiendo clip: ' + (e.message || 'desconocido'));
      if (submitBtn) submitBtn.disabled = false;
    } finally {
      if (progress) progress.classList.add('hidden');
    }
  }
  // ===== END CLIPS =====

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
