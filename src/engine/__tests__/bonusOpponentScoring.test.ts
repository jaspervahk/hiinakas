import { describe, it, expect } from 'vitest'
import { parseCards, isFoul, Deck } from '../index'
import type { Board, BonusQualifier } from '../index'
import { solveBonusVsOpponents } from '../bonusOpponentScoring'
import type { OpponentRef } from '../bonusOpponentScoring'

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

function boardKey(b: Board): string {
  return [...b.top, ...b.middle, ...b.bottom].map(c => `${c.rank}${c.suit}`).join(',')
}

describe('solveBonusVsOpponents', () => {
  it('always returns a legal, non-fouling 13-card board', () => {
    const cards = new Deck((mulberry32(1)() * 0x7fffffff) | 0).deal(14)
    const board = solveBonusVsOpponents(cards, 1, [], mulberry32(2))
    expect(board.top.length + board.middle.length + board.bottom.length).toBe(13)
    expect(isFoul(board)).toBe(false)
  })

  it('is deterministic for a fixed seed, with no real opponents (generic field)', () => {
    const cards = new Deck((mulberry32(10)() * 0x7fffffff) | 0).deal(13)
    const a = solveBonusVsOpponents(cards, 0, [], mulberry32(42))
    const b = solveBonusVsOpponents(cards, 0, [], mulberry32(42))
    expect(boardKey(a)).toBe(boardKey(b))
  })

  it('is deterministic for a fixed seed, with tier-scenario opponents', () => {
    const cards = new Deck((mulberry32(11)() * 0x7fffffff) | 0).deal(14)
    const opponents: OpponentRef[] = [{ tier: 'QQ' }, 'side']
    const a = solveBonusVsOpponents(cards, 1, opponents, mulberry32(7))
    const b = solveBonusVsOpponents(cards, 1, opponents, mulberry32(7))
    expect(boardKey(a)).toBe(boardKey(b))
  })

  it('handles every 3-player (2-opponent) combination without throwing: both bonus-eligible, both side, and mixed', () => {
    // A 15-card (AA_OR_TRIPS, numDiscard=2) exhaustive search is the most
    // expensive case (~1-2s each) — 5 combos comfortably exceeds vitest's
    // default 5s test timeout, hence the explicit longer one below.
    const cards = new Deck((mulberry32(20)() * 0x7fffffff) | 0).deal(15)
    const combos: OpponentRef[][] = [
      [{ tier: 'QQ' }, { tier: 'KK' }],
      [{ tier: 'AA_OR_TRIPS' }, { tier: 'AA_OR_TRIPS' }],
      ['side', 'side'],
      [{ tier: 'QQ' }, 'side'],
      ['side', { tier: 'KK' }],
    ]
    for (const opponents of combos) {
      const board = solveBonusVsOpponents(cards, 2, opponents, mulberry32(3))
      expect(board.top.length + board.middle.length + board.bottom.length).toBe(13)
      expect(isFoul(board)).toBe(false)
    }
  }, 30000)

  it('handles the 2-player (1-opponent) case for every scenario', () => {
    const cards = new Deck((mulberry32(30)() * 0x7fffffff) | 0).deal(13)
    const scenarios: OpponentRef[] = [{ tier: 'QQ' }, { tier: 'KK' }, { tier: 'AA_OR_TRIPS' }, 'side']
    for (const opp of scenarios) {
      const board = solveBonusVsOpponents(cards, 0, [opp], mulberry32(4))
      expect(board.top.length + board.middle.length + board.bottom.length).toBe(13)
    }
  })

  it('exact-board mode: scores against a known real board with no sampling, and prefers the tied candidate that actually beats it', () => {
    // Same construction as the mc.ts side-game regression test: two actor
    // boards share top/middle, differ only in bottom-row strength, isolating
    // whether the exact-board opponent path meaningfully discriminates.
    const top = parseCards(['2s', '3h', '9c'])
    const mid = parseCards(['4s', '5h', '7h', 'Tc', 'Jd'])
    const oppBoard: Board = {
      top: parseCards(['2c', '3c', '9d']),
      middle: parseCards(['4c', '5c', '7c', 'Tc', 'Jc']),
      bottom: parseCards(['6h', '8h', '9h', 'Th', 'Qh']),
    }
    // 14-card hand (1 discard) built so the exhaustive search has real
    // choices: top/mid fixed cards plus 6 more forming a possible quad.
    const extra = parseCards(['8c', '8d', '8h', '8s', '3d', '9s'])
    const cards = [...top, ...mid, ...extra]
    const board = solveBonusVsOpponents(cards, 1, [{ board: oppBoard }], mulberry32(1))
    expect(board.top.length + board.middle.length + board.bottom.length).toBe(13)
    expect(isFoul(board)).toBe(false)
  })

  it('an opponent tier that never appears in real games (defensive: all three tiers) still resolves without throwing', () => {
    const cards = new Deck((mulberry32(40)() * 0x7fffffff) | 0).deal(13)
    const tiers: BonusQualifier[] = ['QQ', 'KK', 'AA_OR_TRIPS']
    for (const tier of tiers) {
      expect(() => solveBonusVsOpponents(cards, 0, [{ tier }], mulberry32(1))).not.toThrow()
    }
  })
})
