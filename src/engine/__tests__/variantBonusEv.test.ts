import { describe, it, expect } from 'vitest'
import { bonusGameValue, bonusTrigger, BONUS_NET, VARIANT_BONUS_NET } from '../rules'
import { parseCards } from '../deck'
import { CLASSIC_RULES, VARIANT_RULES } from '../types'
import type { Board, BonusQualifier, RuleSet } from '../types'

const mk = (t: string[], m: string[], b: string[]): Board =>
  ({ top: parseCards(t), middle: parseCards(m), bottom: parseCards(b) })

const TIERS: readonly BonusQualifier[] = ['QQ', 'KK', 'AA_OR_TRIPS']

// Boards whose top row fixes the tier, all legal and non-fouling.
const qq = mk(['Qs', 'Qd', '2c'], ['Kc', 'Kh', '3c', '4d', '8s'], ['Ac', 'Ad', '5h', '9s', 'Tc'])
const kk = mk(['Kc', 'Kd', '3h'], ['Ac', 'Ad', '5h', '6s', '7c'], ['2c', '2d', '2h', '9s', 'Tc'])
const aa = mk(['Ac', 'Ad', '3h'], ['2c', '2d', '2h', '6s', '7c'], ['4c', '4d', '4h', '9s', 'Tc'])
const none = mk(['2s', '3d', '7c'], ['4h', '5c', '8d', 'Tc', 'Jd'], ['6h', '9h', 'Qs', 'Ks', 'Ah'])
const byTier: Record<BonusQualifier, Board> = { QQ: qq, KK: kk, AA_OR_TRIPS: aa }

describe('variant bonus EV table', () => {
  it('the fixtures qualify at the tiers the tests assume', () => {
    for (const t of TIERS) expect(bonusTrigger(byTier[t], CLASSIC_RULES)).toBe(t)
    expect(bonusTrigger(none, CLASSIC_RULES)).toBeNull()
    expect(bonusTrigger(none, VARIANT_RULES)).toBeNull()
  })

  it('leaves every tier-vs-tier cell identical to the classic table', () => {
    // A round in which both players hold bonus boards cannot re-trigger, so
    // the chain ends there and recursion changes nothing.
    for (const a of TIERS) for (const b of TIERS) {
      expect(VARIANT_BONUS_NET[a][b]).toBe(BONUS_NET[a][b])
    }
  })

  it('reduces every BASE cell, by a tier-dependent amount', () => {
    // (I + P) x = R with P indexed by the actor's tier, so the penalty is NOT
    // one shared constant: a side-game player facing a stronger board gambles
    // harder and qualifies at a different rate. The penalty shrinks as the
    // actor's tier rises.
    const drops = TIERS.map(t => BONUS_NET[t].BASE - VARIANT_BONUS_NET[t].BASE)
    for (const d of drops) {
      expect(d).toBeGreaterThan(0)  // recursion COSTS the trigger-er
      expect(d).toBeLessThan(6)     // and not by an implausible amount
    }
    // Strictly decreasing QQ -> KK -> AA.
    expect(drops[0]).toBeGreaterThan(drops[1]!)
    expect(drops[1]).toBeGreaterThan(drops[2]!)
  })

  it('stays antisymmetric and zero on the diagonal', () => {
    for (const a of TIERS) {
      expect(VARIANT_BONUS_NET[a][a]).toBe(0)
      for (const b of TIERS) expect(VARIANT_BONUS_NET[a][b]).toBeCloseTo(-VARIANT_BONUS_NET[b][a], 10)
    }
  })

  it('bonusGameValue picks the table off allowBonusRecursion', () => {
    for (const t of TIERS) {
      const board = byTier[t]
      // vs a non-qualifying (side-game) opponent -> the BASE cell
      expect(bonusGameValue(board, [none], CLASSIC_RULES)).toBe(BONUS_NET[t].BASE)
      expect(bonusGameValue(board, [none], VARIANT_RULES)).toBe(VARIANT_BONUS_NET[t].BASE)
      expect(bonusGameValue(board, [none], VARIANT_RULES))
        .toBeLessThan(bonusGameValue(board, [none], CLASSIC_RULES))
      // vs a qualifying opponent -> unchanged between rulesets
      expect(bonusGameValue(board, [kk], VARIANT_RULES)).toBe(bonusGameValue(board, [kk], CLASSIC_RULES))
    }
  })

  it('sums one term per opponent, so 3-player still works', () => {
    const two = bonusGameValue(aa, [none, none], VARIANT_RULES)
    const one = bonusGameValue(aa, [none], VARIANT_RULES)
    expect(two).toBeCloseTo(2 * one, 10)
  })

  it('a ruleset with recursion off keeps the classic table even with the bottom rule on', () => {
    // The table switch keys off allowBonusRecursion alone — the bottom
    // straight-flush rule changes WHICH boards trigger, not what a trigger is
    // worth once you have one.
    const bottomOnly: RuleSet = {
      bonusFromBottomStraightFlush: true, allowBonusRecursion: false, placementOrder: 'simultaneous',
    }
    expect(bonusGameValue(qq, [none], bottomOnly)).toBe(BONUS_NET.QQ.BASE)
  })

  it('returns 0 for a board that does not qualify', () => {
    expect(bonusGameValue(none, [qq], VARIANT_RULES)).toBe(0)
    expect(bonusGameValue(none, [qq], CLASSIC_RULES)).toBe(0)
  })
})
