import { describe, it, expect } from 'vitest'
import { parseCards, scorePair } from '../index'
import type { Board } from '../index'
import { rankBoard, fastScorePair } from '../fastEvaluate'

function board(top: string[], middle: string[], bottom: string[]): Board {
  return { top: parseCards(top), middle: parseCards(middle), bottom: parseCards(bottom) }
}

// This is a pure performance optimization over scorePair (scoring.ts) — must
// be behaviorally identical for every board shape scorePair handles: normal
// row comparisons, fouled boards (both/one/neither), scoops, clean sweeps,
// and category ties broken by kickers.
describe('fastScorePair vs scorePair', () => {
  const cases: Array<[string, Board, Board]> = [
    ['both legal, mixed rows', board(['2s', '2d', '9c'], ['8h', '8s', '8d', '4c', '3h'], ['Th', 'Jh', 'Qh', 'Kh', 'Ah']), board(['3s', '3d', '4c'], ['9h', '9s', '9d', '5c', '4h'], ['2h', '3h', '4h', '5h', '6h'])],
    ['A fouled, B legal', board(['As', 'Ad', '4c'], ['Ks', 'Kd', '9h', '8h', '2c'], ['Qs', 'Qd', 'Qh', '7c', '5d']), board(['2s', '3d', '4c'], ['5h', '6s', '7d', '8c', '9h'], ['Th', 'Jh', 'Qh', 'Kh', 'Ah'])],
    ['B fouled, A legal', board(['2s', '3d', '4c'], ['5h', '6s', '7d', '8c', '9h'], ['Th', 'Jh', 'Qh', 'Kh', 'Ah']), board(['As', 'Ad', '4c'], ['Ks', 'Kd', '9h', '8h', '2c'], ['Qs', 'Qd', 'Qh', '7c', '5d'])],
    ['both fouled', board(['As', 'Ad', '4c'], ['Ks', 'Kd', '9h', '8h', '2c'], ['Qs', 'Qd', 'Qh', '7c', '5d']), board(['Ks', 'Kd', '4h'], ['Qs', 'Qd', '9d', '8d', '2d'], ['Js', 'Jd', 'Jh', '7d', '5h'])],
    ['clean sweep upgrade', board(['Ks', 'Kd', '4c'], ['2c', '2d', '2h', '2s', '3c'], ['Th', 'Jh', 'Qh', 'Kh', 'Ah']), board(['2s', '3d', '4c'], ['5h', '6s', '7d', '8c', '9h'], ['9d', 'Tc', 'Js', 'Qh', 'Kd'])],
    ['same category, kicker breaks it', board(['9s', '9d', '2c'], ['4h', '5s', '6d', '7c', '9h'], ['Th', 'Jh', 'Qh', 'Kh', 'Ah']), board(['9s', '9h', '3c'], ['4d', '5d', '6h', '7d', '9c'], ['2h', '3h', '4h', '5h', '7h'])],
  ]

  for (const [label, a, b] of cases) {
    it(label, () => {
      const expected = scorePair(a, b)
      const actual = fastScorePair(rankBoard(a), rankBoard(b))
      expect(actual).toBe(expected.aNet)
    })
  }

  it('is symmetric (fastScorePair(a,b) === -fastScorePair(b,a)) matching scorePair', () => {
    for (const [, a, b] of cases) {
      const ra = rankBoard(a)
      const rb = rankBoard(b)
      // +0 normalizes -0 (e.g. both-fouled -> 0 both directions, and
      // Object.is(-0, 0) is false even though they're numerically equal).
      expect(fastScorePair(rb, ra) + 0).toBe(-fastScorePair(ra, rb) + 0)
    }
  })
})
