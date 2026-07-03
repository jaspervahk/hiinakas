// Royalty-only MCTS bot — maximises own royalty score, plays solitaire-style.
//
// Objective: topRoyalty + middleRoyalty + bottomRoyalty, or -6 if bust.
// Opponents are used only for card removal (dead-card elimination), never
// for strategy modelling. All future card draws are sampled from the live deck.

import type { Card, PartialBoard } from './types'
import type { Board } from './types'
import { isFoul, royalties, bonusTrigger } from './rules'
import { evaluate3, evaluate5, HandCategory } from './index'
import type { InfoState, RNG, ScoredPlacement } from './mc'
import { buildLiveDeck, fisherYates } from './mc'
import { legalPlacements, applyPlacement } from './placement'
import type { Placement } from './placement'
import { foulSafePlacements } from './foulPruner'

// Easy to bump without touching call sites.
export const ROYALTY_MCTS_SIMS = 1000

// Bonus game value added on top of standard royalties.
// KK triggers a 14-card bonus game (+7); AA or trips triggers 15-card bonus (+15).
function bonusGameValue(board: Board): number {
  const q = bonusTrigger(board)
  if (q === 'KK') return 7
  if (q === 'AA_OR_TRIPS') return 15
  return 0
}

// Terminal evaluation: royalties + bonus game EV if not bust, -6 if bust.
export function computeRoyaltyScore(board: Board): number {
  if (isFoul(board)) return -6
  return royalties(board) + bonusGameValue(board)
}

// Heuristic score for a partial board: sum royalties from complete rows only.
// Includes bonus game value when top is complete and qualifying.
function partialRoyaltyHint(board: PartialBoard): number {
  let score = 0
  if (board.top.length === 3) {
    const rank = evaluate3(board.top)
    if (rank.category === HandCategory.Trips) {
      score += 10 + (rank.tiebreakers[0]! - 2)  // +10..+22
      score += 15  // bonus game
    } else if (rank.category === HandCategory.OnePair) {
      const pr = rank.tiebreakers[0]!
      if (pr >= 6) score += pr - 5  // standard royalty
      if (pr === 14) score += 15    // AA bonus game
      else if (pr === 13) score += 7  // KK bonus game
    }
  }
  if (board.middle.length === 5) {
    const rank = evaluate5(board.middle)
    switch (rank.category) {
      case HandCategory.Trips:         score += 2;  break
      case HandCategory.Straight:      score += 4;  break
      case HandCategory.Flush:         score += 8;  break
      case HandCategory.FullHouse:     score += 12; break
      case HandCategory.Quads:         score += 20; break
      case HandCategory.StraightFlush: score += 30; break
      case HandCategory.RoyalFlush:    score += 50; break
    }
  }
  if (board.bottom.length === 5) {
    const rank = evaluate5(board.bottom)
    switch (rank.category) {
      case HandCategory.Straight:      score += 2;  break
      case HandCategory.Flush:         score += 4;  break
      case HandCategory.FullHouse:     score += 6;  break
      case HandCategory.Quads:         score += 10; break
      case HandCategory.StraightFlush: score += 15; break
      case HandCategory.RoyalFlush:    score += 25; break
    }
  }
  return score
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
    const candidates = foulSafePlacements(b, legalPlacements(b, hand, s), s)
    if (candidates.length === 0) break
    // Greedy: pick placement(s) with highest partial royalty score; break ties randomly.
    let bestScore = -Infinity
    let bestCandidates: typeof candidates = []
    for (const p of candidates) {
      const next = applyPlacement(b, p)
      const score = partialRoyaltyHint(next)
      if (score > bestScore) { bestScore = score; bestCandidates = [p] }
      else if (score === bestScore) bestCandidates.push(p)
    }
    b = applyPlacement(b, bestCandidates[Math.floor(rng() * bestCandidates.length)]!)
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
  const candidates = foulSafePlacements(
    state.board,
    legalPlacements(state.board, state.hand, state.street),
    state.street,
  )
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
