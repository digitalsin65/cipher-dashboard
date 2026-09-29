import type { Snapshot } from '../types.js';

let lastGood: Snapshot | null = null;

export function saveSnapshot(snap: Snapshot): void {
  lastGood = { ...snap, fromCache: false };
}

export function getCachedSnapshot(asStaleFallback = false): Snapshot | null {
  if (!lastGood) return null;
  if (asStaleFallback) {
    return { ...lastGood, fromCache: true };
  }
  return { ...lastGood };
}

export function hasCache(): boolean {
  return lastGood != null;
}
