import { describe, it, expect } from 'vitest'
import { computeSessionStats, parseSessionGames, type GameSummary, type P6Game, type P6Card } from '../sessionParser'

function card(rank: string, suit: string): P6Card { return { rank, suit } }

// A 2-player game where A triggers the bonus (QQ+ on top, non-fouled normal
// round) and B plays the side game. `bonusEligibleUids` is deliberately wrong
// (empty) to simulate the raw export field's unreliable semantics — the
// parser must still correctly classify roles from each move's own segment tag.
function buildBonusGame(bonusEligibleUids: string[]): P6Game {
  const aNormalPlacements = [
    { row: 'top', card: card('Q', 's') },
    { row: 'top', card: card('Q', 'h') },
    { row: 'top', card: card('2', 'c') },
    { row: 'middle', card: card('3', 'c') },
    { row: 'middle', card: card('3', 'd') },
    { row: 'middle', card: card('3', 'h') },
    { row: 'middle', card: card('9', 's') },
    { row: 'middle', card: card('8', 'h') },
    { row: 'bottom', card: card('5', 'd') },
    { row: 'bottom', card: card('6', 'h') },
    { row: 'bottom', card: card('7', 's') },
    { row: 'bottom', card: card('8', 'd') },
    { row: 'bottom', card: card('9', 'c') },
  ]
  const bNormalPlacements = [
    { row: 'top', card: card('4', 'c') },
    { row: 'top', card: card('5', 'c') },
    { row: 'top', card: card('6', 'd') },
    { row: 'middle', card: card('7', 'd') },
    { row: 'middle', card: card('8', 's') },
    { row: 'middle', card: card('9', 'd') },
    { row: 'middle', card: card('10', 'd') },
    { row: 'middle', card: card('J', 'd') },
    { row: 'bottom', card: card('2', 'h') },
    { row: 'bottom', card: card('3', 'h') },
    { row: 'bottom', card: card('4', 'h') },
    { row: 'bottom', card: card('5', 'h') },
    { row: 'bottom', card: card('6', 'c') },
  ]

  return {
    gameId: 'g1',
    createdAt: '2026-01-01T00:00:00.000Z',
    players: [
      { uid: 'ua', username: 'A', status: 'active' },
      { uid: 'ub', username: 'B', status: 'active' },
    ],
    results: [
      { uid: 'ua', username: 'A', hand: [], isWinner: true, cpGamePoints: 5 },
      { uid: 'ub', username: 'B', hand: [], isWinner: false, cpGamePoints: -5 },
    ],
    chinesePoker: {
      normalBreakdown: null,
      boards: null,
      bonusEligibleUids,
      moves: [
        { id: 'a-normal', uid: 'ua', segment: 'normal_play', hand: [], placements: aNormalPlacements, turn: 0 },
        { id: 'b-normal', uid: 'ub', segment: 'normal_play', hand: [], placements: bNormalPlacements, turn: 0 },
        {
          id: 'a-submit', uid: 'ua', segment: 'bonus_submit', hand: [],
          top: [card('A', 's'), card('A', 'h'), card('A', 'd')],
          middle: [card('K', 's'), card('K', 'h'), card('2', 's'), card('3', 's'), card('4', 's')],
          bottom: [card('5', 's'), card('6', 's'), card('7', 'h'), card('8', 'c'), card('9', 'h')],
          discards: [],
        },
        {
          id: 'b-side-0', uid: 'ub', segment: 'bonus_play', hand: [],
          placements: [{ row: 'top', card: card('6', 'h') }, { row: 'middle', card: card('9', 's') }],
          turn: 0,
        },
      ],
    },
  }
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

describe('computeSessionStats', () => {
  it('does not count an all-bust hand as a tie', () => {
    const summaries = [
      summary({
        gameId: 'g1',
        playerNames: ['A', 'B'],
        points: { A: 0, B: 0 },
        busts: { A: true, B: true },
      }),
    ]
    const stats = computeSessionStats(summaries, ['A', 'B'])
    expect(stats.ties.A).toBe(0)
    expect(stats.ties.B).toBe(0)
    expect(stats.allBustHands).toBe(1)
  })

  it('only credits a tie to players who actually tied, not every participant', () => {
    const summaries = [
      summary({
        gameId: 'g1',
        playerNames: ['A', 'B', 'C'],
        points: { A: 5, B: 5, C: 1 },
        busts: { A: false, B: false, C: false },
      }),
    ]
    const stats = computeSessionStats(summaries, ['A', 'B', 'C'])
    expect(stats.ties.A).toBe(1)
    expect(stats.ties.B).toBe(1)
    expect(stats.ties.C).toBe(0)
  })

  it('does not count a hand toward a player who did not participate in it', () => {
    const summaries = [
      // A vs B tie, C sat this one out
      summary({
        gameId: 'g1',
        playerNames: ['A', 'B'],
        points: { A: 3, B: 3 },
        busts: { A: false, B: false },
      }),
      // A vs B vs C, no tie
      summary({
        gameId: 'g2',
        playerNames: ['A', 'B', 'C'],
        points: { A: 1, B: 2, C: 0 },
        busts: { A: false, B: false, C: false },
      }),
    ]
    const stats = computeSessionStats(summaries, ['A', 'B', 'C'])
    expect(stats.ties.A).toBe(1)
    expect(stats.ties.B).toBe(1)
    expect(stats.ties.C).toBe(0)
  })

  it('still counts wins normally when there is a single winner', () => {
    const summaries = [
      summary({
        gameId: 'g1',
        playerNames: ['A', 'B'],
        points: { A: 5, B: -5 },
        busts: { A: false, B: false },
      }),
    ]
    const stats = computeSessionStats(summaries, ['A', 'B'])
    expect(stats.wins.A).toBe(1)
    expect(stats.wins.B).toBe(0)
    expect(stats.ties.A).toBe(0)
    expect(stats.ties.B).toBe(0)
  })
})

describe('parseSessionGames — side-game role derivation', () => {
  it('populates invisibleBonusOpponents for the side-game player even when bonusEligibleUids is empty/wrong', () => {
    const game = buildBonusGame([])  // field missing/empty despite A having triggered bonus
    const { decisions } = parseSessionGames([game], [['A', 'B']])

    const bDecision = decisions.find(d => d.username === 'B' && d.segment === 'bonus_play')
    expect(bDecision).toBeDefined()
    expect(bDecision!.infoState.invisibleBonusOpponents).toEqual(['QQ'])
    expect(bDecision!.infoState.revealedOpponentBoards).toEqual([])
  })

  it('gives the same correct result even if bonusEligibleUids wrongly includes the side-game player too', () => {
    const game = buildBonusGame(['ua', 'ub'])  // field incorrectly includes B (the side-gamer) as well
    const { decisions } = parseSessionGames([game], [['A', 'B']])

    const bDecision = decisions.find(d => d.username === 'B' && d.segment === 'bonus_play')
    expect(bDecision).toBeDefined()
    expect(bDecision!.infoState.invisibleBonusOpponents).toEqual(['QQ'])
    expect(bDecision!.infoState.revealedOpponentBoards).toEqual([])
  })
})
