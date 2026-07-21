// Builds the data needed to replay one historical hand: the target player's
// own per-street dealt cards (so they can make a genuinely new decision) plus
// every other seat's frozen historical placements (replayed verbatim, never
// recomputed). Pure and React-free — consumes the same ReviewDecision/
// BonusDecisionPoint/GameSummary shapes already produced by sessionParser.ts,
// so it works identically whether the session is freshly uploaded or reopened
// from a saved analysis.

import type { Card, Board, PartialBoard } from '../engine/index'
import type { Placement } from '../engine/index'
import { applyPlacement } from '../engine/index'
import type { ReviewDecision } from './sessionAnalysisTypes'
import type { BonusDecisionPoint, GameSummary } from './sessionParser'
import type { ReplayConfig } from './types'
import type { BonusQualifier } from '../engine/index'

export interface HandReplayData {
  playerCount: 2 | 3
  preDealt: Card[][][]   // [0] = target player's 5 normal-street hands; other seats unused (bots never deal, only replay placements)
  replay: ReplayConfig
  opponentNames: string[]   // same order as replay.opponentNormalPlacements/opponentBonusOutcomes
}

// The target's own actual historical placements — NOT used by the replay
// feature itself (the whole point of a replay is a genuinely new decision
// with the same cards), but needed by the Huub-challenge detail viewer to
// show "what I actually did originally" alongside the challenged player's
// real result. Same qualifies:true/false shape already used for opponents.
export interface TargetOwnHistory {
  normalPlacements: Placement[]   // [street 0-4], the target's own actual choices
  bonusOutcome:
    | { qualifies: true; board: Board }
    | { qualifies: false; placements: Placement[] }
    | null
}

export function buildTargetOwnHistory(
  gameId: string,
  targetUsername: string,
  streetDecisions: ReviewDecision[],
  bonusBoardDecisions: BonusDecisionPoint[],
): TargetOwnHistory {
  const gameStreetDecisions = streetDecisions.filter(d => d.gameId === gameId)
  const gameBonusBoards = bonusBoardDecisions.filter(d => d.gameId === gameId)
  const sortedByStreet = (decs: ReviewDecision[]) => [...decs].sort((a, b) => a.street - b.street)

  const targetNormal = sortedByStreet(
    gameStreetDecisions.filter(d => d.username === targetUsername && d.segment === 'normal_play'),
  )
  if (targetNormal.length !== 5) {
    throw new Error(
      `Expected 5 normal-round streets for ${targetUsername} in game ${gameId}, found ${targetNormal.length}`,
    )
  }
  const normalPlacements = targetNormal.map(d => d.actualPlacement)

  const targetBonusBoard = gameBonusBoards.find(d => d.username === targetUsername)
  let bonusOutcome: TargetOwnHistory['bonusOutcome'] = null
  if (targetBonusBoard) {
    bonusOutcome = { qualifies: true, board: targetBonusBoard.actualBoard }
  } else {
    const sideDecs = sortedByStreet(
      gameStreetDecisions.filter(d => d.username === targetUsername && d.segment === 'bonus_play'),
    )
    if (sideDecs.length > 0) {
      if (sideDecs.length !== 5) {
        throw new Error(
          `Expected 5 side-game streets for ${targetUsername} in game ${gameId}, found ${sideDecs.length}`,
        )
      }
      bonusOutcome = { qualifies: false, placements: sideDecs.map(d => d.actualPlacement) }
    }
  }

  return { normalPlacements, bonusOutcome }
}

// Folds a target's own actual historical placements into the boards they
// really ended up with — used to show "what I actually did" alongside a bot
// simulation's result. Mirrors the same fold used for a replayed opponent's
// frozen board (reducer.ts's foldPlacements), just exposed here for the
// target's own history instead.
export function foldPlacements(placements: readonly Placement[]): Board {
  let board: PartialBoard = { top: [], middle: [], bottom: [] }
  for (const p of placements) board = applyPlacement(board, p)
  return board as Board
}

// Resolves one opponent's frozen bonus-round outcome (as stored in
// ReplayConfig.opponentBonusOutcomes) into the actual board they ended up
// with — a one-shot bonus board is already a Board; a side-game outcome is
// folded from its per-street placements the same way as any other board.
export function resolveBonusOutcomeBoard(outcome: ReplayConfig['opponentBonusOutcomes'][number]): Board | null {
  if (!outcome) return null
  return outcome.qualifies ? outcome.board : foldPlacements(outcome.placements)
}

export function targetOwnFinalBoards(history: TargetOwnHistory): { board: Board; bonusBoard: Board | null } {
  const board = foldPlacements(history.normalPlacements)

  let bonusBoard: Board | null = null
  if (history.bonusOutcome) {
    bonusBoard = history.bonusOutcome.qualifies
      ? history.bonusOutcome.board
      : foldPlacements(history.bonusOutcome.placements)
  }

  return { board, bonusBoard }
}

const DISCARD_TO_TIER: Record<number, BonusQualifier> = { 0: 'QQ', 1: 'KK', 2: 'AA_OR_TRIPS' }

// Deterministic string hash — used only to seed the human's own bonus/side
// dealing when their new play diverges from history and there's no
// historical deal to replay. Doesn't need to be cryptographic, just stable.
function hashSeed(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

// Ordered list of gameIds where the target player participated, matching
// `summaries`' existing chronological order.
export function buildReplayQueue(summaries: GameSummary[], targetUsername: string): string[] {
  return summaries.filter(s => s.playerNames.includes(targetUsername)).map(s => s.gameId)
}

export function buildHandReplayData(
  gameId: string,
  targetUsername: string,
  streetDecisions: ReviewDecision[],
  bonusBoardDecisions: BonusDecisionPoint[],
  summaries: GameSummary[],
): HandReplayData {
  const summary = summaries.find(s => s.gameId === gameId)
  if (!summary) throw new Error(`No summary found for game ${gameId}`)
  const playerNames = summary.playerNames
  if (!playerNames.includes(targetUsername)) {
    throw new Error(`${targetUsername} did not play in game ${gameId}`)
  }
  const playerCount = playerNames.length as 2 | 3
  const opponentNames = playerNames.filter(n => n !== targetUsername)

  const gameStreetDecisions = streetDecisions.filter(d => d.gameId === gameId)
  const gameBonusBoards = bonusBoardDecisions.filter(d => d.gameId === gameId)

  const sortedByStreet = (decs: ReviewDecision[]) => [...decs].sort((a, b) => a.street - b.street)

  // Target player's normal-round per-street hands -> preDealt[0].
  const targetNormal = sortedByStreet(
    gameStreetDecisions.filter(d => d.username === targetUsername && d.segment === 'normal_play'),
  )
  if (targetNormal.length !== 5) {
    throw new Error(
      `Expected 5 normal-round streets for ${targetUsername} in game ${gameId}, found ${targetNormal.length}`,
    )
  }
  const targetNormalHands = targetNormal.map(d => [...d.hand])

  // Opponents' normal-round per-street actual placements — replayed verbatim,
  // never recomputed, regardless of what the target player does differently.
  const opponentNormalPlacements: Placement[][] = opponentNames.map(name => {
    const decs = sortedByStreet(
      gameStreetDecisions.filter(d => d.username === name && d.segment === 'normal_play'),
    )
    if (decs.length !== 5) {
      throw new Error(`Expected 5 normal-round streets for ${name} in game ${gameId}, found ${decs.length}`)
    }
    return decs.map(d => d.actualPlacement)
  })

  // Opponents' bonus/side outcome: one-shot board if they triggered the
  // bonus, else their side-game placements if they played one, else neither.
  const opponentBonusOutcomes: ReplayConfig['opponentBonusOutcomes'] = opponentNames.map(name => {
    const bonusBoard = gameBonusBoards.find(d => d.username === name)
    if (bonusBoard) return { qualifies: true, board: bonusBoard.actualBoard }

    const sideDecs = sortedByStreet(
      gameStreetDecisions.filter(d => d.username === name && d.segment === 'bonus_play'),
    )
    if (sideDecs.length === 0) return null
    if (sideDecs.length !== 5) {
      throw new Error(`Expected 5 side-game streets for ${name} in game ${gameId}, found ${sideDecs.length}`)
    }
    return { qualifies: false, placements: sideDecs.map(d => d.actualPlacement) }
  })

  // Target's own historical bonus outcome — only reusable if the replayed
  // hand reaches the same tier; the reducer falls back to a fresh
  // deterministic deal otherwise (see ReplayConfig.fallbackSeed).
  const targetBonusBoard = gameBonusBoards.find(d => d.username === targetUsername)
  const targetSideDecs = sortedByStreet(
    gameStreetDecisions.filter(d => d.username === targetUsername && d.segment === 'bonus_play'),
  )

  let humanBonusReplay: ReplayConfig['humanBonusReplay'] = null
  if (targetBonusBoard) {
    const tier = DISCARD_TO_TIER[targetBonusBoard.numDiscard]
    if (tier) humanBonusReplay = { tier, cards: [...targetBonusBoard.cards] }
  } else if (targetSideDecs.length > 0) {
    if (targetSideDecs.length !== 5) {
      throw new Error(
        `Expected 5 side-game streets for ${targetUsername} in game ${gameId}, found ${targetSideDecs.length}`,
      )
    }
    humanBonusReplay = { tier: null, sideHands: targetSideDecs.map(d => [...d.hand]) }
  }

  // Only the target seat (index 0) needs real dealt hands — bots are always
  // driven by frozen placements, never by dealing, so their preDealt slots
  // are simply unused.
  const preDealt: Card[][][] = [targetNormalHands, ...opponentNames.map(() => [])]

  const replay: ReplayConfig = {
    opponentNormalPlacements,
    opponentBonusOutcomes,
    humanBonusReplay,
    historicalTotal: summary.points[targetUsername] ?? 0,
    fallbackSeed: hashSeed(gameId),
  }

  return { playerCount, preDealt, replay, opponentNames }
}
