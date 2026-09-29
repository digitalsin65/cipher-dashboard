import { useCallback, useEffect, useState } from 'react';
import type { Snapshot } from '../types';

const POLL_MS = 15_000;

export function useScores() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/scores');
      if (res.status === 503) {
        const body = await res.json();
        setError(body.error || 'Warming up…');
        setLoading(true);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as Snapshot;
      setData(json);
      setError(null);
      setLoading(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const refresh = useCallback(async () => {
    try {
      await fetch('/api/refresh', { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load]);

  return { data, error, loading, refresh };
}
