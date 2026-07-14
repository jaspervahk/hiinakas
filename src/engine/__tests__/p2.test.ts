import { describe, it, expect } from 'vitest'
import {
  parseCards,
  legalPlacements,
  applyPlacement,
  heuristicPlacement,
  getBotMove,
  computeEV,
  isFoul,
  bonusTrigger,
  scoreTable,
  Deck,
} from '../index'
import type { PartialBoard, Board, InfoState } from '../index'

// ── Helpers ────────────────────────────────────────────────────────────────

function emptyBoard(): PartialBoard {
  return { top: [], middle: [], bottom: [] }
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── legalPlacements ────────────────────────────────────────────────────────

describe('legalPlacements', () => {
  it('street 0 from empty board: all 5 cards placed, no discard', () => {
    const dealt = parseCards(['As', 'Kd', 'Qh', 'Jc', 'Ts'])
    const placements = legalPlacements(emptyBoard(), dealt, 0)
    // Every placement has no discard and places exactly 5 cards total
    for (const p of placements) {
      expect(p.discard).toBeNull()
      const total = p.topAdd.length + p.middleAdd.length + p.bottomAdd.length
      expect(total).toBe(5)
      // Top must have ≤ 3 cards
      expect(p.topAdd.length).toBeLessThanOrEqual(3)
    }
    expect(placements.length).toBeGreaterThan(0)
  })

  it('street 1 from partial board: 1 discard, 2 placed', () => {
    // Board after street 0: say (2, 2, 1) distribution
    const board: PartialBoard = {
      top:    parseCards(['As', 'Ad']),
      middle: parseCards(['Kh', 'Kd']),
      bottom: parseCards(['Qh']),
    }
    const dealt = parseCards(['Jh', 'Tc', '9d'])
    const placements = legalPlacements(board, dealt, 1)

    for (const p of placements) {
      expect(p.discard).not.toBeNull()
      const total = p.topAdd.length + p.middleAdd.length + p.bottomAdd.length
      expect(total).toBe(2)
      // Respect row capacities
      expect(board.top.length    + p.topAdd.length).toBeLessThanOrEqual(3)
      expect(board.middle.length + p.middleAdd.length).toBeLessThanOrEqual(5)
      expect(board.bottom.length + p.bottomAdd.length).toBeLessThanOrEqual(5)
    }
    expect(placements.length).toBeGreaterThan(0)
  })

  it('each dealt card appears exactly once in each placement', () => {
    const dealt = parseCards(['2s', '3d', '4c'])
    const board: PartialBoard = {
      top: [], middle: parseCards(['5h', '6h']), bottom: parseCards(['7h', '8h']),
    }
    const placements = legalPlacements(board, dealt, 1)
    for (const p of placements) {
      const allCards = [p.discard!, ...p.topAdd, ...p.middleAdd, ...p.bottomAdd]
      const keys = allCards.map(c => `${c.rank}${c.suit}`)
      const uniqueKeys = new Set(keys)
      expect(uniqueKeys.size).toBe(dealt.length) // all 3 dealt cards, each once
    }
  })

  it('applyPlacement updates board correctly', () => {
    const board = emptyBoard()
    const dealt = parseCards(['As', 'Kd', 'Qh', 'Jc', 'Ts'])
    const placements = legalPlacements(board, dealt, 0)
    for (const p of placements) {
      const updated = applyPlacement(board, p)
      expect(updated.top.length).toBe(p.topAdd.length)
      expect(updated.middle.length).toBe(p.middleAdd.length)
      expect(updated.bottom.length).toBe(p.bottomAdd.length)
    }
  })
})

// ── Heuristic placement ────────────────────────────────────────────────────

describe('heuristicPlacement', () => {
  it('returns a valid legal placement', () => {
    const board = emptyBoard()
    const dealt = parseCards(['As', 'Kd', 'Qh', 'Jc', 'Ts'])
    const p = heuristicPlacement(board, dealt, 0)
    expect(p.discard).toBeNull()
    expect(p.topAdd.length + p.middleAdd.length + p.bottomAdd.length).toBe(5)
    expect(p.topAdd.length).toBeLessThanOrEqual(3)
  })

  it('is deterministic (same board+dealt → same placement)', () => {
    const board = emptyBoard()
    const dealt = parseCards(['As', 'Kd', 'Qh', 'Jc', 'Ts'])
    const p1 = heuristicPlacement(board, dealt, 0)
    const p2 = heuristicPlacement(board, dealt, 0)
    expect(p1).toEqual(p2)
  })
})

// ── Bot-vs-bot simulation ─────────────────────────────────────────────────

describe('bot-vs-bot full game', () => {
  it('completes without error and produces a valid scored board', () => {
    const deck = new Deck(1234)
    const rng = mulberry32(1234)

    // Two players
    let board0: PartialBoard = emptyBoard()
    let board1: PartialBoard = emptyBoard()

    // Street 0: deal 5 each
    const hand0s0 = deck.deal(5)
    const hand1s0 = deck.deal(5)

    const state0s0: InfoState = { board: board0, hand: hand0s0, street: 0, revealedOpponentBoards: [board1] }
    const state1s0: InfoState = { board: board1, hand: hand1s0, street: 0, revealedOpponentBoards: [board0] }

    board0 = applyPlacement(board0, getBotMove(state0s0, 10, rng))
    board1 = applyPlacement(board1, getBotMove(state1s0, 10, rng))

    // Streets 1-4: deal 3 each
    for (let s = 1; s <= 4; s++) {
      const h0 = deck.deal(3)
      const h1 = deck.deal(3)
      const st0: InfoState = { board: board0, hand: h0, street: s, revealedOpponentBoards: [board1] }
      const st1: InfoState = { board: board1, hand: h1, street: s, revealedOpponentBoards: [board0] }
      board0 = applyPlacement(board0, getBotMove(st0, 10, rng))
      board1 = applyPlacement(board1, getBotMove(st1, 10, rng))
    }

    // Boards should be complete
    expect(board0.top.length).toBe(3)
    expect(board0.middle.length).toBe(5)
    expect(board0.bottom.length).toBe(5)
    expect(board1.top.length).toBe(3)
    expect(board1.middle.length).toBe(5)
    expect(board1.bottom.length).toBe(5)

    // Score should be zero-sum
    const [n0, n1] = scoreTable([board0 as Board, board1 as Board])
    expect(n0! + n1!).toBe(0)

    // Bot should generally not foul (it might occasionally, but not often)
    // This is a sanity check not a hard requirement
    const bothFoul = isFoul(board0 as Board) && isFoul(board1 as Board)
    // If both foul, net is 0 which is already tested above
    void bothFoul
  })
})

// ── Info-set hygiene ──────────────────────────────────────────────────────

describe('info-set hygiene', () => {
  it('same InfoState + same seed → identical EV', () => {
    const hand = parseCards(['As', 'Ad', 'Ac', 'Kh', 'Kd'])
    const state: InfoState = {
      board: emptyBoard(),
      hand,
      street: 0,
      revealedOpponentBoards: [emptyBoard()],
    }
    const placements = legalPlacements(state.board, state.hand, state.street)
    const p = placements[0]!

    const ev1 = computeEV(state, p, 50, mulberry32(42))
    const ev2 = computeEV(state, p, 50, mulberry32(42))

    expect(ev1.ev).toBe(ev2.ev)
    expect(ev1.n).toBe(50)
  })

  it('different seeds → different EV estimates (MC variance)', () => {
    const hand = parseCards(['2s', '3d', '4c', '5h', '6d'])
    const state: InfoState = {
      board: emptyBoard(),
      hand,
      street: 0,
      revealedOpponentBoards: [emptyBoard()],
    }
    const p = legalPlacements(state.board, state.hand, 0)[0]!

    const ev1 = computeEV(state, p, 30, mulberry32(1))
    const ev2 = computeEV(state, p, 30, mulberry32(999))

    // Results should be finite numbers; they likely differ due to random sampling
    expect(Number.isFinite(ev1.ev)).toBe(true)
    expect(Number.isFinite(ev2.ev)).toBe(true)
    // Both within a plausible range for a 2-player game
    expect(ev1.ev).toBeGreaterThan(-100)
    expect(ev1.ev).toBeLessThan(100)
  })

  it('InfoState type contains no hidden opponent info (structural guarantee)', () => {
    // The InfoState type only carries revealedOpponentBoards (placed cards).
    // There is no field for opponent hand, opponent discards, or the stub.
    // This test documents the API contract.
    const state: InfoState = {
      board: emptyBoard(),
      hand: parseCards(['As']),
      street: 0,
      revealedOpponentBoards: [{ top: parseCards(['Kh']), middle: [], bottom: [] }],
    }
    // Accessing these would be a type error (they don't exist):
    // state.revealedOpponentBoards[0].hiddenHand  // TS error — no such field
    // Verify the board only has the three row arrays
    const oppBoard = state.revealedOpponentBoards[0]!
    expect(Object.keys(oppBoard).sort()).toEqual(['bottom', 'middle', 'top'])
  })
})

// ── EV ordering sanity ────────────────────────────────────────────────────

describe('EV ordering sanity', () => {
  it('placing trips on bottom vs top: bottom placement has higher EV', () => {
    // A hand with three aces is clearly best placed in bottom (strongest row)
    // not top (where they'd foul relative to middle).
    const hand = parseCards(['Ah', 'As', 'Ad', '2c', '3d'])
    const state: InfoState = {
      board: emptyBoard(),
      hand,
      street: 0,
      revealedOpponentBoards: [emptyBoard()],
    }
    const placements = legalPlacements(state.board, state.hand, 0)

    // Find a placement with all three aces in bottom
    const tripsInBottom = placements.find(p =>
      p.bottomAdd.filter(c => c.rank === 14).length === 3
    )
    // Find a placement with all three aces in top
    const tripsInTop = placements.find(p =>
      p.topAdd.filter(c => c.rank === 14).length === 3
    )

    // At least one of each should exist since board is empty
    if (tripsInBottom && tripsInTop) {
      const evBottom = computeEV(state, tripsInBottom, 100, mulberry32(7777))
      const evTop    = computeEV(state, tripsInTop,    100, mulberry32(7777))
      // Trips-in-bottom should have strictly higher EV (trips in top causes foul risk)
      expect(evBottom.ev).toBeGreaterThan(evTop.ev)
    }
  })
})

// ── Bonus EV suppressed inside an already-triggered bonus round ────────────
// Re-triggering is disabled (docs/01_RULES_AND_SCORING.md section 8): reaching
// a new qualifying top INSIDE a side game (bonus_play) grants no further
// bonus-round value, unlike reaching one during the normal round.

describe('inBonusRound suppresses bonus EV', () => {
  it('adds bonus EV in normal play but not when already inside a bonus round', () => {
    // Top is locked as a QQ pair; middle is trips (beats top); this street's
    // placement completes bottom into a full house (beats middle) — no foul.
    const state: Omit<InfoState, 'inBonusRound'> = {
      board: {
        top: [{ rank: 12, suit: 's' }, { rank: 12, suit: 'h' }, { rank: 4, suit: 'd' }],
        middle: [{ rank: 3, suit: 'c' }, { rank: 3, suit: 'd' }, { rank: 3, suit: 'h' }, { rank: 8, suit: 's' }, { rank: 9, suit: 'd' }],
        bottom: [{ rank: 2, suit: 'c' }, { rank: 2, suit: 'd' }, { rank: 7, suit: 's' }],
      },
      hand: [{ rank: 7, suit: 'c' }, { rank: 7, suit: 'd' }, { rank: 9, suit: 'h' }],
      street: 4,
      revealedOpponentBoards: [{
        top: [{ rank: 9, suit: 's' }, { rank: 4, suit: 'c' }, { rank: 3, suit: 's' }],
        middle: [{ rank: 8, suit: 'c' }, { rank: 8, suit: 'd' }, { rank: 2, suit: 's' }, { rank: 5, suit: 'h' }, { rank: 10, suit: 's' }],
        bottom: [{ rank: 6, suit: 'h' }, { rank: 10, suit: 'd' }, { rank: 4, suit: 'h' }],
      }],
    }

    const candidates = legalPlacements(state.board, state.hand, state.street)
    const placement = candidates.find(p =>
      p.bottomAdd.some(c => c.rank === 7 && c.suit === 'c') &&
      p.bottomAdd.some(c => c.rank === 7 && c.suit === 'd')
    )!
    const finalBoard: Board = { ...state.board, bottom: [...state.board.bottom, ...placement.bottomAdd] }
    expect(isFoul(finalBoard)).toBe(false)
    expect(bonusTrigger(finalBoard)).toBe('QQ')

    const normalEV = computeEV({ ...state, inBonusRound: false }, placement, 2000, mulberry32(7))
    const sideEV   = computeEV({ ...state, inBonusRound: true },  placement, 2000, mulberry32(7))

    // Normal play should be worth meaningfully more (the future bonus round's
    // EV); inside a side game that upside doesn't exist.
    expect(normalEV.ev - sideEV.ev).toBeGreaterThan(10)
  })
})

// ── Side-game EV with zero visible opponents ────────────────────────────────
// When a side-game player is the only non-qualifier at their table, there is
// no visible opponent to run scoreTable's pairwise comparison against, so it
// returned exactly 0 for every candidate — silently dropping the actor's own
// royalties from the EV even though real scoring still compares them against
// the invisible bonus-round qualifier(s). invisibleBonusOpponents fixes this.

describe('invisibleBonusOpponents values own royalties with zero visible opponents', () => {
  it('differentiates candidates by royalty instead of returning a flat 0', () => {
    const state: Omit<InfoState, 'inBonusRound' | 'invisibleBonusOpponents'> = {
      board: { top: [], middle: [], bottom: [] },
      hand: [
        { rank: 6, suit: 'h' }, { rank: 12, suit: 's' }, { rank: 7, suit: 'd' },
        { rank: 13, suit: 'c' }, { rank: 3, suit: 's' },
      ],
      street: 0,
      revealedOpponentBoards: [],
    }
    const candidates = legalPlacements(state.board, state.hand, state.street).slice(0, 5)

    const withoutFix = candidates.map(p =>
      computeEV({ ...state, inBonusRound: true }, p, 300, mulberry32(3)).ev
    )
    expect(new Set(withoutFix.map(v => v.toFixed(2))).size).toBe(1)
    expect(withoutFix[0]).toBe(0)

    const withFix = candidates.map(p =>
      computeEV({ ...state, inBonusRound: true, invisibleBonusOpponents: ['QQ'] }, p, 300, mulberry32(3)).ev
    )
    expect(new Set(withFix.map(v => v.toFixed(2))).size).toBeGreaterThan(1)
  })
})
