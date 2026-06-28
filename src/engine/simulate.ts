// Standalone game simulator — no React, no Firebase.
// Used by the self-play training script (Node.js) and optionally by tests.
//
// Simulates a full 5-street OFC hand with simultaneous placement:
// all players see only the previous streets' boards when deciding (info-set clean).
//
// Training labels include the bonus round: if any non-bust player's final top
// qualifies (QQ/KK/AA/trips), the bonus boards are solved with bestBonusBoard
// and non-qualifying players play a heuristic 5-street side game. Bonus-round
// scores are added to each player's label so the value network learns to value
// bonus-triggering tops correctly.

import { Deck } from './deck'
import type { Card, PartialBoard, Board } from './types'
import { applyPlacement } from './placement'
import { heuristicPlacement } from './heuristic'
import { scoreTable } from './scoring'
import { bonusTrigger, bonusDealCount } from './rules'
import { bestBonusBoard } from './bestBonus'
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
  // Final net score for the player who made this decision (normal + bonus round).
  outcome: number
  playerIdx: number
  street: number
}

// ── Bonus round ─────────────────────────────────────────────────────────────
//
// Run after the normal 5-street game. Returns per-player net bonus scores
// (zero-sum) or null if no player qualifies. Uses a fresh deck (per rules).
//
// Qualifying players: bestBonusBoard (exhaustive royalty-maximising search).
// Non-qualifying players: heuristic 5-street side game (parallel to the
// one-shot board; they don't see the bonus boards being built simultaneously).

function runBonusRound(normalBoards: Board[], seed: number): number[] | null {
  const qualifiers: Array<[number, ReturnType<typeof bonusTrigger> & string]> = []
  for (let p = 0; p < normalBoards.length; p++) {
    const q = bonusTrigger(normalBoards[p]!)
    if (q !== null) qualifiers.push([p, q])
  }
  if (qualifiers.length === 0) return null

  // Fresh deck per rules ("a fresh reshuffled 52-card deck for each bonus round").
  // Seed is derived from the game seed so the bonus is deterministic given the seed.
  const bonusSeed = ((seed ^ 0x1B2D3C4E) * 1664525 + 1013904223) >>> 0
  const bonusDeck = new Deck(bonusSeed)
  const bonusBoards: (Board | null)[] = new Array(normalBoards.length).fill(null)

  // Qualifying players receive their one-shot deal; best legal board is chosen.
  for (const [p, qualifier] of qualifiers) {
    const n = bonusDealCount(qualifier)
    const cards = bonusDeck.deal(n)
    bonusBoards[p] = bestBonusBoard(cards, n - 13)
  }

  // Non-qualifying players play a standard heuristic 5-street side game.
  // They don't see the bonus boards (built simultaneously), so oppBoards = [].
  const sideSizes = [5, 3, 3, 3, 3] as const
  for (let p = 0; p < normalBoards.length; p++) {
    if (bonusBoards[p] !== null) continue
    let sideBoard: PartialBoard = { top: [], middle: [], bottom: [] }
    for (let s = 0; s < sideSizes.length; s++) {
      const hand = bonusDeck.deal(sideSizes[s]!)
      const pl = heuristicPlacement(sideBoard, hand, s)
      sideBoard = applyPlacement(sideBoard, pl)
    }
    bonusBoards[p] = sideBoard as Board
  }

  return scoreTable(bonusBoards as Board[])
}

// ── Main game ────────────────────────────────────────────────────────────────

// Run one complete hand. Returns per-player outcomes and one TrainSample per
// decision. Outcomes include the bonus round if triggered, so the value network
// learns to aim for bonus-qualifying tops (QQ/KK/AA/trips).
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

  // Add bonus round scores to outcomes so the NN learns bonus EV.
  const bonusOutcomes = runBonusRound(boards as Board[], seed)
  if (bonusOutcomes) {
    for (let p = 0; p < playerCount; p++) {
      outcomes[p]! += bonusOutcomes[p]!
    }
  }

  const samples: TrainSample[] = decisionLog.map(d => ({
    features: encodeBoardState(d.boardAfter, d.street, d.oppBoards, d.discards),
    outcome: outcomes[d.playerIdx]!,
    playerIdx: d.playerIdx,
    street: d.street,
  }))

  return { samples, outcomes }
}
