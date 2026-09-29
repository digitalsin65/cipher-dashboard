import type { SignalContribution } from '../types';
import { ScoreBar } from './ScoreBar';

interface Props {
  signals: SignalContribution[];
}

export function SignalBreakdown({ signals }: Props) {
  return (
    <div className="signals">
      {signals.map((s) => (
        <div key={s.key} className="signal-row">
          <div className="signal-row__head">
            <span className="signal-row__label">{s.label}</span>
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
