# Testing the Foro34 chat app

Full-stack chat app: Express + MongoDB (Atlas) + Cloudinary + Pusher (optional). Vercel-targeted via `api/index.js`. Static frontend in `public/` (vanilla JS SPA).

## Devin Secrets Needed

Required for any meaningful testing (the server refuses to start without these):

- `MONGODB_URI` — MongoDB Atlas connection string
- `JWT_SECRET` — any strong random string; must be the same across server restarts or auth cookies stop working
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`

Optional (controls real-time path):

- `PUSHER_APP_ID`, `PUSHER_KEY`, `PUSHER_SECRET`, `PUSHER_CLUSTER` — **all four** must be set, otherwise the client falls back to polling every 3 s.

## Run locally

```
npm install
npm run dev   # node server.js, listens on http://localhost:3000
```

Quick env-loaded sanity check before doing UI work:

```
curl -s localhost:3000/api/health   # {ok:true, hasMongo:true, hasCloudinary:true, hasPusher:bool}
curl -s localhost:3000/api/config   # {pusher:{key, cluster, enabled}}
```

`hasPusher` and `config.pusher.enabled` are derived from whether all four Pusher vars are set; the chat UI shows a badge **"tiempo real desactivado"** when this is false. That badge is the fastest way to confirm which delivery path you are about to test.

## Primary flow worth re-testing

1. Anonymous post — visit `/`, type into composer; message renders as `Anon-<digits>` with italic muted styling. Anon name is derived from a hash of the IP, so two windows on the same loopback share the same anon name.
2. Register — `/register`, fill all fields (`username` is lowercase a–z 0–9 _, 3–24 chars). On success the sidebar swaps to show `displayName @username` + `Cerrar sesión`, and a `Mi perfil` nav appears.
3. Authed post — message bubble shows `displayName` in the user's color (random palette), avatar circle uses their letter or uploaded image. Distinct from anon styling.
4. Profile edit — `/profile`, change `displayName`, `bio`, `color`. **Always hard-refresh (Ctrl+F5) and re-check** to verify persistence in Mongo, not just client state.
5. Avatar upload — `Cambiar foto` label triggers a hidden `<input id="avatarInput">` whose change handler PATCHes `/api/users/me/avatar`. Server returns the user object including a `res.cloudinary.com/<cloud>/image/upload/.../foro34/avatars/<id>.png` URL.
6. Banner upload — same pattern with `#bannerInput` → `/api/users/me/banner` → `foro34/banners/...`.
7. Image-attached message — paperclip icon in composer triggers `#imageInput`. `POST /api/messages` (multipart) returns the message with `imageUrl` under `foro34/messages/...`.
8. Cross-window delivery — open a second window in incognito (clean cookies = anon). Post in window A; window B should show the new message within ~3 s when in polling mode, ~instant with Pusher.
9. Public profile — `/u/<username>` — banner, avatar, displayName, bio, color all render. **Edit form must be hidden** when the visitor is not the owner.
10. Logout — `Cerrar sesión` clears the cookie; sidebar reverts.

## Known UI quirks / workarounds

- **Hidden `<input type="file">` label-click can be flaky in headless-ish Chrome on this VM.** The OS file picker sometimes fails to open on the *second* click of a session (the first usually works). The DOM, change handler, and backend route are all correct — confirmed by attaching the file directly via Playwright over CDP, which fires the same `change` handler and uses the same multipart endpoint:

  ```js
  import { chromium } from 'playwright';
  const browser = await chromium.connectOverCDP('http://localhost:29229');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url() === 'http://localhost:3000/profile');
  await page.setInputFiles('#bannerInput', '/tmp/banner.png');  // or #avatarInput, #imageInput
  ```

  Use this as a **last resort**, only after a couple of UI clicks fail; the user should still be able to upload normally in production.

- **Chat composer form is `#composer`, not `#sendBtn`.** To submit programmatically: `await page.evaluate(() => document.querySelector('#composer').requestSubmit())`.

- **Auth cookie disappearing across local server restarts is suspicious** and was observed once during testing. The JWT secret should be a stable env var, not a randomized in-memory value. If you observe this, re-login via the UI and continue, but flag it for the user — JWT_SECRET literal must be stable for cookies to keep working across restarts.

- **Anon-name collisions on localhost.** Both browser windows on localhost share `127.0.0.1`, so they will get the same `Anon-XXXX`. To prove cross-user delivery, register one window as a real user and keep the second window anonymous instead of trying to use two anon windows.

## Recording and annotations

- Always maximize the browser window before recording (`xdotool getactivewindow windowsize 100% 100%` works on this VM; `wmctrl` is not installed by default).
- Annotate **before** each `test_start` and **right after** the assertion for that test — the video slows down on annotations so they double as section markers for the user.
- Keep assertion text under 80 chars and consolidated (one assertion = one meaningful state change, not per-element).

## Out-of-scope test areas (deliberate)

- Multi-room chat: the schema has a `room` field but the UI only shows `global`.
- Rate limits: 8 messages/10 s on send, 30 auth requests/15 min — exceeding them in tests is more annoying than informative.
- Pusher real-time path itself: only worth testing once all four `PUSHER_*` env vars are configured. The polling fallback is what runs without them and is what currently runs in production-like setups missing those credentials.
