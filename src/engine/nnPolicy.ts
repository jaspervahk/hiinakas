// NN-guided rollout policy and value function.
// Used by the engine worker to replace the heuristic policy when model weights are loaded.

import type { PartialBoard } from './types'
import type { Placement } from './placement'
import { legalPlacements, applyPlacement } from './placement'
import { encodeBoardState } from './encode'
import type { MLPWeights } from './mlpInference'
import { mlpForward } from './mlpInference'

// Evaluate a board state (after placement) using the value network.
// discards: actor's own discards including the one just made on this street.
export function nnValue(
  weights: MLPWeights,
  board: PartialBoard,
  street: number,
  oppBoards: readonly PartialBoard[],
  discards: readonly import('./types').Card[] = [],
): number {
  const features = encodeBoardState(board, street, oppBoards, discards)
  return mlpForward(weights, features)
}

// NN-guided policy: enumerate all legal placements, pick the one whose
// resulting board state has the highest predicted value.
// priorDiscards: actor's discards from streets before this one (current discard appended internally).
export function nnPickPlacement(
  weights: MLPWeights,
  board: PartialBoard,
  hand: readonly import('./types').Card[],
  street: number,
  oppBoards: readonly PartialBoard[],
  priorDiscards: readonly import('./types').Card[] = [],
): Placement {
  const candidates = legalPlacements(board, hand, street)
  if (candidates.length === 0) throw new Error('No legal placements')
  if (candidates.length === 1) return candidates[0]!

  let bestVal = -Infinity
  let bestPl = candidates[0]!
  for (const pl of candidates) {
    const boardAfter = applyPlacement(board, pl)
    const allDiscards = pl.discard ? [...priorDiscards, pl.discard] : priorDiscards
    const val = nnValue(weights, boardAfter, street, oppBoards, allDiscards)
    if (val > bestVal) { bestVal = val; bestPl = pl }
  }
  return bestPl
}
