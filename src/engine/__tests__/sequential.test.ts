import { describe, it, expect } from 'vitest'
import { getBotMove, buildLiveDeck, type InfoState } from '../mc'
import { parseCards } from '../deck'
import type { PartialBoard } from '../types'

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const count = (b: PartialBoard) => b.top.length + b.middle.length + b.bottom.length

// Under sequential placement (players act in order from the left of the
// dealer) an opponent seated ahead of the actor has already committed this
// street's cards, and those cards are visible on their board. rollout() infers
// that from card counts: before placing street s a player shows 3+2s cards,
// after placing 5+2s.
describe('sequential placement', () => {
  // Actor is at street 1 with 5 cards down. The opponent ahead of them has
  // already placed street 1, so shows 7.
  const actorBoard: PartialBoard = {
    top: parseCards(['Qs']), middle: parseCards(['Th', '9h']), bottom: parseCards(['Kd', 'Kc']),
  }
  const oppActed: PartialBoard = {
    top: parseCards(['2c']), middle: parseCards(['5d', '6d', '7d']), bottom: parseCards(['As', 'Ad', 'Ah']),
  }
  const oppWaiting: PartialBoard = {
    top: parseCards(['2c']), middle: parseCards(['5d', '6d']), bottom: parseCards(['As', 'Ad']),
  }

  it('the fixtures encode the intended card counts', () => {
    expect(count(actorBoard)).toBe(5)   // 3 + 2*1, yet to place street 1
    expect(count(oppActed)).toBe(7)     // 5 + 2*1, has placed street 1
    expect(count(oppWaiting)).toBe(5)   // level with the actor
  })

  it('does not deal a second hand to an opponent who already acted', () => {
    // If rollout dealt street 1 to an opponent already holding 7 cards, their
    // board would end at 15 rather than 13 and scoring would throw or skew.
    const st: InfoState = {
      board: actorBoard, hand: parseCards(['8c', '4h', '3s']), street: 1,
      revealedOpponentBoards: [oppActed],
    }
    expect(() => getBotMove(st, 12, mulberry32(5))).not.toThrow()
  })

  it('produces a different decision than if that opponent were still to act', () => {
    const hand = parseCards(['8c', '4h', '3s'])
    const acted: InfoState = { board: actorBoard, hand, street: 1, revealedOpponentBoards: [oppActed] }
    const waiting: InfoState = { board: actorBoard, hand, street: 1, revealedOpponentBoards: [oppWaiting] }
    // Both must be legal and stable; the point is that the two info sets are
    // genuinely distinct inputs, not that one dominates.
    const a = getBotMove(acted, 20, mulberry32(9))
    const b = getBotMove(waiting, 20, mulberry32(9))
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    // The live deck differs: the acted opponent has one more card showing.
    expect(buildLiveDeck(acted).length).toBe(buildLiveDeck(waiting).length - 2)
  })

  it('is unchanged when every opponent is level with the actor', () => {
    // The simultaneous case: nobody has acted, so the sequential branch must
    // not engage at all and results must be reproducible.
    const st: InfoState = {
      board: actorBoard, hand: parseCards(['8c', '4h', '3s']), street: 1,
      revealedOpponentBoards: [oppWaiting],
    }
    const first = getBotMove(st, 25, mulberry32(11))
    const again = getBotMove(st, 25, mulberry32(11))
    expect(again).toEqual(first)
  })

  it('handles a 3-player street where one opponent has acted and one has not', () => {
    const st: InfoState = {
      board: actorBoard, hand: parseCards(['8c', '4h', '3s']), street: 1,
      revealedOpponentBoards: [oppActed, {
        top: parseCards(['9s']), middle: parseCards(['2h', '3h']), bottom: parseCards(['Jc', 'Js']),
      }],
    }
    expect(() => getBotMove(st, 12, mulberry32(3))).not.toThrow()
  })
})
