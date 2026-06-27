// Parse pokker6 JSON export into engine-compatible structures for EV analysis.
// Only handles 'normal_play' and 'bonus_play' move types — 'bonus_submit' is
// one-shot and used only as the revealed opponent board for side-game decisions.

import type { Card, Rank, Suit, PartialBoard } from '../engine/types'
import type { InfoState } from '../engine/mc'
import type { Placement } from '../engine/placement'

// ── Pokker6 raw types ────────────────────────────────────────────────────────

export interface P6Card { rank: string; suit: string }

export interface P6Move {
  id: string
  uid: string
  segment: 'normal_play' | 'bonus_play' | 'bonus_submit'
  hand: P6Card[]
  // normal_play / bonus_play
  placements?: Array<{ row: string; card: P6Card }>
  discard?: P6Card
  turn?: number
  // bonus_submit (one-shot full board)
  top?: P6Card[]
  middle?: P6Card[]
  bottom?: P6Card[]
  discards?: P6Card[]
}

export interface P6NormalBreakdown {
  uid: string
  username: string
  fouled: boolean
  royalties: number
  totalNet: number
  handSummary: string
}

export interface P6ChinesePoker {
  moves: P6Move[]
  normalBreakdown: P6NormalBreakdown[] | null
  boards: Record<string, { top: P6Card[]; middle: P6Card[]; bottom: P6Card[] }> | null
  bonusEligibleUids: string[]
}

export interface P6Player {
  uid: string
  username: string
  status: 'active' | 'bust' | string
}

export interface P6Result {
  uid: string
  username: string
  hand: P6Card[]
  isWinner: boolean
  cpGamePoints: number
}

export interface P6Game {
  gameId: string
  createdAt: string
  players: P6Player[]
  results: P6Result[]
  chinesePoker: P6ChinesePoker
}

export interface P6Export {
  exportedAt?: string
  totalGames?: number
  games: P6Game[]
}

// ── Analysis types ───────────────────────────────────────────────────────────

export interface DecisionPoint {
  id: string
  gameId: string
  gameTime: string
  username: string
  uid: string
  segment: 'normal_play' | 'bonus_play'
  street: number
  infoState: InfoState
  actualPlacement: Placement
}

export interface GameSummary {
  gameId: string
  gameTime: string
  p1Points: number
  p2Points: number
  p1Bust: boolean
  p2Bust: boolean
  p1Run: number
  p2Run: number
  normalBreakdown: P6NormalBreakdown[] | null
}

// ── Card conversion ──────────────────────────────────────────────────────────

const RANK_MAP: Record<string, Rank> = {
  A: 14, K: 13, Q: 12, J: 11, '10': 10,
  '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2,
}
const SUIT_MAP: Record<string, Suit> = {
  spades: 's', hearts: 'h', diamonds: 'd', clubs: 'c',
  s: 's', h: 'h', d: 'd', c: 'c',
}

function toCard(p6: P6Card): Card {
  const rank = RANK_MAP[p6.rank]
  const suit = SUIT_MAP[p6.suit]
  if (!rank || !suit) throw new Error(`Unknown card: ${p6.rank}${p6.suit}`)
  return { rank, suit }
}

function toPartialBoard(raw: { top: P6Card[]; middle: P6Card[]; bottom: P6Card[] }): PartialBoard {
  return {
    top: raw.top.map(toCard),
    middle: raw.middle.map(toCard),
    bottom: raw.bottom.map(toCard),
  }
}

// Build actor's PartialBoard by applying all their moves before `upToTurn`.
function boardBeforeTurn(moves: P6Move[], upToTurn: number): PartialBoard {
  const top: Card[] = []
  const middle: Card[] = []
  const bottom: Card[] = []
  for (const m of moves) {
    if ((m.turn ?? 0) >= upToTurn) continue
    if (!m.placements) continue
    for (const p of m.placements) {
      const c = toCard(p.card)
      if (p.row === 'top') top.push(c)
      else if (p.row === 'middle') middle.push(c)
      else bottom.push(c)
    }
  }
  return { top, middle, bottom }
}

// Build the Placement object from a raw move.
function toPlacement(m: P6Move): Placement {
  const topAdd: Card[] = []
  const middleAdd: Card[] = []
  const bottomAdd: Card[] = []
  if (m.placements) {
    for (const p of m.placements) {
      const c = toCard(p.card)
      if (p.row === 'top') topAdd.push(c)
      else if (p.row === 'middle') middleAdd.push(c)
      else bottomAdd.push(c)
    }
  }
  return { topAdd, middleAdd, bottomAdd, discard: m.discard ? toCard(m.discard) : null }
}

// Parse one player's sequence of moves into DecisionPoints.
// getOppBoard(turn) returns the revealed opponent board at the start of that turn.
function parseMovesToDecisions(
  gameId: string,
  gameTime: string,
  username: string,
  uid: string,
  segment: 'normal_play' | 'bonus_play',
  moves: P6Move[],
  getOppBoard: (turn: number) => PartialBoard | null,
): DecisionPoint[] {
  const sorted = [...moves].sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
  const decisions: DecisionPoint[] = []
  const priorDiscards: Card[] = []

  for (const m of sorted) {
    const turn = m.turn ?? 0
    if (!m.placements) continue

    const board = boardBeforeTurn(sorted, turn)
    const hand = m.hand.map(toCard)
    const actualPlacement = toPlacement(m)
    const oppBoard = getOppBoard(turn)

    decisions.push({
      id: `${gameId}:${uid}:${segment}:${turn}`,
      gameId,
      gameTime,
      username,
      uid,
      segment,
      street: turn,
      infoState: {
        board,
        hand,
        street: turn,
        revealedOpponentBoards: oppBoard ? [oppBoard] : [],
        discards: [...priorDiscards],
      },
      actualPlacement,
    })

    if (m.discard) priorDiscards.push(toCard(m.discard))
  }

  return decisions
}

// ── Main entry point ─────────────────────────────────────────────────────────

export function parseSessionGames(
  games: P6Game[],
  player1: string,
  player2: string,
): { decisions: DecisionPoint[]; summaries: GameSummary[] } {
  const filtered = games
    .filter(g => {
      const names = new Set(g.players.map(p => p.username))
      return names.has(player1) && names.has(player2)
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const decisions: DecisionPoint[] = []
  const summaries: GameSummary[] = []
  let p1Run = 0
  let p2Run = 0

  for (const game of filtered) {
    const p1Player = game.players.find(p => p.username === player1)
    const p2Player = game.players.find(p => p.username === player2)
    const p1Result = game.results.find(r => r.username === player1)
    const p2Result = game.results.find(r => r.username === player2)
    if (!p1Player || !p2Player || !p1Result || !p2Result) continue

    const uid1 = p1Player.uid
    const uid2 = p2Player.uid

    p1Run += p1Result.cpGamePoints
    p2Run += p2Result.cpGamePoints

    const cp = game.chinesePoker

    summaries.push({
      gameId: game.gameId,
      gameTime: game.createdAt,
      p1Points: p1Result.cpGamePoints,
      p2Points: p2Result.cpGamePoints,
      p1Bust: p1Player.status === 'bust',
      p2Bust: p2Player.status === 'bust',
      p1Run,
      p2Run,
      normalBreakdown: cp?.normalBreakdown ?? null,
    })

    // Skip games without move data (older export format)
    const moves = cp?.moves
    if (!Array.isArray(moves) || moves.length === 0) continue

    // ── Normal game ────────────────────────────────────────────────────────
    const p1Normal = moves.filter(m => m.uid === uid1 && m.segment === 'normal_play' && m.placements)
    const p2Normal = moves.filter(m => m.uid === uid2 && m.segment === 'normal_play' && m.placements)

    decisions.push(
      ...parseMovesToDecisions(game.gameId, game.createdAt, player1, uid1, 'normal_play',
        p1Normal, (t) => boardBeforeTurn(p2Normal, t)),
      ...parseMovesToDecisions(game.gameId, game.createdAt, player2, uid2, 'normal_play',
        p2Normal, (t) => boardBeforeTurn(p1Normal, t)),
    )

    // ── Bonus / side game ──────────────────────────────────────────────────
    const p1BonusPlay = moves.filter(m => m.uid === uid1 && m.segment === 'bonus_play' && m.placements)
    const p2BonusPlay = moves.filter(m => m.uid === uid2 && m.segment === 'bonus_play' && m.placements)
    const p1Submit = moves.find(m => m.uid === uid1 && m.segment === 'bonus_submit')
    const p2Submit = moves.find(m => m.uid === uid2 && m.segment === 'bonus_submit')

    // p1 played side game (bonus_play) against p2's fixed bonus board
    if (p1BonusPlay.length > 0 && p2Submit) {
      const oppBoard = toPartialBoard({
        top: p2Submit.top ?? [],
        middle: p2Submit.middle ?? [],
        bottom: p2Submit.bottom ?? [],
      })
      decisions.push(
        ...parseMovesToDecisions(game.gameId, game.createdAt, player1, uid1, 'bonus_play',
          p1BonusPlay, () => oppBoard),
      )
    }

    // p2 played side game against p1's fixed bonus board
    if (p2BonusPlay.length > 0 && p1Submit) {
      const oppBoard = toPartialBoard({
        top: p1Submit.top ?? [],
        middle: p1Submit.middle ?? [],
        bottom: p1Submit.bottom ?? [],
      })
      decisions.push(
        ...parseMovesToDecisions(game.gameId, game.createdAt, player2, uid2, 'bonus_play',
          p2BonusPlay, () => oppBoard),
      )
    }
  }

  return { decisions, summaries }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function detectPlayerPairs(games: P6Game[]): Array<{ p1: string; p2: string; count: number }> {
  const counts = new Map<string, number>()
  for (const g of games) {
    if (g.players.length === 2) {
      const [a, b] = g.players.map(p => p.username).sort()
      const key = `${a}|${b}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [p1, p2] = key.split('|') as [string, string]
      return { p1, p2, count }
    })
    .sort((a, b) => b.count - a.count)
}

// Check if a candidate placement matches what was actually played (set comparison).
export function matchesActual(candidate: Placement, played: Placement): boolean {
  const sameSet = (a: readonly Card[], b: readonly Card[]) => {
    if (a.length !== b.length) return false
    const keys = new Set(b.map(c => `${c.rank}${c.suit}`))
    return a.every(c => keys.has(`${c.rank}${c.suit}`))
  }
  const sameDiscard = (a: Card | null, b: Card | null) =>
    a === null ? b === null : b !== null && a.rank === b.rank && a.suit === b.suit
  return (
    sameSet(candidate.topAdd, played.topAdd) &&
    sameSet(candidate.middleAdd, played.middleAdd) &&
    sameSet(candidate.bottomAdd, played.bottomAdd) &&
    sameDiscard(candidate.discard, played.discard)
  )
}
