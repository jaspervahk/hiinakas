import type { Card, PartialBoard, BonusQualifier, ScoredPlacement } from '../engine/index'

export type GamePhase =
  | 'setup'
  | 'placing'         // human placing (normal street OR side-game street)
  | 'revealing'       // post-lock: all boards shown, awaiting advance
  | 'scoring'         // normal-round score display
  | 'bonus_oneshot'   // human qualifies: place all bonus cards at once
  | 'bonus_scoring'   // bonus totals display

// 'normal' = regular game streets; 'side' = bonus-round side game
export type GameContext = 'normal' | 'side'

export interface PendingRows {
  top: Card[]
  middle: Card[]
  bottom: Card[]
}

export function emptyPending(): PendingRows {
  return { top: [], middle: [], bottom: [] }
}

export function emptyBoard(): PartialBoard {
  return { top: [], middle: [], bottom: [] }
}

export interface GameState {
  phase: GamePhase
  context: GameContext
  playerCount: 2 | 3
  seed: number

  // ── Normal round ─────────────────────────────────────────────────────────
  preDealt: Card[][][]  // [playerIdx][streetIdx] = Card[]
  street: number        // 0-4

  humanBoard: PartialBoard
  botBoards: PartialBoard[]  // length = playerCount - 1

  // ── Human placement (shared across normal/side/bonus_oneshot) ─────────────
  humanHand: Card[]         // unassigned cards
  pending: PendingRows      // tentatively assigned
  selectedCard: Card | null

  // ── After normal round ────────────────────────────────────────────────────
  normalScores: number[]    // [humanNet, bot0Net, bot1Net?]

  // ── Bonus round setup ─────────────────────────────────────────────────────
  humanBonusQualifier: BonusQualifier | null
  botBonusQualifiers: (BonusQualifier | null)[]

  // Cards dealt for bonus (for qualifiers); empty [] for non-qualifiers
  humanBonusCards: Card[]
  botBonusCards: Card[][]   // [botIdx]

  // Final boards from bonus round
  humanBonusBoard: PartialBoard      // built via oneshot or side game
  botBonusBoards: PartialBoard[]

  // ── Side game (non-qualifying players play 5-street side game) ────────────
  sidePreDealt: Card[][][]   // [playerIdx][streetIdx]
  sideStreet: number         // 0-4
  humanSideBoard: PartialBoard
  botSideBoards: PartialBoard[]

  // ── Final scores ──────────────────────────────────────────────────────────
  bonusScores: number[]
  totalScores: number[]

  // ── P4 additions ─────────────────────────────────────────────────────────
  currentStreetLogs: StreetLog[]   // accumulates during a hand
  appSettings: AppSettings
}

export interface StreetLog {
  street: number
  context: GameContext
  dealt: Card[]
  topAdd: Card[]
  middleAdd: Card[]
  bottomAdd: Card[]
  discard: Card | null
  evList: ScoredPlacement[]
  chosenEV: number
  bestEV: number
  evGap: number                    // bestEV - chosenEV
}

export interface HandLog {
  id: string
  timestamp: number
  seed: number
  playerCount: 2 | 3
  streets: StreetLog[]
  normalScores: number[]
  bonusScores: number[]
  totalScores: number[]
  humanFouled: boolean
  humanRoyalties: number
  cumEvLoss: number
}

export type Difficulty = 'easy' | 'medium' | 'hard'

export interface AppSettings {
  coachEnabled: boolean
  playerCount: 2 | 3
  difficulty: Difficulty
}
