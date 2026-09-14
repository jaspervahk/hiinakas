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

// The bonus tier a board qualifies for, which is exactly its deal count:
// QQ=13, KK=14, AA_OR_TRIPS=15 (rules.ts bonusDealCount).
//
// A bottom-row straight flush or better (variant rules) also deals 15 and
// reuses AA_OR_TRIPS rather than adding a tier: the bonus board is built from
// a FRESH deal, so its distribution — and therefore every EV table and sample
// pool keyed by tier — depends only on how many cards you get, never on which
// row qualified you.
export type BonusQualifier = 'QQ' | 'KK' | 'AA_OR_TRIPS'

// ── Rule variants ──────────────────────────────────────────────────────────
//
// The engine supports more than one ruleset. Everything rules-dependent takes
// a RuleSet, defaulting to CLASSIC_RULES so existing callers are unchanged and
// bit-identical. Per CLAUDE.md invariant 1 there is still ONE engine: variants
// are configuration, never a forked copy of the rules or scoring.
export interface RuleSet {
  // Bottom row straight flush or better also triggers a 15-card bonus round,
  // in the normal round and in side games alike.
  readonly bonusFromBottomStraightFlush: boolean
  // A side-game player who qualifies starts a further bonus round, which can
  // chain. Unbounded: each round re-triggers with probability well below 1, so
  // chains terminate almost surely and the EV converges as a geometric series.
  readonly allowBonusRecursion: boolean
  // 'simultaneous': every player places a street at once, seeing opponents'
  // boards only as of the previous street.
  // 'sequential': players place one at a time starting left of the dealer, so
  // a later actor sees earlier actors' cards from the CURRENT street.
  readonly placementOrder: 'simultaneous' | 'sequential'
}

// v1 Hiinakas (docs/01_RULES_AND_SCORING.md).
export const CLASSIC_RULES: RuleSet = {
  bonusFromBottomStraightFlush: false,
  allowBonusRecursion: false,
  placementOrder: 'simultaneous',
}

// The variant: recursive bonus rounds, bottom straight flushes qualify, and
// ordered placement within a street.
export const VARIANT_RULES: RuleSet = {
  bonusFromBottomStraightFlush: true,
  allowBonusRecursion: true,
  placementOrder: 'sequential',
}

export interface PairResult {
  readonly aNet: number // always equals −bNet (zero-sum)
  readonly bNet: number
}
