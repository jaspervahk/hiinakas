#!/usr/bin/env tsx
// Generates a fixed set of realistic side-game final boards, for embedding
// as static data (src/engine/sideGameSamplesData.ts). Run with:
//   npx tsx scripts/compute-side-game-samples.ts > /tmp/side-game-samples-out.txt
//
// Completes the "opponent field" the kicker-aware bonus solver
// (bonusOpponentScoring.ts) compares tied candidates against — bonus-eligible
// opponents were already covered by compute-bonus-samples.ts, but a real
// bonus round is also scored pairwise against non-qualifying side-game
// opponents, and no sample pool existed for "what does a typical side-game
// final board look like" until now.
//
// The pool must match the side-game opponent BONUS_NET is calibrated against,
// or the tie-breaker and the EV table disagree about who they are playing.
// That was the original reason this used solo heuristic play; when BONUS_NET's
// BASE column was recalibrated (2026-09-14) against a competent side-game
// player, the same consistency argument required regenerating this pool the
// same way.
//
// Two things are load-bearing in how the side game is played here:
//
//  1. invisibleBonusOpponents MUST be set. A side-game player has no VISIBLE
//     opponent — the bonus-board player's board is hidden — so without it
//     every rollout scores a one-board table, scoreTable's pairwise loop never
//     runs, every candidate scores exactly 0, and getBotMove returns an
//     arbitrary first candidate that fouls ~67% of the time. With it, the
//     player is scored against a realistic board of the tier they face, which
//     restores both the royalty and the foul signal.
//
//  2. The tier they face is sampled from the REAL distribution of bonus-round
//     triggers, measured below rather than assumed uniform. It matters: a
//     side-game player facing a 15-card AA board is far behind and gambles,
//     fouling ~46% of the time, versus ~28% against a 13-card QQ board. A flat
//     mix would skew the pool's foul rate by several points.

import { heuristicPlacement } from '../src/engine/heuristic'
import { getBotMove } from '../src/engine/mc'
import { bonusTrigger } from '../src/engine/rules'
import { applyPlacement } from '../src/engine/placement'
import { Deck } from '../src/engine/deck'
import { CLASSIC_RULES } from '../src/engine/types'
import type { Board, PartialBoard, Card, BonusQualifier } from '../src/engine/types'

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

const args = process.argv.slice(2)
const getArg = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`)
  return i !== -1 ? (args[i + 1] ?? d) : d
}
const rng = mulberry32(20260914)
const botRng = mulberry32(84213)
const SAMPLE_COUNT = parseInt(getArg('count', '1000'), 10)
const TIER_TRIALS  = parseInt(getArg('tier-trials', '4000'), 10)
const BOT_SIMS     = parseInt(getArg('sims', '20'), 10)

const TIERS: readonly BonusQualifier[] = ['QQ', 'KK', 'AA_OR_TRIPS']
const STREETS = [5, 3, 3, 3, 3]

// A normal 5-street hand, used only to measure which tiers actually trigger
// bonus rounds. Played by the heuristic: this is a question about the
// distribution of QUALIFYING TOPS, which the policy barely moves, and it lets
// the measurement run at a sample size the bot could not reach.
function playNormalHand(deck: Deck): Board {
  let board: PartialBoard = { top: [], middle: [], bottom: [] }
  for (let s = 0; s <= 4; s++) {
    board = applyPlacement(board, heuristicPlacement(board, deck.deal(STREETS[s]!), s))
  }
  return board as Board
}

// The side game itself, against a hidden bonus board of tier `vs`.
function playSideGame(deck: Deck, vs: BonusQualifier): Board {
  let board: PartialBoard = { top: [], middle: [], bottom: [] }
  for (let s = 0; s <= 4; s++) {
    const hand = deck.deal(STREETS[s]!)
    const pl = getBotMove({
      board, hand, street: s, revealedOpponentBoards: [], inBonusRound: true,
      invisibleBonusOpponents: [vs], rules: CLASSIC_RULES,
    }, BOT_SIMS, botRng)
    board = applyPlacement(board, pl)
  }
  return board as Board
}

const RANK_CHAR: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'T',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
}
function encodeCard(c: Card): string {
  return `${RANK_CHAR[c.rank]}${c.suit}`
}
function encodeBoard(b: Board): string {
  return [...b.top, ...b.middle, ...b.bottom].map(encodeCard).join('')
}

// ── 1. Which tiers actually trigger bonus rounds? ──────────────────────────
const tierCounts: Record<BonusQualifier, number> = { QQ: 0, KK: 0, AA_OR_TRIPS: 0 }
for (let i = 0; i < TIER_TRIALS; i++) {
  const t = bonusTrigger(playNormalHand(new Deck((rng() * 0x7fffffff) | 0)), CLASSIC_RULES)
  if (t) tierCounts[t]++
}
const totalTriggers = TIERS.reduce((a, t) => a + tierCounts[t], 0)
const weights = TIERS.map(t => tierCounts[t] / totalTriggers)
console.error(`Bonus-trigger tier mix over ${TIER_TRIALS} normal hands (${totalTriggers} triggers):`)
TIERS.forEach((t, i) => console.error(`  ${t.padEnd(12)} ${(100 * weights[i]!).toFixed(1)}%`))

function sampleTier(): BonusQualifier {
  const r = rng()
  let acc = 0
  for (let i = 0; i < TIERS.length; i++) { acc += weights[i]!; if (r < acc) return TIERS[i]! }
  return TIERS[TIERS.length - 1]!
}

// ── 2. Generate the pool ──────────────────────────────────────────────────
console.error(`\nGenerating ${SAMPLE_COUNT} side-game boards (getBotMove sims=${BOT_SIMS})...`)
const t0 = Date.now()
const out: string[] = []
for (let i = 0; i < SAMPLE_COUNT; i++) {
  out.push(encodeBoard(playSideGame(new Deck((rng() * 0x7fffffff) | 0), sampleTier())))
  if ((i + 1) % 100 === 0) process.stderr.write(`  ${i + 1}/${SAMPLE_COUNT}\n`)
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.error(`  n=${SAMPLE_COUNT}  (${elapsed}s)`)

console.log('// Auto-generated by scripts/compute-side-game-samples.ts — do not hand-edit.')
console.log()
console.log('// Each string is 13 two-char card codes: 3 top + 5 middle + 5 bottom.')
console.log('export const SIDE_GAME_SAMPLES: readonly string[] = [')
for (const s of out) console.log(`  '${s}',`)
console.log(']')
