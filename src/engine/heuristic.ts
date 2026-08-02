import type { Card, HandRank, PartialBoard, Board } from './types'
import { HandCategory } from './types'
import { evaluate3, evaluate5 } from './evaluate'
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

// Score a partial row (any number of cards). A row only gets the full
// category-based handRankScore (millions-scale — see handRankScore above)
// once it's actually at its full target size (3 for top, 5 for middle/
// bottom); evaluate3/evaluate5 assume a *complete* hand, and calling them on
// a still-growing row (e.g. evaluate5 on 4 cards) previously let a
// half-finished "pair" spike to the same scale as a genuinely completed
// hand. That made any placement which happened to fill one row to 3+ cards
// outscore a sane, balanced placement by ~6 orders of magnitude regardless
// of actual strength — reproduced concretely: dealing 9,10,J,Q,Q on an
// empty street-0 board made heuristicPlacement dump all 5 cards into one
// row. Partial (not-yet-full) rows instead get a small, continuous score —
// highest card plus a modest bonus for ranks already pairing up — that
// stays comparable across row/card-count combinations until the row is
// actually complete enough to judge for real. A row that reaches full size
// with no actual combo (HighCard — no pair, straight, or better) hasn't
// gained anything by being "complete": scoring it via the same small formula
// (rather than handRankScore's tiebreaker encoding, which is large purely by
// construction — see handRankScore above) avoids a second artifact where
// filling a row with unrelated cards for no reason outscores a genuinely
// sensible spread across all three rows, confirmed with a fully unconnected
// hand (2,3,5,8,K) that otherwise still got dumped into a single row.
function smallScore(cards: readonly Card[]): number {
  const ranks = cards.map(c => c.rank)
  const freq = new Map<number, number>()
  for (const r of ranks) freq.set(r, (freq.get(r) ?? 0) + 1)
  let bonus = 0
  for (const count of freq.values()) {
    if (count >= 2) bonus += (count - 1) * 8 // modest pair/trips-in-progress credit
  }
  return Math.max(...ranks) + bonus
}

// Whether completing a row as this exact hand actually earns anything
// (royalty-wise) beyond just winning-or-losing that row outright — mirrors
// rules.ts's topRoyalty/middleRoyalty/bottomRoyalty tables (middle and
// bottom both start paying at Trips; top pays for Trips or a pair of 6s+).
function earnsRoyalty(rank: HandRank, isTop: boolean): boolean {
  if (isTop) {
    if (rank.category === HandCategory.Trips) return true
    if (rank.category === HandCategory.OnePair) return rank.tiebreakers[0]! >= 6
    return false
  }
  return rank.category >= HandCategory.Trips
}

function partialRowScore(cards: readonly Card[], isTop: boolean): number {
  if (cards.length === 0) return 0
  const fullSize = isTop ? 3 : 5
  if (cards.length < fullSize) return smallScore(cards)
  const rank = isTop ? evaluate3(cards) : evaluate5(cards)
  // A row that completes into a hand with no real royalty value (HighCard,
  // a low top pair, or — critically for middle/bottom — OnePair/TwoPair,
  // since neither earns any royalty there) hasn't actually gained much by
  // being "complete": scoring it via the same small formula as a partial row
  // (rather than handRankScore's tiebreaker encoding, large purely by
  // construction) stops the heuristic from spending an ENTIRE row's worth of
  // capacity on a zero-value hand it'll never get to revise. Reproduced
  // concretely: dealt 5,5,6,9,A on an empty street-0 board, the heuristic
  // dumped all 5 into bottom as a bare pair of 5s (zero royalty) — bottom
  // was then permanently full with nothing left to improve it, and by the
  // final street middle had nowhere else to go but into a foul-causing full
  // house that outranked that locked-in weak bottom.
  if (!earnsRoyalty(rank, isTop)) return smallScore(cards)
  return handRankScore(rank)
}

// Penalty: if full board is already determined to be fouled, large negative.
function foulPenalty(board: PartialBoard): number {
  if (board.top.length === 3 && board.middle.length === 5 && board.bottom.length === 5) {
    return isFoul(board as Board) ? -1e9 : 0
  }
  // Partial board: penalise if a row already looks stronger than the row
  // below it. Previously this only checked top-vs-middle — middle-vs-bottom
  // was never compared at any street, so nothing warned when a strong row
  // built up in middle while bottom stayed weak. Reproduced concretely: dealt
  // K,Q,Q,9,9 on a fresh board, the heuristic greedily completed middle as
  // two pair (a real, correctly-scored combo) while leaving bottom empty —
  // by the time bottom was later filled with only a pair of 2s, middle > bottom
  // was already locked in and unavoidable, fouling the whole board. Uses
  // partialRowScore (not raw evaluate3/5) so the comparison stays meaningful
  // at any partial card count, not just once a row is completely full.
  //
  // Penalty must be on the same -1e9 scale as the complete-board foul check
  // above, not the old -5e5 this originally used: 1000-random-game testing
  // showed -5e5 was nowhere near enough to outweigh the reward from
  // completing a real combo row (handRankScore is millions-scale, x3 row
  // weight for bottom) — a candidate happily "ate" a -5e5 penalty to bank
  // ~4,000,000+ from completing middle as two pair, since every alternative
  // that avoided the penalty scored far less. Confirmed via 1000-random-game
  // foul-rate sampling: -5e5 left the foul rate at ~40% (barely better than
  // the ~71% baseline with no middle-vs-bottom check at all); -1e9 needed to
  // actually change the argmax choice.
  let penalty = 0
  const topScore = partialRowScore(board.top, true)
  const midScore = partialRowScore(board.middle, false)
  const botScore = partialRowScore(board.bottom, false)
  if (board.top.length > 0 && board.middle.length > 0 && topScore > midScore) penalty -= 1e9
  if (board.middle.length > 0 && board.bottom.length > 0 && midScore > botScore) penalty -= 1e9
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

