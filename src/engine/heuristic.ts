import type { Card, HandRank, PartialBoard, Board } from './types'
import { evaluate3, evaluate5, compareHandRank } from './evaluate'
import { isFoul } from './rules'
import { legalPlacements } from './placement'
import type { Placement } from './placement'

// ── Hand rank → numeric score (for fast heuristic comparison) ─────────────

function handRankScore(rank: HandRank): number {
  // Encode as category * large_base + tiebreakers weighted by position
  let score = rank.category * 1_000_000
  for (let i = 0; i < rank.tiebreakers.length; i++) {
    score += (rank.tiebreakers[i] ?? 0) * Math.pow(15, rank.tiebreakers.length - 1 - i)
  }
  return score
}

// Score a partial row (any number of cards). Uses whatever cards are present.
// evaluate3/evaluate5 work on subsets; for partial 5-card rows we call evaluate5
// on the partial array (it treats missing cards as not yet dealt).
function partialRowScore(cards: readonly Card[], isTop: boolean): number {
  if (cards.length === 0) return 0
  if (isTop) return handRankScore(evaluate3(cards))
  // For middle/bottom, treat partial hands by evaluating what's there.
  // evaluate5 is designed for 5 cards; for <5 we use evaluate3-like logic
  // (just rank the partial hand by what we have).
  if (cards.length < 3) {
    // Too few cards to evaluate meaningfully; use max rank as proxy
    const maxRank = Math.max(...cards.map(c => c.rank))
    return maxRank
  }
  if (cards.length === 3) return handRankScore(evaluate3(cards)) // 3-card partial for 5-card row
  return handRankScore(evaluate5(cards)) // 4 or 5 cards
}

// Penalty: if full board is already determined to be fouled, large negative.
function foulPenalty(board: PartialBoard): number {
  if (board.top.length === 3 && board.middle.length === 5 && board.bottom.length === 5) {
    return isFoul(board as Board) ? -1e9 : 0
  }
  // Partial board: penalise if current rows already violate ordering
  // (e.g. top already stronger than middle)
  let penalty = 0
  if (board.top.length > 0 && board.middle.length > 0) {
    const topRank = evaluate3(board.top)
    const midRank = evaluate3(board.middle) // approximate mid with eval3
    if (compareHandRank(topRank, midRank) > 0) penalty -= 5e5
  }
  return penalty
}

const ROW_WEIGHT = { top: 1.0, middle: 2.0, bottom: 3.0 } as const
// How much of a row's own weighted score to discount when we're clearly
// behind the strongest visible opponent in that same row — small and
// bounded (never more than this fraction of the raw shortfall) so it nudges
// candidate ranking toward rows we can still win / redirects into royalties
// elsewhere, without swamping the base row-strength scoring above.
const OPPONENT_AWARENESS_FRACTION = 0.15

// Compare our candidate row strengths against the strongest visible opponent
// in each same row (using whatever opponent boards the caller can see — per
// info-set hygiene, only ever their REVEALED placed cards, never hidden
// hands/discards/stub). Rows we're clearly behind in get a small discount:
// fighting a likely-lost row is worth less than banking royalties or safety
// elsewhere. Returns 0 (no adjustment) when no opponent info is available,
// exactly preserving old behavior for callers that don't pass any.
function opponentComparisonAdj(newBoard: PartialBoard, oppBoards: readonly PartialBoard[]): number {
  if (oppBoards.length === 0) return 0
  let adj = 0
  for (const row of ['top', 'middle', 'bottom'] as const) {
    const ourCards = newBoard[row]
    if (ourCards.length === 0) continue
    const isTop = row === 'top'
    const ourScore = partialRowScore(ourCards, isTop)
    let maxOppScore = 0
    for (const opp of oppBoards) {
      const oppCards = opp[row]
      if (oppCards.length === 0) continue
      const s = partialRowScore(oppCards, isTop)
      if (s > maxOppScore) maxOppScore = s
    }
    if (maxOppScore === 0) continue // no opponent has cards in this row yet — no signal
    if (ourScore < maxOppScore) {
      adj -= (maxOppScore - ourScore) * ROW_WEIGHT[row] * OPPONENT_AWARENESS_FRACTION
    }
  }
  return adj
}

// Score a placement for the heuristic. Higher = better. `oppBoards` (each
// opponent's own revealed board so far) is optional — when supplied, adds a
// small opponent-comparison signal on top of the base row-strength scoring.
function scorePlacement(board: PartialBoard, p: Placement, oppBoards: readonly PartialBoard[] = []): number {
  const newTop    = [...board.top,    ...p.topAdd]
  const newMid    = [...board.middle, ...p.middleAdd]
  const newBot    = [...board.bottom, ...p.bottomAdd]
  const newBoard: PartialBoard = { top: newTop, middle: newMid, bottom: newBot }

  // Bottom weighted most heavily (strongest hand should go bottom)
  const score =
    partialRowScore(newBot, false) * 3.0 +
    partialRowScore(newMid, false) * 2.0 +
    partialRowScore(newTop, true)  * 1.0 +
    foulPenalty(newBoard) +
    opponentComparisonAdj(newBoard, oppBoards)

  return score
}

// ── Heuristic placement policy ─────────────────────────────────────────────
//
// Fast greedy: pick the legal placement with the highest heuristic score.
// Used as the rollout policy in MC (argmax, not sampling). `oppBoards` is
// optional (defaults to none, preserving old opponent-blind behavior) — pass
// each visible opponent's revealed board (never their hidden hand/discards/
// the stub) to let the heuristic favor rows it can still win over ones it's
// clearly already lost.

export function heuristicPlacement(
  board: PartialBoard,
  dealt: readonly Card[],
  street: number,
  oppBoards: readonly PartialBoard[] = [],
): Placement {
  const candidates = legalPlacements(board, dealt, street)
  if (candidates.length === 0) {
    throw new Error('No legal placements — board/dealt mismatch')
  }
  let best = candidates[0]!
  let bestScore = scorePlacement(board, best, oppBoards)
  for (let i = 1; i < candidates.length; i++) {
    const s = scorePlacement(board, candidates[i]!, oppBoards)
    if (s > bestScore) {
      bestScore = s
      best = candidates[i]!
    }
  }
  return best
}

