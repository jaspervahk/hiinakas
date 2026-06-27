// NN-guided rollout policy and value function.
// Used by the engine worker to replace the heuristic policy when model weights are loaded.

import type { Card, PartialBoard } from './types'
import type { Placement } from './placement'
import { legalPlacements, applyPlacement } from './placement'
import { encodeBoardState, ENCODE_DIM } from './encode'
import type { MLPWeights } from './mlpInference'
import { mlpForward } from './mlpInference'

// Dim of the legacy (v1) model trained without discard features.
// Layout: own_top(52)|own_mid(52)|own_bot(52)|street(5)|opp1×3(156)|opp2×3(156)
const LEGACY_DIM = 473
// Block of 52 discard bits in the 525-dim encoding sits between street and opp boards.
const DISCARD_START = 3 * 52 + 5   // 161
const DISCARD_END   = DISCARD_START + 52  // 213

// Build the feature vector for the given model.
// If the model was trained without discard features (473-dim), strip the 52-bit
// discard block from the 525-dim encoding so dimensions match the weight matrix.
function getFeatures(
  weights: MLPWeights,
  board: PartialBoard,
  street: number,
  oppBoards: readonly PartialBoard[],
  discards: readonly Card[],
): Float32Array {
  const f = encodeBoardState(board, street, oppBoards, discards)
  if (weights.inputDim === ENCODE_DIM) return f
  if (weights.inputDim === LEGACY_DIM) {
    const out = new Float32Array(LEGACY_DIM)
    out.set(f.subarray(0, DISCARD_START))
    out.set(f.subarray(DISCARD_END), DISCARD_START)
    return out
  }
  throw new Error(`Unsupported model dim: ${weights.inputDim}`)
}

// Evaluate a board state (after placement) using the value network.
// discards: actor's own discards including the one just made on this street.
export function nnValue(
  weights: MLPWeights,
  board: PartialBoard,
  street: number,
  oppBoards: readonly PartialBoard[],
  discards: readonly Card[] = [],
): number {
  const features = getFeatures(weights, board, street, oppBoards, discards)
  return mlpForward(weights, features)
}

// NN-guided policy: enumerate all legal placements, pick the one whose
// resulting board state has the highest predicted value.
// priorDiscards: actor's discards from streets before this one (current discard appended internally).
export function nnPickPlacement(
  weights: MLPWeights,
  board: PartialBoard,
  hand: readonly Card[],
  street: number,
  oppBoards: readonly PartialBoard[],
  priorDiscards: readonly Card[] = [],
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
