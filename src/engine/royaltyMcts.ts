// Royalty-only MCTS bot — maximises own royalty score, plays solitaire-style.
//
// Objective: topRoyalty + middleRoyalty + bottomRoyalty, or -6 if bust.
// Opponents are used only for card removal (dead-card elimination), never
// for strategy modelling. All future card draws are sampled from the live deck.

import type { Card, PartialBoard } from './types'
import type { Board } from './types'
import { isFoul, royalties } from './rules'
import type { InfoState, RNG, ScoredPlacement } from './mc'
import { buildLiveDeck, fisherYates } from './mc'
import { legalPlacements, applyPlacement } from './placement'
import type { Placement } from './placement'

// Easy to bump without touching call sites.
export const ROYALTY_MCTS_SIMS = 1000

// Terminal evaluation: royalties if not bust, -6 if bust.
export function computeRoyaltyScore(board: Board): number {
  if (isFoul(board)) return -6
  return royalties(board)
}

// Complete a partial board with random placements for streets after `fromStreet`.
// Cards are drawn in order from the pre-shuffled live deck.
function royaltyRollout(
  board: PartialBoard,
  fromStreet: number,
  shuffledDeck: Card[],
  rng: RNG,
): number {
  let di = 0
  let b = board

  for (let s = fromStreet + 1; s <= 4; s++) {
    const hand = shuffledDeck.slice(di, di + 3)
    di += 3
    if (hand.length < 3) break
    const candidates = legalPlacements(b, hand, s)
    if (candidates.length === 0) break
    b = applyPlacement(b, candidates[Math.floor(rng() * candidates.length)]!)
  }

  return computeRoyaltyScore(b as Board)
}

// UCB1 MCTS over all legal placements (no ROOT_TOP_K pruning).
// Returns scored placements sorted by visit count descending.
export function royaltyMctsScoredPlacements(
  state: InfoState,
  nSims: number,
  rng: RNG,
): ScoredPlacement[] {
  const candidates = legalPlacements(state.board, state.hand, state.street)
  if (candidates.length === 0) return []

  const liveDeck = buildLiveDeck(state)
  const boardsAfter = candidates.map(p => applyPlacement(state.board, p))
  const k = candidates.length

  // On the last street (4), terminal evaluation is immediate and deterministic —
  // skip UCB overhead and just score each placement directly.
  if (state.street === 4) {
    return candidates.map((placement, i) => ({
      placement,
      ev: computeRoyaltyScore(boardsAfter[i]! as Board),
      variance: 0,
      n: 1,
    })).sort((a, b) => b.ev - a.ev)
  }

  const visits = new Int32Array(k)
  const totals = new Float64Array(k)
  const C = Math.SQRT2

  for (let sim = 0; sim < nSims; sim++) {
    // UCB1 arm selection — unvisited arms always go first (Infinity score).
    let arm = -1
    let bestUCB = -Infinity
    const logTotal = Math.log(sim + 1)
    for (let i = 0; i < k; i++) {
      const ucb = visits[i] === 0
        ? Infinity
        : totals[i]! / visits[i]! + C * Math.sqrt(logTotal / visits[i]!)
      if (ucb > bestUCB) { bestUCB = ucb; arm = i }
    }

    const shuffled = fisherYates(liveDeck, rng)
    const val = royaltyRollout(boardsAfter[arm]!, state.street, shuffled, rng)
    visits[arm]++
    totals[arm] += val
  }

  return candidates
    .map((placement, i) => ({
      placement,
      ev: visits[i]! > 0 ? totals[i]! / visits[i]! : 0,
      variance: 0,
      n: visits[i]!,
    }))
    .sort((a, b) => b.ev - a.ev)
}

export function royaltyMctsPickPlacement(
  state: InfoState,
  nSims: number,
  rng: RNG,
): Placement {
  const scored = royaltyMctsScoredPlacements(state, nSims, rng)
  if (scored.length === 0) {
    return legalPlacements(state.board, state.hand, state.street)[0]!
  }
  // Best by EV (already sorted).
  return scored[0]!.placement
}
