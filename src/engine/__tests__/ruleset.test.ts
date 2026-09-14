import { describe, it, expect } from 'vitest'
import { bonusTrigger, bonusDealCount, bonusGameValue, isFoul } from '../rules'
import { parseCards, FULL_DECK } from '../deck'
import { CLASSIC_RULES, VARIANT_RULES } from '../types'
import type { Board, Card, RuleSet } from '../types'

const mk = (t: string[], m: string[], b: string[]): Board =>
  ({ top: parseCards(t), middle: parseCards(m), bottom: parseCards(b) })

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function shuffled(rng: () => number): Card[] {
  const a = [...FULL_DECK] as Card[]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = a[i]!; a[i] = a[j]!; a[j] = tmp
  }
  return a
}

describe('bottom straight flush trigger (variant rules)', () => {
  // Legal stack (top <= middle <= bottom) with a straight flush on the bottom
  // and a top row that qualifies for nothing on its own.
  const sfBottom = mk(['2s', '7d', '9c'], ['3h', '5c', '8d', 'Tc', 'Jd'], ['9h', '8h', '7h', '6h', '5h'])
  const royalBottom = mk(['2s', '7d', '9c'], ['3h', '5c', '8d', 'Tc', 'Jd'], ['Ah', 'Kh', 'Qh', 'Jh', 'Th'])
  // Quads on the bottom is NOT enough — the threshold is straight flush.
  const quadsBottom = mk(['2s', '7d', '9c'], ['3h', '5c', '8d', 'Tc', 'Jd'], ['4h', '4d', '4s', '4c', 'Kh'])

  it('does not trigger under classic rules', () => {
    for (const b of [sfBottom, royalBottom, quadsBottom]) {
      expect(isFoul(b)).toBe(false) // the fixtures must be legal, or this proves nothing
      expect(bonusTrigger(b, CLASSIC_RULES)).toBeNull()
    }
  })

  it('triggers the 15-card tier under variant rules', () => {
    expect(bonusTrigger(sfBottom, VARIANT_RULES)).toBe('AA_OR_TRIPS')
    expect(bonusTrigger(royalBottom, VARIANT_RULES)).toBe('AA_OR_TRIPS')
    expect(bonusDealCount(bonusTrigger(sfBottom, VARIANT_RULES)!)).toBe(15)
  })

  it('still requires straight flush or better on the bottom', () => {
    expect(bonusTrigger(quadsBottom, VARIANT_RULES)).toBeNull()
  })

  it('a fouled board never triggers, however strong the bottom', () => {
    // Top trips beats middle -> foul, despite a straight flush bottom.
    const fouled = mk(['As', 'Ad', 'Ac'], ['2h', '3c', '4d', '5s', '7c'], ['9h', '8h', '7h', '6h', '5h'])
    expect(isFoul(fouled)).toBe(true)
    expect(bonusTrigger(fouled, VARIANT_RULES)).toBeNull()
  })

  it('takes the better tier when top and bottom both qualify', () => {
    // QQ top (13 cards) + straight flush bottom (15) -> 15 wins.
    const both = mk(['Qs', 'Qd', '2c'], ['Kc', 'Kd', '3c', '4d', '8s'], ['9h', '8h', '7h', '6h', '5h'])
    expect(isFoul(both)).toBe(false)
    expect(bonusTrigger(both, CLASSIC_RULES)).toBe('QQ')
    expect(bonusTrigger(both, VARIANT_RULES)).toBe('AA_OR_TRIPS')
    expect(bonusDealCount(bonusTrigger(both, VARIANT_RULES)!)).toBe(15)
  })

  it('leaves top-row qualifiers exactly as they were', () => {
    const kk = mk(['Kc', 'Kd', '3h'], ['Ac', 'Ad', '5h', '6s', '7c'], ['2c', '2d', '2h', '9s', 'Tc'])
    expect(bonusTrigger(kk, CLASSIC_RULES)).toBe('KK')
    expect(bonusTrigger(kk, VARIANT_RULES)).toBe('KK')
  })
})

// The whole point of routing variants through a RuleSet is that the existing
// game is untouched. CLASSIC_RULES must be indistinguishable from no argument
// at all, on every board — this is what lets the current bot, coach, analyzer
// and arena keep their verified behavior.
describe('CLASSIC_RULES is identical to the default argument', () => {
  it('agrees with the no-argument call over 40000 random boards', () => {
    const rng = mulberry32(606060)
    let triggers = 0
    for (let i = 0; i < 40000; i++) {
      const d = shuffled(rng)
      const b: Board = { top: d.slice(0, 3), middle: d.slice(3, 8), bottom: d.slice(8, 13) }
      const o: Board = { top: d.slice(13, 16), middle: d.slice(16, 21), bottom: d.slice(21, 26) }
      const def = bonusTrigger(b)
      expect(bonusTrigger(b, CLASSIC_RULES)).toBe(def)
      expect(bonusGameValue(b, [o], CLASSIC_RULES)).toBe(bonusGameValue(b, [o]))
      if (def !== null) triggers++
    }
    expect(triggers).toBeGreaterThan(0)
  })

  it('classic triggers always survive into variant, at a tier no smaller', () => {
    const rng = mulberry32(707070)
    let classicTriggers = 0
    for (let i = 0; i < 40000; i++) {
      const d = shuffled(rng)
      const b: Board = { top: d.slice(0, 3), middle: d.slice(3, 8), bottom: d.slice(8, 13) }
      const c = bonusTrigger(b, CLASSIC_RULES)
      if (c === null) continue
      classicTriggers++
      const v = bonusTrigger(b, VARIANT_RULES)
      expect(v).not.toBeNull()
      expect(bonusDealCount(v!)).toBeGreaterThanOrEqual(bonusDealCount(c))
    }
    expect(classicTriggers).toBeGreaterThan(0)
  })

  it('variant gains triggers classic misses, across every straight flush', () => {
    // Random 3/5/5 splits have a non-fouling bottom straight flush roughly
    // never (0 in 40k measured), so the new rule has to be exercised by
    // construction: every straight flush in every suit, each given a legal,
    // deliberately worthless top and middle.
    const SUITS = ['c', 'd', 'h', 's'] as const
    const RANK_CH: Record<number, string> = { 14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T' }
    const ch = (r: number) => RANK_CH[r] ?? String(r)
    let gained = 0
    for (const suit of SUITS) {
      // low = 5 means the wheel (A2345); low = 10 means the royal.
      for (let low = 5; low <= 14; low++) {
        const ranks = low === 5 ? [14, 5, 4, 3, 2] : [low, low - 1, low - 2, low - 3, low - 4]
        if (ranks.some(r => r < 2 || r > 14)) continue
        const bottom = ranks.map(r => `${ch(r)}${suit}`)
        // Top and middle from the other three suits, spread so neither pairs,
        // flushes nor straightens, and top stays weaker than middle.
        const others = SUITS.filter(x => x !== suit)
        const used = new Set(bottom)
        const pick = (want: number[], suits: readonly string[]): string[] => {
          const out: string[] = []
          for (const r of want) {
            for (const sx of suits) {
              const card = `${ch(r)}${sx}`
              if (!used.has(card)) { used.add(card); out.push(card); break }
            }
          }
          return out
        }
        const middle = pick([13, 11, 9, 6, 4], others)
        const top = pick([12, 7, 3], others)
        if (middle.length !== 5 || top.length !== 3) continue
        const b = mk(top, middle, bottom)
        if (isFoul(b)) continue // only legal boards can trigger anything
        expect(bonusTrigger(b, CLASSIC_RULES)).toBeNull()
        expect(bonusTrigger(b, VARIANT_RULES)).toBe('AA_OR_TRIPS')
        gained++
      }
    }
    expect(gained).toBeGreaterThanOrEqual(36) // 9 straight flushes x 4 suits
  })
})

describe('RuleSet presets', () => {
  it('classic and variant differ on exactly the three documented axes', () => {
    const keys = Object.keys(CLASSIC_RULES) as (keyof RuleSet)[]
    expect(keys.sort()).toEqual(['allowBonusRecursion', 'bonusFromBottomStraightFlush', 'placementOrder'])
    expect(CLASSIC_RULES).toEqual({
      bonusFromBottomStraightFlush: false, allowBonusRecursion: false, placementOrder: 'simultaneous',
    })
    expect(VARIANT_RULES).toEqual({
      bonusFromBottomStraightFlush: true, allowBonusRecursion: true, placementOrder: 'sequential',
    })
  })
})
