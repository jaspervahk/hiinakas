import { HandCategory } from './types'
import type { Board, BonusQualifier, Card } from './types'
import { evaluate3, evaluate5, compareHandRank } from './evaluate'

// ── Foul detection ─────────────────────────────────────────────────────────

export function isFoul(board: Board): boolean {
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
  if (isFoul(board)) return 0
  return topRoyalty(board.top) + middleRoyalty(board.middle) + bottomRoyalty(board.bottom)
}

// ── Bonus round ────────────────────────────────────────────────────────────

// Returns the bonus qualifier for a non-bust board's top row, or null.
export function bonusTrigger(board: Board): BonusQualifier | null {
  if (isFoul(board)) return null
  const top = evaluate3(board.top)
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
// Carlo simulation (scripts/compute-bonus-ev.ts, shared-deck trials, flat
// 500 trials per cell) against every possible opponent scenario.
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
// (two boards drawn i.i.d. from the same distribution ⇒ E[net] = E[-net] = 0).
// Off-diagonal cells are symmetrized from both simulated directions
// (net(A,B) = -net(B,A) exactly, for any specific pair of boards, so
// averaging both directions' independent samples halves the estimation
// variance for free). BASE (non-qualifying opponent playing the 17-card
// side game) has no such counterpart and uses the raw simulated value.
export type BonusOppScenario = 'BASE' | BonusQualifier

export const BONUS_NET: Record<BonusQualifier, Record<BonusOppScenario, number>> = {
  QQ:          { BASE: 13.89, QQ: 0,     KK: -4.57,  AA_OR_TRIPS: -9.65 },
  KK:          { BASE: 18.21, QQ: 4.57,  KK: 0,      AA_OR_TRIPS: -4.68 },
  AA_OR_TRIPS: { BASE: 21.68, QQ: 9.65,  KK: 4.68,   AA_OR_TRIPS: 0     },
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
export function bonusGameValue(actorBoard: Board, opponentBoards: readonly Board[] = []): number {
  const q = bonusTrigger(actorBoard)
  if (!q) return 0
  if (opponentBoards.length === 0) return BONUS_NET[q].BASE
  let total = 0
  for (const oppBoard of opponentBoards) {
    const oppQ = bonusTrigger(oppBoard)
    total += BONUS_NET[q][oppQ ?? 'BASE']
  }
  return total
}
