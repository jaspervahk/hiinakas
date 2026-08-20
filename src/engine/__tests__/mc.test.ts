import { describe, it, expect } from 'vitest'
import { getBotMove, parseCards } from '../index'
import type { InfoState, RNG, PartialBoard, Card } from '../index'

function board(top: string[], middle: string[], bottom: string[]): PartialBoard {
  return { top: parseCards(top), middle: parseCards(middle), bottom: parseCards(bottom) }
}

// Deterministic RNG (not cryptographically random, just reproducible for a test).
function mulberry32(seed: number): RNG {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('getBotMove', () => {
  it('does not throw when a visible opponent board is already fully resolved', () => {
    // Reproduces the production bug: in a side game, a bot opponent's board
    // is resolved wholesale (all 5 streets, 13 cards) the instant the side
    // game starts (reducer.ts's startBonus -> botSideGamesInterleaved) —
    // unlike a normal-round opponent, whose revealed board only ever grows
    // one street at a time. A rollout that keeps trying to deal that
    // already-full opponent more cards and place them overflows row
    // capacity, and legalPlacements throws "No legal placements — board/
    // dealt mismatch" deep inside the worker with no indication why.
    const fullOpponent = board(
      ['2s', '2h', '3c'],
      ['4s', '4h', '5c', '5h', '6c'],
      ['7s', '7h', '8c', '8h', '9c'],
    )
    const hand: Card[] = parseCards(['Ts', 'Th', 'Jc', 'Jh', 'Qc'])
    const state: InfoState = {
      board: { top: [], middle: [], bottom: [] },
      hand,
      street: 0,
      revealedOpponentBoards: [fullOpponent],
      inBonusRound: true,
    }

    expect(() => getBotMove(state, 20, mulberry32(42))).not.toThrow()
  })
})
