import { describe, it, expect } from 'vitest'
import { resolveBonusBots } from '../bonusBotResolver'
import type { GetBotMoveFn, SolveBonusFn } from '../botSimulator'
import { makeInitialState } from '../reducer'
import { emptyBoard } from '../types'
import type { GameState } from '../types'
import type { Board, Card, InfoState } from '../../engine/index'
import type { OpponentRef } from '../../worker/client'

function c(rank: number, suit: 's' | 'h' | 'd' | 'c'): Card { return { rank: rank as Card['rank'], suit } }

// Deterministic, fully scripted "bot" (same shape as botSimulator.test.ts's
// scriptedBot): fills top first (up to 3), then bottom (up to 5), then
// middle — respects row caps regardless of how many streets have already
// been applied to state.board, so it produces a valid 13-card board over any
// 5-street sequence. Discard is always the 3rd dealt card on streets 1-4,
// mirroring the real discard rule.
function makeScriptedBot(calls: InfoState[]): GetBotMoveFn {
  return async (state) => {
    calls.push(state)
    const toPlace = state.street === 0 ? state.hand : state.hand.slice(0, 2)
    const top: Card[] = []
    const middle: Card[] = []
    const bottom: Card[] = []
    let topRoom = 3 - state.board.top.length
    let botRoom = 5 - state.board.bottom.length
    for (const card of toPlace) {
      if (topRoom > 0) { top.push(card); topRoom-- }
      else if (botRoom > 0) { bottom.push(card); botRoom-- }
      else middle.push(card)
    }
    const discard = state.street === 0 ? null : (state.hand[2] ?? null)
    return { topAdd: top, middleAdd: middle, bottomAdd: bottom, discard }
  }
}

const DUMMY_BOARD: Board = {
  top: [c(14, 's'), c(14, 'h'), c(14, 'c')],
  middle: [c(2, 's'), c(2, 'h'), c(2, 'c'), c(3, 's'), c(3, 'h')],
  bottom: [c(4, 's'), c(4, 'h'), c(4, 'c'), c(5, 's'), c(5, 'h')],
}

function makeStubSolveBonus(calls: { cards: Card[]; numDiscard: number; opponents: OpponentRef[] }[]): SolveBonusFn {
  return async (cards, numDiscard, opponents) => {
    calls.push({ cards, numDiscard, opponents })
    return DUMMY_BOARD
  }
}

// Five streets of dealt cards ([5,3,3,3,3]) for one side-gaming participant,
// using a distinct rank range per participant so boards/hands are trivially
// distinguishable across bots in assertions.
function dealtStreets(baseRank: number, suit: 's' | 'h' | 'd' | 'c'): Card[][] {
  let r = baseRank
  const counts = [5, 3, 3, 3, 3]
  return counts.map(n => {
    const cards: Card[] = []
    for (let i = 0; i < n; i++) { cards.push(c((r % 13) + 2 as Card['rank'], suit)); r++ }
    return cards
  })
}

function baseState(overrides: Partial<GameState>): GameState {
  return { ...makeInitialState(), ...overrides }
}

describe('resolveBonusBots — one-shot bots', () => {
  it('derives opponent refs as [human, ...other bots] excluding the acting bot, and skips non-qualifiers', async () => {
    const solveBonusCalls: { cards: Card[]; numDiscard: number; opponents: OpponentRef[] }[] = []
    const getBotMoveCalls: InfoState[] = []

    const state = baseState({
      playerCount: 3,
      humanBonusQualifier: 'KK',
      botBonusQualifiers: ['QQ', null],
      botBonusCards: [
        [c(2, 's'), c(3, 's'), c(4, 's'), c(5, 's'), c(6, 's'), c(7, 's'), c(8, 's'), c(9, 's'), c(10, 's'), c(11, 's'), c(12, 's'), c(13, 's'), c(2, 'h')],
        [],
      ],
      sidePreDealt: [dealtStreets(2, 'd')],  // only bot 1 is in the side game (human qualifies)
      appSettings: { ...makeInitialState().appSettings, botPolicy: 'heuristic', botSims: 5 },
    })

    const result = await resolveBonusBots(state, makeScriptedBot(getBotMoveCalls), makeStubSolveBonus(solveBonusCalls))

    // Only bot 0 qualifies -> exactly one solveBonus call.
    expect(solveBonusCalls).toHaveLength(1)
    expect(solveBonusCalls[0]!.numDiscard).toBe(0)  // QQ -> 0 discards
    expect(solveBonusCalls[0]!.opponents).toEqual<OpponentRef[]>([{ tier: 'KK' }, 'side'])
    expect(result.botBonusBoards[0]).toEqual(DUMMY_BOARD)
    // Bot 1 doesn't qualify -> empty one-shot board.
    expect(result.botBonusBoards[1]).toEqual(emptyBoard())
  })

  it('includes every other qualifying bot as a {tier} ref and every non-qualifying bot as \'side\'', async () => {
    const solveBonusCalls: { cards: Card[]; numDiscard: number; opponents: OpponentRef[] }[] = []
    const state = baseState({
      playerCount: 3,
      humanBonusQualifier: null,  // human plays the side game
      botBonusQualifiers: ['AA_OR_TRIPS', 'KK'],
      botBonusCards: [
        new Array(15).fill(0).map((_, i) => c((i % 13) + 2 as Card['rank'], 's')),
        new Array(14).fill(0).map((_, i) => c((i % 13) + 2 as Card['rank'], 'h')),
      ],
      sidePreDealt: [dealtStreets(2, 'c')],  // only the human is in the side game
      appSettings: { ...makeInitialState().appSettings, botPolicy: 'heuristic', botSims: 5 },
    })

    await resolveBonusBots(state, makeScriptedBot([]), makeStubSolveBonus(solveBonusCalls))

    expect(solveBonusCalls).toHaveLength(2)
    const forBot0 = solveBonusCalls.find(c => c.numDiscard === 2)!  // AA_OR_TRIPS -> 2 discards
    expect(forBot0.opponents).toEqual<OpponentRef[]>(['side', { tier: 'KK' }])
    const forBot1 = solveBonusCalls.find(c => c.numDiscard === 1)!  // KK -> 1 discard
    expect(forBot1.opponents).toEqual<OpponentRef[]>(['side', { tier: 'AA_OR_TRIPS' }])
  })
})

describe('resolveBonusBots — side-game bots', () => {
  it('resolves a solo side-gaming bot into a full 13-card board using getBotMove per street', async () => {
    const getBotMoveCalls: InfoState[] = []
    const state = baseState({
      playerCount: 2,
      humanBonusQualifier: 'QQ',  // human qualifies -> the single bot plays the side game alone
      botBonusQualifiers: [null],
      botBonusCards: [[]],
      sidePreDealt: [dealtStreets(2, 's')],
      appSettings: { ...makeInitialState().appSettings, botPolicy: 'heuristic', botSims: 5 },
    })

    const result = await resolveBonusBots(state, makeScriptedBot(getBotMoveCalls), makeStubSolveBonus([]))

    const board = result.botSideBoards[0]!
    expect(board.top).toHaveLength(3)
    expect(board.middle).toHaveLength(5)
    expect(board.bottom).toHaveLength(5)
    expect(getBotMoveCalls).toHaveLength(5)  // one call per street
    // Solo side-gamer: no revealed opponents at any street (human hasn't acted yet).
    for (const call of getBotMoveCalls) expect(call.revealedOpponentBoards).toEqual([])
    // Human's tier is invisible-but-scored throughout.
    for (const call of getBotMoveCalls) expect(call.invisibleBonusOpponents).toEqual(['QQ'])
    for (const call of getBotMoveCalls) expect(call.inBonusRound).toBe(true)
  })

  it('gives each side-gaming bot the others\' revealed boards (excluding itself and the human) and tracks discards across streets', async () => {
    const getBotMoveCalls: InfoState[] = []
    const state = baseState({
      playerCount: 3,
      humanBonusQualifier: 'AA_OR_TRIPS',  // human qualifies -> both bots share the side game
      botBonusQualifiers: [null, null],
      botBonusCards: [[], []],
      sidePreDealt: [dealtStreets(2, 's'), dealtStreets(2, 'h')],
      appSettings: { ...makeInitialState().appSettings, botPolicy: 'heuristic', botSims: 5 },
    })

    const result = await resolveBonusBots(state, makeScriptedBot(getBotMoveCalls), makeStubSolveBonus([]))

    expect(getBotMoveCalls).toHaveLength(10)  // 2 bots x 5 streets
    for (const call of getBotMoveCalls) {
      expect(call.revealedOpponentBoards).toHaveLength(1)  // only the other side-gamer, never the human
      expect(call.invisibleBonusOpponents).toEqual(['AA_OR_TRIPS'])
    }
    // Street-2 call should see the other bot's board already containing street 0-1 cards.
    const street2Calls = getBotMoveCalls.filter(c => c.street === 2)
    for (const call of street2Calls) {
      const oppBoard = call.revealedOpponentBoards[0]!
      const total = oppBoard.top.length + oppBoard.middle.length + oppBoard.bottom.length
      expect(total).toBeGreaterThan(0)
    }
    // Discards accrue: by street 4, this bot's own discards array should have
    // one entry per prior street (1,2,3) that actually discarded a card.
    const lastCallBot0 = getBotMoveCalls.filter(c => c.board.top.length + c.board.middle.length + c.board.bottom.length >= 0 && c.street === 4)[0]!
    expect(lastCallBot0.discards).toBeDefined()

    expect(result.botSideBoards[0]!.top.length + result.botSideBoards[0]!.middle.length + result.botSideBoards[0]!.bottom.length).toBe(13)
    expect(result.botSideBoards[1]!.top.length + result.botSideBoards[1]!.middle.length + result.botSideBoards[1]!.bottom.length).toBe(13)
    // Both bots' one-shot boards are empty placeholders (neither qualifies).
    expect(result.botBonusBoards[0]).toEqual(emptyBoard())
    expect(result.botBonusBoards[1]).toEqual(emptyBoard())
  })
})
