/**
 * AX composite helpers. Component scores stay independently reportable; the
 * composite is a secondary summary that penalizes a weak discovery or
 * usability component instead of allowing one to fully compensate for the
 * other.
 */

export function harmonicMean(left: number, right: number): number {
  if (!Number.isFinite(left) || left < 0 || left > 1) throw new Error("left score must be between 0 and 1");
  if (!Number.isFinite(right) || right < 0 || right > 1) throw new Error("right score must be between 0 and 1");
  if (left === 0 || right === 0) return 0;
  return (2 * left * right) / (left + right);
}

export interface AxCompositeScore {
  usability: number;
  discovery: number;
  ax_score: number;
  formula: "harmonic_mean";
}

export function axCompositeScore(usability: number, discovery: number): AxCompositeScore {
  return {
    usability,
    discovery,
    ax_score: harmonicMean(usability, discovery),
    formula: "harmonic_mean",
  };
}
