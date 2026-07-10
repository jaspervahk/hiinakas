import type { Card, PartialBoard } from './types'
import { FULL_DECK } from './deck'
import { scoreTable } from './scoring'
import { bonusGameValue } from './rules'
import type { Board } from './types'
import { legalPlacements, applyPlacement } from './placement'
import type { Placement } from './placement'
import { heuristicPlacement } from './heuristic'

// Optional NN-guided policy replaces heuristicPlacement inside rollouts.
// Receives (board, hand, street, revealedOppBoards) and returns the chosen placement.
export type RolloutPolicy = (
  board: PartialBoard,
  hand: readonly Card[],
  street: number,
  oppBoards: PartialBoard[],
) => Placement

// Module-level policy slot — set by the worker when model weights are loaded.
let activePolicy: RolloutPolicy | null = null

export function setRolloutPolicy(policy: RolloutPolicy | null): void {
  activePolicy = policy
}

// ── Info set (what the acting player can see) ──────────────────────────────
//
// This is the ONLY input to the EV/bot functions. It must never contain
// opponents' hidden cards, discards, future draws, or the undealt stub.
// The type boundary enforces hygiene structurally.

export interface InfoState {
  readonly board: PartialBoard            // actor's own placed cards
  readonly hand: readonly Card[]          // actor's current-street cards (not yet placed)
  readonly street: number                 // 0-4
  readonly revealedOpponentBoards: readonly PartialBoard[] // opponents' placed (revealed) cards only
  readonly discards?: readonly Card[]     // actor's own discards from previous streets (not opponents')
}

// ── Scored placement (result of MC evaluation) ────────────────────────────

export interface ScoredPlacement {
  readonly placement: Placement
  readonly ev: number        // mean net score over n rollouts
  readonly variance: number
  readonly n: number         // rollouts completed
}

// ── RNG ───────────────────────────────────────────────────────────────────

export type RNG = () => number

export function fisherYates<T>(arr: T[], rng: RNG): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = a[i]!; a[i] = a[j]!; a[j] = tmp
  }
  return a
}

// ── Live deck from actor's info state ─────────────────────────────────────

function cardKey(c: Card): string { return `${c.rank}${c.suit}` }

export function buildLiveDeck(state: InfoState): Card[] {
  const seen = new Set<string>()
  const mark = (cards: readonly Card[]) => { for (const c of cards) seen.add(cardKey(c)) }
  mark(state.board.top)
  mark(state.board.middle)
  mark(state.board.bottom)
  mark(state.hand)
  if (state.discards) mark(state.discards)
  for (const b of state.revealedOpponentBoards) {
    mark(b.top); mark(b.middle); mark(b.bottom)
  }
  return (FULL_DECK as Card[]).filter(c => !seen.has(cardKey(c)))
}

// ── Single rollout ─────────────────────────────────────────────────────────
//
// Simulates the game from the actor's perspective:
//  1. Apply the candidate placement to actor's board.
//  2. For the current street, sample opponent hand(s) from the live deck
//     and apply their heuristic policy (they see only their own board +
//     actor's revealed board — no hidden info leaks in).
//  3. For remaining streets (street+1..4) deal to all seats from live deck,
//     apply heuristic policy for each.
//  4. Score the complete table and return the actor's net.

function rollout(
  actorBoardAfterPlacement: PartialBoard,
  state: InfoState,
  shuffledLiveDeck: Card[],
  includeBonusEV = true,
): number {
  let di = 0 // deck index into shuffledLiveDeck
  let actorBrd = actorBoardAfterPlacement
  const oppBrds: PartialBoard[] = state.revealedOpponentBoards.map(b => ({
    top: [...b.top], middle: [...b.middle], bottom: [...b.bottom],
  }))

  // Use NN policy if loaded, otherwise heuristic (now opponent-aware: forward
  // the 4th arg so it can weigh visible opponent progress per row).
  const pick = activePolicy ?? ((b, h, s, opp) => heuristicPlacement(b, h, s, opp))

  const cardsPerStreet = (s: number) => s === 0 ? 5 : 3

  // Current street: deal to opponents (actor's cards already accounted for in state.hand)
  const curN = cardsPerStreet(state.street)
  for (let i = 0; i < oppBrds.length; i++) {
    const oppHand = shuffledLiveDeck.slice(di, di + curN)
    di += curN
    if (oppHand.length < curN) return 0 // not enough cards — degenerate rollout
    // Opponent uses the same policy as the actor for symmetric, unbiased EV estimates.
    const visibleToOpp = [actorBrd, ...oppBrds.filter((_, j) => j !== i)]
    const pl = pick(oppBrds[i]!, oppHand, state.street, visibleToOpp)
    oppBrds[i] = applyPlacement(oppBrds[i]!, pl)
  }

  // Remaining streets
  for (let s = state.street + 1; s <= 4; s++) {
    const actorHand = shuffledLiveDeck.slice(di, di + 3)
    di += 3
    if (actorHand.length < 3) return 0
    const actorPl = pick(actorBrd, actorHand, s, oppBrds)
    actorBrd = applyPlacement(actorBrd, actorPl)

    for (let i = 0; i < oppBrds.length; i++) {
      const oppHand = shuffledLiveDeck.slice(di, di + 3)
      di += 3
      if (oppHand.length < 3) return 0
      const visibleToOpp = [actorBrd, ...oppBrds.filter((_, j) => j !== i)]
      const pl = pick(oppBrds[i]!, oppHand, s, visibleToOpp)
      oppBrds[i] = applyPlacement(oppBrds[i]!, pl)
    }
  }

  const allBoards = [actorBrd as Board, ...(oppBrds as Board[])]
  const nets = scoreTable(allBoards)
  // scoreTable only covers the normal 5-street game; add the actor's expected
  // bonus-round upside (0 if fouled or non-qualifying). Passing the actual
  // simulated opponent boards lets bonusGameValue sum one term per real
  // opponent (correct for both 2p and 3p) and value a co-qualifying
  // opponent's own bonus board correctly instead of assuming a generic one.
  return (nets[0] ?? 0) + (includeBonusEV ? bonusGameValue(actorBrd as Board, oppBrds as Board[]) : 0)
}

// ── EV computation for a single placement ─────────────────────────────────

export function computeEV(
  state: InfoState,
  placement: Placement,
  rollouts: number,
  rng: RNG,
): ScoredPlacement {
  const liveDeck = buildLiveDeck(state)
  const boardAfter = applyPlacement(state.board, placement)

  let sum = 0
  let sumSq = 0
  for (let r = 0; r < rollouts; r++) {
    const shuffled = fisherYates(liveDeck, rng)
    const net = rollout(boardAfter, state, shuffled)
    sum += net
    sumSq += net * net
  }
  const ev = sum / rollouts
  const variance = rollouts > 1 ? (sumSq / rollouts - ev * ev) : 0
  return { placement, ev, variance, n: rollouts }
}

// ── Progressive MC (generator) ────────────────────────────────────────────
//
// Evaluates all candidate placements in interleaved batches.
// Yields the current ScoredPlacement[] after each batch so the UI can
// show "best so far" with growing confidence.

export interface MCOptions {
  totalRollouts: number  // target rollouts per placement
  batchSize?: number     // rollouts per yielded update (default 10)
}

export function* runMC(
  state: InfoState,
  options: MCOptions,
  rng: RNG,
  candidates?: Placement[],  // if provided, skip legalPlacements (used for pruned NN+MC hybrid)
): Generator<ScoredPlacement[], void, unknown> {
  const { totalRollouts, batchSize = 10 } = options
  const candidates_ = candidates ?? legalPlacements(state.board, state.hand, state.street)
  if (candidates_.length === 0) return

  const liveDeck = buildLiveDeck(state)
  const boardsAfter = candidates_.map(p => applyPlacement(state.board, p))

  const sums    = new Float64Array(candidates_.length)
  const sumsSq  = new Float64Array(candidates_.length)
  const counts  = new Int32Array(candidates_.length)

  let done = 0
  while (done < totalRollouts) {
    const batch = Math.min(batchSize, totalRollouts - done)
    for (let r = 0; r < batch; r++) {
      const shuffled = fisherYates(liveDeck, rng)
      for (let pi = 0; pi < candidates_.length; pi++) {
        const net = rollout(boardsAfter[pi]!, state, shuffled)
        sums[pi] += net
        sumsSq[pi] += net * net
        counts[pi]++
      }
    }
    done += batch

    const results: ScoredPlacement[] = candidates_.map((placement, pi) => {
      const n  = counts[pi]!
      const ev = n > 0 ? sums[pi]! / n : 0
      const variance = n > 1 ? sumsSq[pi]! / n - ev * ev : 0
      return { placement, ev, variance, n }
    })
    yield results
  }
}

// ── Bot: argmax EV ────────────────────────────────────────────────────────

export function getBotMove(
  state: InfoState,
  rollouts: number,
  rng: RNG,
  includeBonusEV = true,
): Placement {
  const candidates = legalPlacements(state.board, state.hand, state.street)
  if (candidates.length === 0) throw new Error('No legal placements')
  if (candidates.length === 1) return candidates[0]!

  const liveDeck = buildLiveDeck(state)
  const boardsAfter = candidates.map(p => applyPlacement(state.board, p))

  const sums = new Float64Array(candidates.length)
  for (let r = 0; r < rollouts; r++) {
    const shuffled = fisherYates(liveDeck, rng)
    for (let pi = 0; pi < candidates.length; pi++) {
      sums[pi] += rollout(boardsAfter[pi]!, state, shuffled, includeBonusEV)
    }
  }

  let bestIdx = 0
  for (let pi = 1; pi < candidates.length; pi++) {
    if ((sums[pi] ?? -Infinity) > (sums[bestIdx] ?? -Infinity)) bestIdx = pi
  }
  return candidates[bestIdx]!
}

// Re-export legalPlacements for convenience
export { legalPlacements }
