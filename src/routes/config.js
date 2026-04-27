const express = require('express');

const router = express.Router();

// Public config used by the client (Pusher key + cluster are safe to expose).
// `enabled` requires ALL four Pusher env vars so the server is also able to
// broadcast — otherwise the client would subscribe and never receive anything.
router.get('/', (_req, res) => {
  const e = process.env;
  const ready = Boolean(e.PUSHER_APP_ID && e.PUSHER_KEY && e.PUSHER_SECRET && e.PUSHER_CLUSTER);
  res.json({
    pusher: {
      key: e.PUSHER_KEY || '',
      cluster: e.PUSHER_CLUSTER || '',
      enabled: ready,
    },
  });
});

module.exports = router;
