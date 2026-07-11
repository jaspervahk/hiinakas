// Shared types for computed session-analysis results — used both by the live
// analysis pipeline (SessionTab.tsx) and by Firestore persistence
// (firestore/sessionAnalysis.ts). A ReviewDecision is deliberately flat and
// self-contained (board + hand, not a full InfoState) since no display
// component needs revealedOpponentBoards/discards after analysis is done —
// this lets freshly-computed and reopened-from-Firestore decisions share one
// shape with no adapter branching anywhere downstream.

import type { Card, PartialBoard, Board } from '../engine/types'
import type { Placement } from '../engine/placement'
import type { GameSummary } from './sessionParser'
import type { BotPolicy } from '../worker/client'

export interface ReviewDecision {
  id: string
  gameId: string
  gameTime: string
  username: string
  uid: string
  segment: 'normal_play' | 'bonus_play'
  street: number
  board: PartialBoard
  hand: readonly Card[]
  actualPlacement: Placement
  bestPlacement: Placement
  playedEV: number
  bestEV: number
  evLost: number
  topCandidates: Array<{ placement: Placement; ev: number }>
}

export interface PersistedBonusDecision {
  id: string
  gameId: string
  gameTime: string
  username: string
  uid: string
  numDiscard: number
  cards: Card[]
  actualBoard: Board
  bestBoard: Board
  bestRoyalties: number
  actualRoyalties: number
  actualFoul: boolean
  evLost: number
}

export interface SavedAnalysisMeta {
  id: string
  schemaVersion: 1
  name: string
  createdAt: number            // epoch ms (Timestamp.toMillis() on read)
  playerNames: string[]
  gameCount: number
  decisionCount: number
  bonusDecisionCount: number
  dateRangeStart: string
  dateRangeEnd: string
  analysisMode: BotPolicy
  sims: number
  rootTopK: number
  decisionChunkCount: number
  bonusChunkCount: number
  summaries: GameSummary[]
}
