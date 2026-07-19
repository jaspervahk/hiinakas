// Reconstructs the historical side of a sent Huub challenge's hand-by-hand
// detail view from Hiinakas's own persisted record (replayChallenges/{id}/
// hands/{index} — see functions/src/replayBridge.ts's encodeHandForStorage)
// plus translates the challenged player's actual board (pulled live from
// Huub, in Huub's own card shape) back into Hiinakas's own Card/Board types
// so both sides can render through the same CardChip component.

import type { Card, Board, Placement } from '../engine/index'
import { applyPlacement } from '../engine/index'
import type { HuubCard, HuubBoard } from '../firestore/huubBridge'

// ── Firestore wire shape (mirrors functions/src/utils/firestoreArrayCodec.ts) ──

interface WrappedRow<T> { row: T[] }
function unwrapRows<T>(wrapped: WrappedRow<T>[]): T[][] {
  return wrapped.map(w => w.row)
}

export interface PersistedHand {
  index: number
  gameId: string
  playerCount: 2 | 3
  historicalTotal: number
  opponentNames: string[]
  targetNormalHands: Card[][]
  opponentNormalPlacements: Placement[][]
  opponentBonusOutcomes: (
    | { qualifies: true; board: Board }
    | { qualifies: false; placements: Placement[] }
    | null
  )[]
  humanBonusReplay:
    | { tier: 'QQ' | 'KK' | 'AA_OR_TRIPS'; cards: Card[] }
    | { tier: null; sideHands: Card[][] }
    | null
  targetNormalPlacements: Placement[]
  targetBonusOutcome:
    | { qualifies: true; board: Board }
    | { qualifies: false; placements: Placement[] }
    | null
}

export function decodePersistedHand(raw: Record<string, unknown>): PersistedHand {
  return {
    index: raw.index as number,
    gameId: raw.gameId as string,
    playerCount: raw.playerCount as 2 | 3,
    historicalTotal: raw.historicalTotal as number,
    opponentNames: raw.opponentNames as string[],
    targetNormalHands: unwrapRows(raw.targetNormalHands as WrappedRow<Card>[]),
    opponentNormalPlacements: unwrapRows(raw.opponentNormalPlacements as WrappedRow<Placement>[]),
    opponentBonusOutcomes: raw.opponentBonusOutcomes as PersistedHand['opponentBonusOutcomes'],
    humanBonusReplay: (raw.humanBonusReplay ?
      ((raw.humanBonusReplay as { tier: unknown }).tier === null ?
        { tier: null, sideHands: unwrapRows((raw.humanBonusReplay as { sideHands: WrappedRow<Card>[] }).sideHands) } :
        raw.humanBonusReplay as { tier: 'QQ' | 'KK' | 'AA_OR_TRIPS'; cards: Card[] }) :
      null) as PersistedHand['humanBonusReplay'],
    targetNormalPlacements: raw.targetNormalPlacements as Placement[],
    targetBonusOutcome: raw.targetBonusOutcome as PersistedHand['targetBonusOutcome'],
  }
}

// Reconstructs a complete final Board from a sequence of street placements —
// a bonus/side-game outcome always fully replaces the normal-round board
// (docs/01_RULES_AND_SCORING.md), so this always starts from empty.
function reconstructBoard(placements: Placement[]): Board {
  let board: Board = { top: [], middle: [], bottom: [] }
  for (const p of placements) board = applyPlacement(board, p) as Board
  return board
}

/** The target's own actual final board for this hand — whichever of normal
 *  round / one-shot bonus / side game it actually ended up being. */
export function targetFinalBoard(hand: PersistedHand): Board {
  if (hand.targetBonusOutcome?.qualifies === true) return hand.targetBonusOutcome.board
  if (hand.targetBonusOutcome?.qualifies === false) return reconstructBoard(hand.targetBonusOutcome.placements)
  return reconstructBoard(hand.targetNormalPlacements)
}

// ── Huub card/board translation (reverse of functions/src/replayBridge.ts's toHuubCard) ──

const SUIT_FROM_HUUB: Record<string, Card['suit']> = { hearts: 'h', diamonds: 'd', clubs: 'c', spades: 's' }
const RANK_FROM_HUUB: Record<string, Card['rank']> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, J: 11, Q: 12, K: 13, A: 14,
}

export function fromHuubCard(c: HuubCard): Card {
  return { rank: RANK_FROM_HUUB[c.rank], suit: SUIT_FROM_HUUB[c.suit] }
}

export function fromHuubBoard(b: HuubBoard): Board {
  return {
    top: b.top.map(fromHuubCard),
    middle: b.middle.map(fromHuubCard),
    bottom: b.bottom.map(fromHuubCard),
  }
}
