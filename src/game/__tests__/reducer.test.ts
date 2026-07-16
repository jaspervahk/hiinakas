import { describe, it, expect } from 'vitest'
import { gameReducer, makeInitialState } from '../reducer'
import type { GameState } from '../types'
import type { ReplayConfig } from '../types'
import type { Card, Placement } from '../../engine/index'

function c(rank: number, suit: 's' | 'h' | 'd' | 'c'): Card { return { rank: rank as Card['rank'], suit } }

function placement(top: Card[], middle: Card[], bottom: Card[], discard: Card | null = null): Placement {
  return { topAdd: top, middleAdd: middle, bottomAdd: bottom, discard }
}

// Opponent's frozen historical placements, folding to exactly:
// top=[Qs,Qh,2c] (pair Q, qualifies 'QQ'), middle=[3c,3d,3h,9s,8h] (trips),
// bottom=[5d,6h,7s,8d,9c] (straight) — non-fouled since Pair <= Trips <= Straight.
const OPPONENT_STREETS: Placement[] = [
  placement([c(12, 's'), c(12, 'h')], [c(3, 'c'), c(3, 'd')], [c(5, 'd')]),
  placement([c(2, 'c')], [c(3, 'h')], [], c(2, 'd')),
  placement([], [c(9, 's')], [c(6, 'h')], c(2, 'h')),
  placement([], [c(8, 'h')], [c(7, 's')], c(4, 'c')),
  placement([], [], [c(8, 'd'), c(9, 'c')], c(4, 'd')),
]

// Dummy hands dealt to the human seat — content doesn't matter for these
// tests, only that they're valid enough to drive LOCK_IN through the reducer.
const HUMAN_STREETS: Card[][] = [
  [c(4, 's'), c(5, 's'), c(6, 's'), c(7, 'd'), c(10, 'c')],
  [c(11, 'c'), c(11, 'd'), c(2, 's')],
  [c(13, 'c'), c(13, 'd'), c(3, 's')],
  [c(14, 'c'), c(14, 'd'), c(4, 'h')],
  [c(9, 'd'), c(9, 'h'), c(5, 'h')],
]

function baseReplay(overrides: Partial<ReplayConfig> = {}): ReplayConfig {
  return {
    opponentNormalPlacements: [OPPONENT_STREETS],
    opponentBonusOutcomes: [null],
    humanBonusReplay: null,
    historicalTotal: 0,
    fallbackSeed: 777,
    ...overrides,
  }
}

function startReplay(replay: ReplayConfig, humanStreets: Card[][] = HUMAN_STREETS): GameState {
  return gameReducer(makeInitialState(), {
    type: 'START_REPLAY', playerCount: 2, preDealt: [humanStreets, []], replay,
  })
}

// Per-street row assignment for the human's dummy hand — respects row caps
// (top 3, middle/bottom 5 each) across the whole 13-card board: street 0
// places all 5 dealt cards (2 top, 2 middle, 1 bottom); streets 1-4 place
// exactly 2 of the 3 dealt cards (the 3rd auto-discards).
const HUMAN_ROWS: ('top' | 'middle' | 'bottom')[][] = [
  ['top', 'top', 'middle', 'middle', 'bottom'],
  ['top', 'middle'],
  ['middle', 'bottom'],
  ['middle', 'bottom'],
  ['bottom', 'bottom'],
]

// A human hand/row-assignment that ends up qualifying for the bonus (pair of
// Queens on top, non-fouled: OnePair <= TwoPair <= Straight) — used by the
// test that needs the human to be the one triggering the round while the
// opponent plays the side game.
const QUALIFYING_HUMAN_STREETS: Card[][] = [
  [c(12, 'd'), c(12, 'c'), c(3, 'd'), c(3, 'h'), c(6, 'd')],
  [c(9, 'd'), c(9, 'h'), c(2, 's')],
  [c(9, 's'), c(8, 'd'), c(3, 's')],
  [c(8, 'h'), c(7, 'd'), c(4, 'h')],
  [c(9, 'c'), c(10, 'd'), c(5, 'h')],
]

// Drives the human through one street using `rows`, then locks in and
// resolves the bot via the frozen replay placement for that street.
function playStreet(state: GameState, rows: ('top' | 'middle' | 'bottom')[] = HUMAN_ROWS[state.street]!): GameState {
  const street = state.street
  const hand = state.humanHand
  let s = state
  for (let i = 0; i < rows.length; i++) {
    s = gameReducer(s, { type: 'SELECT_CARD', card: hand[i]! })
    s = gameReducer(s, { type: 'ASSIGN_TO_ROW', row: rows[i]! })
  }
  s = gameReducer(s, { type: 'LOCK_IN' })
  expect(s.phase).toBe('bot_thinking')
  s = gameReducer(s, {
    type: 'BOT_PLACED',
    placements: s.replay!.opponentNormalPlacements.map(p => p[street]!),
  })
  expect(s.phase).toBe('revealing')
  return s
}

function playFullNormalRound(state: GameState, rowsPerStreet: ('top' | 'middle' | 'bottom')[][] = HUMAN_ROWS): GameState {
  let s = state
  for (let i = 0; i < 5; i++) {
    s = playStreet(s, rowsPerStreet[i]!)
    s = gameReducer(s, { type: 'ADVANCE' })
  }
  return s
}

describe('START_REPLAY', () => {
  it('produces the expected initial state', () => {
    const replay = baseReplay()
    const s = startReplay(replay)
    expect(s.phase).toBe('placing')
    expect(s.context).toBe('normal')
    expect(s.playerCount).toBe(2)
    expect(s.preDealt[0]).toEqual(HUMAN_STREETS)
    expect(s.humanHand).toEqual(HUMAN_STREETS[0])
    expect(s.botBoards).toEqual([{ top: [], middle: [], bottom: [] }])
    expect(s.replay).toBe(replay)
    expect(s.seed).toBe(replay.fallbackSeed)
  })
})

describe('BOT_PLACED with frozen replay placements', () => {
  it('reproduces the exact historical opponent board after all 5 streets', () => {
    const s = playFullNormalRound(startReplay(baseReplay()))
    expect(s.phase).toBe('scoring')
    expect(s.botBoards[0]).toEqual({
      top: [c(12, 's'), c(12, 'h'), c(2, 'c')],
      middle: [c(3, 'c'), c(3, 'd'), c(3, 'h'), c(9, 's'), c(8, 'h')],
      bottom: [c(5, 'd'), c(6, 'h'), c(7, 's'), c(8, 'd'), c(9, 'c')],
    })
  })
})

describe('startBonus() replay branch', () => {
  it('uses the frozen historical board for an opponent who triggered the bonus', () => {
    const frozenBonusBoard = {
      top: [c(14, 's'), c(14, 'h'), c(14, 'd')],
      middle: [c(2, 's'), c(2, 'h'), c(2, 'c'), c(3, 's'), c(3, 'h')],
      bottom: [c(4, 's'), c(4, 'h'), c(4, 'c'), c(5, 's'), c(5, 'h')],
    }
    const replay = baseReplay({ opponentBonusOutcomes: [{ qualifies: true, board: frozenBonusBoard }] })
    let s = playFullNormalRound(startReplay(replay))
    s = gameReducer(s, { type: 'START_BONUS' })
    expect(s.botBonusQualifiers[0]).toBe('QQ')  // recomputed fresh from the (frozen) opponent board — matches history
    expect(s.botBonusBoards[0]).toEqual(frozenBonusBoard)
  })

  it('folds a side-gaming opponent\'s frozen placements instead of computing a heuristic board', () => {
    // Opponent ends up NOT qualifying this time (no pair/trips on top) so they
    // play the side game — give them frozen side-game placements to fold.
    const nonQualifyingStreets: Placement[] = [
      placement([c(4, 's'), c(5, 'h')], [c(6, 'c'), c(7, 'd')], [c(8, 's')]),
      placement([c(9, 'h')], [c(10, 'c')], [], c(2, 'd')),
      placement([], [c(11, 'c')], [c(2, 'h')], c(3, 'c')),
      placement([], [c(13, 'h')], [c(3, 'd')], c(4, 'c')),
      placement([], [], [c(6, 'd'), c(7, 'h')], c(4, 'd')),
    ]
    const sideOutcomeStreets: Placement[] = [
      placement([c(2, 's'), c(2, 'h')], [c(3, 's'), c(3, 'h')], [c(4, 's')]),
      placement([c(2, 'c')], [c(4, 'h')], [], c(9, 'd')),
      placement([], [c(5, 's')], [c(4, 'd')], c(9, 'h')),
      placement([], [c(6, 's')], [c(5, 'd')], c(10, 'd')),
      placement([], [], [c(6, 'h'), c(7, 's')], c(10, 'h')),
    ]
    const replay = baseReplay({
      opponentNormalPlacements: [nonQualifyingStreets],
      opponentBonusOutcomes: [{ qualifies: false, placements: sideOutcomeStreets }],
    })
    // The human must be the one to trigger the round here (opponent doesn't
    // qualify this time), or no bonus round happens for anyone at all.
    let s = playFullNormalRound(startReplay(replay, QUALIFYING_HUMAN_STREETS))
    s = gameReducer(s, { type: 'START_BONUS' })
    expect(s.botBonusQualifiers[0]).toBeNull()
    expect(s.botSideBoards[0]).toEqual({
      top: [c(2, 's'), c(2, 'h'), c(2, 'c')],
      middle: [c(3, 's'), c(3, 'h'), c(4, 'h'), c(5, 's'), c(6, 's')],
      bottom: [c(4, 's'), c(4, 'd'), c(5, 'd'), c(6, 'h'), c(7, 's')],
    })
  })

  it('falls back to a fresh deterministic deal when the human\'s replayed tier diverges from history', () => {
    // History says the human qualified for QQ, but this replay's board (built
    // from HUMAN_STREETS, arbitrary cards with no top pair) won't qualify —
    // humanBonusReplay should simply be unused, no crash, and (if the human
    // happens to still qualify) fresh cards get dealt instead of historical ones.
    const replay = baseReplay({ humanBonusReplay: { tier: 'QQ', cards: [c(12, 's'), c(12, 'h')] } })
    let s = playFullNormalRound(startReplay(replay))
    expect(() => gameReducer(s, { type: 'START_BONUS' })).not.toThrow()
    s = gameReducer(s, { type: 'START_BONUS' })
    // The opponent still qualifies (QQ, frozen), so a bonus round happens either way.
    expect(s.botBonusQualifiers[0]).toBe('QQ')
  })
})
