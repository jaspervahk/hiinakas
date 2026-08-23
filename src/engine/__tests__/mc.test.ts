import { describe, it, expect } from 'vitest'
import { getBotMove, computeEV, parseCards } from '../index'
import type { InfoState, Placement, RNG, PartialBoard, Card } from '../index'

function board(top: string[], middle: string[], bottom: string[]): PartialBoard {
  return { top: parseCards(top), middle: parseCards(middle), bottom: parseCards(bottom) }
}

// Deterministic RNG (not cryptographically random, just reproducible for a test).
function mulberry32(seed: number): RNG {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('getBotMove', () => {
  it('does not throw when a visible opponent board is already fully resolved', () => {
    // Reproduces the production bug: in a side game, a bot opponent's board
    // is resolved wholesale (all 5 streets, 13 cards) the instant the side
    // game starts (reducer.ts's startBonus -> botSideGamesInterleaved) —
    // unlike a normal-round opponent, whose revealed board only ever grows
    // one street at a time. A rollout that keeps trying to deal that
    // already-full opponent more cards and place them overflows row
    // capacity, and legalPlacements throws "No legal placements — board/
    // dealt mismatch" deep inside the worker with no indication why.
    const fullOpponent = board(
      ['2s', '2h', '3c'],
      ['4s', '4h', '5c', '5h', '6c'],
      ['7s', '7h', '8c', '8h', '9c'],
    )
    const hand: Card[] = parseCards(['Ts', 'Th', 'Jc', 'Jh', 'Qc'])
    const state: InfoState = {
      board: { top: [], middle: [], bottom: [] },
      hand,
      street: 0,
      revealedOpponentBoards: [fullOpponent],
      inBonusRound: true,
    }

    expect(() => getBotMove(state, 20, mulberry32(42))).not.toThrow()
  })
})

describe('rollout — invisible bonus opponent scoring', () => {
  // Regression test for the fix that replaced a flat AVG_BONUS_ROYALTY
  // constant (which assumed the row-score half of the comparison was always
  // a wash) with scoring against a realistic sampled opponent board
  // (bonusOpponentSamples.ts). Two actor boards share an identical top and
  // middle, differing only in bottom-row strength: high-card (0 royalty) vs
  // quads-of-8s (10 royalty on the bottom row specifically). The old
  // formula would value the switch at EXACTLY the royalty delta (10),
  // since it couldn't see that a much stronger bottom also wins the row
  // comparison far more often. The new one should show a larger delta.
  const top = parseCards(['2s', '3h', '9c'])
  const mid = parseCards(['4s', '5h', '7h', 'Tc', 'Jd'])

  const weakState: InfoState = {
    board: { top, middle: mid, bottom: parseCards(['2c', '4d', '6s']) },
    hand: parseCards(['8h', 'Qc', '3d']),
    street: 4,
    revealedOpponentBoards: [],
    inBonusRound: true,
    invisibleBonusOpponents: ['QQ'],
  }
  const weakPlacement: Placement = {
    topAdd: [], middleAdd: [], bottomAdd: parseCards(['8h', 'Qc']), discard: parseCards(['3d'])[0]!,
  }

  const strongState: InfoState = {
    board: { top, middle: mid, bottom: parseCards(['8c', '8d', '8h']) },
    hand: parseCards(['8s', '3c', '9d']),
    street: 4,
    revealedOpponentBoards: [],
    inBonusRound: true,
    invisibleBonusOpponents: ['QQ'],
  }
  const strongPlacement: Placement = {
    topAdd: [], middleAdd: [], bottomAdd: parseCards(['8s', '3c']), discard: parseCards(['9d'])[0]!,
  }

  it('values a stronger bottom row by more than its pure royalty delta against an invisible bonus opponent', () => {
    const rollouts = 2000
    const weakEv = computeEV(weakState, weakPlacement, rollouts, mulberry32(123))
    const strongEv = computeEV(strongState, strongPlacement, rollouts, mulberry32(123))
    const diff = strongEv.ev - weakEv.ev
    // Pure royalty delta (quads-on-bottom royalty minus high-card's 0) is
    // 10 — the old flat-average formula could never show more than that.
    expect(diff).toBeGreaterThan(12)
  })

  it('is deterministic for a fixed seed', () => {
    const a = computeEV(strongState, strongPlacement, 500, mulberry32(7))
    const b = computeEV(strongState, strongPlacement, 500, mulberry32(7))
    expect(a.ev).toBe(b.ev)
  })
})
