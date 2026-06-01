// NN-guided rollout policy and value function.
// Used by the engine worker to replace the heuristic policy when model weights are loaded.

import type { PartialBoard } from './types'
import type { Placement } from './placement'
import { legalPlacements, applyPlacement } from './placement'
import { encodeBoardState } from './encode'
import type { MLPWeights } from './mlpInference'
import { mlpForward } from './mlpInference'

// Evaluate a board state (after placement) using the value network.
// oppBoards: revealed opponent boards at the time of this decision.
export function nnValue(
  weights: MLPWeights,
  board: PartialBoard,
  street: number,
  oppBoards: readonly PartialBoard[],
): number {
  const features = encodeBoardState(board, street, oppBoards)
  return mlpForward(weights, features)
}

// NN-guided policy: enumerate all legal placements, pick the one whose
// resulting board state has the highest predicted value.
// oppBoards: the visible opponent boards (for context, treated as fixed in rollout).
export function nnPickPlacement(
  weights: MLPWeights,
  board: PartialBoard,
  hand: readonly import('./types').Card[],
  street: number,
  oppBoards: readonly PartialBoard[],
): Placement {
  const candidates = legalPlacements(board, hand, street)
  if (candidates.length === 0) throw new Error('No legal placements')
  if (candidates.length === 1) return candidates[0]!

  let bestVal = -Infinity
  let bestPl = candidates[0]!
  for (const pl of candidates) {
    const boardAfter = applyPlacement(board, pl)
    const val = nnValue(weights, boardAfter, street, oppBoards)
    if (val > bestVal) { bestVal = val; bestPl = pl }
  }
  return bestPl
}
