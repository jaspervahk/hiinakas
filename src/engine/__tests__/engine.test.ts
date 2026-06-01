import { describe, it, expect } from 'vitest'
import {
  parseCards,
  evaluate3,
  evaluate5,
  compareHandRank,
  isFoul,
  royalties,
  bonusTrigger,
  bonusDealCount,
  scorePair,
  scoreTable,
  HandCategory,
  Deck,
} from '../index'
import type { Board } from '../index'

// Helper: build a Board from string arrays
function board(top: string[], middle: string[], bottom: string[]): Board {
  return {
    top: parseCards(top),
    middle: parseCards(middle),
    bottom: parseCards(bottom),
  }
}

// ── §9 Vector 1: Foul by pairs ─────────────────────────────────────────────
describe('Vector 1 — foul by pairs', () => {
  it('top pair(A) > middle pair(K) → foul', () => {
    const b = board(
      ['As', 'Ad', '4c'],
      ['Ks', 'Kd', '9h', '8h', '2c'],
      ['Qs', 'Qd', 'Qh', '7c', '5d'],
    )
    expect(isFoul(b)).toBe(true)
  })
})

// ── §9 Vector 2: Legal stack + royalties ──────────────────────────────────
describe('Vector 2 — legal stack', () => {
  const b = board(
    ['2s', '2d', '9c'],
    ['8h', '8s', '8d', '4c', '3h'],
    ['Th', 'Jh', 'Qh', 'Kh', 'Ah'],
  )

  it('board is not fouled', () => {
    expect(isFoul(b)).toBe(false)
  })

  it('bottom royal flush → +25', () => {
    const rank = evaluate5(b.bottom)
    expect(rank.category).toBe(HandCategory.RoyalFlush)
    expect(royalties(b)).toBeGreaterThanOrEqual(25)
  })

  it('middle trips → +2', () => {
    const rank = evaluate5(b.middle)
    expect(rank.category).toBe(HandCategory.Trips)
  })

  it('top pair(2) → royalty 0', () => {
    const rank = evaluate3(b.top)
    expect(rank.category).toBe(HandCategory.OnePair)
    // Pair 2 < pair 6 → 0 royalty from top
    expect(royalties(b)).toBe(25 + 2 + 0) // bottom+middle+top
  })
})

// ── §9 Vector 3: Scoop ────────────────────────────────────────────────────
describe('Vector 3 — scoop', () => {
  it('A wins all 3 rows, no bust, no royalties → A +6, B −6', () => {
    // Royalty-free boards so scoop bonus is the only delta.
    // A royalties: pair5 top=0, two-pair middle=0, trips bottom=0 → total 0
    // B royalties: high-card top=0, pair(A) middle=0, two-pair bottom=0 → total 0
    const a = board(
      ['5s', '5d', '2c'],              // pair(5) → royalty 0 (pair <66)
      ['9s', '9d', '8s', '8d', '3h'], // two-pair (9,8) → royalty 0
      ['7h', '7d', '7c', '4h', '3s'], // trips(7) → royalty 0 on bottom
    )
    const b = board(
      ['2h', '3d', '4c'],              // high card → royalty 0
      ['As', 'Ad', 'Ks', 'Qh', 'Jd'], // pair(A) on middle → royalty 0
      ['Kh', 'Kd', 'Qc', 'Qd', '2s'], // two-pair (K,Q) on bottom → royalty 0
    )
    const { aNet, bNet } = scorePair(a, b)
    expect(aNet).toBe(6)
    expect(bNet).toBe(-6)
    expect(aNet + bNet).toBe(0)
  })
})

// ── §9 Vector 4: Royalty independent of row loss ───────────────────────────
describe('Vector 4 — royalty survives row loss', () => {
  it('A loses bottom row but has flush → A still books +4 bottom royalty', () => {
    // A's board (legal: pair<straight<flush): wins top+middle, loses bottom.
    // A royalties: pair(7)=+2, straight=+4, flush=+4 → total +10
    // B royalties: pair(3)=0, two-pair=0, full-house=+6 → total +6
    // Row: A wins top(+1), A wins middle(+1), B wins bottom(-1) → row score +1
    // aNet = 1 + 10 - 6 = +5
    const a = board(
      ['7s', '7d', '2c'],              // pair(7) → royalty +2
      ['5h', '6d', '7c', '8s', '9d'], // straight 5-9 → royalty +4
      ['2h', '4h', '6h', '8h', 'Th'], // flush → royalty +4
    )
    const b = board(
      ['3h', '3d', 'Ac'],             // pair(3) → royalty 0
      ['Ah', 'Ad', 'Kh', 'Kd', '4s'], // two-pair (A,K) → royalty 0 on middle
      ['Jh', 'Jd', 'Js', 'Qh', 'Qd'], // full house JJJ-QQ → royalty +6
    )
    const royA = royalties(a)
    // The key invariant: A earns the flush royalty even though A lost that row
    expect(royA).toBe(10) // pair(7)=2 + straight=4 + flush=4
    const { aNet, bNet } = scorePair(a, b)
    expect(aNet).toBe(5)  // row+1 + royA(10) - royB(6)
    expect(aNet + bNet).toBe(0)
  })
})

// ── §9 Vector 5: Bust opponent ────────────────────────────────────────────
describe('Vector 5 — bust opponent', () => {
  it('B fouls → A gets +6 plus royalties; B gets 0 royalties', () => {
    // A's board is legal (high-card < straight < full-house).
    // A royalties: 0 + straight(+4) + full-house(+6) = +10
    const a = board(
      ['2s', '3d', '5c'],              // high card (royalty 0)
      ['6h', '7d', '8c', '9s', 'Th'], // straight 6-T (royalty +4)
      ['Jh', 'Jd', 'Jc', 'Qh', 'Qd'], // full house JJJ-QQ (royalty +6)
    )
    // B's board is fouled: top pair(A) > middle pair(K)
    const b = board(
      ['As', 'Ad', '4c'],
      ['Ks', 'Kd', '9h', '8h', '2c'],
      ['Qs', 'Qd', 'Qh', '7c', '5d'],
    )
    expect(isFoul(a)).toBe(false)
    expect(isFoul(b)).toBe(true)
    const { aNet, bNet } = scorePair(a, b)
    const aRoy = royalties(a)
    expect(aRoy).toBe(10)
    expect(aNet).toBe(6 + aRoy)  // 16
    expect(bNet).toBe(-6 - aRoy) // -16
    expect(aNet + bNet).toBe(0)
  })
})

// ── §9 Vector 6: Both bust ─────────────────────────────────────────────────
describe('Vector 6 — both bust', () => {
  it('both fouled → net 0', () => {
    const foul = board(
      ['As', 'Ad', '4c'],
      ['Ks', 'Kd', '9h', '8h', '2c'],
      ['Qs', 'Qd', 'Qh', '7c', '5d'],
    )
    const { aNet, bNet } = scorePair(foul, foul)
    expect(aNet).toBe(0)
    expect(bNet).toBe(0)
  })
})

// ── §9 Vector 7: Top royalty ladder ───────────────────────────────────────
describe('Vector 7 — top royalty ladder', () => {
  // Middle two-pair (cat=2) and bottom trips (cat=3) both score 0 royalty,
  // so total royalties = top royalty only. Valid for any pair top (cat=1).
  function pairTopBoard(top: string[]): Board {
    return board(top, ['3h', '3d', '4s', '4c', '5h'], ['6h', '6d', '6c', '7h', '8d'])
  }

  it('QQ → +7', () => {
    const b = pairTopBoard(['Qs', 'Qd', '7c'])
    const r = evaluate3(b.top)
    expect(r.category).toBe(HandCategory.OnePair)
    expect(r.tiebreakers[0]).toBe(12)
    expect(royalties(b)).toBe(7) // QQ=7, middle two-pair=0, bottom trips=0
  })

  it('77 → +2', () => {
    const b = pairTopBoard(['7s', '7d', '2c'])
    expect(royalties(b)).toBe(2)
  })

  it('55 → 0 (below 66)', () => {
    const b = pairTopBoard(['5s', '5d', '9c'])
    expect(royalties(b)).toBe(0)
  })

  it('trip Ks → +21', () => {
    // trips(K) top (cat=3) requires middle ≥ cat=3.
    // straight(cat=4) middle + flush(cat=5) bottom: +4 + +4 royalties.
    // Total: trips(K)=21 + straight=4 + flush=4 = 29
    const b = board(
      ['Kc', 'Kd', 'Ks'],
      ['2h', '3d', '4c', '5s', '6h'], // straight 2-6 → +4 middle royalty
      ['7h', '9h', 'Jh', 'Qh', 'Ah'], // flush A-high → +4 bottom royalty
    )
    const r = evaluate3(b.top)
    expect(r.category).toBe(HandCategory.Trips)
    expect(r.tiebreakers[0]).toBe(13) // King
    expect(royalties(b)).toBe(29)
  })
})

// ── §9 Vector 8: Bonus trigger ────────────────────────────────────────────
describe('Vector 8 — bonus round trigger', () => {
  function topBoard(top: string[]): Board {
    return board(top, ['2h', '3d', '4c', '5s', '6h'], ['7h', '8d', '9c', 'Ts', 'Jh'])
  }

  it('QQ top → qualifier QQ, 13 cards', () => {
    const b = topBoard(['Qs', 'Qd', '7c'])
    const q = bonusTrigger(b)
    expect(q).toBe('QQ')
    expect(bonusDealCount(q!)).toBe(13)
  })

  it('KK top → qualifier KK, 14 cards', () => {
    const b = topBoard(['Ks', 'Kd', '7c'])
    const q = bonusTrigger(b)
    expect(q).toBe('KK')
    expect(bonusDealCount(q!)).toBe(14)
  })

  it('AA top → qualifier AA_OR_TRIPS, 15 cards', () => {
    const b = topBoard(['As', 'Ad', '7c'])
    const q = bonusTrigger(b)
    expect(q).toBe('AA_OR_TRIPS')
    expect(bonusDealCount(q!)).toBe(15)
  })

  it('trips top → qualifier AA_OR_TRIPS, 15 cards', () => {
    const b = topBoard(['7c', '7d', '7h'])
    expect(bonusTrigger(b)).toBe('AA_OR_TRIPS')
  })

  it('bust board → no bonus trigger', () => {
    const b = board(
      ['As', 'Ad', '4c'],
      ['Ks', 'Kd', '9h', '8h', '2c'],
      ['Qs', 'Qd', 'Qh', '7c', '5d'],
    )
    expect(bonusTrigger(b)).toBeNull()
  })
})

// ── Property: zero-sum ─────────────────────────────────────────────────────
describe('property — zero-sum', () => {
  it('scoreTable sums to 0 for 2-player', () => {
    const a = board(['As', 'Ad', 'Kc'], ['Kh', 'Kd', 'Ks', '5h', '5d'], ['Th', 'Jh', 'Qh', 'Kh', 'Ah'])
    const b = board(['2s', '3d', '4c'], ['5s', '6d', '7c', '8h', '9d'], ['2h', '3h', '4h', '5d', '6d'])
    const [na, nb] = scoreTable([a, b])
    expect(na! + nb!).toBe(0)
  })

  it('scoreTable sums to 0 for 3-player', () => {
    const p0 = board(['As', 'Ad', 'Kc'], ['Kh', 'Kd', 'Ks', '5h', '5d'], ['Th', 'Jh', 'Qh', 'Kh', 'Ah'])
    const p1 = board(['2s', '3d', '4c'], ['5s', '6d', '7c', '8h', '9d'], ['2h', '3h', '4h', '5d', '6d'])
    const p2 = board(['7s', '7d', '2c'], ['8s', '8d', '8c', '9s', '9d'], ['Ac', 'Ad', 'Ah', 'Kc', 'Kd'])
    const [n0, n1, n2] = scoreTable([p0, p1, p2])
    expect(n0! + n1! + n2!).toBe(0)
  })
})

// ── Property: bust board never earns royalties ─────────────────────────────
describe('property — no royalties on bust board', () => {
  it('fouled board royalties = 0', () => {
    const b = board(
      ['As', 'Ad', '4c'],
      ['Ks', 'Kd', '9h', '8h', '2c'],
      ['Qs', 'Qd', 'Qh', '7c', '5d'],
    )
    expect(royalties(b)).toBe(0)
  })
})

// ── Property: determinism ──────────────────────────────────────────────────
describe('property — deck determinism', () => {
  it('same seed → same deal order', () => {
    const d1 = new Deck(42)
    const d2 = new Deck(42)
    const hand1 = d1.deal(5)
    const hand2 = d2.deal(5)
    expect(hand1).toEqual(hand2)
  })

  it('different seeds → different deal (statistically certain)', () => {
    const d1 = new Deck(1)
    const d2 = new Deck(2)
    expect(d1.deal(5)).not.toEqual(d2.deal(5))
  })
})

// ── Cross-size comparison ──────────────────────────────────────────────────
describe('cross-size foul comparison', () => {
  it('top trips(7) vs middle two-pair → foul', () => {
    const b = board(
      ['7c', '7d', '7h'],
      ['Ah', 'As', '2c', '2d', '9h'],
      ['Qs', 'Qd', 'Qh', 'Kh', 'Kd'],
    )
    // top trips(7) > middle two-pair → foul
    expect(isFoul(b)).toBe(true)
  })

  it('top pair(K) vs middle pair(A) → legal', () => {
    const b = board(
      ['Ks', 'Kd', '2c'],
      ['As', 'Ad', '9h', '8h', '3c'],
      ['Qs', 'Qd', 'Qh', '7c', '5d'],
    )
    // top pair(K) < middle pair(A) → legal
    expect(isFoul(b)).toBe(false)
  })
})

// ── Straight evaluation edge cases ────────────────────────────────────────
describe('straight evaluation', () => {
  it('A-low straight (wheel) has high card 5', () => {
    const cards = parseCards(['Ah', '2d', '3c', '4s', '5h'])
    const rank = evaluate5(cards)
    expect(rank.category).toBe(HandCategory.Straight)
    expect(rank.tiebreakers[0]).toBe(5)
  })

  it('royal flush detected', () => {
    const cards = parseCards(['Th', 'Jh', 'Qh', 'Kh', 'Ah'])
    expect(evaluate5(cards).category).toBe(HandCategory.RoyalFlush)
  })

  it('A-low straight flush', () => {
    const cards = parseCards(['Ah', '2h', '3h', '4h', '5h'])
    const rank = evaluate5(cards)
    expect(rank.category).toBe(HandCategory.StraightFlush)
    expect(rank.tiebreakers[0]).toBe(5)
  })
})

// ── compareHandRank ────────────────────────────────────────────────────────
describe('compareHandRank', () => {
  it('higher category wins', () => {
    const flush = evaluate5(parseCards(['2h', '4h', '6h', '8h', 'Th']))
    const straight = evaluate5(parseCards(['2c', '3h', '4d', '5s', '6h']))
    expect(compareHandRank(flush, straight)).toBe(1)
  })

  it('same category, kicker breaks tie', () => {
    const pairA = evaluate3(parseCards(['As', 'Ad', '2c']))
    const pairK = evaluate3(parseCards(['Ks', 'Kd', '2c']))
    expect(compareHandRank(pairA, pairK)).toBe(1)
    expect(compareHandRank(pairK, pairA)).toBe(-1)
  })

  it('identical hands compare equal', () => {
    const h1 = evaluate5(parseCards(['Ah', 'Kh', 'Qh', 'Jh', 'Th']))
    const h2 = evaluate5(parseCards(['As', 'Ks', 'Qs', 'Js', 'Ts']))
    expect(compareHandRank(h1, h2)).toBe(0)
  })
})
