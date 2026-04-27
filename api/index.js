// Vercel serverless entry point. Express app is exported as a request handler.
require('dotenv').config();
const { createApp } = require('../src/app');

const app = createApp();

module.exports = app;
