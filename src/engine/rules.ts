import { HandCategory } from './types'
import type { Board, BonusQualifier, Card, HandRank, RuleSet } from './types'
import { CLASSIC_RULES } from './types'
import { evaluate3, evaluate5, compareHandRank } from './evaluate'
import { fastEval3, fastEval5, fastRoyalties, cmpRank } from './fastEvaluate'

// ── Foul detection ─────────────────────────────────────────────────────────

// The fast evaluator indexes its cards positionally, so it can only be used
// on a genuinely complete 3-5-5 board. These functions are typed for `Board`
// but several UI callers cast a still-growing board to it (BoardView and
// GamePlayView both display a live foul/royalty status mid-hand), and the
// Map-based evaluators tolerate a short row where the fast ones would read
// past the end. Complete boards — every call from the bot, coach, analyzer
// and scorer, i.e. all the hot ones — take the fast path; anything partial
// falls through to the original behavior unchanged.
function isCompleteBoard(b: Board): boolean {
  return b.top.length === 3 && b.middle.length === 5 && b.bottom.length === 5
}

// Ranks all three rows of a complete board with the allocation-light
// evaluator. Callers below share one call instead of re-evaluating per row.
function rankRows(b: Board): { top: HandRank; mid: HandRank; bot: HandRank } {
  return {
    top: fastEval3(b.top[0]!, b.top[1]!, b.top[2]!),
    mid: fastEval5(b.middle[0]!, b.middle[1]!, b.middle[2]!, b.middle[3]!, b.middle[4]!),
    bot: fastEval5(b.bottom[0]!, b.bottom[1]!, b.bottom[2]!, b.bottom[3]!, b.bottom[4]!),
  }
}

export function isFoul(board: Board): boolean {
  if (isCompleteBoard(board)) {
    const { top, mid, bot } = rankRows(board)
    return cmpRank(top, mid) > 0 || cmpRank(mid, bot) > 0
  }
  const top = evaluate3(board.top)
  const mid = evaluate5(board.middle)
  const bot = evaluate5(board.bottom)
  // Top ≤ Middle ≤ Bottom; strict greater-than = foul
  return compareHandRank(top, mid) > 0 || compareHandRank(mid, bot) > 0
}

// ── Royalties ──────────────────────────────────────────────────────────────

export function topRoyalty(cards: readonly Card[]): number {
  const rank = evaluate3(cards)
  if (rank.category === HandCategory.Trips) {
    // Trips 2→10, J→A map to +10..+22
    return 10 + (rank.tiebreakers[0]! - 2)
  }
  if (rank.category === HandCategory.OnePair) {
    const pairRank = rank.tiebreakers[0]!
    // Pairs: 66=+1 … AA=+9; pairs below 66 score 0
    if (pairRank < 6) return 0
    return pairRank - 5 // 6→1, 7→2, … 14→9
  }
  return 0
}

export function middleRoyalty(cards: readonly Card[]): number {
  const rank = evaluate5(cards)
  switch (rank.category) {
    case HandCategory.Trips:         return 2
    case HandCategory.Straight:      return 4
    case HandCategory.Flush:         return 8
    case HandCategory.FullHouse:     return 12
    case HandCategory.Quads:         return 20
    case HandCategory.StraightFlush: return 30
    case HandCategory.RoyalFlush:    return 50
    default:                         return 0
  }
}

export function bottomRoyalty(cards: readonly Card[]): number {
  const rank = evaluate5(cards)
  switch (rank.category) {
    case HandCategory.Straight:      return 2
    case HandCategory.Flush:         return 4
    case HandCategory.FullHouse:     return 6
    case HandCategory.Quads:         return 10
    case HandCategory.StraightFlush: return 15
    case HandCategory.RoyalFlush:    return 25
    default:                         return 0
  }
}

// Returns total royalties for a board; 0 if fouled.
export function royalties(board: Board): number {
  if (isCompleteBoard(board)) {
    // One ranking pass covers both the foul check and all three royalty
    // tables; the slow path below evaluates every row twice over (once inside
    // isFoul, once more per row-royalty function).
    const { top, mid, bot } = rankRows(board)
    if (cmpRank(top, mid) > 0 || cmpRank(mid, bot) > 0) return 0
    return fastRoyalties(top, mid, bot)
  }
  if (isFoul(board)) return 0
  return topRoyalty(board.top) + middleRoyalty(board.middle) + bottomRoyalty(board.bottom)
}

// ── Bonus round ────────────────────────────────────────────────────────────

// Returns the bonus qualifier for a non-bust board's top row, or null.
export function bonusTrigger(board: Board, rules: RuleSet = CLASSIC_RULES): BonusQualifier | null {
  let top: HandRank
  let bot: HandRank | null = null
  if (isCompleteBoard(board)) {
    const ranks = rankRows(board)
    if (cmpRank(ranks.top, ranks.mid) > 0 || cmpRank(ranks.mid, ranks.bot) > 0) return null
    top = ranks.top
    bot = ranks.bot
  } else {
    if (isFoul(board)) return null
    top = evaluate3(board.top)
  }

  // Bottom straight flush or better deals 15 — the largest tier there is — so
  // when it applies it wins outright and the top row needn't be consulted.
  // (Royal flush sorts above straight flush, so >= covers both.)
  if (rules.bonusFromBottomStraightFlush) {
    const bottom = bot ?? evaluate5(board.bottom)
    if (bottom.category >= HandCategory.StraightFlush) return 'AA_OR_TRIPS'
  }

  if (top.category === HandCategory.Trips) return 'AA_OR_TRIPS'
  if (top.category === HandCategory.OnePair) {
    const pairRank = top.tiebreakers[0]!
    if (pairRank === 14) return 'AA_OR_TRIPS'
    if (pairRank === 13) return 'KK'
    if (pairRank === 12) return 'QQ'
  }
  return null
}

// Cards dealt to qualifying players in the bonus round.
export function bonusDealCount(qualifier: BonusQualifier): number {
  switch (qualifier) {
    case 'QQ':         return 13
    case 'KK':         return 14
    case 'AA_OR_TRIPS': return 15
  }
}

// Expected net pairwise score (scorePair-equivalent: row-score + royalty
// differential) from optimal bonus-board play, computed via exact Monte
// Carlo simulation (scripts/compute-bonus-ev.ts, shared-deck trials) against
// every possible opponent scenario.
//
// The bonus round is scored pairwise against EVERY active opponent, exactly
// like a normal round (docs/01_RULES_AND_SCORING.md section 8), so a flat
// single-opponent constant undervalues the bonus round in 3-player games
// (2 opponents) relative to 2-player (1 opponent) — and an opponent who
// independently also qualifies for their own bonus board is worth a very
// different amount than one playing the (much weaker-royalty) side game.
// BONUS_NET[actorTier][oppScenario] is the expected net score for ONE such
// pairwise matchup; summing over however many real opponents exist (using
// each one's ACTUAL simulated final-board tier) gives an EV that is
// automatically correct for both 2p and 3p and automatically accounts for
// opponents who are about to trigger their own bonus round.
//
// Diagonal cells (actor tier === opponent tier) are exactly 0 by symmetry
// (two boards drawn i.i.d. from the same distribution ⇒ E[net] = E[-net] = 0)
// — not simulated at all. Off-diagonal cells are symmetrized from both
// simulated directions (net(A,B) = -net(B,A) exactly, for any specific pair
// of boards, so averaging both directions' independent samples halves the
// estimation variance for free). BASE (non-qualifying opponent playing the
// 17-card side game) has no such counterpart and uses the raw simulated
// value. Regenerated 2026-08-25 after the kicker-aware bonus solver landed
// (bonusOpponentScoring.ts) — cells not touching AA_OR_TRIPS use 3000
// trials/direction, cells touching it (the expensive tier, ~100x a QQ-only
// cell) use 1200/direction; implied standard error ranges ~0.11-0.23 across
// the table, down from ~0.3-0.5 at the previous flat 500 trials/cell.
export type BonusOppScenario = 'BASE' | BonusQualifier

// BASE column re-measured 2026-09-14 against a side-game opponent with the
// CORRECT info set — getBotMove with invisibleBonusOpponents set (n=500/tier).
// The previous values (12.13 / 16.50 / 20.44) were measured against
// heuristicPlacement, which fouls ~30% of the time and earns 0.83 royalties;
// a properly-informed side-game player earns 2.06 at a similar foul rate, so
// the old numbers were collecting free +6 scoops and facing almost no royalty
// opposition. Decomposition of the old QQ cell: 8.95 own royalties + 4.28 row
// score (70% scoop rate, 31% of which came from the opponent busting) - 0.82
// opponent royalties = 12.41, reproducing the old table against its own weak
// opponent. Against a real one the same cell is 10.13.
//
// The actor's own royalties (~9 / ~12 / ~15 by tier, at a 0% foul rate) are
// the dominant term and are unaffected — a solver handed 13-15 cards really
// does build boards that strong. What changed is the quality of what it is
// being compared against.
//
// Tier-vs-tier cells are NOT re-measured and keep their 3000/1200-trial
// values: those are bonus board vs bonus board, with no side game involved, so
// side-game policy cannot affect them. Diagonals remain exactly 0 by symmetry.
export const BONUS_NET: Record<BonusQualifier, Record<BonusOppScenario, number>> = {
  QQ:          { BASE: 10.13, QQ: 0,    KK: -4.34, AA_OR_TRIPS: -9.19 },
  KK:          { BASE: 14.92, QQ: 4.34, KK: 0,     AA_OR_TRIPS: -4.62 },
  AA_OR_TRIPS: { BASE: 19.87, QQ: 9.19, KK: 4.62,  AA_OR_TRIPS: 0     },
}

// The same table for the variant ruleset, where a qualifying SIDE GAME starts
// a further bonus round (allowBonusRecursion). Solved by
// scripts/compute-variant-bonus-ev.ts.
//
// A 13-15 card bonus board cannot re-trigger, so a round in which both players
// hold bonus boards ends the chain — every tier-vs-tier cell below is
// therefore IDENTICAL to BONUS_NET. Only the BASE column moves. Writing V for
// the whole-chain value and x_a := V[a][BASE]:
//
//   x_a = R[a][BASE] + SUM_t P_a(t) * V[BASE][t],  V[BASE][t] = -x_t
//   =>  (I + P) x = R_BASE
//
// P is indexed by the actor's tier, not a single scalar: the side-game player
// knows which tier they are up against and plays differently when further
// behind (measured: they foul 28% against a QQ board but 46% against an AA
// one, gambling harder when the board they must beat is stronger). So the
// recursion penalty differs per tier — 0.93 / 0.84 / 0.72 — rather than being
// one shared constant.
//
// Direction: recursion makes triggering a bonus round worth LESS. The
// follow-up round only happens when the OPPONENT's side game qualifies, which
// hands them the bonus board and the actor the side game, so qualifying
// carries retaliation risk.
//
// Both R[a][BASE] and P_a(t) are measured against a side-game player with the
// correct info set — getBotMove with invisibleBonusOpponents set (n=500/tier).
// That field is load-bearing, not cosmetic: a side-game player has no VISIBLE
// opponent, so without it every rollout scores a one-board table, scoreTable's
// pairwise loop never runs, and every candidate gets exactly 0. The bot then
// returns an arbitrary first candidate and fouls ~67% of the time. An earlier
// version of this table was measured that way and was wrong; see mc.ts's note
// on invisibleBonusOpponents.
export const VARIANT_BONUS_NET: Record<BonusQualifier, Record<BonusOppScenario, number>> = {
  QQ:          { BASE: 9.14,  QQ: 0,    KK: -4.34, AA_OR_TRIPS: -9.19 },
  KK:          { BASE: 14.04, QQ: 4.34, KK: 0,     AA_OR_TRIPS: -4.62 },
  AA_OR_TRIPS: { BASE: 19.27, QQ: 9.19, KK: 4.62,  AA_OR_TRIPS: 0     },
}

// Deprecated: the single-opponent ("BASE") net values, kept for callers
// (royaltyMcts.ts's solitaire-style objective) that don't model opponents.
export const BONUS_EV_QQ       = BONUS_NET.QQ.BASE
export const BONUS_EV_KK       = BONUS_NET.KK.BASE
export const BONUS_EV_AA_TRIPS = BONUS_NET.AA_OR_TRIPS.BASE

// Expected bonus-round upside for `actorBoard`'s top-row qualifier, summed
// over each entry in `opponentBoards` (their ACTUAL simulated final board —
// each one's own qualifier tier, if any, is looked up via bonusTrigger so a
// co-qualifying opponent is valued correctly instead of assumed generic).
// With no opponent boards supplied, falls back to a single BASE opponent
// (the old default single-opponent behavior, for callers that don't model
// opponents at all).
//
// Note on a related, tested-and-rejected refinement: in a 3-player game
// where BOTH opponents are non-qualifying, they play their side games
// against each other with mutual street-by-street visibility (heuristic-
// Placement is opponent-aware — see opponentComparisonAdj in heuristic.ts),
// so their average play could plausibly differ from a solo non-qualifying
// opponent's. Measured directly (scripts/_compute-paired-base.ts, n=1500
// trials/tier, comparing two mutually-visible side-gamers against one
// solo side-gamer): QQ diff=-0.04, KK diff=+0.55, AA_OR_TRIPS diff=-0.01 —
// inconsistent in sign and small relative to the ~14-22 point scale of
// BASE itself, i.e. not distinguishable from sampling noise. Both scenarios
// use the same BASE constant; no separate "paired" constant was added.
export function bonusGameValue(
  actorBoard: Board,
  opponentBoards: readonly Board[] = [],
  rules: RuleSet = CLASSIC_RULES,
): number {
  const q = bonusTrigger(actorBoard, rules)
  if (!q) return 0
  // Recursive rulesets are worth less per trigger, not more — see
  // VARIANT_BONUS_NET above.
  const table = rules.allowBonusRecursion ? VARIANT_BONUS_NET : BONUS_NET
  if (opponentBoards.length === 0) return table[q].BASE
  let total = 0
  for (const oppBoard of opponentBoards) {
    const oppQ = bonusTrigger(oppBoard, rules)
    total += table[q][oppQ ?? 'BASE']
  }
  return total
}
