#!/usr/bin/env tsx
// Solve BONUS_NET for the variant ruleset (recursive bonus rounds + bottom
// straight-flush trigger). Run: npx tsx scripts/compute-variant-bonus-ev.ts
//
// Under variant rules a SIDE-GAME player who qualifies starts a further bonus
// round; a 13-15 card bonus board cannot re-trigger. Writing V[p][q] for the
// actor's expected net over the WHOLE chain:
//
//   - Both players hold bonus boards -> neither can re-trigger, the chain ends,
//     so V[a][b] = R[a][b]. The tier-vs-tier cells are unchanged.
//
//   - Actor holds a bonus board, opponent plays a side game:
//       x_a := V[a][BASE] = R[a][BASE] + SUM_t P(t) * V[BASE][t]
//     where P(t) is the chance the side game finishes in tier t. If it does,
//     the next round has THEM on a bonus board and the actor (who just played
//     a bonus board, and so cannot qualify) on a side game.
//
//   - The game is zero-sum and the roles are symmetric, so V[BASE][t] = -x_t:
//       x_a = R[a][BASE] - S,  S := SUM_t P(t) * x_t
//     Substituting x_t = R[t][BASE] - S gives S = M - qS, hence
//       S = M / (1 + q),  q := SUM_t P(t),  M := SUM_t P(t) * R[t][BASE]
//
//   => x_a = R[a][BASE] - M / (1 + q)     (closed form, no iteration)
//
// Note the SIGN: recursion makes triggering a bonus round worth LESS, not
// more. The follow-up round only happens when the OPPONENT's side game
// qualifies, which puts them on the bonus board and the actor on the side
// game. The bonus round now carries retaliation risk.
//
// R[a][BASE] is unchanged from the classic table: side games are played by
// heuristicPlacement, which takes no RuleSet (it is a pure greedy scorer with
// no EV term), and scoring is unchanged. So the only new quantity to measure
// is P(t) under variant triggers.

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
const N_HEURISTIC = parseInt(getArg('trials', '200000'), 10)
const N_BOT       = parseInt(getArg('bot-trials', '400'), 10)
const BOT_SIMS    = parseInt(getArg('bot-sims', '20'), 10)
// Re-measure R[a][BASE] with bot-played side games too. The committed
// BONUS_NET BASE column was measured against heuristicPlacement side games,
// but a real side-game opponent plays like the bot, and the two reach a
// qualifying board at very different rates — so both q AND R[a][BASE] should
// come from the same, realistic policy.
const N_RBASE     = parseInt(getArg('rbase-trials', '0'), 10)

const TIERS: readonly BonusQualifier[] = ['QQ', 'KK', 'AA_OR_TRIPS']
const rng = mulberry32(20260914)

function playSideGameHeuristic(deck: Deck): Board {
  let board: PartialBoard = { top: [], middle: [], bottom: [] }
  const sizes = [5, 3, 3, 3, 3]
  for (let s = 0; s <= 4; s++) {
    board = applyPlacement(board, heuristicPlacement(board, deck.deal(sizes[s]!), s))
  }
  return board as Board
}

// The bot actually plays side games with rollouts, and under variant rules it
// sees value in qualifying — so it should reach a qualifying board more often
// than the greedy heuristic. Measured separately as a sensitivity check.
function playSideGameBot(deck: Deck, r: () => number): Board {
  let board: PartialBoard = { top: [], middle: [], bottom: [] }
  const sizes = [5, 3, 3, 3, 3]
  for (let s = 0; s <= 4; s++) {
    const hand = deck.deal(sizes[s]!)
    const pl = getBotMove(
      { board, hand, street: s, revealedOpponentBoards: [], inBonusRound: true, rules: VARIANT_RULES },
      BOT_SIMS, r,
    )
    board = applyPlacement(board, pl)
  }
  return board as Board
}

function measureP(play: (d: Deck) => Board, n: number, label: string) {
  const counts: Record<BonusQualifier, number> = { QQ: 0, KK: 0, AA_OR_TRIPS: 0 }
  let classicQualified = 0
  for (let i = 0; i < n; i++) {
    const board = play(new Deck((rng() * 0x7fffffff) | 0))
    const t = bonusTrigger(board, VARIANT_RULES)
    if (t) counts[t]++
    if (bonusTrigger(board, CLASSIC_RULES)) classicQualified++
    if ((i + 1) % 20000 === 0) process.stderr.write(`    ${label}: ${i + 1}/${n}\n`)
  }
  const P: Record<BonusQualifier, number> = {
    QQ: counts.QQ / n, KK: counts.KK / n, AA_OR_TRIPS: counts.AA_OR_TRIPS / n,
  }
  const q = P.QQ + P.KK + P.AA_OR_TRIPS
  console.error(`\n${label} (n=${n})`)
  console.error(`  P(QQ)=${P.QQ.toFixed(5)}  P(KK)=${P.KK.toFixed(5)}  P(AA/trips/bottomSF)=${P.AA_OR_TRIPS.toFixed(5)}`)
  console.error(`  q = P(side game qualifies) = ${q.toFixed(5)}   [classic-rule rate: ${(classicQualified / n).toFixed(5)}]`)
  // Binomial standard error on q.
  console.error(`  se(q) ~ ${Math.sqrt(q * (1 - q) / n).toFixed(5)}`)
  return { P, q }
}

console.error('Solving variant BONUS_NET (recursive bonus rounds + bottom straight flush)\n')

const heur = measureP(playSideGameHeuristic, N_HEURISTIC, 'side game played by heuristicPlacement')
const botRng = mulberry32(4242)
const bot = measureP(d => playSideGameBot(d, botRng), N_BOT, `side game played by getBotMove (sims=${BOT_SIMS})`)

function solveWith(
  P: Record<BonusQualifier, number>,
  q: number,
  R: Record<BonusQualifier, number>,
) {
  const M = TIERS.reduce((acc, t) => acc + P[t] * R[t], 0)
  const S = M / (1 + q)
  const x: Record<BonusQualifier, number> = { QQ: 0, KK: 0, AA_OR_TRIPS: 0 }
  for (const t of TIERS) x[t] = R[t] - S
  return { M, S, x }
}
const CLASSIC_RBASE: Record<BonusQualifier, number> = {
  QQ: BONUS_NET.QQ.BASE, KK: BONUS_NET.KK.BASE, AA_OR_TRIPS: BONUS_NET.AA_OR_TRIPS.BASE,
}
const solve = (P: Record<BonusQualifier, number>, q: number) => solveWith(P, q, CLASSIC_RBASE)

for (const [label, m] of [['heuristic', heur], ['bot', bot]] as const) {
  const { M, S, x } = solve(m.P, m.q)
  console.error(`\n=== solved from the ${label} side-game distribution ===`)
  console.error(`  M = SUM P(t)*R[t][BASE] = ${M.toFixed(4)}`)
  console.error(`  S = M/(1+q)             = ${S.toFixed(4)}   <- every BASE cell drops by this`)
  for (const t of TIERS) {
    console.error(`  V[${t.padEnd(11)}][BASE] = ${BONUS_NET[t].BASE.toFixed(2)} - ${S.toFixed(4)} = ${x[t].toFixed(4)}`)
  }
}

// Optionally re-measure R[a][BASE] against bot-played side games.
const DISCARDS: Record<BonusQualifier, number> = { QQ: 0, KK: 1, AA_OR_TRIPS: 2 }
if (N_RBASE > 0) {
  const r2 = mulberry32(99881)
  const rBase: Record<BonusQualifier, number> = { QQ: 0, KK: 0, AA_OR_TRIPS: 0 }
  for (const tier of TIERS) {
    let total = 0
    for (let i = 0; i < N_RBASE; i++) {
      const deck = new Deck((rng() * 0x7fffffff) | 0)
      const actor = bestBonusBoard(deck.deal(bonusDealCount(tier)), DISCARDS[tier])
      const opp = playSideGameBot(deck, r2)
      total += scorePair(actor, opp).aNet
      if ((i + 1) % 50 === 0) process.stderr.write(`    R[${tier}][BASE]: ${i + 1}/${N_RBASE}\n`)
    }
    rBase[tier] = total / N_RBASE
    console.error(`  R[${tier.padEnd(11)}][BASE] vs BOT side game = ${rBase[tier].toFixed(3)}  (n=${N_RBASE}, classic table says ${BONUS_NET[tier].BASE})`)
  }
  const { M, S, x } = solveWith(bot.P, bot.q, rBase)
  console.error(`\n=== solved from BOT side games throughout (the realistic combination) ===`)
  console.error(`  M = ${M.toFixed(4)}   S = M/(1+q) = ${S.toFixed(4)}`)
  for (const t of TIERS) console.error(`  V[${t.padEnd(11)}][BASE] = ${rBase[t].toFixed(3)} - ${S.toFixed(4)} = ${x[t].toFixed(4)}`)
}

// Emit the shipped table: the BOT side-game distribution (a real opponent plays
// like the bot, not like the greedy heuristic, and the two differ ~10x on q)
// combined with the CLASSIC R[a][BASE] values, which were measured over
// 3000/1200 trials rather than this script's --rbase-trials. Re-measuring R
// against bot side games moves it by about one standard error, so the more
// precise numbers are kept; S is insensitive to the choice either way.
const { S, x } = solve(bot.P, bot.q)
console.log(`// Auto-generated by scripts/compute-variant-bonus-ev.ts — do not hand-edit.`)
console.log(`// Variant rules: recursive bonus rounds + bottom straight-flush trigger.`)
console.log(`// Tier-vs-tier cells are identical to BONUS_NET (bonus boards cannot`)
console.log(`// re-trigger, so the chain ends there). Every BASE cell is reduced by`)
console.log(`// S = M/(1+q) = ${S.toFixed(4)}, the expected cost of handing the opponent a`)
console.log(`// bonus round when their side game qualifies (q = ${bot.q.toFixed(5)}).`)
console.log(`export const VARIANT_BONUS_NET: Record<BonusQualifier, Record<BonusOppScenario, number>> = {`)
for (const t of TIERS) {
  const cells = (['BASE', 'QQ', 'KK', 'AA_OR_TRIPS'] as const)
    .map(o => `${o}: ${(o === 'BASE' ? x[t] : BONUS_NET[t][o]).toFixed(2)}`)
    .join(', ')
  console.log(`  ${t.padEnd(12)}: { ${cells} },`)
}
console.log(`}`)
