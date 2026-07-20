import { describe, it, expect } from 'vitest'
import { simulateHandWithBot } from '../botSimulator'
import type { GetBotMoveFn } from '../botSimulator'
import type { HandReplayData } from '../replayBuilder'
import type { Card, PartialBoard, Placement } from '../../engine/index'

function c(rank: number, suit: 's' | 'h' | 'd' | 'c'): Card { return { rank: rank as Card['rank'], suit } }

function placement(top: Card[], middle: Card[], bottom: Card[]): Placement {
  return { topAdd: top, middleAdd: middle, bottomAdd: bottom, discard: null }
}

// Deterministic, fully scripted "bot": fills top first (up to 3), then
// bottom (up to 5), then middle — on street 0 it places all 5 dealt cards,
// on streets 1-4 only the first 2 (mirroring the real discard rule; the
// reducer itself derives the actual discard from what's left in hand, so the
// 3rd dealt card is simply never chosen here). Used instead of the real
// heuristic/MCTS bot so tests can assert on an exact, predictable board.
const scriptedBot: GetBotMoveFn = async (state) => {
  const toPlace = state.street === 0 ? state.hand : state.hand.slice(0, 2)
  const top: Card[] = []
  const middle: Card[] = []
  const bottom: Card[] = []
  let topRoom = 3 - state.board.top.length
  let botRoom = 5 - state.board.bottom.length
  for (const card of toPlace) {
    if (topRoom > 0) { top.push(card); topRoom--; }
    else if (botRoom > 0) { bottom.push(card); botRoom--; }
    else middle.push(card)
  }
  return placement(top, middle, bottom)
}

// A legal, non-fouling, non-qualifying (unpaired top) frozen opponent board
// spread across 5 streets — reused by both fixtures below.
function weakOpponentPlacements(): Placement[] {
  return [
    placement([c(2, 's'), c(3, 's'), c(4, 's')], [], [c(5, 's'), c(6, 's')]),
    placement([], [], [c(8, 's'), c(10, 's')]),
    placement([], [c(3, 'h')], [c(11, 's')]),
    placement([], [c(5, 'h'), c(6, 'h')], []),
    placement([], [c(11, 'h'), c(13, 'h')], []),
  ]
}

function baseReplay(opponentPlacements: Placement[], humanBonusReplay: HandReplayData['replay']['humanBonusReplay'] = null) {
  return {
    opponentNormalPlacements: [opponentPlacements],
    opponentBonusOutcomes: [null],
    humanBonusReplay,
    historicalTotal: 7,
    fallbackSeed: 12345,
  }
}

describe('simulateHandWithBot', () => {
  it('plays a full hand with no bonus trigger and zero-sum scoring', async () => {
    const hand: HandReplayData = {
      playerCount: 2,
      preDealt: [
        [
          [c(14, 's'), c(13, 'h'), c(2, 'c'), c(12, 'd'), c(12, 'h')],   // street 0: A,K,2 -> top (unpaired), Q,Q -> bottom
          [c(12, 'c'), c(12, 's'), c(4, 'd')],
          [c(13, 'd'), c(9, 'c'), c(11, 'd')],
          [c(9, 'd'), c(9, 'h'), c(5, 'c')],
          [c(9, 's'), c(7, 'd'), c(7, 'h')],
        ],
        [],
      ],
      replay: baseReplay(weakOpponentPlacements()),
      opponentNames: ['Opp'],
    }

    const result = await simulateHandWithBot(hand, 'heuristic', 1, undefined, 42, scriptedBot)

    expect(result.board.top).toHaveLength(3)
    expect(result.board.middle).toHaveLength(5)
    expect(result.board.bottom).toHaveLength(5)
    expect(result.bonusBoard).toBeNull()   // neither side qualified -> straight to bonus_scoring
    expect(result.totalScores).toHaveLength(2)
    expect(result.totalScores.reduce((a, b) => a + b, 0)).toBe(0)

    expect(result.opponentBoards).toHaveLength(1)
    const oppBoard = result.opponentBoards[0]!
    expect(oppBoard.top.length + oppBoard.middle.length + oppBoard.bottom.length).toBe(13)
  })

  it('drives a triggered bonus one-shot board and keeps scoring zero-sum', async () => {
    // Scripted so the top locks in as a pair of Aces after street 0 (topRoom
    // hits 0 immediately) and never changes again, while middle/bottom end up
    // quads >= quads so the board never fouls — guarantees bonusTrigger fires.
    const hand: HandReplayData = {
      playerCount: 2,
      preDealt: [
        [
          [c(14, 's'), c(14, 'h'), c(2, 'c'), c(12, 'd'), c(12, 'h')],   // top: A,A,2 (pair aces); bottom starts Q,Q
          [c(12, 'c'), c(12, 's'), c(4, 'd')],                            // bottom -> quads Q + K kicker (via street2)
          [c(13, 'd'), c(9, 'c'), c(11, 'd')],
          [c(9, 'd'), c(9, 'h'), c(5, 'c')],
          [c(9, 's'), c(7, 'd'), c(7, 'h')],                              // middle -> quads 9 + 7 kicker
        ],
        [],
      ],
      // No historical bonus data for either seat -> target gets a fresh
      // deterministic bonus deal (fallbackSeed), opponent (non-qualifying)
      // falls into the live heuristic side-game solver, exactly like a real
      // divergent-bonus replay.
      replay: baseReplay(weakOpponentPlacements()),
      opponentNames: ['Opp'],
    }

    const result = await simulateHandWithBot(hand, 'heuristic', 1, undefined, 42, scriptedBot)

    expect(result.board.top).toEqual(expect.arrayContaining([c(14, 's'), c(14, 'h'), c(2, 'c')]))
    expect(result.bonusBoard).not.toBeNull()
    const bonus = result.bonusBoard as PartialBoard
    expect(bonus.top.length + bonus.middle.length + bonus.bottom.length).toBe(13)
    expect(result.totalScores).toHaveLength(2)
    expect(result.totalScores.reduce((a, b) => a + b, 0)).toBe(0)

    // Opponent didn't qualify -> live heuristic side-game solve, not null.
    expect(result.opponentBonusBoards).toHaveLength(1)
    const oppBonus = result.opponentBonusBoards[0]
    expect(oppBonus).not.toBeNull()
    expect((oppBonus as PartialBoard).top.length + (oppBonus as PartialBoard).middle.length + (oppBonus as PartialBoard).bottom.length).toBe(13)
  })

  it('throws if buildInfoState cannot construct a placing decision', async () => {
    // playerCount mismatch: opponentNormalPlacements has 0 opponents for a
    // 2-player hand, so bot_thinking's placements[i] lookup is undefined ->
    // applyPlacement should blow up loudly rather than silently proceeding.
    const hand: HandReplayData = {
      playerCount: 2,
      preDealt: [[[c(2, 's'), c(3, 's'), c(4, 's'), c(5, 's'), c(6, 's')], [c(7, 's'), c(8, 's'), c(9, 's')], [c(10, 's'), c(11, 's'), c(2, 'h')], [c(3, 'h'), c(4, 'h'), c(5, 'h')], [c(6, 'h'), c(7, 'h'), c(8, 'h')]], []],
      replay: baseReplay([]),
      opponentNames: ['Opp'],
    }
    await expect(simulateHandWithBot(hand, 'heuristic', 1, undefined, 1, scriptedBot)).rejects.toThrow()
  })
})
