import type { Card, HandRank, PartialBoard, Board } from './types'
import { HandCategory } from './types'
// fastEval3/fastEval5 (fastEvaluate.ts) return HandRanks identical to
// evaluate.ts's — same category, same tiebreaker tuple — but without the
// per-call Map, spread and comparator sorts. This module is the single
// hottest thing in the engine: it's the rollout policy, so mc.ts calls it
// once per simulated street per candidate per rollout, and a CPU profile put
// ~86% of all bot/coach runtime inside the scoring below. Equivalence is
// covered by heuristic.test.ts.
import { fastEval3, fastEval5 } from './fastEvaluate'
import { isFoul } from './rules'
import { legalPlacements } from './placement'
import type { Placement } from './placement'

// ── Hand rank → numeric score (for fast heuristic comparison) ─────────────

// Math.pow(15, n) for the only exponents a tiebreaker tuple can reach (a
// 5-card hand has at most 5 tiebreakers). Exact integers, so the scores are
// bit-identical to the Math.pow form this replaces.
const POW15 = [1, 15, 225, 3375, 50625] as const

function handRankScore(rank: HandRank): number {
  // Encode as category * large_base + tiebreakers weighted by position
  const tb = rank.tiebreakers
  const n = tb.length
  let score = rank.category * 1_000_000
  for (let i = 0; i < n; i++) {
    score += (tb[i] ?? 0) * (POW15[n - 1 - i] ?? Math.pow(15, n - 1 - i))
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
//
// Counts live in a module-level scratch array rather than a per-call Map: this
// was the single hottest function in the engine (~26% of all bot/coach self
// time) purely from the Map, the .map() and the Math.max spread it used to
// allocate on every call. Reusing one buffer is safe because scoring is
// synchronous, single-threaded and never re-enters itself. The result is
// integer arithmetic either way, so the score is bit-identical to the Map
// version — only the accumulation order of `bonus` changes, and integer
// addition is exact.
const RANK_COUNTS = new Int8Array(15)

function smallScore(cards: readonly Card[]): number {
  const n = cards.length
  let maxRank = 0
  for (let i = 0; i < n; i++) {
    const r = cards[i]!.rank
    RANK_COUNTS[r]++
    if (r > maxRank) maxRank = r
  }
  let bonus = 0
  for (let i = 0; i < n; i++) {
    const r = cards[i]!.rank
    const c = RANK_COUNTS[r]!
    if (c !== 0) {
      if (c >= 2) bonus += (c - 1) * 8 // modest pair/trips-in-progress credit
      RANK_COUNTS[r] = 0               // count each distinct rank once, then clear
    }
  }
  return maxRank + bonus
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
  const rank = isTop
    ? fastEval3(cards[0]!, cards[1]!, cards[2]!)
    : fastEval5(cards[0]!, cards[1]!, cards[2]!, cards[3]!, cards[4]!)
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
//
// topScore/midScore/botScore are passed in rather than recomputed: the caller
// (scorePlacement) needs the very same three partialRowScore values for its
// own weighted sum, and opponentComparisonAdj needs them again. Computing
// them once per candidate instead of three times is the bulk of this
// module's speedup and cannot change a score — they are the same numbers.
function foulPenalty(
  board: PartialBoard,
  topScore: number,
  midScore: number,
  botScore: number,
): number {
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
// The strongest visible opponent score per row, in [top, middle, bottom]
// order. A row where no opponent has placed anything yet is 0, which reads as
// "no signal" below — matching the old per-row `maxOppScore === 0` skip.
type OppRowMax = readonly [number, number, number]

// Opponent boards do not change while a single decision's candidates are
// being ranked, so their row scores are computed once per heuristicPlacement
// call instead of once per candidate (at street 0 that is 232x less work for
// the same numbers).
function opponentRowMax(oppBoards: readonly PartialBoard[]): OppRowMax | null {
  if (oppBoards.length === 0) return null
  let t = 0, m = 0, b = 0
  for (const opp of oppBoards) {
    if (opp.top.length > 0)    { const s = partialRowScore(opp.top, true);     if (s > t) t = s }
    if (opp.middle.length > 0) { const s = partialRowScore(opp.middle, false); if (s > m) m = s }
    if (opp.bottom.length > 0) { const s = partialRowScore(opp.bottom, false); if (s > b) b = s }
  }
  return [t, m, b]
}

function opponentComparisonAdj(
  newBoard: PartialBoard,
  ourTop: number,
  ourMid: number,
  ourBot: number,
  oppMax: OppRowMax | null,
): number {
  if (oppMax === null) return 0
  let adj = 0
  // Row order and the accumulation order of `adj` are load-bearing: these are
  // floating-point terms (ROW_WEIGHT x 0.15), and heuristicPlacement's argmax
  // keeps the FIRST candidate of an equal score, so reordering could flip a
  // near-tie into a different move.
  if (newBoard.top.length > 0 && oppMax[0] !== 0 && ourTop < oppMax[0]) {
    adj -= (oppMax[0] - ourTop) * ROW_WEIGHT.top * OPPONENT_AWARENESS_FRACTION
  }
  if (newBoard.middle.length > 0 && oppMax[1] !== 0 && ourMid < oppMax[1]) {
    adj -= (oppMax[1] - ourMid) * ROW_WEIGHT.middle * OPPONENT_AWARENESS_FRACTION
  }
  if (newBoard.bottom.length > 0 && oppMax[2] !== 0 && ourBot < oppMax[2]) {
    adj -= (oppMax[2] - ourBot) * ROW_WEIGHT.bottom * OPPONENT_AWARENESS_FRACTION
  }
  return adj
}

// Score a placement for the heuristic. Higher = better. `oppBoards` (each
// opponent's own revealed board so far) is optional — when supplied, adds a
// small opponent-comparison signal on top of the base row-strength scoring.
function scorePlacement(board: PartialBoard, p: Placement, oppMax: OppRowMax | null = null): number {
  const newTop    = [...board.top,    ...p.topAdd]
  const newMid    = [...board.middle, ...p.middleAdd]
  const newBot    = [...board.bottom, ...p.bottomAdd]
  const newBoard: PartialBoard = { top: newTop, middle: newMid, bottom: newBot }

  // Each row is scored once and the value reused by all three terms below.
  // This used to be nine partialRowScore calls per candidate — three here,
  // three inside foulPenalty, three inside opponentComparisonAdj — all on
  // identical inputs.
  const topScore = partialRowScore(newTop, true)
  const midScore = partialRowScore(newMid, false)
  const botScore = partialRowScore(newBot, false)

  // Bottom weighted most heavily (strongest hand should go bottom)
  const score =
    botScore * 3.0 +
    midScore * 2.0 +
    topScore * 1.0 +
    foulPenalty(newBoard, topScore, midScore, botScore) +
    opponentComparisonAdj(newBoard, topScore, midScore, botScore, oppMax)

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
    throw new Error(
      `No legal placements — board/dealt mismatch (board top=${board.top.length}/3 `
      + `mid=${board.middle.length}/5 bot=${board.bottom.length}/5, dealt=${dealt.length} card(s), street=${street})`,
    )
  }
  const oppMax = opponentRowMax(oppBoards)
  let best = candidates[0]!
  let bestScore = scorePlacement(board, best, oppMax)
  for (let i = 1; i < candidates.length; i++) {
    const s = scorePlacement(board, candidates[i]!, oppMax)
    if (s > bestScore) {
      bestScore = s
      best = candidates[i]!
    }
  }
  return best
}

