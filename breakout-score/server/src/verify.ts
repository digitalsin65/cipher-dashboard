/**
 * One-shot verification: run a score cycle and print top results.
 * Exit 0 if ≥5 coins scored; else exit 1.
 */
import { loadConfig, runScoreCycle } from './engine/scoreEngine.js';

async function main() {
  console.log('Loading config…');
  const cfg = loadConfig();
  console.log(
    `Config: maxSymbols=${cfg.maxSymbols}, interval=${cfg.klinesInterval}, minVol=${cfg.minQuoteVolumeUsdt}`
  );
  console.log('Running score cycle (Binance public REST)…');
  const snap = await runScoreCycle(cfg);
  console.log(`Scored ${snap.symbolCount} coins at ${snap.generatedAt}`);
  if (snap.errors.length) {
    console.log(`Warnings/errors (${snap.errors.length}):`);
    snap.errors.slice(0, 8).forEach((e) => console.log('  -', e));
  }
  console.log('\nTop 10 by Breakout Score:');
  for (const c of snap.coins.slice(0, 10)) {
    console.log(
      `  ${c.breakoutScore.toString().padStart(3)}  ${c.symbol.padEnd(12)}  ` +
        `px=${c.price}  24h=${c.change24h.toFixed(2)}%`
    );
  }
  if (snap.symbolCount < 5) {
    console.error('FAIL: fewer than 5 scored coins');
    process.exit(1);
  }
  console.log('\nVERIFY OK');
}

main().catch((e) => {
  console.error('VERIFY FAILED', e);
  process.exit(1);
});
