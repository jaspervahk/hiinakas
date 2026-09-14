// Types for bot-vs-bot arena match records.
// All values are plain/serializable so records can cross the worker boundary.

import type { Card, PartialBoard, Board, HandCategory, BonusQualifier } from './types'
import type { Placement } from './placement'

// A bot that can occupy either arena seat. `sims` means MCTS simulations for
// nn-mcts/royalty-mcts/royalty-nn, or rollout count for heuristic.
export type BotKind = 'nn-mcts' | 'royalty-mcts' | 'royalty-nn' | 'heuristic'

export interface BotSpec {
  kind: BotKind
  sims: number
  rootTopK?: number   // nn-mcts only
}

// One street's decision captured for replay.
export interface StreetSnap {
  hand: readonly Card[]
  placement: Placement
  boardAfter: PartialBoard
}

// Per-player record for one hand, covering normal + bonus/side game.
export interface PlayerMatchRecord {
  // Normal game
  streets: StreetSnap[]         // 5 streets
  finalBoard: Board
  foul: boolean
  royaltiesEarned: number       // from normal board (0 if foul)
  topRoyalty: number            // 0 if foul; 1-22 for scoring pairs/trips
  midRoyalty: number            // 0 if foul; 2/4/8/12/20/30/50
  botRoyalty: number            // 0 if foul; 2/4/6/10/15/25
  topCategory: HandCategory
  midCategory: HandCategory
  botCategory: HandCategory

  // Bonus game (this player triggered the bonus)
  bonusCards?: readonly Card[]
  bonusBoard?: Board
  bonusFoul?: boolean
  bonusRoyalties?: number       // royalties from bonus board (0 if foul)

  // Side game (opponent triggered the bonus, this player played a side game)
  sideStreets?: StreetSnap[]
  sideBoard?: Board
  sideFoul?: boolean
  sideRoyalties?: number
}

// One player's participation in a single bonus round: either a one-shot
// 13-15 card board, or the 5-street side game played by non-qualifiers.
export interface BonusRoundPlayerRecord {
  qualifier: BonusQualifier | null   // null = played the side game this round
  cards?: readonly Card[]            // dealt cards, when on a one-shot board
  streets?: StreetSnap[]             // per-street play, when in the side game
  board: Board
  foul: boolean
  royalties: number                  // 0 if foul
}

// One round of the bonus chain. Under CLASSIC_RULES there is at most one of
// these; with allowBonusRecursion a qualifying SIDE-GAME board starts another.
export interface BonusRoundRecord {
  round: number                                            // 0-based
  players: [BonusRoundPlayerRecord, BonusRoundPlayerRecord]
  score: [number, number]                                  // net for this round alone
}

// Full record for one match hand (always 2-player, any bot pairing).
export interface MatchHandRecord {
  idx: number                           // 0-based hand index
  seed: number
  players: [PlayerMatchRecord, PlayerMatchRecord]  // [seat A, seat B]
  normalScore: [number, number]         // net from normal game
  bonusScore: [number, number]          // net summed over EVERY bonus round (0 if none)
  totalScore: [number, number]          // combined
  bonusTriggered: boolean               // any player triggered the bonus
  bonusTriggerPlayer: -1 | 0 | 1 | 2   // which player(s) triggered the FIRST round (-1 = none, 2 = both)
  // Every round of the chain, in order. Round 0 is also mirrored onto the
  // per-player bonus*/side* fields above so existing readers (the Arena replay
  // and its stats) keep working unchanged; rounds beyond the first appear only
  // here, and bonusScore is the total across all of them.
  bonusRounds?: BonusRoundRecord[]
}
