import { HandCategory } from './types'
import type { Card, HandRank, Rank } from './types'

// ── Comparison ─────────────────────────────────────────────────────────────

// Total ordering for HandRank, valid across 3- and 5-card hands.
// Category is compared first; tiebreakers are compared element-by-element
// (missing elements treated as 0, so shorter = weaker on equal ranks).
export function compareHandRank(a: HandRank, b: HandRank): -1 | 0 | 1 {
  if (a.category !== b.category) {
    return a.category > b.category ? 1 : -1
  }
  const len = Math.max(a.tiebreakers.length, b.tiebreakers.length)
  for (let i = 0; i < len; i++) {
    const ar = a.tiebreakers[i] ?? 0
    const br = b.tiebreakers[i] ?? 0
    if (ar !== br) return ar > br ? 1 : -1
  }
  return 0
}

// ── 5-card evaluator ───────────────────────────────────────────────────────

export function evaluate5(cards: readonly Card[]): HandRank {
  // Ranks sorted high→low
  const ranks = [...cards.map(c => c.rank)].sort((a, b) => b - a) as Rank[]
  const suits = cards.map(c => c.suit)

  // Frequency map: rank → count
  const freq = new Map<Rank, number>()
  for (const r of ranks) freq.set(r, (freq.get(r) ?? 0) + 1)

  // Sort frequency entries: by count desc, then rank desc
  const entries = [...freq.entries()].sort((a, b) =>
    b[1] !== a[1] ? b[1] - a[1] : b[0] - a[0]
  )
  const sortedRanks = entries.map(e => e[0])
  const counts = entries.map(e => e[1])

  const isFlush = suits.every(s => s === suits[0])

  // Straight check (freq.size === 5 guarantees all unique ranks)
  let isStraight = false
  let straightHigh: Rank = ranks[0]
  if (freq.size === 5) {
    if (ranks[0] - ranks[4] === 4) {
      isStraight = true
      straightHigh = ranks[0]
    } else if (ranks[0] === 14 && ranks[1] === 5 && ranks[2] === 4 && ranks[3] === 3 && ranks[4] === 2) {
      // Ace-low straight (wheel): A-2-3-4-5 → high card is 5
      isStraight = true
      straightHigh = 5
    }
  }

  if (isFlush && isStraight) {
    return straightHigh === 14
      ? { category: HandCategory.RoyalFlush, tiebreakers: [] }
      : { category: HandCategory.StraightFlush, tiebreakers: [straightHigh] }
  }

  if (counts[0] === 4) {
    return { category: HandCategory.Quads, tiebreakers: [sortedRanks[0], sortedRanks[1]] as Rank[] }
  }

  if (counts[0] === 3 && counts[1] === 2) {
    return { category: HandCategory.FullHouse, tiebreakers: [sortedRanks[0], sortedRanks[1]] as Rank[] }
  }

  if (isFlush) {
    return { category: HandCategory.Flush, tiebreakers: ranks }
  }

  if (isStraight) {
    return { category: HandCategory.Straight, tiebreakers: [straightHigh] }
  }

  if (counts[0] === 3) {
    // Trips in 5-card hand; two kickers
    return { category: HandCategory.Trips, tiebreakers: sortedRanks as Rank[] }
  }

  if (counts[0] === 2 && counts[1] === 2) {
    return { category: HandCategory.TwoPair, tiebreakers: sortedRanks as Rank[] }
  }

  if (counts[0] === 2) {
    return { category: HandCategory.OnePair, tiebreakers: sortedRanks as Rank[] }
  }

  return { category: HandCategory.HighCard, tiebreakers: ranks }
}

// ── 3-card evaluator (top row only) ────────────────────────────────────────
// Top row: only HighCard / OnePair / Trips are valid categories.
// Straights and flushes do NOT count on a 3-card hand.

export function evaluate3(cards: readonly Card[]): HandRank {
  const ranks = [...cards.map(c => c.rank)].sort((a, b) => b - a) as Rank[]

  const freq = new Map<Rank, number>()
  for (const r of ranks) freq.set(r, (freq.get(r) ?? 0) + 1)

  const entries = [...freq.entries()].sort((a, b) =>
    b[1] !== a[1] ? b[1] - a[1] : b[0] - a[0]
  )
  const sortedRanks = entries.map(e => e[0])
  const counts = entries.map(e => e[1])

  if (counts[0] === 3) {
    return { category: HandCategory.Trips, tiebreakers: [sortedRanks[0]] as Rank[] }
  }

  if (counts[0] === 2) {
    return { category: HandCategory.OnePair, tiebreakers: sortedRanks as Rank[] }
  }

  return { category: HandCategory.HighCard, tiebreakers: ranks }
}
