import type { SignalContribution } from '../types';
import { ScoreBar } from './ScoreBar';

const TIPS: Record<string, string> = {
  accumulation: 'Signs that buyers are quietly building positions: price holding steady while buying volume creeps up.',
  floorDistance: 'How close price is to its recent support floor. Closer to the floor means less room to fall before a bounce.',
  bearTrap: 'Price dipped below support then quickly snapped back above it, shaking out sellers. Often a bullish reversal sign.',
  momentumIgnition: 'Early signs of a move starting: recent candles speeding up in one direction after a quiet period.',
  volatilitySqueeze: 'Price range has tightened a lot, like a coiled spring. Big moves often follow a squeeze.',
  volumePressure: 'Whether recent trading volume is mostly buying or selling, compared with normal volume.',
  rsiResistance: 'RSI measures if a coin is overbought or oversold (0-100). This combines it with how close price is to a resistance level it needs to break.',
};


interface Props {
  signals: SignalContribution[];
}

export function SignalBreakdown({ signals }: Props) {
  return (
    <div className="signals">
      {signals.map((s) => (
        <div key={s.key} className="signal-row">
          <div className="signal-row__head">
            <span className="signal-row__label tip" tabIndex={0} data-tip={TIPS[s.key] ?? ''}>{s.label}<span className="tip__icon">i</span></span>
            <span className="signal-row__meta">
              {s.score}
              <span className="dim"> /100 · w{s.weight} · +{s.contribution.toFixed(1)}</span>
            </span>
          </div>
          <ScoreBar score={s.score} />
          <div className="signal-row__detail">{s.detail}</div>
        </div>
      ))}
    </div>
  );
}
