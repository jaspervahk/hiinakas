import type { BotPolicy } from './types'

export const DEFAULT_ROOT_TOP_K = 35

// Heuristic MC brute-forces a full rollout per candidate with no NN/tree-search
// guidance, so it needs a far smaller sims budget than the MCTS-based modes to
// stay usable over a whole session (mirrors the same tradeoff in Arena/coach).
export const DEFAULT_SIMS_FOR: Record<BotPolicy, number> = {
  nn: 500,
  royalty: 1000,
  'royalty-nn': 1000,
  heuristic: 20,
}
export const MAX_SIMS_FOR: Record<BotPolicy, number> = {
  nn: 10_000,
  royalty: 10_000,
  'royalty-nn': 10_000,
  heuristic: 500,
}
