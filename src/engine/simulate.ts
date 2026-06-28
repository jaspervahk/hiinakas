// Standalone game simulator — no React, no Firebase.
// Used by the self-play training script (Node.js) and optionally by tests.
//
// Simulates a full 5-street OFC hand with simultaneous placement:
// all players see only the previous streets' boards when deciding (info-set clean).
//
// Training labels include ALL three game scenarios:
//
//   1. Normal game (streets 0-4): standard 5-street Pineapple OFC.
//   2. Bonus game (one-shot): a qualifying player places 13-15 cards at once.
//      Solved optimally with bestBonusBoard. Training sample: final board at
//      street=4, revealedOppBoards=[], discards=[] (built simultaneously).
//   3. Side game (streets 0-4): a non-qualifying player plays a standard 5-street
//      game during the bonus round, without seeing opponents' bonus boards.
//      Training samples: same encoding as normal game but revealedOppBoards=[].
//
// No bonus-within-bonus recursion: per spec, allowBonusRecursion=false.
// The bonus round scores boards with scoreTable only; it never re-triggers.

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
// Runs after the normal 5-street game when any non-bust top qualifies
// (QQ/KK/AA/trips). Returns:
//   bonusOutcomes: per-player net bonus scores (zero-sum, added to normal labels)
//   bonusSamples:  training samples from bonus-game and side-game decisions
//
// No re-triggering (allowBonusRecursion=false): we call scoreTable on the
// bonus boards and return. The bonus boards themselves are never checked for
// further bonus triggers.

function runBonusRound(
  normalBoards: Board[],
  seed: number,
): { bonusOutcomes: number[], bonusSamples: TrainSample[] } | null {
  const qualifiers: Array<[number, ReturnType<typeof bonusTrigger> & string]> = []
  for (let p = 0; p < normalBoards.length; p++) {
    const q = bonusTrigger(normalBoards[p]!)
    if (q !== null) qualifiers.push([p, q])
  }
  if (qualifiers.length === 0) return null

  // Fresh deck per rules ("a fresh reshuffled 52-card deck for each bonus round").
  const bonusSeed = ((seed ^ 0x1B2D3C4E) * 1664525 + 1013904223) >>> 0
  const bonusDeck = new Deck(bonusSeed)
  const bonusBoards: (Board | null)[] = new Array(normalBoards.length).fill(null)

  // ── Bonus game (qualifying players) ───────────────────────────────────────
  // Placed all at once: bestBonusBoard finds the royalty-maximising legal 3-5-5.
  // Training sample: encode the final board as street=4 (complete board),
  // revealedOppBoards=[] (all bonus boards built simultaneously, none visible),
  // discards=[] (no discard tracking in a one-shot deal).
  const qualifierBoards: Map<number, Board> = new Map()
  for (const [p, qualifier] of qualifiers) {
    const n = bonusDealCount(qualifier)
    const cards = bonusDeck.deal(n)
    const board = bestBonusBoard(cards, n - 13)
    bonusBoards[p] = board
    qualifierBoards.set(p, board)
  }

  // ── Side game (non-qualifying players) ────────────────────────────────────
  // Each non-qualifier plays a standard heuristic 5-street game. The bonus
  // boards are built simultaneously so revealedOppBoards=[] throughout.
  // We record decisions so the NN trains on the "empty opponent board" scenario.
  const sideSizes = [5, 3, 3, 3, 3] as const
  type SideDecision = { boardAfter: PartialBoard, street: number, discards: Card[] }
  const sideDecisionsByPlayer: Map<number, SideDecision[]> = new Map()

  for (let p = 0; p < normalBoards.length; p++) {
    if (bonusBoards[p] !== null) continue
    let sideBoard: PartialBoard = { top: [], middle: [], bottom: [] }
    const sideDiscards: Card[] = []
    const decisions: SideDecision[] = []

    for (let s = 0; s < sideSizes.length; s++) {
      const hand = bonusDeck.deal(sideSizes[s]!)
      const pl = heuristicPlacement(sideBoard, hand, s)
      const boardAfter = applyPlacement(sideBoard, pl)
      const allDiscards = pl.discard ? [...sideDiscards, pl.discard] : [...sideDiscards]

      decisions.push({ boardAfter, street: s, discards: allDiscards })

      if (pl.discard) sideDiscards.push(pl.discard)
      sideBoard = boardAfter
    }

    bonusBoards[p] = sideBoard as Board
    sideDecisionsByPlayer.set(p, decisions)
  }

  // Score the bonus round (no re-triggering: just scoreTable, no bonusTrigger check).
  const bonusOutcomes = scoreTable(bonusBoards as Board[])

  // ── Training samples ───────────────────────────────────────────────────────
  const bonusSamples: TrainSample[] = []

  // Bonus game samples: final board at street=4, no opp boards, no discards.
  // Label = bonus round outcome (what the qualifying player earned in the bonus round).
  for (const [p, board] of qualifierBoards) {
    bonusSamples.push({
      features: encodeBoardState(board as PartialBoard, 4, [], []),
      outcome: bonusOutcomes[p]!,
      playerIdx: p,
      street: 4,
    })
  }

  // Side game samples: each street decision, no revealed opp boards.
  // Label = bonus round outcome for this player (normal round already finished).
  for (const [p, decisions] of sideDecisionsByPlayer) {
    for (const d of decisions) {
      bonusSamples.push({
        features: encodeBoardState(d.boardAfter, d.street, [], d.discards),
        outcome: bonusOutcomes[p]!,
        playerIdx: p,
        street: d.street,
      })
    }
  }

  return { bonusOutcomes, bonusSamples }
}

// ── Main game ────────────────────────────────────────────────────────────────

// Run one complete hand. Returns per-player outcomes and TrainSamples covering
// all three scenarios: normal game, bonus game, and side game decisions.
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

  // Run bonus round and collect bonus training samples.
  const bonusResult = runBonusRound(boards as Board[], seed)
  if (bonusResult) {
    // Add bonus round scores to normal round outcomes (the combined total is the training label).
    for (let p = 0; p < playerCount; p++) {
      outcomes[p]! += bonusResult.bonusOutcomes[p]!
    }
  }

  // Normal game samples: outcome = normal + bonus (so the NN values bonus-triggering positions).
  const samples: TrainSample[] = decisionLog.map(d => ({
    features: encodeBoardState(d.boardAfter, d.street, d.oppBoards, d.discards),
    outcome: outcomes[d.playerIdx]!,
    playerIdx: d.playerIdx,
    street: d.street,
  }))

  // Append bonus-game and side-game samples with their own outcome labels.
  if (bonusResult) {
    samples.push(...bonusResult.bonusSamples)
  }

  return { samples, outcomes }
}
