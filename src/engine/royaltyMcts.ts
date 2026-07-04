// Royalty-only MCTS bot — maximises own royalty score, plays solitaire-style.
//
// Objective: topRoyalty + middleRoyalty + bottomRoyalty, or -6 if bust.
// Opponents are used only for card removal (dead-card elimination), never
// for strategy modelling. All future card draws are sampled from the live deck.
//
// Two variants:
//   royaltyMcts*     — heuristic rollouts, no NN required
//   royaltyNnMcts*   — NN value function, domination-filtered candidates, no ROOT_TOP_K cap

import type { Card, PartialBoard } from './types'
import type { Board } from './types'
import { isFoul, royalties, bonusTrigger, evaluate3, evaluate5 } from './index'
import { HandCategory } from './types'
import type { InfoState, RNG, ScoredPlacement } from './mc'
import { buildLiveDeck, fisherYates } from './mc'
import { legalPlacements, applyPlacement } from './placement'
import type { Placement } from './placement'
import { foulSafePlacements } from './foulPruner'
import { mctsPickPlacement, mctsScoredPlacements } from './mcts'
import type { NNModel } from './wasmModel'

// Easy to bump without touching call sites.
export const ROYALTY_MCTS_SIMS = 1000

// ── Bonus EV constants ────────────────────────────────────────────────────────
//
// Expected royalties from optimal bonus board play, averaged over 5000 random
// deals. Subtract 2 for the side-game opponent's expected score to get the net
// additional reward for qualifying at the top row.
//
// QQ  (13 cards, 0 discards): avg_royalties=9.0 → net=7.0
// KK  (14 cards, 1 discard):  avg_royalties=12.7 → net=10.7
// AA+ (15 cards, 2 discards): avg_royalties=19.2 → net=17.2
const BONUS_EV_QQ        = 7.0
const BONUS_EV_KK        = 10.7
const BONUS_EV_AA_TRIPS  = 17.2

// Net bonus EV for a completed board's top-row qualifier.
function bonusGameValue(board: Board): number {
  const q = bonusTrigger(board)
  if (q === 'QQ')         return BONUS_EV_QQ
  if (q === 'KK')         return BONUS_EV_KK
  if (q === 'AA_OR_TRIPS') return BONUS_EV_AA_TRIPS
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
      score += 10 + (rank.tiebreakers[0]! - 2)
      score += BONUS_EV_AA_TRIPS
    } else if (rank.category === HandCategory.OnePair) {
      const pr = rank.tiebreakers[0]!
      if (pr >= 6) score += pr - 5
      if (pr === 14) score += BONUS_EV_AA_TRIPS
      else if (pr === 13) score += BONUS_EV_KK
      else if (pr === 12) score += BONUS_EV_QQ
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
  return scored[0]!.placement
}

// ── Domination filter ─────────────────────────────────────────────────────────
//
// P1 dominates P2 if the resulting board is ≥ P2's in all rows (by sorted card
// rank, descending) and strictly > in at least one. Eliminates placements that
// are strictly worse in every comparable dimension — e.g. jack-high top when
// another placement gets ace-high top with the same middle and bottom.
// This is conservative (only rank-based) and safe: it never removes a placement
// that could uniquely yield a better hand.

function compareRowByRank(a: readonly Card[], b: readonly Card[]): number {
  const ra = a.map(c => c.rank).sort((x, y) => y - x)
  const rb = b.map(c => c.rank).sort((x, y) => y - x)
  const n = Math.max(ra.length, rb.length)
  for (let i = 0; i < n; i++) {
    const va = ra[i] ?? -1
    const vb = rb[i] ?? -1
    if (va !== vb) return va > vb ? 1 : -1
  }
  return 0
}

export function dominationFilter(board: PartialBoard, placements: Placement[]): Placement[] {
  if (placements.length <= 1) return placements
  const boards = placements.map(p => applyPlacement(board, p))
  const dominated = new Uint8Array(placements.length)
  for (let i = 0; i < placements.length; i++) {
    if (dominated[i]) continue
    for (let j = 0; j < placements.length; j++) {
      if (i === j || dominated[j]) continue
      const tc = compareRowByRank(boards[i]!.top, boards[j]!.top)
      const mc = compareRowByRank(boards[i]!.middle, boards[j]!.middle)
      const bc = compareRowByRank(boards[i]!.bottom, boards[j]!.bottom)
      if (tc >= 0 && mc >= 0 && bc >= 0 && (tc > 0 || mc > 0 || bc > 0)) {
        dominated[j] = 1
      }
    }
  }
  return placements.filter((_, i) => !dominated[i])
}

// ── Royalty NN MCTS ───────────────────────────────────────────────────────────
//
// Uses the learned royalty NN value function instead of heuristic rollouts.
// Applies the domination filter to the candidate list (no ROOT_TOP_K cap).
// Uses heuristic opponents (nnOpponents: false) since opponent moves only
// determine which cards are consumed — their strategy doesn't affect our royalties.

const ROYALTY_NN_MCTS_OPTS = {
  maxDepth: 2 as const,
  nnOpponents: false as const,
  rootTopK: 9999,  // effectively unlimited; domination filter handles pruning
}

export function royaltyNnMctsScoredPlacements(
  state: InfoState,
  model: NNModel,
  nSims: number,
  rng: RNG,
): ScoredPlacement[] {
  const allCandidates = foulSafePlacements(
    state.board,
    legalPlacements(state.board, state.hand, state.street),
    state.street,
  )
  const filtered = dominationFilter(state.board, allCandidates)
  if (filtered.length === 0) return []

  return mctsScoredPlacements(state, model, {
    ...ROYALTY_NN_MCTS_OPTS,
    nSims,
    candidateOverride: filtered,
  }, rng)
}

export function royaltyNnMctsPickPlacement(
  state: InfoState,
  model: NNModel,
  nSims: number,
  rng: RNG,
): Placement {
  const allCandidates = foulSafePlacements(
    state.board,
    legalPlacements(state.board, state.hand, state.street),
    state.street,
  )
  const filtered = dominationFilter(state.board, allCandidates)
  if (filtered.length === 0) {
    return legalPlacements(state.board, state.hand, state.street)[0]!
  }

  return mctsPickPlacement(state, model, {
    ...ROYALTY_NN_MCTS_OPTS,
    nSims,
    candidateOverride: filtered,
  }, rng)
}
