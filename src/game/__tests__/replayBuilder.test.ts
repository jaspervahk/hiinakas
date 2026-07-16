import { describe, it, expect } from 'vitest'
import { buildHandReplayData, buildReplayQueue } from '../replayBuilder'
import type { ReviewDecision } from '../sessionAnalysisTypes'
import type { BonusDecisionPoint, GameSummary } from '../sessionParser'
import type { Card, Board, Placement } from '../../engine/index'

function c(rank: number, suit: 's' | 'h' | 'd' | 'c'): Card { return { rank: rank as Card['rank'], suit } }

function placement(top: Card[], middle: Card[], bottom: Card[]): Placement {
  return { topAdd: top, middleAdd: middle, bottomAdd: bottom, discard: null }
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
    playedEV: 0,
    bestEV: 0,
    evLost: 0,
    topCandidates: [],
    ...overrides,
  }
}

function fiveNormalStreets(gameId: string, username: string): ReviewDecision[] {
  return [0, 1, 2, 3, 4].map(street => streetDecision({ gameId, username, street, segment: 'normal_play' }))
}

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

describe('buildReplayQueue', () => {
  it('returns only games the target played, in order', () => {
    const summaries = [
      summary({ gameId: 'g1', playerNames: ['A', 'B'] }),
      summary({ gameId: 'g2', playerNames: ['B', 'C'] }),
      summary({ gameId: 'g3', playerNames: ['A', 'C'] }),
    ]
    expect(buildReplayQueue(summaries, 'A')).toEqual(['g1', 'g3'])
    expect(buildReplayQueue(summaries, 'B')).toEqual(['g1', 'g2'])
  })
})

describe('buildHandReplayData', () => {
  it('builds normal-round-only replay data with no bonus outcome', () => {
    const decisions = [...fiveNormalStreets('g1', 'A'), ...fiveNormalStreets('g1', 'B')]
    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'], points: { A: 5, B: -5 } })]

    const data = buildHandReplayData('g1', 'A', decisions, [], summaries)

    expect(data.playerCount).toBe(2)
    expect(data.preDealt[0]).toHaveLength(5)
    expect(data.replay.opponentNormalPlacements).toHaveLength(1)
    expect(data.replay.opponentNormalPlacements[0]).toHaveLength(5)
    expect(data.replay.opponentBonusOutcomes).toEqual([null])
    expect(data.replay.humanBonusReplay).toBeNull()
    expect(data.replay.historicalTotal).toBe(5)
  })

  it('captures an opponent who triggered the one-shot bonus board', () => {
    const decisions = [...fiveNormalStreets('g1', 'A'), ...fiveNormalStreets('g1', 'B')]
    const board: Board = { top: [c(12, 's'), c(12, 'h'), c(2, 'c')], middle: [], bottom: [] }
    const bonusBoards: BonusDecisionPoint[] = [{
      id: 'g1:B:bonus_submit', gameId: 'g1', gameTime: '2026-01-01T00:00:00.000Z',
      username: 'B', uid: 'B', numDiscard: 0, cards: [c(12, 's'), c(12, 'h'), c(2, 'c')], actualBoard: board,
    }]
    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'], points: { A: 5, B: -5 } })]

    const data = buildHandReplayData('g1', 'A', decisions, bonusBoards, summaries)

    expect(data.replay.opponentBonusOutcomes[0]).toEqual({ qualifies: true, board })
  })

  it('captures an opponent who played the side game instead of qualifying', () => {
    const decisions = [
      ...fiveNormalStreets('g1', 'A'),
      ...fiveNormalStreets('g1', 'B'),
      ...[0, 1, 2, 3, 4].map(street => streetDecision({ gameId: 'g1', username: 'B', street, segment: 'bonus_play' })),
    ]
    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'], points: { A: 5, B: -5 } })]

    const data = buildHandReplayData('g1', 'A', decisions, [], summaries)

    const outcome = data.replay.opponentBonusOutcomes[0]
    expect(outcome).not.toBeNull()
    expect(outcome && !outcome.qualifies ? outcome.placements : []).toHaveLength(5)
  })

  it('captures the target player\'s own one-shot bonus board for replay', () => {
    const decisions = [...fiveNormalStreets('g1', 'A'), ...fiveNormalStreets('g1', 'B')]
    const cards = [c(14, 's'), c(14, 'h'), c(14, 'd')]
    const bonusBoards: BonusDecisionPoint[] = [{
      id: 'g1:A:bonus_submit', gameId: 'g1', gameTime: '2026-01-01T00:00:00.000Z',
      username: 'A', uid: 'A', numDiscard: 2, cards, actualBoard: { top: cards, middle: [], bottom: [] },
    }]
    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'], points: { A: 20, B: -20 } })]

    const data = buildHandReplayData('g1', 'A', decisions, bonusBoards, summaries)

    expect(data.replay.humanBonusReplay).toEqual({ tier: 'AA_OR_TRIPS', cards })
  })

  it('captures the target player\'s own side-game hands for replay', () => {
    const decisions = [
      ...fiveNormalStreets('g1', 'A'),
      ...fiveNormalStreets('g1', 'B'),
      ...[0, 1, 2, 3, 4].map(street => streetDecision({ gameId: 'g1', username: 'A', street, segment: 'bonus_play' })),
    ]
    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'], points: { A: 3, B: -3 } })]

    const data = buildHandReplayData('g1', 'A', decisions, [], summaries)

    expect(data.replay.humanBonusReplay).not.toBeNull()
    const replay = data.replay.humanBonusReplay
    expect(replay && replay.tier === null ? replay.sideHands : []).toHaveLength(5)
  })

  it('throws if a player is missing a normal-round street', () => {
    const decisions = [
      ...fiveNormalStreets('g1', 'A').slice(0, 4),  // only 4 streets
      ...fiveNormalStreets('g1', 'B'),
    ]
    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'], points: { A: 5, B: -5 } })]

    expect(() => buildHandReplayData('g1', 'A', decisions, [], summaries)).toThrow()
  })

  it('throws if the target player did not play in the given game', () => {
    const summaries = [summary({ gameId: 'g1', playerNames: ['B', 'C'] })]
    expect(() => buildHandReplayData('g1', 'A', [], [], summaries)).toThrow()
  })
})
