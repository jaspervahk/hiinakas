import { describe, it, expect } from 'vitest'
import { computeSessionStats, type GameSummary } from '../sessionParser'

function summary(overrides: Partial<GameSummary> & { gameId: string }): GameSummary {
  return {
    gameTime: '2026-01-01T00:00:00.000Z',
    playerNames: [],
    points: {},
    busts: {},
    runs: {},
    normalBreakdown: null,
    ...overrides,
  }
}

describe('computeSessionStats', () => {
  it('does not count an all-bust hand as a tie', () => {
    const summaries = [
      summary({
        gameId: 'g1',
        playerNames: ['A', 'B'],
        points: { A: 0, B: 0 },
        busts: { A: true, B: true },
      }),
    ]
    const stats = computeSessionStats(summaries, ['A', 'B'])
    expect(stats.ties.A).toBe(0)
    expect(stats.ties.B).toBe(0)
    expect(stats.allBustHands).toBe(1)
  })

  it('only credits a tie to players who actually tied, not every participant', () => {
    const summaries = [
      summary({
        gameId: 'g1',
        playerNames: ['A', 'B', 'C'],
        points: { A: 5, B: 5, C: 1 },
        busts: { A: false, B: false, C: false },
      }),
    ]
    const stats = computeSessionStats(summaries, ['A', 'B', 'C'])
    expect(stats.ties.A).toBe(1)
    expect(stats.ties.B).toBe(1)
    expect(stats.ties.C).toBe(0)
  })

  it('does not count a hand toward a player who did not participate in it', () => {
    const summaries = [
      // A vs B tie, C sat this one out
      summary({
        gameId: 'g1',
        playerNames: ['A', 'B'],
        points: { A: 3, B: 3 },
        busts: { A: false, B: false },
      }),
      // A vs B vs C, no tie
      summary({
        gameId: 'g2',
        playerNames: ['A', 'B', 'C'],
        points: { A: 1, B: 2, C: 0 },
        busts: { A: false, B: false, C: false },
      }),
    ]
    const stats = computeSessionStats(summaries, ['A', 'B', 'C'])
    expect(stats.ties.A).toBe(1)
    expect(stats.ties.B).toBe(1)
    expect(stats.ties.C).toBe(0)
  })

  it('still counts wins normally when there is a single winner', () => {
    const summaries = [
      summary({
        gameId: 'g1',
        playerNames: ['A', 'B'],
        points: { A: 5, B: -5 },
        busts: { A: false, B: false },
      }),
    ]
    const stats = computeSessionStats(summaries, ['A', 'B'])
    expect(stats.wins.A).toBe(1)
    expect(stats.wins.B).toBe(0)
    expect(stats.ties.A).toBe(0)
    expect(stats.ties.B).toBe(0)
  })
})
