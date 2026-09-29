interface Props {
  score: number;
  max?: number;
}

export function ScoreBar({ score, max = 100 }: Props) {
  const pct = Math.max(0, Math.min(100, (score / max) * 100));
  const tone = score >= 70 ? 'hot' : score >= 50 ? 'warm' : 'cool';
  return (
    <div className={`score-bar score-bar--${tone}`}>
      <div className="score-bar__fill" style={{ width: `${pct}%` }} />
    </div>
  );
}
