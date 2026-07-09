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

const rng = mulberry32(20260709)

const TIERS: readonly BonusQualifier[] = ['QQ', 'KK', 'AA_OR_TRIPS']
const DISCARDS: Record<BonusQualifier, number> = { QQ: 0, KK: 1, AA_OR_TRIPS: 2 }

type OppScenario = 'BASE' | BonusQualifier
const OPP_SCENARIOS: readonly OppScenario[] = ['BASE', 'QQ', 'KK', 'AA_OR_TRIPS']

// bestBonusBoard's cost scales with C(dealt, 13) — the number of ways to
// choose which 13 of the dealt cards to keep (0 discards → C(13,13)=1,
// 1 discard → C(14,13)=14, 2 discards → C(15,13)=105). BASE (heuristic
// 5-street side game) is cheap by comparison. Pick trial counts per cell so
// every cell takes roughly the same wall-clock budget instead of a flat
// trial count (which would make AA_OR_TRIPS-involving cells take 100x+ longer).
const RELATIVE_COST: Record<OppScenario, number> = { BASE: 1, QQ: 25, KK: 25 * 14, AA_OR_TRIPS: 25 * 105 }
const TARGET_MS_PER_CELL = 45_000
const MS_PER_COST_UNIT = 0.5 // calibrated so QQ-vs-BASE (cost 26) lands near ~4000 trials

function trialsFor(actorTier: BonusQualifier, oppScenario: OppScenario): number {
  const cost = RELATIVE_COST[actorTier] + RELATIVE_COST[oppScenario]
  const n = Math.round(TARGET_MS_PER_CELL / (cost * MS_PER_COST_UNIT))
  return Math.max(25, Math.min(n, 5000))
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
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const avg = total / n
  console.log(`  actor=${actorTier.padEnd(11)} vs opp=${oppScenario.padEnd(11)}  n=${n}  avg_net=${avg.toFixed(3)}  (${elapsed}s)`)
  return avg
}

console.log('Computing exact pairwise bonus-round EV table (scorePair, shared-deck trials)...\n')

const table: Record<BonusQualifier, Record<OppScenario, number>> = {
  QQ: { BASE: 0, QQ: 0, KK: 0, AA_OR_TRIPS: 0 },
  KK: { BASE: 0, QQ: 0, KK: 0, AA_OR_TRIPS: 0 },
  AA_OR_TRIPS: { BASE: 0, QQ: 0, KK: 0, AA_OR_TRIPS: 0 },
}

for (const actorTier of TIERS) {
  for (const oppScenario of OPP_SCENARIOS) {
    const n = trialsFor(actorTier, oppScenario)
    table[actorTier][oppScenario] = simulateCell(actorTier, oppScenario, n)
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
