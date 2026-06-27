// Standalone game simulator — no React, no Firebase.
// Used by the self-play training script (Node.js) and optionally by tests.
//
// Simulates a full 5-street OFC hand with simultaneous placement:
// all players see only the previous streets' boards when deciding (info-set clean).

import { Deck } from './deck'
import type { Card, PartialBoard, Board } from './types'
import { applyPlacement } from './placement'
import { heuristicPlacement } from './heuristic'
import { scoreTable } from './scoring'
import type { InfoState } from './mc'
import type { Placement } from './placement'
import { encodeBoardState } from './encode'

export type SimPolicy = (info: InfoState) => Placement

// Default policy: fast heuristic (greedy row score).
export function heuristicPolicy(info: InfoState): Placement {
  return heuristicPlacement(info.board, info.hand, info.street)
}

export interface TrainSample {
  // Encoded board state after this placement (hand already placed).
  features: Float32Array
  // Final net score for the player who made this decision.
  outcome: number
  playerIdx: number
  street: number
}

// Run one complete hand. Returns per-player outcomes and one TrainSample per decision.
// bonus round is skipped (normal-round training is sufficient for the value network).
export function runGame(
  playerCount: 2 | 3,
  seed: number,
  policy: SimPolicy,
): { samples: TrainSample[], outcomes: number[] } {
  const deck = new Deck(seed)
  const streetSizes = [5, 3, 3, 3, 3]

  // Pre-deal all streets for all players.
  const dealt: Card[][][] = Array.from({ length: playerCount }, () => [])
  for (let s = 0; s <= 4; s++) {
    for (let p = 0; p < playerCount; p++) {
      dealt[p]!.push(deck.deal(streetSizes[s]!))
    }
  }

  const boards: PartialBoard[] = Array.from({ length: playerCount }, () =>
    ({ top: [], middle: [], bottom: [] })
  )
  // Track each player's accumulated discards for InfoState hygiene and feature encoding.
  const playerDiscards: Card[][] = Array.from({ length: playerCount }, () => [])
  const decisionLog: Array<{
    playerIdx: number
    street: number
    boardAfter: PartialBoard
    oppBoards: PartialBoard[]
    discards: Card[]  // all discards including the one made on this street
  }> = []

  for (let s = 0; s <= 4; s++) {
    // Snapshot revealed boards at the start of each street.
    // Each player sees opponents' boards from PREVIOUS streets only.
    const snapshots: PartialBoard[] = boards.map(b => ({
      top: [...b.top], middle: [...b.middle], bottom: [...b.bottom],
    }))

    const placements: Placement[] = new Array(playerCount)

    // All players decide simultaneously using the snapshots.
    for (let p = 0; p < playerCount; p++) {
      const hand = dealt[p]![s]!
      const board = snapshots[p]!
      const revealedOppBoards = snapshots.filter((_, i) => i !== p)

      const info: InfoState = {
        board,
        hand,
        street: s,
        revealedOpponentBoards: revealedOppBoards,
        discards: playerDiscards[p]!,
      }
      placements[p] = policy(info)
    }

    // Apply all placements, record decisions, update discard lists.
    for (let p = 0; p < playerCount; p++) {
      const pl = placements[p]!
      const boardAfter = applyPlacement(snapshots[p]!, pl)
      boards[p] = boardAfter

      // Feature encoding uses all discards including the one just made.
      const allDiscards = pl.discard ? [...playerDiscards[p]!, pl.discard] : [...playerDiscards[p]!]
      decisionLog.push({
        playerIdx: p,
        street: s,
        boardAfter,
        oppBoards: snapshots.filter((_, i) => i !== p),
        discards: allDiscards,
      })

      if (pl.discard) playerDiscards[p]!.push(pl.discard)
    }
  }

  const outcomes = scoreTable(boards as Board[])

  const samples: TrainSample[] = decisionLog.map(d => ({
    features: encodeBoardState(d.boardAfter, d.street, d.oppBoards, d.discards),
    outcome: outcomes[d.playerIdx]!,
    playerIdx: d.playerIdx,
    street: d.street,
  }))

  return { samples, outcomes }
}
