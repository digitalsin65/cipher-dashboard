// Starts everything CIPHER needs in ONE process tree, for hosts that run a single "node" entry file.
//  - Breakout Score engine on an internal port (never exposed directly)
//  - CIPHER dashboard on the port the host assigns (process.env.PORT)
const { spawn } = require('child_process');
const path = require('path');

const BREAKOUT_PORT = process.env.BREAKOUT_PORT || '3847';

function startBreakout() {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join('server', 'src', 'index.ts')],
    {
      cwd: path.join(__dirname, 'breakout-score'),
      env: { ...process.env, PORT: BREAKOUT_PORT },
      stdio: 'inherit',
    }
  );
  child.on('exit', (code) => {
    console.error(`[host] Breakout exited (${code}), restarting in 5s`);
    setTimeout(startBreakout, 5000);
  });
}

startBreakout();
process.env.BREAKOUT_PORT = BREAKOUT_PORT;
require('./server.js');