import { describe, it, expect } from 'vitest'
import { runMatchHand } from '../matchSimulator'
import { runGame, heuristicPolicy } from '../simulate'
import { CLASSIC_RULES, VARIANT_RULES } from '../types'
import type { BotSpec } from '../matchTypes'

// sims is part of the fixture, not a tuning knob: the chain seeds below were
// found at this value, and changing it changes how the bot plays the side game
// and therefore whether a chain occurs at all.
const spec: BotSpec = { kind: 'heuristic', sims: 8 }
const hand = (idx: number, seed: number, rules = CLASSIC_RULES) =>
  runMatchHand(idx, seed, spec, spec, {}, rules)

// Seeds found by search; each chains further under variant rules than classic.
const CHAIN_SEEDS = [
  { idx: 38, seed: 588467036, rounds: 2 },
  { idx: 731, seed: 2730235503, rounds: 3 },
  { idx: 1022, seed: 2941654340, rounds: 2 },
  { idx: 1265, seed: 2409751753, rounds: 4 },
]

// A full match hand costs a few hundred ms, so each fixture is simulated once
// and shared across the assertions below rather than per test.
const CHAINS = CHAIN_SEEDS.map(c => ({
  ...c,
  variant: hand(c.idx, c.seed, VARIANT_RULES),
  classic: hand(c.idx, c.seed, CLASSIC_RULES),
}))
const SLOW = 60_000

describe('bonus round recursion', () => {
  it('classic never chains, on any seed', () => {
    for (let i = 0; i < 8; i++) {
      const rec = hand(i, (4242 + i * 15485863) >>> 0, CLASSIC_RULES)
      expect(rec.bonusRounds?.length ?? 0).toBeLessThanOrEqual(1)
    }
  }, SLOW)

  it('variant chains on seeds where a side game qualifies', () => {
    for (const c of CHAINS) {
      expect(c.variant.bonusRounds).toHaveLength(c.rounds)
      // ...and the same deal stops at one round under classic.
      expect(c.classic.bonusRounds).toHaveLength(1)
    }
  })

  it('only side-game players can start the next round', () => {
    // A 13-15 card bonus board never re-triggers, so anyone holding one in a
    // round must be playing the side game in the next.
    for (const c of CHAINS) {
      const rounds = c.variant.bonusRounds!
      for (let r = 1; r < rounds.length; r++) {
        for (const p of [0, 1] as const) {
          if (rounds[r - 1]!.players[p].qualifier !== null) {
            expect(rounds[r]!.players[p].qualifier).toBeNull()
          }
        }
      }
    }
  })

  it('bonusScore is the total across every round, and stays zero-sum', () => {
    for (const rules of [CLASSIC_RULES, VARIANT_RULES]) {
      for (let i = 0; i < 5; i++) {
        const rec = hand(i, (4242 + i * 15485863) >>> 0, rules)
        const summed = (rec.bonusRounds ?? []).reduce(
          (a, r) => [a[0] + r.score[0], a[1] + r.score[1]] as [number, number], [0, 0] as [number, number])
        expect(rec.bonusScore[0]).toBe(summed[0])
        expect(rec.bonusScore[1]).toBe(summed[1])
        expect(rec.bonusScore[0] + rec.bonusScore[1]).toBe(0)
        expect(rec.totalScore[0] + rec.totalScore[1]).toBe(0)
        for (const r of rec.bonusRounds ?? []) expect(r.score[0] + r.score[1]).toBe(0)
      }
    }
    // The chain fixtures carry the multi-round version of the same invariant.
    for (const c of CHAINS) {
      const summed = c.variant.bonusRounds!.reduce((a, r) => a + r.score[0], 0)
      expect(c.variant.bonusScore[0]).toBe(summed)
      expect(c.variant.totalScore[0] + c.variant.totalScore[1]).toBe(0)
    }
  }, SLOW)

  it('mirrors round 0 onto the flat fields the Arena replay reads', () => {
    for (const c of CHAINS) {
      const rec = c.variant
      const first = rec.bonusRounds![0]!
      for (const p of [0, 1] as const) {
        const flat = rec.players[p]
        const r = first.players[p]
        if (r.qualifier !== null) {
          expect(flat.bonusBoard).toEqual(r.board)
          expect(flat.bonusFoul).toBe(r.foul)
          expect(flat.bonusRoyalties).toBe(r.royalties)
          expect(flat.bonusCards).toEqual(r.cards)
        } else {
          expect(flat.sideBoard).toEqual(r.board)
          expect(flat.sideFoul).toBe(r.foul)
          expect(flat.sideRoyalties).toBe(r.royalties)
          expect(flat.sideStreets).toEqual(r.streets)
        }
      }
    }
  })

  it('every round produces complete 3-5-5 boards', () => {
    for (const c of CHAINS) {
      for (const r of c.variant.bonusRounds!) {
        for (const p of [0, 1] as const) {
          const b = r.players[p].board
          expect(b.top).toHaveLength(3)
          expect(b.middle).toHaveLength(5)
          expect(b.bottom).toHaveLength(5)
        }
      }
    }
  })
})

describe('simulate.ts recursion', () => {
  it('stays zero-sum under both rulesets', () => {
    for (const rules of [CLASSIC_RULES, VARIANT_RULES]) {
      for (let i = 0; i < 150; i++) {
        const r = runGame(2, (900 + i * 7919) >>> 0, heuristicPolicy, rules)
        expect(r.outcomes.reduce((a, b) => a + b, 0)).toBe(0)
      }
    }
  }, SLOW)

  it('produces training samples for 3-player hands too', () => {
    for (const rules of [CLASSIC_RULES, VARIANT_RULES]) {
      const r = runGame(3, 123456, heuristicPolicy, rules)
      expect(r.outcomes).toHaveLength(3)
      expect(r.outcomes.reduce((a, b) => a + b, 0)).toBe(0)
      expect(r.samples.length).toBeGreaterThan(0)
    }
  })

  it('variant yields at least as many samples as classic over a run', () => {
    // Chained rounds add decisions; they can never remove any.
    let classic = 0, variant = 0
    for (let i = 0; i < 150; i++) {
      const seed = (900 + i * 7919) >>> 0
      classic += runGame(2, seed, heuristicPolicy, CLASSIC_RULES).samples.length
      variant += runGame(2, seed, heuristicPolicy, VARIANT_RULES).samples.length
    }
    expect(variant).toBeGreaterThanOrEqual(classic)
  }, SLOW)
})
