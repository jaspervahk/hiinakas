import { describe, it, expect } from 'vitest'
import { buildHandReplayData, buildReplayQueue } from '../replayBuilder'
import type { ReviewDecision } from '../sessionAnalysisTypes'
import type { BonusDecisionPoint, GameSummary } from '../sessionParser'
import type { Card, Board, Placement } from '../../engine/index'

function c(rank: number, suit: 's' | 'h' | 'd' | 'c'): Card { return { rank: rank as Card['rank'], suit } }

function placement(top: Card[], middle: Card[], bottom: Card[], discard: Card | null = null): Placement {
  return { topAdd: top, middleAdd: middle, bottomAdd: bottom, discard }
}

// Deterministic, collision-free-enough dealt hand for a given street: 5
// cards on street 0, 3 cards (2 to place + 1 discard) on streets 1-4 — the
// real per-street shape, so fixtures naturally satisfy
// assertValidStreetPlacement instead of needing every test to hand-build a
// realistic placement itself. `seed` keeps different players'/games' hands
// from colliding within one test.
function dealtForStreet(street: number, seed: number): Card[] {
  const count = street === 0 ? 5 : 3
  const suits: Card['suit'][] = ['s', 'h', 'd', 'c']
  return Array.from({ length: count }, (_, i) => {
    const n = seed * 17 + street * 5 + i
    return c(2 + (n % 13), suits[n % 4]!)
  })
}

// A realistic placement for the given street from a dealt hand of the
// matching size (see dealtForStreet), following a fixed valid distribution
// across all 5 streets that ends at exactly 3 top / 5 middle / 5 bottom
// without ever exceeding a row's capacity along the way: street 0 fills top
// completely (3) plus 2 middle; streets 1-2 fill the rest of middle (2+1);
// streets 2-4 fill bottom (1+2+2). Streets 1-4 always discard the 3rd dealt
// card.
function realisticPlacement(street: number, dealt: Card[]): Placement {
  switch (street) {
    case 0: return placement([dealt[0]!, dealt[1]!, dealt[2]!], [dealt[3]!, dealt[4]!], [])
    case 1: return placement([], [dealt[0]!, dealt[1]!], [], dealt[2]!)
    case 2: return placement([], [dealt[0]!], [dealt[1]!], dealt[2]!)
    default: return placement([], [], [dealt[0]!, dealt[1]!], dealt[2]!)
  }
}

function streetDecision(overrides: Partial<ReviewDecision> & { gameId: string; username: string; street: number }): ReviewDecision {
  const seed = `${overrides.gameId}:${overrides.username}`.split('').reduce((h, ch) => h * 31 + ch.charCodeAt(0), 0)
  const dealt = dealtForStreet(overrides.street, seed)
  const defaultPlacement = realisticPlacement(overrides.street, dealt)
  return {
    id: `${overrides.gameId}:${overrides.username}:${overrides.segment ?? 'normal_play'}:${overrides.street}`,
    gameTime: '2026-01-01T00:00:00.000Z',
    uid: overrides.username,
    segment: 'normal_play',
    board: { top: [], middle: [], bottom: [] },
    hand: dealt,
    actualPlacement: defaultPlacement,
    bestPlacement: defaultPlacement,
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

  it('throws a precise, located error for a malformed recorded placement instead of building corrupted replay data', () => {
    const decisions = [...fiveNormalStreets('g1', 'A'), ...fiveNormalStreets('g1', 'B')]
    // Corrupt B's street-0 placement to only place 1 card (real street 0
    // must place all 5 dealt cards, no discard) — simulates a truncated/
    // malformed raw session export entry.
    const bStreet0 = decisions.find(d => d.username === 'B' && d.street === 0)!
    bStreet0.actualPlacement = placement([], [c(2, 's')], [])

    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'], points: { A: 5, B: -5 } })]

    expect(() => buildHandReplayData('g1', 'A', decisions, [], summaries)).toThrow(
      /Malformed recorded placement for B in game g1: street 0/,
    )
  })

  it('catches a row that overflows across streets even when every individual street\'s own count looks correct', () => {
    // The bug actually found in production: a street 1 placement that puts
    // both of its 2 placed cards on `top` instead of split across rows.
    // Each individual street here still has the right total placed/discard
    // shape (2 placed + 1 discard on streets 1-4) — only the CUMULATIVE
    // row total across all 5 streets reveals the corruption (top ends up
    // with more than 3 cards), which is exactly what the old
    // assertValidStreetPlacement-only check couldn't catch.
    const decisions = [...fiveNormalStreets('g1', 'A'), ...fiveNormalStreets('g1', 'B')]
    const bStreet1 = decisions.find(d => d.username === 'B' && d.street === 1)!
    const dealt = bStreet1.hand
    bStreet1.actualPlacement = placement([dealt[0]!, dealt[1]!], [], [], dealt[2]!)

    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'], points: { A: 5, B: -5 } })]

    expect(() => buildHandReplayData('g1', 'A', decisions, [], summaries)).toThrow(
      /Malformed recorded placement for B in game g1: after street 1.*row capacity/,
    )
  })

  it('catches a target player\'s own dealt hand with the wrong card count for its street', () => {
    // The actual production bug: a corrupted `hand` field (not
    // actualPlacement) for the TARGET player specifically — this is the one
    // field a bot simulation actually reads to make a fresh decision from
    // (preDealt[0]), so a wrong count here doesn't fail on its own street;
    // it silently unbalances the bot's own running board-capacity math and
    // only surfaces several streets later as a generic "No legal placements
    // — board/dealt mismatch" deep in the worker.
    const decisions = [...fiveNormalStreets('g1', 'A'), ...fiveNormalStreets('g1', 'B')]
    const aStreet1 = decisions.find(d => d.username === 'A' && d.street === 1)!
    aStreet1.hand = [...aStreet1.hand, c(9, 'h')]  // 4 cards instead of 3

    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'], points: { A: 5, B: -5 } })]

    expect(() => buildHandReplayData('g1', 'A', decisions, [], summaries)).toThrow(
      /Malformed recorded hand for A in game g1: street 1 was dealt 4 card\(s\)/,
    )
  })

  it('catches a recorded street sequence with a duplicated/missing street index', () => {
    const decisions = [...fiveNormalStreets('g1', 'A'), ...fiveNormalStreets('g1', 'B')]
    // B's street-3 decision is mislabeled as street 2 (duplicate), so street
    // 3 never appears — a raw-export row landing under the wrong street
    // index, which callers elsewhere consume purely positionally.
    const bStreet3 = decisions.find(d => d.username === 'B' && d.street === 3)!
    bStreet3.street = 2

    const summaries = [summary({ gameId: 'g1', playerNames: ['A', 'B'], points: { A: 5, B: -5 } })]

    expect(() => buildHandReplayData('g1', 'A', decisions, [], summaries)).toThrow(
      /Malformed recorded placement sequence for B in game g1: street indices are/,
    )
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
