// NN-guided rollout policy and value function.
// Used by the engine worker to replace the heuristic policy when a model is loaded.

import type { Card, PartialBoard } from './types'
import type { Placement } from './placement'
import { legalPlacements, applyPlacement } from './placement'
import { encodeBoardState, ENCODE_DIM } from './encode'
import type { NNModel } from './wasmModel'

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
  model: NNModel,
  board: PartialBoard,
  street: number,
  oppBoards: readonly PartialBoard[],
  discards: readonly Card[],
): Float32Array {
  const f = encodeBoardState(board, street, oppBoards, discards)
  if (model.inputDim === ENCODE_DIM) return f
  if (model.inputDim === LEGACY_DIM) {
    const out = new Float32Array(LEGACY_DIM)
    out.set(f.subarray(0, DISCARD_START))
    out.set(f.subarray(DISCARD_END), DISCARD_START)
    return out
  }
  throw new Error(`Unsupported model dim: ${model.inputDim}`)
}

// Single-sample value estimate for a board state (after placement).
// discards: actor's own discards including the one just made on this street.
export function nnValue(
  model: NNModel,
  board: PartialBoard,
  street: number,
  oppBoards: readonly PartialBoard[],
  discards: readonly Card[] = [],
): number {
  return model.forward(getFeatures(model, board, street, oppBoards, discards))
}

// Rank all candidates by NN value in one batched forward pass.
// Packs all feature vectors into a single flat array and calls model.forwardBatch
// to cross the JS↔WASM boundary once instead of once per candidate.
// Returns candidates sorted descending (highest-value first).
export function nnRankCandidates(
  model: NNModel,
  candidates: Placement[],
  board: PartialBoard,
  street: number,
  oppBoards: readonly PartialBoard[],
  priorDiscards: readonly Card[] = [],
): Array<{ pl: Placement; val: number }> {
  const n = candidates.length
  const dim = model.inputDim
  const flat = new Float32Array(n * dim)
  for (let i = 0; i < n; i++) {
    const pl = candidates[i]!
    const boardAfter = applyPlacement(board, pl)
    const discards = pl.discard ? [...priorDiscards, pl.discard] : priorDiscards
    flat.set(getFeatures(model, boardAfter, street, oppBoards, discards), i * dim)
  }
  const vals = model.forwardBatch(flat, n)
  return candidates
    .map((pl, i) => ({ pl, val: vals[i]! }))
    .sort((a, b) => b.val - a.val)
}

// NN-guided policy: enumerate all legal placements, pick the one whose
// resulting board state has the highest predicted value.
// Uses a single batched forward pass for all candidates.
export function nnPickPlacement(
  model: NNModel,
  board: PartialBoard,
  hand: readonly Card[],
  street: number,
  oppBoards: readonly PartialBoard[],
  priorDiscards: readonly Card[] = [],
): Placement {
  const candidates = legalPlacements(board, hand, street)
  if (candidates.length === 0) throw new Error('No legal placements')
  if (candidates.length === 1) return candidates[0]!
  return nnRankCandidates(model, candidates, board, street, oppBoards, priorDiscards)[0]!.pl
}
