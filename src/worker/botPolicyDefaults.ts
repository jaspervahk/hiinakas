import type { BotPolicy } from './types'

export const DEFAULT_ROOT_TOP_K = 35

// Sims budget is clamped to [MIN_SIMS, MAX_SIMS] everywhere it is settable.
//
// The floor of 200 is measured, not a guess. Selection regret — the expected
// points lost by picking a candidate that is not actually the best available —
// was measured against independently-estimated ground truth at street 0 over
// 30 positions:
//
//   sims     20     50    100    200    400    800   2000
//   regret  0.593  0.382  0.279  0.150  0.104  0.055  0.025   points/decision
//
// The old heuristic default of 20 was therefore throwing away ~0.59 points on
// every decision, far more than any policy change measured in this codebase.
// 200 costs roughly 1.9s on a street-0 decision now (it would have cost ~26s
// before the evaluator/scoring/opening-book work) and cuts that to 0.150.
//
// The ceiling of 2000 is where regret has flattened to 0.025 and the
// winner's-curse bias on the displayed EV reaches zero (measured -0.013);
// beyond it there is nothing left to buy.
export const MIN_SIMS = 200
export const MAX_SIMS = 2000

export const DEFAULT_SIMS_FOR: Record<BotPolicy, number> = {
  nn: MIN_SIMS,
  royalty: MIN_SIMS,
  'royalty-nn': MIN_SIMS,
  heuristic: MIN_SIMS,
}
export const MAX_SIMS_FOR: Record<BotPolicy, number> = {
  nn: MAX_SIMS,
  royalty: MAX_SIMS,
  'royalty-nn': MAX_SIMS,
  heuristic: MAX_SIMS,
}

// Clamp any user-entered sims value into the supported range.
export const clampSims = (n: number): number =>
  Math.max(MIN_SIMS, Math.min(MAX_SIMS, Number.isFinite(n) ? Math.round(n) : MIN_SIMS))
