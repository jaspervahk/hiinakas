import { describe, it, expect } from 'vitest'
import { sampleBonusOpponentBoard } from '../bonusOpponentSamples'
import type { BonusQualifier } from '../types'

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

const TIERS: readonly BonusQualifier[] = ['QQ', 'KK', 'AA_OR_TRIPS']

function boardKey(b: ReturnType<typeof sampleBonusOpponentBoard>): string {
  const cardKey = (c: { rank: number; suit: string }) => `${c.rank}${c.suit}`
  return [b.top, b.middle, b.bottom].map(row => row.map(cardKey).join(',')).join('|')
}

describe('sampleBonusOpponentBoard', () => {
  it('returns a valid 3/5/5 board of 13 distinct cards for every tier', () => {
    for (const tier of TIERS) {
      const board = sampleBonusOpponentBoard(tier, mulberry32(1))
      expect(board.top).toHaveLength(3)
      expect(board.middle).toHaveLength(5)
      expect(board.bottom).toHaveLength(5)
      const all = [...board.top, ...board.middle, ...board.bottom]
      const keys = new Set(all.map(c => `${c.rank}${c.suit}`))
      expect(keys.size).toBe(13)
    }
  })

  it('is deterministic for a fixed rng sequence', () => {
    for (const tier of TIERS) {
      const a = sampleBonusOpponentBoard(tier, mulberry32(42))
      const b = sampleBonusOpponentBoard(tier, mulberry32(42))
      expect(boardKey(a)).toBe(boardKey(b))
    }
  })

  it('draws more than one distinct board across many rng draws (not a constant)', () => {
    for (const tier of TIERS) {
      const rng = mulberry32(7)
      const seen = new Set<string>()
      for (let i = 0; i < 30; i++) seen.add(boardKey(sampleBonusOpponentBoard(tier, rng)))
      expect(seen.size).toBeGreaterThan(1)
    }
  })
})
