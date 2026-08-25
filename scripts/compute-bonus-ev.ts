#!/usr/bin/env tsx
// Compute exact pairwise bonus-round EV constants via Monte Carlo simulation.
// Run with: npx tsx scripts/compute-bonus-ev.ts
//
// Model: when the acting player's final top row qualifies for the bonus round
// (QQ/KK/AA_OR_TRIPS), rollout-style evaluators (src/engine/mc.ts) need the
// expected NET score of that bonus round without actually simulating it move
// by move. The bonus round is scored pairwise against every other active
// player (docs/01_RULES_AND_SCORING.md section 8: "exact same pairwise rules
// ... as a normal round"), so the correct EV is a SUM of one term per
// opponent, each term depending on whether THAT specific opponent also
// qualifies for their own bonus board (drawn from the same fresh deal) or
// plays the non-qualifying side game (a normal 17-card 5-street hand).
//
// This script computes BONUS_NET[actorTier][oppScenario] = the expected
// scorePair() net for the actor (with a freshly-drawn, optimally-played
// bonus board of `actorTier`) against ONE opponent in scenario `oppScenario`
// (BASE = side game, or the opponent's own QQ/KK/AA_OR_TRIPS bonus board).
// Both hands are dealt from a single shared shuffled 52-card deck per trial
// (actor's cards first, then the opponent's), matching the real game's
// single fresh-deck-per-bonus-round rule.
//
// Summing BONUS_NET[actorTier][oppScenario_i] over each actual opponent i
// (using their real simulated final-board tier from the SAME rollout sample)
// gives an EV that is automatically correct for both 2p (1 opponent) and 3p
// (2 opponents) games, and automatically accounts for opponents who are
// independently also about to trigger their own bonus round.
//
// Two optimizations that a previous version of this script documented but
// never actually implemented (found while regenerating this table after the
// kicker-aware bonus solver landed):
//   1. Diagonal cells (actorTier === oppScenario) are EXACTLY 0 by symmetry
//      — two boards drawn i.i.d. from the same distribution give
//      E[net] = E[-net] = 0. No need to simulate them at all; this also
//      eliminates the single most expensive cell (AA_OR_TRIPS vs itself,
//      ~2.5s/trial with two 15-card exhaustive solves per trial).
//   2. Off-diagonal cells come in pairs — (A,B) and (B,A) are two
//      independent noisy estimates of the SAME underlying quantity, since
//      net(A,B) = -net(B,A) exactly in expectation. Averaging
//      (sampled_AB - sampled_BA) / 2 halves the estimation variance with NO
//      extra simulation cost, since both directions get simulated anyway to
//      fill the table.

import { bestBonusBoard } from '../src/engine/bestBonus'
import { heuristicPlacement } from '../src/engine/heuristic'
import { scorePair } from '../src/engine/scoring'
import { bonusDealCount } from '../src/engine/rules'
import { Deck } from '../src/engine/deck'
import { applyPlacement } from '../src/engine/placement'
import type { Board, PartialBoard, BonusQualifier } from '../src/engine/types'

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = mulberry32(20260825)

const TIERS: readonly BonusQualifier[] = ['QQ', 'KK', 'AA_OR_TRIPS']
const DISCARDS: Record<BonusQualifier, number> = { QQ: 0, KK: 1, AA_OR_TRIPS: 2 }

type OppScenario = 'BASE' | BonusQualifier
const OPP_SCENARIOS: readonly OppScenario[] = ['BASE', 'QQ', 'KK', 'AA_OR_TRIPS']

// bestBonusBoard's cost scales with C(dealt, 13): 0 discards -> C(13,13)=1,
// 1 discard -> C(14,13)=14, 2 discards -> C(15,13)=105 — so any cell
// touching AA_OR_TRIPS (as actor or opponent) costs ~100x a QQ-only cell.
// Empirically measured (n=150 probe): QQ~0.013s/trial, KK~0.163s/trial
// combined, AA_OR_TRIPS-involving pairs ~1.2-1.4s/trial. Trial counts below
// are picked so the AA_OR_TRIPS-heavy cells (which dominate total runtime
// regardless) get a real precision bump without the whole run stretching to
// many hours; the cheap cells are generous since they're nearly free.
const TRIALS_CHEAP = 3000       // any cell not touching AA_OR_TRIPS
const TRIALS_AA = 1200          // any cell touching AA_OR_TRIPS (actor or opponent)

function involvesAA(actorTier: BonusQualifier, oppScenario: OppScenario): boolean {
  return actorTier === 'AA_OR_TRIPS' || oppScenario === 'AA_OR_TRIPS'
}
function trialsFor(actorTier: BonusQualifier, oppScenario: OppScenario): number {
  return involvesAA(actorTier, oppScenario) ? TRIALS_AA : TRIALS_CHEAP
}

// Build a full 5-street 3-5-5 board via the standard heuristic policy
// (the "side game" — a normal 17-card Pineapple hand, no opponent info).
function playSideGame(deck: Deck): Board {
  let board: PartialBoard = { top: [], middle: [], bottom: [] }
  const streetSizes = [5, 3, 3, 3, 3]
  for (let s = 0; s <= 4; s++) {
    const hand = deck.deal(streetSizes[s]!)
    const pl = heuristicPlacement(board, hand, s)
    board = applyPlacement(board, pl)
  }
  return board as Board
}

function buildOpponentBoard(deck: Deck, scenario: OppScenario): Board {
  if (scenario === 'BASE') return playSideGame(deck)
  const n = bonusDealCount(scenario)
  const cards = deck.deal(n)
  return bestBonusBoard(cards, DISCARDS[scenario])
}

function simulateCell(actorTier: BonusQualifier, oppScenario: OppScenario, n: number): number {
  let total = 0
  const t0 = Date.now()
  for (let i = 0; i < n; i++) {
    const seed = (rng() * 0x7fffffff) | 0
    const deck = new Deck(seed)
    const actorCards = deck.deal(bonusDealCount(actorTier))
    const actorBoard = bestBonusBoard(actorCards, DISCARDS[actorTier])
    const oppBoard = buildOpponentBoard(deck, oppScenario)
    const { aNet } = scorePair(actorBoard, oppBoard)
    total += aNet
    if ((i + 1) % 200 === 0) process.stderr.write(`    ${actorTier} vs ${oppScenario}: ${i + 1}/${n}\n`)
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const avg = total / n
  console.error(`  actor=${actorTier.padEnd(11)} vs opp=${oppScenario.padEnd(11)}  n=${n}  avg_net=${avg.toFixed(3)}  (${elapsed}s)`)
  return avg
}

console.error('Computing exact pairwise bonus-round EV table (scorePair, shared-deck trials)...\n')

const table: Record<BonusQualifier, Record<OppScenario, number>> = {
  QQ: { BASE: 0, QQ: 0, KK: 0, AA_OR_TRIPS: 0 },
  KK: { BASE: 0, QQ: 0, KK: 0, AA_OR_TRIPS: 0 },
  AA_OR_TRIPS: { BASE: 0, QQ: 0, KK: 0, AA_OR_TRIPS: 0 },
}

// Diagonal cells: exactly 0 by symmetry, no simulation needed.
for (const tier of TIERS) {
  table[tier][tier] = 0
  console.error(`  actor=${tier.padEnd(11)} vs opp=${tier.padEnd(11)}  (diagonal, exact 0 by symmetry — skipped)`)
}

// BASE cells: no symmetric counterpart, simulate independently.
for (const tier of TIERS) {
  table[tier].BASE = simulateCell(tier, 'BASE', trialsFor(tier, 'BASE'))
}

// Off-diagonal tier pairs: simulate both directions, combine for free
// variance reduction (net(A,B) = -net(B,A) in expectation).
for (let i = 0; i < TIERS.length; i++) {
  for (let j = i + 1; j < TIERS.length; j++) {
    const a = TIERS[i]!, b = TIERS[j]!
    const n = trialsFor(a, b)
    const sampledAB = simulateCell(a, b, n)
    const sampledBA = simulateCell(b, a, n)
    const combinedAB = (sampledAB - sampledBA) / 2
    table[a][b] = combinedAB
    table[b][a] = -combinedAB
    console.error(`  combined: ${a} vs ${b} = ${combinedAB.toFixed(3)}  (raw AB=${sampledAB.toFixed(3)}, raw BA=${sampledBA.toFixed(3)})`)
  }
}

console.log('\n── Result: BONUS_NET[actorTier][oppScenario] ──────────────────────────')
console.log(JSON.stringify(table, null, 2))

console.log('\n── TypeScript literal (paste into src/engine/rules.ts) ─────────────────')
console.log('export const BONUS_NET: Record<BonusQualifier, Record<BonusOppScenario, number>> = {')
for (const actorTier of TIERS) {
  const row = OPP_SCENARIOS.map(s => `${s}: ${table[actorTier][s].toFixed(2)}`).join(', ')
  console.log(`  ${actorTier}: { ${row} },`)
}
console.log('}')
