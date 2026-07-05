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

// Expected net royalties from optimal bonus-board play, averaged over 5000
// random deals, minus the side-game opponent's expected score. Lets rollout-
// style evaluators value a completed top-row qualifier's bonus-round upside
// without actually simulating the bonus deal.
//
// QQ  (13 cards, 0 discards): avg_royalties=9.0  -> net=7.0
// KK  (14 cards, 1 discard):  avg_royalties=12.7 -> net=10.7
// AA+ (15 cards, 2 discards): avg_royalties=19.2 -> net=17.2
export const BONUS_EV_QQ       = 7.0
export const BONUS_EV_KK       = 10.7
export const BONUS_EV_AA_TRIPS = 17.2

export function bonusGameValue(board: Board): number {
  const q = bonusTrigger(board)
  if (q === 'QQ')          return BONUS_EV_QQ
  if (q === 'KK')          return BONUS_EV_KK
  if (q === 'AA_OR_TRIPS') return BONUS_EV_AA_TRIPS
  return 0
}
