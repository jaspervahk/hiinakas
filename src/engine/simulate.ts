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
//      game during the bonus round. Side players see each other's partial boards
//      per turn (like the normal game) but never see bonus players' boards.
//
// Bonus rounds chain when RuleSet.allowBonusRecursion is set: a SIDE-GAME
// player who qualifies starts another bonus round, while a 13-15 card bonus
// board never re-triggers. Under CLASSIC_RULES (the default) exactly one round
// runs, as before.

import { Deck } from './deck'
import type { Card, PartialBoard, Board, BonusQualifier, RuleSet } from './types'
import { CLASSIC_RULES } from './types'
import { applyPlacement } from './placement'
import { heuristicPlacement } from './heuristic'
import { scoreTable } from './scoring'
import { bonusTrigger, bonusDealCount } from './rules'
import { bestBonusBoard } from './bestBonus'
import type { InfoState } from './mc'
import type { Placement } from './placement'
import { encodeBoardState } from './encode'

export type SimPolicy = (info: InfoState) => Placement

// Default policy: fast heuristic (greedy row score), opponent-aware.
export function heuristicPolicy(info: InfoState): Placement {
  return heuristicPlacement(info.board, info.hand, info.street, info.revealedOpponentBoards)
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

// Safety cap on chain length. The chain terminates almost surely on its own —
// each round re-triggers only if a side-game player qualifies, which is well
// under a 10% event — so this is not the mechanism that ends it, only a guard
// against a pathological deal or a future rules change making qualification
// near-certain. Reaching it would be a bug worth knowing about.
const MAX_BONUS_ROUNDS = 32

function runBonusRounds(
  normalBoards: Board[],
  seed: number,
  rules: RuleSet = CLASSIC_RULES,
): { bonusOutcomes: number[], bonusSamples: TrainSample[], rounds: number } | null {
  const playerCount = normalBoards.length
  let entry: (BonusQualifier | null)[] = normalBoards.map(b => bonusTrigger(b, rules))
  if (entry.every(q => q === null)) return null

  const totals = new Array<number>(playerCount).fill(0)
  const perRoundOutcomes: number[][] = []
  // Samples are held until the chain ends: a decision's label must be the net
  // from that round ONWARD, since a side-game decision determines both this
  // round's score and whether another round happens at all.
  const pending: Array<{ round: number, playerIdx: number, features: Float32Array, street: number }> = []

  let roundSeed = ((seed ^ 0x1B2D3C4E) * 1664525 + 1013904223) >>> 0
  let rounds = 0

  for (let round = 0; round < MAX_BONUS_ROUNDS; round++) {
    const deck = new Deck(roundSeed)
    const boards: (Board | null)[] = new Array(playerCount).fill(null)

    // ── Bonus game (qualifying players) ─────────────────────────────────────
    // Placed all at once: bestBonusBoard finds the royalty-maximising legal 3-5-5.
    const qualifierIdx: number[] = []
    for (let p = 0; p < playerCount; p++) {
      const q = entry[p]
      if (!q) continue
      const n = bonusDealCount(q)
      if (deck.remaining < n) break // degenerate deal — stop the chain rather than throw
      boards[p] = bestBonusBoard(deck.deal(n), n - 13)
      qualifierIdx.push(p)
    }

    // ── Side game (non-qualifying players) ──────────────────────────────────
    // Side players see each other's partial boards per turn (exactly like the
    // normal game) but never see bonus players' boards.
    const sideIndices: number[] = []
    for (let p = 0; p < playerCount; p++) if (boards[p] === null) sideIndices.push(p)

    const sideSizes = [5, 3, 3, 3, 3] as const
    if (deck.remaining < sideIndices.length * 17) break // not enough deck left

    const sideBoards: PartialBoard[] = sideIndices.map(() => ({ top: [], middle: [], bottom: [] }))
    const sideDiscardLists: Card[][] = sideIndices.map(() => [])
    const sideDecisions: Array<{ playerIdx: number, boardAfter: PartialBoard, street: number, discards: Card[], oppBoards: PartialBoard[] }> = []

    for (let s = 0; s < sideSizes.length; s++) {
      const snapshots: PartialBoard[] = sideBoards.map(b =>
        ({ top: [...b.top], middle: [...b.middle], bottom: [...b.bottom] })
      )
      for (let i = 0; i < sideIndices.length; i++) {
        const hand = deck.deal(sideSizes[s]!)
        const oppBoards = snapshots.filter((_, j) => j !== i)
        const pl = heuristicPlacement(snapshots[i]!, hand, s, oppBoards)
        const boardAfter = applyPlacement(snapshots[i]!, pl)
        const disc = sideDiscardLists[i]!
        sideDecisions.push({
          playerIdx: sideIndices[i]!,
          boardAfter,
          street: s,
          discards: pl.discard ? [...disc, pl.discard] : [...disc],
          oppBoards,
        })
        if (pl.discard) disc.push(pl.discard)
        sideBoards[i] = boardAfter
      }
    }
    for (let i = 0; i < sideIndices.length; i++) boards[sideIndices[i]!] = sideBoards[i] as Board

    // ── Score this round ────────────────────────────────────────────────────
    const outcomes = scoreTable(boards as Board[])
    perRoundOutcomes.push(outcomes)
    for (let p = 0; p < playerCount; p++) totals[p]! += outcomes[p]!
    rounds++

    // Bonus-game samples: final board at street=4, no opp boards, no discards
    // (all bonus boards are built simultaneously and none is visible).
    for (const p of qualifierIdx) {
      pending.push({
        round, playerIdx: p, street: 4,
        features: encodeBoardState(boards[p] as PartialBoard, 4, [], []),
      })
    }
    for (const d of sideDecisions) {
      pending.push({
        round, playerIdx: d.playerIdx, street: d.street,
        features: encodeBoardState(d.boardAfter, d.street, d.oppBoards, d.discards),
      })
    }

    // ── Does the chain continue? ────────────────────────────────────────────
    // Only a SIDE-GAME player can re-trigger: a 13-15 card bonus board never
    // starts another round (docs/01_RULES_AND_SCORING.md section 8, extended
    // by RuleSet.allowBonusRecursion).
    if (!rules.allowBonusRecursion) break
    const next: (BonusQualifier | null)[] = new Array(playerCount).fill(null)
    let any = false
    for (const p of sideIndices) {
      const q = bonusTrigger(boards[p] as Board, rules)
      if (q) { next[p] = q; any = true }
    }
    if (!any) break
    entry = next
    roundSeed = ((roundSeed ^ 0x9E3779B9) * 1664525 + 1013904223) >>> 0
  }

  // Label each decision with the net from its own round onward.
  const bonusSamples: TrainSample[] = pending.map(s => {
    let outcome = 0
    for (let k = s.round; k < perRoundOutcomes.length; k++) outcome += perRoundOutcomes[k]![s.playerIdx]!
    return { features: s.features, outcome, playerIdx: s.playerIdx, street: s.street }
  })

  return { bonusOutcomes: totals, bonusSamples, rounds }
}

// ── Main game ────────────────────────────────────────────────────────────────

// Run one complete hand. Returns per-player outcomes and TrainSamples covering
// all three scenarios: normal game, bonus game, and side game decisions.
export function runGame(
  playerCount: 2 | 3,
  seed: number,
  policy: SimPolicy,
  rules: RuleSet = CLASSIC_RULES,
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
  const bonusResult = runBonusRounds(boards as Board[], seed, rules)
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
