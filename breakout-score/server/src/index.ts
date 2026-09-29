import express from 'express';
import cors from 'cors';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig, runScoreCycle } from './engine/scoreEngine.js';
import { getCachedSnapshot, hasCache } from './services/cache.js';
import type { Snapshot } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3847);

let refreshing = false;
let lastRefreshError: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const snap = await runScoreCycle();
    lastRefreshError = snap.errors.length ? snap.errors[0]! : null;
    console.log(
      `[breakout] scored ${snap.symbolCount} coins @ ${snap.generatedAt}` +
        (snap.fromCache ? ' (cache fallback)' : '')
    );
  } catch (e) {
    lastRefreshError = e instanceof Error ? e.message : String(e);
    console.error('[breakout] refresh failed:', lastRefreshError);
  } finally {
    refreshing = false;
  }
}

function startPoller(): void {
  const cfg = loadConfig();
  void refresh();
  if (timer) clearInterval(timer);
  timer = setInterval(() => void refresh(), cfg.pollIntervalMs);
  console.log(`[breakout] poll interval ${cfg.pollIntervalMs}ms`);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasCache: hasCache(),
    refreshing,
    lastRefreshError,
    time: new Date().toISOString(),
  });
});

app.get('/api/scores', (_req, res) => {
  const snap = getCachedSnapshot();
  if (!snap) {
    res.status(503).json({
      error: 'No snapshot yet — engine still warming up',
      refreshing,
      lastRefreshError,
    });
    return;
  }
  const payload: Snapshot & { refreshing: boolean; lastRefreshError: string | null } = {
    ...snap,
    refreshing,
    lastRefreshError,
  };
  res.json(payload);
});

app.get('/api/config', (_req, res) => {
  res.json(loadConfig());
});

app.post('/api/refresh', async (_req, res) => {
  await refresh();
  const snap = getCachedSnapshot();
  res.json({ ok: true, symbolCount: snap?.symbolCount ?? 0, lastRefreshError });
});

// Serve Vite build in production if present
const clientDist = join(__dirname, '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(join(clientDist, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[breakout] API listening on http://localhost:${PORT}`);
  startPoller();
});
