#!/usr/bin/env tsx
// Solve BONUS_NET for the variant ruleset (recursive bonus rounds + bottom
// straight-flush trigger). Run: npx tsx scripts/compute-variant-bonus-ev.ts
//
// ── The chain ──────────────────────────────────────────────────────────────
//
// Under variant rules a SIDE-GAME player who qualifies starts a further bonus
// round; a 13-15 card bonus board cannot re-trigger. Writing V[p][q] for the
// actor's expected net over the WHOLE chain:
//
//   - Both hold bonus boards -> neither re-triggers, the chain ends, so
//     V[a][b] = R[a][b]. The tier-vs-tier cells are unchanged.
//
//   - Actor holds a bonus board of tier a, opponent plays the side game:
//       x_a := V[a][BASE] = R[a][BASE] + SUM_t P_a(t) * V[BASE][t]
//     P_a(t) is the chance that side game ends in tier t. It is indexed by a
//     because the side-game player's info set includes which tier they are up
//     against, and they play differently when further behind (measured: they
//     foul 28% against a QQ board but 46% against an AA board, gambling more
//     when the board they must beat is stronger).
//
//   - Zero-sum symmetry gives V[BASE][t] = -x_t, so
//       x_a = R[a][BASE] - SUM_t P_a(t) * x_t
//     i.e. the linear system  (I + P) x = R_BASE,  solved exactly below.
//
// Note the SIGN: recursion makes triggering a bonus round worth LESS. The
// follow-up round only happens when the OPPONENT's side game qualifies, which
// puts them on the bonus board and the actor on the side game.
//
// ── The side-game opponent ─────────────────────────────────────────────────
//
// Both R[a][BASE] and P_a(t) are only as meaningful as the side-game player
// they are measured against, and this is easy to get badly wrong.
//
// A side-game player has NO visible opponent: the bonus-board player's board
// is hidden. If their info set says only that, every rollout scores a
// one-board table, scoreTable's pairwise loop never runs, and EVERY candidate
// gets exactly 0 — getBotMove then returns an arbitrary first candidate and
// fouls ~67% of the time. That degenerate case is exactly what
// invisibleBonusOpponents exists to prevent (see mc.ts): it scores the actor
// against a realistic sampled board of the opponent's tier, which restores
// both the royalty and the foul signal. Measured with it, the side-game
// player fouls ~28% and earns ~2.1 royalties rather than ~1.2; without it the
// numbers are meaningless. Always pass it.

import { heuristicPlacement } from '../src/engine/heuristic'
import { bonusTrigger, BONUS_NET, bonusDealCount } from '../src/engine/rules'
import { getBotMove } from '../src/engine/mc'
import { scorePair } from '../src/engine/scoring'
import { bestBonusBoard } from '../src/engine/bestBonus'
import { Deck } from '../src/engine/deck'
import { applyPlacement } from '../src/engine/placement'
import { VARIANT_RULES, CLASSIC_RULES } from '../src/engine/types'
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

const args = process.argv.slice(2)
const getArg = (n: string, d: string) => {
  const i = args.indexOf(`--${n}`)
  return i !== -1 ? (args[i + 1] ?? d) : d
}
const N        = parseInt(getArg('trials', '500'), 10)
const BOT_SIMS = parseInt(getArg('bot-sims', '20'), 10)
const BASELINE = args.includes('--heuristic-opponent')
// Which ruleset the SIDE-GAME player is playing under. Under classic they have
// no reason to chase a qualifying board (re-triggering is disabled, so
// qualifying in a side game is worth nothing); under variant it starts another
// bonus round and is worth chasing. That changes their policy, so the classic
// and variant tables must each be measured under their own rules.
const SIDE_RULES = args.includes('--classic') ? CLASSIC_RULES : VARIANT_RULES
const RULES_LABEL = args.includes('--classic') ? 'CLASSIC' : 'VARIANT'

const TIERS: readonly BonusQualifier[] = ['QQ', 'KK', 'AA_OR_TRIPS']
const DISCARDS: Record<BonusQualifier, number> = { QQ: 0, KK: 1, AA_OR_TRIPS: 2 }
const rng = mulberry32(20260914)
const botRng = mulberry32(55501)

// The side game, played against a hidden bonus board of tier `vs`.
function playSideGame(deck: Deck, vs: BonusQualifier): Board {
  let board: PartialBoard = { top: [], middle: [], bottom: [] }
  const sizes = [5, 3, 3, 3, 3]
  for (let s = 0; s <= 4; s++) {
    const hand = deck.deal(sizes[s]!)
    const pl = BASELINE
      ? heuristicPlacement(board, hand, s)
      : getBotMove({
          board, hand, street: s, revealedOpponentBoards: [], inBonusRound: true,
          invisibleBonusOpponents: [vs], rules: SIDE_RULES,
        }, BOT_SIMS, botRng)
    board = applyPlacement(board, pl)
  }
  return board as Board
}

console.error(`Measuring R[a][BASE] and P_a(t) under ${RULES_LABEL} rules against a ${BASELINE ? 'heuristicPlacement' : `getBotMove (sims=${BOT_SIMS}, invisibleBonusOpponents set)`} side game, n=${N}/tier\n`)

const R: Record<BonusQualifier, number> = { QQ: 0, KK: 0, AA_OR_TRIPS: 0 }
const P: Record<BonusQualifier, Record<BonusQualifier, number>> = {
  QQ: { QQ: 0, KK: 0, AA_OR_TRIPS: 0 },
  KK: { QQ: 0, KK: 0, AA_OR_TRIPS: 0 },
  AA_OR_TRIPS: { QQ: 0, KK: 0, AA_OR_TRIPS: 0 },
}

for (const a of TIERS) {
  let net = 0
  const counts: Record<BonusQualifier, number> = { QQ: 0, KK: 0, AA_OR_TRIPS: 0 }
  for (let i = 0; i < N; i++) {
    const deck = new Deck((rng() * 0x7fffffff) | 0)
    const actor = bestBonusBoard(deck.deal(bonusDealCount(a)), DISCARDS[a])
    const opp = playSideGame(deck, a)
    net += scorePair(actor, opp).aNet
    const t = bonusTrigger(opp, VARIANT_RULES)
    if (t) counts[t]++
    if ((i + 1) % 100 === 0) process.stderr.write(`    ${a}: ${i + 1}/${N}\n`)
  }
  R[a] = net / N
  for (const t of TIERS) P[a][t] = counts[t] / N
  const q = TIERS.reduce((s, t) => s + P[a][t], 0)
  console.error(`  a=${a.padEnd(11)} R[a][BASE]=${R[a].toFixed(3).padStart(7)}  q=${q.toFixed(4)}  (classic table: ${BONUS_NET[a].BASE})`)
}

// Solve (I + P) x = R exactly by Gaussian elimination (3x3).
function solve3(A: number[][], b: number[]): number[] {
  const m = A.map((row, i) => [...row, b[i]!])
  for (let c = 0; c < 3; c++) {
    let piv = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r
    ;[m[c], m[piv]] = [m[piv]!, m[c]!]
    for (let r = 0; r < 3; r++) {
      if (r === c) continue
      const f = m[r]![c]! / m[c]![c]!
      for (let k = c; k <= 3; k++) m[r]![k] = m[r]![k]! - f * m[c]![k]!
    }
  }
  return [0, 1, 2].map(i => m[i]![3]! / m[i]![i]!)
}

// Classic has no recursion: a qualifying side game starts nothing, so the
// chain is one round deep and V[a][BASE] is just R[a][BASE].
const A = TIERS.map((a, i) => TIERS.map((t, j) =>
  (i === j ? 1 : 0) + (SIDE_RULES.allowBonusRecursion ? P[a][t] : 0)))
const x = solve3(A, TIERS.map(a => R[a]))

console.error(`\n=== ${SIDE_RULES.allowBonusRecursion ? 'solved (I + P) x = R' : 'no recursion: V[a][BASE] = R[a][BASE]'} ===`)
TIERS.forEach((a, i) => {
  console.error(`  V[${a.padEnd(11)}][BASE] = ${x[i]!.toFixed(4)}   (R=${R[a].toFixed(3)}, drop ${(R[a] - x[i]!).toFixed(4)})`)
})

console.log(`// Auto-generated by scripts/compute-variant-bonus-ev.ts — do not hand-edit.`)
console.log(`// Variant rules: recursive bonus rounds + bottom straight-flush trigger.`)
console.log(`// Tier-vs-tier cells are identical to BONUS_NET (bonus boards cannot`)
console.log(`// re-trigger, so the chain ends there). BASE solves (I + P) x = R_BASE.`)
console.log(`export const VARIANT_BONUS_NET: Record<BonusQualifier, Record<BonusOppScenario, number>> = {`)
TIERS.forEach((a, i) => {
  const cells = (['BASE', 'QQ', 'KK', 'AA_OR_TRIPS'] as const)
    .map(o => `${o}: ${(o === 'BASE' ? x[i]! : BONUS_NET[a][o]).toFixed(2)}`).join(', ')
  console.log(`  ${a.padEnd(12)}: { ${cells} },`)
})
console.log(`}`)
