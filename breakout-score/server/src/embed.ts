// In-process Breakout engine for hosts that block internal ports (e.g. Hostinger).
import { Router } from 'express';
import { loadConfig, runScoreCycle } from './engine/scoreEngine.js';
import { getCachedSnapshot } from './services/cache.js';

let refreshing = false;
let lastRefreshError: string | null = null;

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const snap = await runScoreCycle();
    lastRefreshError = snap.errors.length ? snap.errors[0]! : null;
    console.log(`[breakout] scored ${snap.symbolCount} coins @ ${snap.generatedAt}`);
  } catch (e) {
    lastRefreshError = e instanceof Error ? e.message : String(e);
    console.error('[breakout] refresh failed:', lastRefreshError);
  } finally {
    refreshing = false;
  }
}

export function createBreakoutRouter() {
  const cfg = loadConfig();
  void refresh();
  setInterval(() => void refresh(), cfg.pollIntervalMs);
  console.log(`[breakout] in-process, poll interval ${cfg.pollIntervalMs}ms`);

  const r = Router();
  r.get('/api/health', (_q, res) => res.json({ ok: true, refreshing, lastRefreshError, time: new Date().toISOString() }));
  r.get('/api/scores', (_q, res) => {
    const snap = getCachedSnapshot();
    if (!snap) { res.status(503).json({ error: 'No snapshot yet - engine still warming up', refreshing, lastRefreshError }); return; }
    res.json({ ...snap, refreshing, lastRefreshError });
  });
  r.get('/api/config', (_q, res) => res.json(loadConfig()));
  r.post('/api/refresh', async (_q, res) => {
    await refresh();
    const snap = getCachedSnapshot();
    res.json({ ok: true, symbolCount: snap?.symbolCount ?? 0, lastRefreshError });
  });
  return r;
}