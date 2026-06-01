export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14
export type Suit = 'c' | 'd' | 'h' | 's'

export interface Card {
  readonly rank: Rank
  readonly suit: Suit
}

// Numeric category for total hand ordering: higher number = stronger hand.
// Used as-is for cross-size foul comparison (Top ≤ Middle ≤ Bottom).
export const HandCategory = {
  HighCard: 0,
  OnePair: 1,
  TwoPair: 2,
  Trips: 3,
  Straight: 4,
  Flush: 5,
  FullHouse: 6,
  Quads: 7,
  StraightFlush: 8,
  RoyalFlush: 9,
} as const
export type HandCategory = typeof HandCategory[keyof typeof HandCategory]

export interface HandRank {
  readonly category: HandCategory
  // Descending priority ranks for tie-breaking (pair rank → kickers, etc.)
  readonly tiebreakers: readonly Rank[]
}

// A complete 3-5-5 board (all 13 cards placed, end of hand).
export interface Board {
  readonly top: readonly Card[]    // exactly 3
  readonly middle: readonly Card[] // exactly 5
  readonly bottom: readonly Card[] // exactly 5
}

// Partial board for mid-hand use (P3+).
export interface PartialBoard {
  readonly top: readonly Card[]    // 0–3
  readonly middle: readonly Card[] // 0–5
  readonly bottom: readonly Card[] // 0–5
}

export type BonusQualifier = 'QQ' | 'KK' | 'AA_OR_TRIPS'

export interface PairResult {
  readonly aNet: number // always equals −bNet (zero-sum)
  readonly bNet: number
}
