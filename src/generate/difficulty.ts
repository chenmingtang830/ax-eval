export const DIFFICULTY_LEVELS = ["L1", "L2", "L3", "L4"] as const;

export type DifficultyLevel = typeof DIFFICULTY_LEVELS[number];

export function missingDifficultyLevels(
  tasks: readonly { difficulty: string }[],
): DifficultyLevel[] {
  const present = new Set(tasks.map((task) => task.difficulty));
  return DIFFICULTY_LEVELS.filter((difficulty) => !present.has(difficulty));
}
