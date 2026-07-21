import { describe, it, expect } from 'vitest'
import { computeHandLuck } from '../luckAnalysis'
import type { AnalyzePositionsFn } from '../luckAnalysis'
import { bestBonusBoard, scoreTable } from '../../engine/index'
import type { Card, Placement, InfoState } from '../../engine/index'
import type { ReviewDecision } from '../sessionAnalysisTypes'
import type { BonusDecisionPoint, GameSummary } from '../sessionParser'

function c(rank: number, suit: 's' | 'h' | 'd' | 'c'): Card { return { rank: rank as Card['rank'], suit } }

function placement(top: Card[], middle: Card[], bottom: Card[], discard: Card | null = null): Placement {
  return { topAdd: top, middleAdd: middle, bottomAdd: bottom, discard }
}

function streetDecision(overrides: Partial<ReviewDecision> & { gameId: string; username: string; street: number }): ReviewDecision {
  return {
    id: `${overrides.gameId}:${overrides.username}:${overrides.segment ?? 'normal_play'}:${overrides.street}`,
    gameTime: '2026-01-01T00:00:00.000Z',
    uid: overrides.username,
    segment: 'normal_play',
    board: { top: [], middle: [], bottom: [] },
    hand: [c(2, 's')],
    actualPlacement: placement([], [c(2, 's')], []),
    bestPlacement: placement([], [c(2, 's')], []),
    playedEV: 0, bestEV: 0, evLost: 0, topCandidates: [],
    ...overrides,
  }
}

function summary(overrides: Partial<GameSummary> & { gameId: string }): GameSummary {
  return {
    gameTime: '2026-01-01T00:00:00.000Z', playerNames: [], points: {}, busts: {}, runs: {}, normalBreakdown: null,
    ...overrides,
  }
}

// A's non-bonus-triggering normal round (unpaired top -> bonusTrigger null),
// reused across tests. B mirrors the same shape on a disjoint suit pair.
function aNormalDecisions(gameId: string): ReviewDecision[] {
  return [
    streetDecision({ gameId, username: 'A', street: 0, actualPlacement: placement([c(2, 's'), c(3, 's'), c(4, 's')], [], [c(5, 's'), c(6, 's')]) }),
    streetDecision({ gameId, username: 'A', street: 1, actualPlacement: placement([], [], [c(8, 's'), c(10, 's')], c(2, 'h')) }),
    streetDecision({ gameId, username: 'A', street: 2, actualPlacement: placement([], [c(3, 'h')], [c(11, 's')], c(4, 'h')) }),
    streetDecision({ gameId, username: 'A', street: 3, actualPlacement: placement([], [c(5, 'h'), c(6, 'h')], [], c(8, 'h')) }),
    streetDecision({ gameId, username: 'A', street: 4, actualPlacement: placement([], [c(11, 'h'), c(13, 'h')], [], c(7, 'h')) }),
  ]
}
function bNormalDecisions(gameId: string): ReviewDecision[] {
  return [
    streetDecision({ gameId, username: 'B', street: 0, actualPlacement: placement([c(2, 'c'), c(3, 'c'), c(4, 'c')], [], [c(5, 'c'), c(6, 'c')]) }),
    streetDecision({ gameId, username: 'B', street: 1, actualPlacement: placement([], [], [c(8, 'c'), c(10, 'c')], c(2, 'd')) }),
    streetDecision({ gameId, username: 'B', street: 2, actualPlacement: placement([], [c(3, 'd')], [c(11, 'c')], c(4, 'd')) }),
    streetDecision({ gameId, username: 'B', street: 3, actualPlacement: placement([], [c(5, 'd'), c(6, 'd')], [], c(8, 'd')) }),
    streetDecision({ gameId, username: 'B', street: 4, actualPlacement: placement([], [c(11, 'd'), c(13, 'd')], [], c(7, 'd')) }),
  ]
}

const evOf = (state: InfoState) => state.hand.reduce((s, card) => s + card.rank, 0)
const stubAnalyze: AnalyzePositionsFn = async (positions) =>
  positions.map(p => ({ id: p.id, candidates: [{ ev: evOf(p.state) }] }))

describe('computeHandLuck', () => {
  it('computes per-street normal-round luck with no bonus reached', async () => {
    const decisions = [...aNormalDecisions('g1'), ...bNormalDecisions('g1')]
    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'], points: { A: 5, B: -5 } })]

    const result = await computeHandLuck('g1', 'A', decisions, [], summaries, {
      policy: 'heuristic', sims: 1, rootTopK: undefined, outerSamples: 5, seed: 42, analyzePositions: stubAnalyze,
    })

    expect(result.gameId).toBe('g1')
    expect(result.streets).toHaveLength(5)
    expect(result.streets.map(s => s.segment)).toEqual(['normal', 'normal', 'normal', 'normal', 'normal'])
    expect(result.streets.map(s => s.street)).toEqual([0, 1, 2, 3, 4])
    // Street 0's actual hand is [2s,3s,4s,5s,6s] -> rank sum 20.
    expect(result.streets[0]!.actualEV).toBe(20)
    for (const s of result.streets) {
      expect(s.luck).toBeCloseTo(s.actualEV - s.baselineEV, 10)
    }
    expect(result.totalLuck).toBeCloseTo(result.streets.reduce((a, s) => a + s.luck, 0), 10)
  })

  it('is deterministic for a fixed seed', async () => {
    const decisions = [...aNormalDecisions('g1'), ...bNormalDecisions('g1')]
    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'] })]
    const opts = { policy: 'heuristic' as const, sims: 1, rootTopK: undefined, outerSamples: 5, seed: 7, analyzePositions: stubAnalyze }

    const r1 = await computeHandLuck('g1', 'A', decisions, [], summaries, opts)
    const r2 = await computeHandLuck('g1', 'A', decisions, [], summaries, opts)
    expect(r2).toEqual(r1)
  })

  it('batches actual + N sampled hands into one analyzePositions call per street', async () => {
    const calls: number[] = []
    const countingStub: AnalyzePositionsFn = async (positions) => {
      calls.push(positions.length)
      return positions.map(p => ({ id: p.id, candidates: [{ ev: evOf(p.state) }] }))
    }
    const decisions = [...aNormalDecisions('g1'), ...bNormalDecisions('g1')]
    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'] })]

    await computeHandLuck('g1', 'A', decisions, [], summaries, {
      policy: 'heuristic', sims: 1, rootTopK: undefined, outerSamples: 7, seed: 1, analyzePositions: countingStub,
    })
    expect(calls).toEqual([8, 8, 8, 8, 8])   // 1 actual + 7 samples, once per normal street
  })

  it('excludes every already-dealt card (own AND opponent\'s) from the resampling pool', async () => {
    // B's street-0 board is [2c,3c,4c,5c,6c] — already dealt/placed by the
    // time street 1 happens, so a hypothetical redeal for A's street-1 hand
    // can never legally include any of them; this indicator must average to
    // exactly 0. (Street 0 itself is dealt simultaneously to everyone, so
    // there's nothing "already dealt" to exclude yet at that point — this
    // check needs a street after the opponent has actually placed something.)
    const bClubs = new Set(['2c', '3c', '4c', '5c', '6c'])
    const indicatorStub: AnalyzePositionsFn = async (positions) =>
      positions.map(p => ({
        id: p.id,
        candidates: [{ ev: p.state.hand.some(card => bClubs.has(`${card.rank}${card.suit}`)) ? 1 : 0 }],
      }))

    const decisions = [...aNormalDecisions('g1'), ...bNormalDecisions('g1')]
    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'] })]

    const result = await computeHandLuck('g1', 'A', decisions, [], summaries, {
      policy: 'heuristic', sims: 1, rootTopK: undefined, outerSamples: 300, seed: 11, analyzePositions: indicatorStub,
    })

    expect(result.streets[1]!.baselineEV).toBe(0)
  })

  it('computes bonus one-shot luck when the target qualifies, scored against the opponent\'s side-game board', async () => {
    const decisions = [...aNormalDecisions('g1'), ...bNormalDecisions('g1')]
    const bonusSpades: Card[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(r => c(r, 's'))
    const bonusBoards: BonusDecisionPoint[] = [{
      id: 'g1:A:bonus', gameId: 'g1', gameTime: '2026-01-01T00:00:00.000Z', username: 'A', uid: 'A',
      numDiscard: 0, cards: bonusSpades, actualBoard: bestBonusBoard(bonusSpades, 0),
    }]
    // B plays the mandatory side game (non-qualifier) since A qualified.
    const bSideDecisions: ReviewDecision[] = [
      streetDecision({ gameId: 'g1', username: 'B', segment: 'bonus_play', street: 0, actualPlacement: placement([c(2, 'c'), c(3, 'c'), c(4, 'c')], [], [c(5, 'c'), c(6, 'c')]) }),
      streetDecision({ gameId: 'g1', username: 'B', segment: 'bonus_play', street: 1, actualPlacement: placement([], [], [c(8, 'c'), c(10, 'c')], c(2, 'd')) }),
      streetDecision({ gameId: 'g1', username: 'B', segment: 'bonus_play', street: 2, actualPlacement: placement([], [c(3, 'd')], [c(11, 'c')], c(4, 'd')) }),
      streetDecision({ gameId: 'g1', username: 'B', segment: 'bonus_play', street: 3, actualPlacement: placement([], [c(5, 'd'), c(6, 'd')], [], c(8, 'd')) }),
      streetDecision({ gameId: 'g1', username: 'B', segment: 'bonus_play', street: 4, actualPlacement: placement([], [c(11, 'd'), c(13, 'd')], [], c(7, 'd')) }),
    ]
    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'] })]

    const result = await computeHandLuck('g1', 'A', [...decisions, ...bSideDecisions], bonusBoards, summaries, {
      policy: 'heuristic', sims: 1, rootTopK: undefined, outerSamples: 5, seed: 3, analyzePositions: stubAnalyze,
    })

    expect(result.streets).toHaveLength(6)   // 5 normal + 1 bonus_oneshot
    const bonusEntry = result.streets[5]!
    expect(bonusEntry.segment).toBe('bonus_oneshot')
    expect(bonusEntry.street).toBe(0)

    // B's folded side-game board: top=[2c,3c,4c], middle=[3d,5d,6d,11d,13d], bottom=[5c,6c,8c,10c,11c].
    const bBoard = {
      top: [c(2, 'c'), c(3, 'c'), c(4, 'c')],
      middle: [c(3, 'd'), c(5, 'd'), c(6, 'd'), c(11, 'd'), c(13, 'd')],
      bottom: [c(5, 'c'), c(6, 'c'), c(8, 'c'), c(10, 'c'), c(11, 'c')],
    }
    const expectedActualEV = scoreTable([bestBonusBoard(bonusSpades, 0), bBoard])[0]!
    expect(bonusEntry.actualEV).toBeCloseTo(expectedActualEV, 10)
    expect(bonusEntry.luck).toBeCloseTo(bonusEntry.actualEV - bonusEntry.baselineEV, 10)
  })

  it('computes side-game luck across 5 streets when the target does not qualify', async () => {
    // B qualifies via trips on top (any rank triggers AA_OR_TRIPS) with a
    // non-fouling middle/bottom (trips-5 < straight), so bonusTrigger(B) is
    // non-null and B's tier ends up in invisibleBonusOpponents.
    const bQualifyingDecisions: ReviewDecision[] = [
      streetDecision({ gameId: 'g1', username: 'B', street: 0, actualPlacement: placement([c(2, 'c'), c(2, 'd'), c(2, 'h')], [], [c(6, 'h'), c(7, 'h')]) }),
      streetDecision({ gameId: 'g1', username: 'B', street: 1, actualPlacement: placement([], [], [c(8, 'h'), c(9, 'h')], c(3, 'c')) }),
      streetDecision({ gameId: 'g1', username: 'B', street: 2, actualPlacement: placement([], [c(5, 'c')], [c(10, 'h')], c(4, 'd')) }),
      streetDecision({ gameId: 'g1', username: 'B', street: 3, actualPlacement: placement([], [c(5, 'd'), c(5, 'h')], [], c(11, 'h')) }),
      streetDecision({ gameId: 'g1', username: 'B', street: 4, actualPlacement: placement([], [c(9, 'c'), c(10, 'c')], [], c(12, 'c')) }),
    ]
    const bonusBoards: BonusDecisionPoint[] = [{
      id: 'g1:B:bonus', gameId: 'g1', gameTime: '2026-01-01T00:00:00.000Z', username: 'B', uid: 'B',
      numDiscard: 0, cards: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(r => c(r, 'd')),
      actualBoard: bestBonusBoard([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(r => c(r, 'd')), 0),
    }]
    // A plays the side game (own normal round + 5 bonus_play streets).
    const aSideDecisions: ReviewDecision[] = [
      streetDecision({ gameId: 'g1', username: 'A', segment: 'bonus_play', street: 0, actualPlacement: placement([c(2, 's'), c(3, 's'), c(4, 's')], [], [c(5, 's'), c(6, 's')]) }),
      streetDecision({ gameId: 'g1', username: 'A', segment: 'bonus_play', street: 1, actualPlacement: placement([], [], [c(8, 's'), c(10, 's')], c(2, 'h')) }),
      streetDecision({ gameId: 'g1', username: 'A', segment: 'bonus_play', street: 2, actualPlacement: placement([], [c(3, 'h')], [c(11, 's')], c(4, 'h')) }),
      streetDecision({ gameId: 'g1', username: 'A', segment: 'bonus_play', street: 3, actualPlacement: placement([], [c(5, 'h'), c(6, 'h')], [], c(8, 'h')) }),
      streetDecision({ gameId: 'g1', username: 'A', segment: 'bonus_play', street: 4, actualPlacement: placement([], [c(11, 'h'), c(13, 'h')], [], c(7, 'h')) }),
    ]
    const decisions = [...aNormalDecisions('g1'), ...bQualifyingDecisions, ...aSideDecisions]
    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'] })]

    const result = await computeHandLuck('g1', 'A', decisions, bonusBoards, summaries, {
      policy: 'heuristic', sims: 1, rootTopK: undefined, outerSamples: 4, seed: 9, analyzePositions: stubAnalyze,
    })

    expect(result.streets).toHaveLength(10)   // 5 normal + 5 side
    const sideEntries = result.streets.slice(5)
    expect(sideEntries.map(s => s.segment)).toEqual(['side', 'side', 'side', 'side', 'side'])
    expect(sideEntries.map(s => s.street)).toEqual([0, 1, 2, 3, 4])
    for (const s of sideEntries) {
      expect(s.luck).toBeCloseTo(s.actualEV - s.baselineEV, 10)
    }
  })
})
