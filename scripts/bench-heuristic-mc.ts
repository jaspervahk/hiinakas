// Ad-hoc benchmark for Setthirteen Phase 0 audit — NOT part of the app.
// Measures p50/p95 decision time of getBotMove() (Heuristic MC, the
// confirmed champion policy) at street 0 (5-card, worst case) and street 1
// (3-card) across candidate sims settings, single-threaded Node.
// Run: npx tsx scripts/bench-heuristic-mc.ts

import { getBotMove, fisherYates, type InfoState } from '../src/engine/mc'
import { FULL_DECK } from '../src/engine/deck'
import type { Card } from '../src/engine/types'

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function dealHands(rng: () => number, street: 0 | 1, players: 2 | 3) {
  const deck = fisherYates([...FULL_DECK] as Card[], rng)
  let i = 0
  const n = street === 0 ? 5 : 3
  const hands: Card[][] = []
  for (let p = 0; p < players; p++) { hands.push(deck.slice(i, i + n)); i += n }
  return hands
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]!
}

function bench(label: string, street: 0 | 1, players: 2 | 3, sims: number, trials: number) {
  const rng = mulberry32(42)
  const times: number[] = []
  for (let t = 0; t < trials; t++) {
    const hands = dealHands(rng, street, players)
    const state: InfoState = {
      board: { top: [], middle: [], bottom: [] },
      hand: hands[0]!,
      street,
      revealedOpponentBoards: hands.slice(1).map(() => ({ top: [], middle: [], bottom: [] })),
    }
    const t0 = performance.now()
    getBotMove(state, sims, rng)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const p50 = percentile(times, 50)
  const p95 = percentile(times, 95)
  console.log(
    `${label.padEnd(28)} sims=${String(sims).padStart(5)} players=${players}  p50=${p50.toFixed(0).padStart(6)}ms  p95=${p95.toFixed(0).padStart(6)}ms  max=${times[times.length - 1]!.toFixed(0)}ms`,
  )
}

console.log('Heuristic MC decision-time benchmark (Node, single-threaded, no WASM)\n')

for (const sims of [10, 20, 50, 100]) {
  bench('street 0 (5-card, 2p)', 0, 2, sims, 15)
}
for (const sims of [10, 20, 50, 100]) {
  bench('street 0 (5-card, 3p)', 0, 3, sims, 15)
}
for (const sims of [20, 50, 100, 200]) {
  bench('street 1 (3-card, 2p)', 1, 2, sims, 15)
}
