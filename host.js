// Starts everything CIPHER needs in ONE process, for hosts that run a single "node" entry file.
// The Breakout engine runs inside this process (no internal port), then the dashboard starts.
const path = require('path');
const { pathToFileURL } = require('node:url');

(async () => {
  try {
    const mod = await import(pathToFileURL(path.join(__dirname, 'breakout-score', 'dist', 'server', 'embed.js')).href);
    global.__BREAKOUT_ROUTER = mod.createBreakoutRouter();
  } catch (e) {
    console.error('[host] Breakout failed to load:', e);
  }
  require('./server.js');
})();