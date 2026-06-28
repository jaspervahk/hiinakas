// Parse pokker6 JSON export into engine-compatible structures for EV analysis.
// Supports 2- and 3-player games. 'bonus_submit' is used only as the revealed
// opponent board for side-game decisions, never analysed directly.

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
  playerNames: string[]              // ordered list matching the group
  points: Record<string, number>     // cpGamePoints per player this hand
  busts: Record<string, boolean>     // fouled? per player
  runs: Record<string, number>       // cumulative running totals
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
// getOppBoards(turn) returns all revealed opponent boards at the start of that turn.
function parseMovesToDecisions(
  gameId: string,
  gameTime: string,
  username: string,
  uid: string,
  segment: 'normal_play' | 'bonus_play',
  moves: P6Move[],
  getOppBoards: (turn: number) => PartialBoard[],
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
    const oppBoards = getOppBoards(turn)

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
        revealedOpponentBoards: oppBoards,
        discards: [...priorDiscards],
      },
      actualPlacement,
    })

    if (m.discard) priorDiscards.push(toCard(m.discard))
  }

  return decisions
}

// ── Main entry point ─────────────────────────────────────────────────────────

// Accepts one or more exact player groups. A game is included only if its
// player set exactly matches one of the provided groups. Running totals are
// tracked per player across the union of all groups; each game's summary
// records `playerNames` as the actual players in that specific game so callers
// can distinguish per-game participation from the combined player list.
export function parseSessionGames(
  games: P6Game[],
  playerGroups: string[][],
): { decisions: DecisionPoint[]; summaries: GameSummary[]; allPlayers: string[] } {
  if (playerGroups.length === 0 || playerGroups.every(g => g.length < 2)) {
    return { decisions: [], summaries: [], allPlayers: [] }
  }

  // Build an exact-match key for each group.
  const groupKeyMap = new Map<string, string[]>()
  for (const group of playerGroups) {
    const key = [...group].sort().join('|')
    groupKeyMap.set(key, group)
  }

  const allPlayers = [...new Set(playerGroups.flat())].sort()

  const filtered = games
    .filter(g => {
      const gameKey = g.players.map(p => p.username).sort().join('|')
      return groupKeyMap.has(gameKey)
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const decisions: DecisionPoint[] = []
  const summaries: GameSummary[] = []
  const runs: Record<string, number> = {}
  for (const n of allPlayers) runs[n] = 0

  for (const game of filtered) {
    const gameKey = game.players.map(p => p.username).sort().join('|')
    const activeGroup = groupKeyMap.get(gameKey)!

    // Gather uid + result for every player in this game's exact group.
    const playerData = new Map<string, { uid: string; points: number; bust: boolean }>()
    let skip = false
    for (const pname of activeGroup) {
      const player = game.players.find(p => p.username === pname)
      const result = game.results.find(r => r.username === pname)
      if (!player || !result) { skip = true; break }
      playerData.set(pname, {
        uid: player.uid,
        points: result.cpGamePoints,
        bust: player.status === 'bust',
      })
    }
    if (skip) continue

    // Update running totals for players in this game only.
    const points: Record<string, number> = {}
    const busts: Record<string, boolean> = {}
    for (const [pname, data] of playerData) {
      runs[pname] = (runs[pname] ?? 0) + data.points
      points[pname] = data.points
      busts[pname] = data.bust
    }

    const cp = game.chinesePoker
    summaries.push({
      gameId: game.gameId,
      gameTime: game.createdAt,
      playerNames: activeGroup,   // actual players in THIS game (not the union)
      points,
      busts,
      runs: { ...runs },
      normalBreakdown: cp?.normalBreakdown ?? null,
    })

    // Skip games without move data
    const moves = cp?.moves
    if (!Array.isArray(moves) || moves.length === 0) continue

    // Collect normal_play moves per player
    const normalMoves = new Map<string, P6Move[]>()
    for (const [pname, data] of playerData) {
      normalMoves.set(
        pname,
        moves.filter(m => m.uid === data.uid && m.segment === 'normal_play' && m.placements),
      )
    }

    // Parse normal game decisions — each player sees all opponents' revealed boards
    for (const [pname, data] of playerData) {
      const pMoves = normalMoves.get(pname) ?? []
      const oppNames = activeGroup.filter(n => n !== pname)
      decisions.push(
        ...parseMovesToDecisions(
          game.gameId, game.createdAt, pname, data.uid, 'normal_play',
          pMoves,
          (t) => oppNames.map(n => boardBeforeTurn(normalMoves.get(n) ?? [], t)),
        )
      )
    }

    // Bonus / side-game — analyse bonus_play decisions for any player
    // Each bonus_play player faces each opponent's bonus_submit board.
    for (const [pname, data] of playerData) {
      const bonusPlay = moves.filter(
        m => m.uid === data.uid && m.segment === 'bonus_play' && m.placements,
      )
      if (bonusPlay.length === 0) continue

      // Collect all opponent submitted boards
      const oppBoards: PartialBoard[] = []
      for (const [oppName, oppData] of playerData) {
        if (oppName === pname) continue
        const sub = moves.find(m => m.uid === oppData.uid && m.segment === 'bonus_submit')
        if (sub) {
          oppBoards.push(toPartialBoard({
            top: sub.top ?? [],
            middle: sub.middle ?? [],
            bottom: sub.bottom ?? [],
          }))
        }
      }
      if (oppBoards.length === 0) continue

      decisions.push(
        ...parseMovesToDecisions(
          game.gameId, game.createdAt, pname, data.uid, 'bonus_play',
          bonusPlay,
          () => oppBoards,
        )
      )
    }
  }

  return { decisions, summaries, allPlayers }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Detect all player groups (2–4 players) that appear together, sorted by frequency.
export function detectPlayerGroups(
  games: P6Game[],
): Array<{ players: string[]; count: number }> {
  const counts = new Map<string, number>()
  for (const g of games) {
    if (g.players.length < 2) continue
    const sorted = g.players.map(p => p.username).sort()
    const key = sorted.join('|')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ players: key.split('|'), count }))
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
