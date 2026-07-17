// Pure builder: turns the same HandReplayData already used by the local
// Replay feature (see replayBuilder.ts) into the flat per-hand payload shape
// Hiinakas's createHuubReplayChallenge Cloud Function expects. No Firebase
// imports — the function boundary (firestore/huubBridge.ts) owns the network
// call, this module only owns the data shape translation.

import type { Card } from '../engine/index'
import type { Placement } from '../engine/index'
import type { ReplayConfig } from './types'
import type { HandReplayData } from './replayBuilder'
import type { GameSummary } from './sessionParser'

export interface ChallengeHandInput {
  gameId: string
  playerCount: 2 | 3
  historicalTotal: number
  opponentNames: string[]                         // parallel to opponentNormalPlacements/opponentBonusOutcomes
  targetNormalHands: Card[][]                      // [street 0-4]
  opponentNormalPlacements: Placement[][]          // [opponent][street 0-4]
  opponentBonusOutcomes: ReplayConfig['opponentBonusOutcomes']
  humanBonusReplay: ReplayConfig['humanBonusReplay']
}

export function buildChallengeHandInput(
  gameId: string,
  targetUsername: string,
  summaries: GameSummary[],
  handData: HandReplayData,
): ChallengeHandInput {
  const summary = summaries.find(s => s.gameId === gameId)
  if (!summary) throw new Error(`No summary found for game ${gameId}`)
  const opponentNames = summary.playerNames.filter(n => n !== targetUsername)
  return {
    gameId,
    playerCount: handData.playerCount,
    historicalTotal: handData.replay.historicalTotal,
    opponentNames,
    targetNormalHands: handData.preDealt[0]!,
    opponentNormalPlacements: handData.replay.opponentNormalPlacements,
    opponentBonusOutcomes: handData.replay.opponentBonusOutcomes,
    humanBonusReplay: handData.replay.humanBonusReplay,
  }
}
