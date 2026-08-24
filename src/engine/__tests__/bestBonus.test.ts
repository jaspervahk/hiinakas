import { describe, it, expect } from 'vitest'
import { parseCards, isFoul, royalties, scorePair, Deck } from '../index'
import type { Board } from '../index'
import { bestBonusBoard, searchBonusBoardTies } from '../bestBonus'

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('searchBonusBoardTies', () => {
  it('every returned tie is a legal (non-fouling) board achieving bestRoy', () => {
    const cards = new Deck((mulberry32(1)() * 0x7fffffff) | 0).deal(13)
    const { bestRoy, ties } = searchBonusBoardTies(cards, 0, mulberry32(2), 500)
    expect(ties.length).toBeGreaterThan(0)
    for (const board of ties) {
      expect(isFoul(board as Board)).toBe(false)
      expect(royalties(board as Board)).toBe(bestRoy)
    }
  })

  it('bestRoy matches plain bestBonusBoard\'s royalty total', () => {
    const cards = new Deck((mulberry32(10)() * 0x7fffffff) | 0).deal(14)
    const { bestRoy } = searchBonusBoardTies(cards, 1, mulberry32(11), 500)
    const plain = bestBonusBoard(cards, 1)
    expect(bestRoy).toBe(royalties(plain))
  })

  it('respects the tie cap via reservoir sampling', () => {
    // A hand with a known-large tie count (see plan's empirical probe: KK
    // hands regularly produce hundreds-to-thousands of royalty ties).
    const cards = new Deck((mulberry32(20)() * 0x7fffffff) | 0).deal(14)
    const { ties } = searchBonusBoardTies(cards, 1, mulberry32(21), 5)
    expect(ties.length).toBeLessThanOrEqual(5)
  })

  it('is deterministic for a fixed seed', () => {
    const cards = new Deck((mulberry32(30)() * 0x7fffffff) | 0).deal(14)
    const a = searchBonusBoardTies(cards, 1, mulberry32(99), 10)
    const b = searchBonusBoardTies(cards, 1, mulberry32(99), 10)
    const key = (bs: readonly Board[]) => bs.map(b => [...b.top, ...b.middle, ...b.bottom].map(c => `${c.rank}${c.suit}`).join(',')).join('|')
    expect(key(a.ties as Board[])).toBe(key(b.ties as Board[]))
  })

  it('a hand with essentially no royalty upside (unpaired top, no flush/straight potential) still returns at least one legal board', () => {
    // 13 cards, all different ranks, mixed suits chosen to avoid an
    // accidental flush — should still find a valid non-fouling split even at
    // minimal (possibly zero) royalty.
    const cards = parseCards(['2s', '3h', '4d', '5c', '6s', '7h', '8d', '9c', 'Ts', 'Jh', 'Qd', 'Kc', '2h'])
    const { ties } = searchBonusBoardTies(cards, 0, mulberry32(1), 500)
    expect(ties.length).toBeGreaterThan(0)
    for (const board of ties) expect(isFoul(board as Board)).toBe(false)
  })

  it('kicker matters: among royalty-tied boards from a realistic random hand, scorePair distinguishes different kicker choices', () => {
    // Middle/bottom royalties are flat per category (any flush on the
    // bottom scores exactly 4, 7-high or Ace-high) — this is the actual gap
    // the opponent-aware solver fixes. Uses a real random deal (see the
    // empirical tie-count probe run during planning: real KK-tier hands
    // average ~300 ties) rather than a constructed hand — a maximally
    // symmetric hand (e.g. all one suit) can coincidentally have every tied
    // variation compare as an exact wash pairwise, which isn't
    // representative of real hands and isn't what this is testing for.
    let found = false
    for (let seed = 1; seed <= 20 && !found; seed++) {
      const cards = new Deck((mulberry32(seed)() * 0x7fffffff) | 0).deal(14)
      const { ties } = searchBonusBoardTies(cards, 1, mulberry32(seed + 1000), 3000)
      if (ties.length < 2) continue
      const sample = ties.slice(0, 30) as Board[]
      const nets = new Set<number>()
      for (const x of sample) for (const y of sample) nets.add(scorePair(x, y).aNet)
      if (nets.size > 1) found = true
    }
    expect(found).toBe(true)
  })
})
