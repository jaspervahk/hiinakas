import { describe, it, expect } from 'vitest'
import { openingPlacement } from '../opening'
import { legalPlacements } from '../placement'
import { parseCards, FULL_DECK, Deck } from '../deck'
import type { Card } from '../types'

const EMPTY = { top: [], middle: [], bottom: [] }
const key = (p: { topAdd: readonly Card[]; middleAdd: readonly Card[]; bottomAdd: readonly Card[] }) => [
  [...p.topAdd].map(c => `${c.rank}${c.suit}`).sort().join(','),
  [...p.middleAdd].map(c => `${c.rank}${c.suit}`).sort().join(','),
  [...p.bottomAdd].map(c => `${c.rank}${c.suit}`).sort().join(','),
].join('|')
const place = (s: string[]) => openingPlacement(parseCards(s))!
const rows = (s: string[]) => {
  const p = place(s)
  return {
    top: [...p.topAdd].map(c => c.rank).sort((a, b) => b - a),
    mid: [...p.middleAdd].map(c => c.rank).sort((a, b) => b - a),
    bot: [...p.bottomAdd].map(c => c.rank).sort((a, b) => b - a),
    split: `${p.topAdd.length}/${p.middleAdd.length}/${p.bottomAdd.length}`,
  }
}

// The book is the rollout policy's five-card opening. These pin the rules as
// specified; a deliberate strategy change should update them with a reason.
describe('opening book rules', () => {
  it('sends made hands to the bottom whole', () => {
    expect(rows(['Jc', 'Tc', '9c', '8c', '7c']).split).toBe('0/0/5')  // straight flush
    expect(rows(['Kh', 'Jh', '9h', '7h', '5h']).split).toBe('0/0/5')  // flush
    expect(rows(['Th', '9s', '8s', '7h', '6d']).split).toBe('0/0/5')  // straight
    expect(rows(['Ah', '5c', '4d', '3s', '2h']).split).toBe('0/0/5')  // wheel
    expect(rows(['5s', '5d', '5c', '2c', '2s']).split).toBe('0/0/5')  // full house
  })

  it('quads and trips keep the set in the bottom', () => {
    const q = rows(['9s', '9c', '9d', '9h', '5d'])
    expect(q.split).toBe('0/1/4')
    expect(q.bot).toEqual([9, 9, 9, 9])
    const t = rows(['Kc', 'Jc', '4h', '4d', '4s'])
    expect(t.split).toBe('0/2/3')
    expect(t.bot).toEqual([4, 4, 4])
    expect(t.mid).toEqual([13, 11])
  })

  it('two pair goes to the bottom with the odd card in the middle', () => {
    const r = rows(['Td', 'Th', '9h', '9s', '3c'])
    expect(r.split).toBe('0/1/4')
    expect(r.bot).toEqual([10, 10, 9, 9])
    expect(r.mid).toEqual([3])
  })

  it('a four-flush goes to the bottom, and outranks a straight draw', () => {
    const f = rows(['Ks', '8s', '5s', '3s', '2c'])
    expect(f.split).toBe('0/1/4')
    expect(f.mid).toEqual([2])
    // 4-suited AND 4-straight: the flush wins (case 20)
    const both = place(['Qd', 'Jc', 'Jd', 'Td', '9d'])
    expect([...both.bottomAdd].every(c => c.suit === 'd')).toBe(true)
  })

  it('takes an open-ended run but not a one-ended one or a gutshot', () => {
    // 5-6-7-8 is open-ended -> to the bottom
    const oe = rows(['8h', '7c', '6s', '5c', 'Kd'])
    expect(oe.bot).toEqual([8, 7, 6, 5])
    // J-Q-K-A completes only with a ten -> no run, falls through
    const oneEnded = rows(['Ah', 'Kc', 'Qs', 'Jd', '4c'])
    expect(oneEnded.bot).not.toEqual([14, 13, 12, 11])
    // 5-6-7-9 is a gutshot -> no run
    const gut = rows(['9h', '7c', '6s', '5c', 'Kd'])
    expect(gut.bot).not.toEqual([9, 7, 6, 5])
    // 2-3-4-5 is open-ended, since the ace plays low
    const wheelish = rows(['5h', '4c', '3s', '2c', 'Kd'])
    expect(wheelish.bot).toEqual([5, 4, 3, 2])
  })

  it('with a pair plus an open-ended run, the run breaks the pair', () => {
    // 5-6-7-8 with a spare 7: run to the bottom, duplicate to the middle
    const r = rows(['8h', '7c', '7h', '6s', '5c'])
    expect(r.bot).toEqual([8, 7, 6, 5])
    expect(r.mid).toEqual([7])
  })

  it('one pair: the pair is always in the bottom', () => {
    // nothing outranks the pair -> lowest loose card joins it
    const low = rows(['Ah', 'As', 'Qs', 'Jh', '2d'])
    expect(low.bot).toEqual([14, 14, 2])
    expect(low.mid).toEqual([12, 11])
    // an ace remains -> ace on top
    const ace = rows(['7h', '7s', 'Ad', 'Kh', '3c'])
    expect(ace.split).toBe('1/1/3')
    expect(ace.top).toEqual([14])
    expect(ace.bot).toEqual([13, 7, 7])
    expect(ace.mid).toEqual([3])
    // otherwise the highest loose card joins the pair
    const hi = rows(['7h', '7s', 'Kd', 'Qh', '3c'])
    expect(hi.bot).toEqual([13, 7, 7])
    expect(hi.mid).toEqual([12, 3])
  })

  it('no pair offsuit: ace up top only with two more high cards', () => {
    const withHigh = rows(['Ac', 'Kh', 'Qs', '6h', '3s'])
    expect(withHigh.split).toBe('1/2/2')
    expect(withHigh.top).toEqual([14])
    expect(withHigh.bot).toEqual([13, 12])
    const withoutHigh = rows(['Ac', '7h', '5s', '4h', '3s'])
    expect(withoutHigh.top).toEqual([3])     // lowest on top
    expect(withoutHigh.bot).toEqual([14, 7]) // two highest in the bottom
  })

  it('three-suited no-pair sends the suited cards to the bottom', () => {
    const r = rows(['Kc', 'Qd', '9s', '7d', '5d'])
    expect(r.split).toBe('0/2/3')
    expect(r.bot).toEqual([12, 7, 5])  // the three diamonds
  })
})

describe('opening book is always a legal, card-conserving placement', () => {
  it('holds over 20000 random deals', () => {
    for (let i = 0; i < 20000; i++) {
      const hand = new Deck((i * 2654435761) >>> 0).deal(5)
      const pl = openingPlacement(hand)!
      expect(pl).not.toBeNull()
      expect(pl.discard).toBeNull()  // street 0 never discards
      const placed = [...pl.topAdd, ...pl.middleAdd, ...pl.bottomAdd]
      expect(placed).toHaveLength(5)
      expect(placed.map(c => `${c.rank}${c.suit}`).sort())
        .toEqual(hand.map(c => `${c.rank}${c.suit}`).sort())
      expect(pl.topAdd.length).toBeLessThanOrEqual(3)
    }
  })

  it('always produces a placement the engine itself considers legal', () => {
    for (let i = 0; i < 2000; i++) {
      const hand = new Deck((i * 40503 + 11) >>> 0).deal(5)
      const pl = openingPlacement(hand)!
      const legal = legalPlacements(EMPTY, hand, 0)
      expect(legal.some(l => key(l) === key(pl))).toBe(true)
    }
  })

  it('returns null for a malformed hand rather than throwing', () => {
    expect(openingPlacement([])).toBeNull()
    expect(openingPlacement((FULL_DECK as Card[]).slice(0, 3))).toBeNull()
    expect(openingPlacement((FULL_DECK as Card[]).slice(0, 6))).toBeNull()
  })
})
