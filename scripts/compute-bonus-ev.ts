#!/usr/bin/env tsx
// Compute expected royalties from optimal bonus game play for each qualifier type.
// Run with: npx tsx scripts/compute-bonus-ev.ts
//
// Output: avg_royalties per qualifier. Subtract 2 to get the net reward constant
// used in royalty NN training (the 2 accounts for the side-game opponent EV).

import { bestBonusBoard } from '../src/engine/bestBonus'
import { royalties, isFoul } from '../src/engine/rules'
import { Deck } from '../src/engine/deck'

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

const rng = mulberry32(12345)

function simulate(dealCount: number, numDiscard: number, n: number, label: string): number {
  let royaltyTotal = 0
  let foulCount = 0
  const t0 = Date.now()
  for (let i = 0; i < n; i++) {
    const seed = (rng() * 0x7fffffff) | 0
    const deck = new Deck(seed)
    const cards = deck.deal(dealCount)
    const board = bestBonusBoard(cards, numDiscard)
    if (isFoul(board)) {
      foulCount++
    } else {
      royaltyTotal += royalties(board)
    }
  }
  const avg = royaltyTotal / n
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(
    `${label}:\n  n=${n}  avg_royalties=${avg.toFixed(3)}  net_ev=${(avg - 2).toFixed(3)}` +
    `  foul_rate=${(foulCount / n * 100).toFixed(1)}%  time=${elapsed}s`
  )
  return avg
}

console.log('Computing bonus game EV constants (bestBonusBoard royalties averaged over random deals)...\n')
const qqAvg        = simulate(13, 0, 200, 'QQ        (13 cards, 0 discards)')
const kkAvg        = simulate(14, 1,  80, 'KK        (14 cards, 1 discard) ')
const aaTripsAvg   = simulate(15, 2,  25, 'AA/Trips  (15 cards, 2 discards)')

console.log('\n── Summary (round to 1 decimal, subtract 2 for net reward) ────────────')
console.log(`BONUS_EV_QQ        = ${(qqAvg - 2).toFixed(1)}   // avg_royalties=${qqAvg.toFixed(1)}`)
console.log(`BONUS_EV_KK        = ${(kkAvg - 2).toFixed(1)}   // avg_royalties=${kkAvg.toFixed(1)}`)
console.log(`BONUS_EV_AA_TRIPS  = ${(aaTripsAvg - 2).toFixed(1)}   // avg_royalties=${aaTripsAvg.toFixed(1)}`)
