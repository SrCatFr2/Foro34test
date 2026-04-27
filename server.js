// Local development server. On Vercel the app is invoked via api/index.js.
require('dotenv').config();
const { createApp } = require('./src/app');

const app = createApp();
const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Foro34test chat listening on http://localhost:${port}`);
});
