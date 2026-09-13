import { describe, it, expect } from 'vitest'
import { scorePair, scoreTable } from '../scoring'
import { isFoul, royalties, bonusTrigger, topRoyalty, middleRoyalty, bottomRoyalty } from '../rules'
import { evaluate3, evaluate5, compareHandRank } from '../evaluate'
import { FULL_DECK, parseCards } from '../deck'
import { HandCategory } from '../types'
import type { Board, Card, BonusQualifier } from '../types'

// scorePair, scoreTable, isFoul, royalties and bonusTrigger all moved onto the
// allocation-light evaluator, ranking each board once instead of re-evaluating
// every row two or three times per call. fastEvaluate.test.ts used to be the
// cross-check for that formula, but it compares fastScorePair against
// scorePair — which now delegates to fastScorePair, so it no longer proves
// anything. These reference implementations are the ORIGINAL evaluate.ts-based
// versions, kept here deliberately so the optimized production code is still
// checked against an independent one.

function refIsFoul(b: Board): boolean {
  const top = evaluate3(b.top)
  const mid = evaluate5(b.middle)
  const bot = evaluate5(b.bottom)
  return compareHandRank(top, mid) > 0 || compareHandRank(mid, bot) > 0
}

function refRoyalties(b: Board): number {
  if (refIsFoul(b)) return 0
  return topRoyalty(b.top) + middleRoyalty(b.middle) + bottomRoyalty(b.bottom)
}

function refScorePair(a: Board, b: Board): number {
  const aFoul = refIsFoul(a)
  const bFoul = refIsFoul(b)
  if (aFoul && bFoul) return 0
  const aRoy = aFoul ? 0 : refRoyalties(a)
  const bRoy = bFoul ? 0 : refRoyalties(b)
  let rowScore: number
  if (aFoul) rowScore = -6
  else if (bFoul) rowScore = 6
  else {
    const sum = compareHandRank(evaluate3(a.top), evaluate3(b.top))
      + compareHandRank(evaluate5(a.middle), evaluate5(b.middle))
      + compareHandRank(evaluate5(a.bottom), evaluate5(b.bottom))
    rowScore = sum === 3 ? 6 : sum === -3 ? -6 : sum
  }
  return rowScore + aRoy - bRoy
}

function refBonusTrigger(b: Board): BonusQualifier | null {
  if (refIsFoul(b)) return null
  const top = evaluate3(b.top)
  if (top.category === HandCategory.Trips) return 'AA_OR_TRIPS'
  if (top.category === HandCategory.OnePair) {
    const pr = top.tiebreakers[0]!
    if (pr === 14) return 'AA_OR_TRIPS'
    if (pr === 13) return 'KK'
    if (pr === 12) return 'QQ'
  }
  return null
}

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomBoards(rng: () => number, count: number): Board[] {
  const a = [...FULL_DECK] as Card[]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = a[i]!; a[i] = a[j]!; a[j] = tmp
  }
  const out: Board[] = []
  for (let k = 0; k < count; k++) {
    const c = a.slice(k * 13, k * 13 + 13)
    out.push({ top: c.slice(0, 3), middle: c.slice(3, 8), bottom: c.slice(8, 13) })
  }
  return out
}

describe('optimized scoring matches the reference implementation', () => {
  it('scorePair agrees over 30000 random board pairings', () => {
    const rng = mulberry32(31337)
    let fouls = 0, royaltyBoards = 0
    for (let i = 0; i < 30000; i++) {
      const [a, b] = randomBoards(rng, 2) as [Board, Board]
      const got = scorePair(a, b)
      const want = refScorePair(a, b)
      expect(got.aNet).toBe(want)
      // zero-sum, with 0 normalized (see the -0 case below)
      expect(got.bNet).toBe(want === 0 ? 0 : -want)
      if (refIsFoul(a)) fouls++
      if (refRoyalties(a) > 0) royaltyBoards++
    }
    // The corpus must actually exercise both branches, or the test is hollow.
    expect(fouls).toBeGreaterThan(100)
    expect(royaltyBoards).toBeGreaterThan(100)
  })

  it('isFoul, royalties and bonusTrigger agree over 30000 random boards', () => {
    const rng = mulberry32(90210)
    let triggers = 0
    for (let i = 0; i < 30000; i++) {
      const [b] = randomBoards(rng, 1) as [Board]
      expect(isFoul(b)).toBe(refIsFoul(b))
      expect(royalties(b)).toBe(refRoyalties(b))
      const t = bonusTrigger(b)
      expect(t).toBe(refBonusTrigger(b))
      if (t !== null) triggers++
    }
    // Random 3/5/5 splits foul most of the time, so a non-fouling QQ+/trips
    // top is genuinely rare here (single digits in 30k). This only asserts the
    // branch is reached at all; per-tier coverage is in the hand-built cases
    // below, which exercise QQ, KK and trips explicitly.
    expect(triggers).toBeGreaterThan(0)
  })

  it('agrees on hand-built boards covering foul, scoop and big royalties', () => {
    const mk = (t: string[], m: string[], b: string[]): Board =>
      ({ top: parseCards(t), middle: parseCards(m), bottom: parseCards(b) })
    const cases: Board[] = [
      // Fouls by pairs (test vector 1 from docs/01_RULES_AND_SCORING.md)
      mk(['As', 'Ad', '4c'], ['Ks', 'Kd', '9h', '8h', '2c'], ['Qs', 'Qd', 'Qh', '7c', '5d']),
      // Legal stack with royalties (test vector 2)
      mk(['2s', '2d', '9c'], ['8h', '8s', '8d', '4c', '3h'], ['Th', 'Jh', 'Qh', 'Kh', 'Ah']),
      // Trips top (max royalty) over quads / straight flush
      mk(['Ac', 'Ad', 'Ah'], ['2c', '2d', '2h', '2s', '7c'], ['9d', '8d', '7d', '6d', '5d']),
      // Exactly-equal rows: Top == Middle == Bottom category, must not foul
      mk(['3c', '4d', '7h'], ['2c', '5d', '8h', 'Ts', 'Jc'], ['2d', '5h', '9s', 'Tc', 'Jd']),
      // Bonus trigger tiers
      mk(['Qc', 'Qd', '3h'], ['Kc', 'Kd', '5h', '6s', '7c'], ['Ac', 'Ad', '8h', '9s', 'Tc']),
      mk(['Kc', 'Kd', '3h'], ['Ac', 'Ad', '5h', '6s', '7c'], ['2c', '2d', '2h', '9s', 'Tc']),
    ]
    for (const a of cases) {
      expect(isFoul(a)).toBe(refIsFoul(a))
      expect(royalties(a)).toBe(refRoyalties(a))
      expect(bonusTrigger(a)).toBe(refBonusTrigger(a))
      for (const b of cases) expect(scorePair(a, b).aNet).toBe(refScorePair(a, b))
    }
  })

  it('never returns -0 when both boards foul', () => {
    const foul: Board = {
      top: parseCards(['As', 'Ad', '4c']),
      middle: parseCards(['Ks', 'Kd', '9h', '8h', '2c']),
      bottom: parseCards(['Qs', 'Qd', 'Qh', '7c', '5d']),
    }
    const { aNet, bNet } = scorePair(foul, foul)
    // Object.is distinguishes these; plain === does not.
    expect(Object.is(aNet, 0)).toBe(true)
    expect(Object.is(bNet, 0)).toBe(true)
    for (const n of scoreTable([foul, foul, foul])) expect(Object.is(n, 0)).toBe(true)
  })

  it('scoreTable stays zero-sum for 2 and 3 players', () => {
    const rng = mulberry32(5150)
    for (let i = 0; i < 3000; i++) {
      for (const n of [2, 3]) {
        const boards = randomBoards(rng, n)
        const nets = scoreTable(boards)
        expect(nets.reduce((x, y) => x + y, 0)).toBe(0)
        // and matches pairwise reference summation
        const want = boards.map((_, k) =>
          boards.reduce((acc, _o, j) => j === k ? acc : acc + refScorePair(boards[k]!, boards[j]!), 0))
        expect(nets).toEqual(want)
      }
    }
  })
})

describe('partial boards still take the tolerant slow path', () => {
  // BoardView and GamePlayView cast still-growing boards to Board to show a
  // live status mid-hand. The fast evaluator reads cards positionally, so
  // these must not reach it.
  const partials: Board[] = [
    { top: [], middle: [], bottom: [] } as unknown as Board,
    { top: parseCards(['As']), middle: [], bottom: [] } as unknown as Board,
    { top: parseCards(['As', 'Kd', 'Qh']), middle: parseCards(['2c', '3d']), bottom: [] } as unknown as Board,
    { top: parseCards(['As', 'Kd', 'Qh']), middle: parseCards(['2c', '3d', '4h', '5s', '7c']), bottom: parseCards(['9d']) } as unknown as Board,
  ]

  it('does not throw on incomplete boards', () => {
    for (const b of partials) {
      expect(() => isFoul(b)).not.toThrow()
      expect(() => royalties(b)).not.toThrow()
      expect(() => bonusTrigger(b)).not.toThrow()
    }
  })

  it('returns the same answers the evaluate.ts path always did', () => {
    for (const b of partials) {
      expect(isFoul(b)).toBe(refIsFoul(b))
      expect(royalties(b)).toBe(refRoyalties(b))
      expect(bonusTrigger(b)).toBe(refBonusTrigger(b))
    }
  })

  // The analyzer lets a user describe any position, including a later street
  // whose rows aren't filled, and rollout() then scores boards that never
  // reach 13 cards. Scoring one used to return a harmless answer; it must not
  // start throwing.
  it('scorePair and scoreTable handle incomplete boards without throwing', () => {
    const complete: Board = {
      top: parseCards(['2s', '2d', '9c']),
      middle: parseCards(['8h', '8s', '8d', '4c', '3h']),
      bottom: parseCards(['Th', 'Jh', 'Qh', 'Kh', 'Ah']),
    }
    for (const b of partials) {
      expect(() => scorePair(b, complete)).not.toThrow()
      expect(() => scorePair(complete, b)).not.toThrow()
      expect(() => scoreTable([b, complete])).not.toThrow()
      expect(scorePair(b, complete).aNet).toBe(refScorePair(b, complete))
      expect(scorePair(complete, b).aNet).toBe(refScorePair(complete, b))
      expect(scoreTable([b, complete]).reduce((x, y) => x + y, 0)).toBe(0)
    }
  })
})
