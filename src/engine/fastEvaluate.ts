// Fast, allocation-light hand evaluation — shared by bestBonus.ts's
// exhaustive search and the opponent-aware bonus-tie-breaking scorer
// (bonusOpponentScoring.ts). The public evaluate3/evaluate5 (evaluate.ts,
// used by scorePair/isFoul/royalties) are Map-based with comparator sorts;
// measured at ~10-22us/call in the hot loops these functions are used in
// (up to 24 evaluate calls per scorePair, since isFoul/royalties each
// re-evaluate independently). These fixed-size-array, no-Map versions are
// 60-1000x faster — critical for scoring thousands of tied bonus-board
// candidates against hundreds of sampled opponent boards without taking
// seconds. Behavior must stay identical to evaluate.ts; that's covered by
// bestBonusSolver.test.ts's cross-check against scorePair.
import type { Card, HandRank, Rank, Board } from './types'
import { HandCategory } from './types'

export function fastEval5(c0: Card, c1: Card, c2: Card, c3: Card, c4: Card): HandRank {
  const counts = new Int8Array(15)
  counts[c0.rank]++; counts[c1.rank]++; counts[c2.rank]++; counts[c3.rank]++; counts[c4.rank]++
  const flush = c0.suit === c1.suit && c1.suit === c2.suit && c2.suit === c3.suit && c3.suit === c4.suit

  const r = [c0.rank, c1.rank, c2.rank, c3.rank, c4.rank]
  for (let i = 1; i < 5; i++) {
    const v = r[i]!
    let j = i - 1
    while (j >= 0 && r[j]! < v) { r[j + 1] = r[j]!; j-- }
    r[j + 1] = v
  }

  let q4 = 0, q3 = 0, pairHi = 0, pairLo = 0
  const kickers: number[] = []
  for (let rv = 14; rv >= 2; rv--) {
    const c = counts[rv]
    if (c === 4) q4 = rv
    else if (c === 3) q3 = rv
    else if (c === 2) { if (pairHi === 0) pairHi = rv; else if (pairLo === 0) pairLo = rv }
    else if (c === 1) kickers.push(rv)
  }

  let straightHi = 0
  if (r[0]! - r[4]! === 4 && r[0] !== r[1] && r[1] !== r[2] && r[2] !== r[3] && r[3] !== r[4]) {
    straightHi = r[0]!
  } else if (r[0] === 14 && r[1] === 5 && r[2] === 4 && r[3] === 3 && r[4] === 2) {
    straightHi = 5
  }

  if (flush && straightHi !== 0) {
    return straightHi === 14
      ? { category: HandCategory.RoyalFlush, tiebreakers: [] }
      : { category: HandCategory.StraightFlush, tiebreakers: [straightHi as Rank] }
  }
  if (q4 !== 0) return { category: HandCategory.Quads, tiebreakers: [q4 as Rank, kickers[0]! as Rank] }
  if (q3 !== 0 && pairHi !== 0) return { category: HandCategory.FullHouse, tiebreakers: [q3 as Rank, pairHi as Rank] }
  if (flush) return { category: HandCategory.Flush, tiebreakers: r as Rank[] }
  if (straightHi !== 0) return { category: HandCategory.Straight, tiebreakers: [straightHi as Rank] }
  if (q3 !== 0) return { category: HandCategory.Trips, tiebreakers: [q3, ...kickers] as Rank[] }
  if (pairHi !== 0 && pairLo !== 0) return { category: HandCategory.TwoPair, tiebreakers: [pairHi as Rank, pairLo as Rank, kickers[0]! as Rank] }
  if (pairHi !== 0) return { category: HandCategory.OnePair, tiebreakers: [pairHi, ...kickers] as Rank[] }
  return { category: HandCategory.HighCard, tiebreakers: r as Rank[] }
}

export function fastEval3(c0: Card, c1: Card, c2: Card): HandRank {
  const r = [c0.rank, c1.rank, c2.rank]
  for (let i = 1; i < 3; i++) {
    const v = r[i]!
    let j = i - 1
    while (j >= 0 && r[j]! < v) { r[j + 1] = r[j]!; j-- }
    r[j + 1] = v
  }
  if (r[0] === r[1] && r[1] === r[2]) return { category: HandCategory.Trips, tiebreakers: [r[0]!] }
  if (r[0] === r[1]) return { category: HandCategory.OnePair, tiebreakers: [r[0]!, r[2]!] }
  if (r[1] === r[2]) return { category: HandCategory.OnePair, tiebreakers: [r[1]!, r[0]!] }
  return { category: HandCategory.HighCard, tiebreakers: r as Rank[] }
}

// Inline compare (avoids array allocation in tiebreaker loop).
export function cmpRank(a: HandRank, b: HandRank): number {
  if (a.category !== b.category) return a.category > b.category ? 1 : -1
  const al = a.tiebreakers.length, bl = b.tiebreakers.length
  const n = al > bl ? al : bl
  for (let i = 0; i < n; i++) {
    const ar = a.tiebreakers[i] ?? 0
    const br = b.tiebreakers[i] ?? 0
    if (ar !== br) return ar > br ? 1 : -1
  }
  return 0
}

export function fastRoyalties(top: HandRank, mid: HandRank, bot: HandRank): number {
  let total = 0

  if (top.category === HandCategory.Trips) {
    total += 10 + (top.tiebreakers[0]! - 2)
  } else if (top.category === HandCategory.OnePair) {
    const pr = top.tiebreakers[0]!
    if (pr >= 6) total += pr - 5
  }

  switch (mid.category) {
    case HandCategory.Trips:         total += 2; break
    case HandCategory.Straight:      total += 4; break
    case HandCategory.Flush:         total += 8; break
    case HandCategory.FullHouse:     total += 12; break
    case HandCategory.Quads:         total += 20; break
    case HandCategory.StraightFlush: total += 30; break
    case HandCategory.RoyalFlush:    total += 50; break
    default: break
  }

  switch (bot.category) {
    case HandCategory.Straight:      total += 2; break
    case HandCategory.Flush:         total += 4; break
    case HandCategory.FullHouse:     total += 6; break
    case HandCategory.Quads:         total += 10; break
    case HandCategory.StraightFlush: total += 15; break
    case HandCategory.RoyalFlush:    total += 25; break
    default: break
  }
  return total
}

// Iterate over all combinations of `k` indices from [0..n), calling `cb` with
// a stable buffer (do NOT retain across calls).
export function forEachComboIdx(n: number, k: number, cb: (buf: Int32Array) => void): void {
  if (k < 0 || k > n) return
  if (k === 0) { cb(new Int32Array(0)); return }
  const idx = new Int32Array(k)
  for (let i = 0; i < k; i++) idx[i] = i
  while (true) {
    cb(idx)
    let i = k - 1
    while (i >= 0 && idx[i] === n - k + i) i--
    if (i < 0) return
    idx[i]++
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1]! + 1
  }
}

// A board ranked once — top/mid/bot HandRank, foul status, and royalties all
// computed up front so repeated pairwise comparisons (fastScorePair) are pure
// comparisons with zero re-evaluation. Ranking a board and then comparing it
// against many opponents (or vice versa) is exactly the tie-breaking
// scorer's access pattern.
export interface RankedBoard {
  readonly top: HandRank
  readonly mid: HandRank
  readonly bot: HandRank
  readonly fouled: boolean
  readonly royalties: number
}

export function rankBoard(b: Board): RankedBoard {
  const top = fastEval3(b.top[0]!, b.top[1]!, b.top[2]!)
  const mid = fastEval5(b.middle[0]!, b.middle[1]!, b.middle[2]!, b.middle[3]!, b.middle[4]!)
  const bot = fastEval5(b.bottom[0]!, b.bottom[1]!, b.bottom[2]!, b.bottom[3]!, b.bottom[4]!)
  const fouled = cmpRank(top, mid) > 0 || cmpRank(mid, bot) > 0
  const royalties = fouled ? 0 : fastRoyalties(top, mid, bot)
  return { top, mid, bot, fouled, royalties }
}

// scorePair's exact formula (scoring.ts), operating on already-ranked boards.
// `aNet` is A's net vs B: rowScore + aRoy - bRoy, both-bust = 0, one-bust =
// scoop (+/-6, but the non-busting side's royalties still count — a fouled
// board's own royalties are already zeroed in RankedBoard, so aRoy/bRoy
// don't need special-casing here), clean sweep upgrades to +/-6.
export function fastScorePair(a: RankedBoard, b: RankedBoard): number {
  if (a.fouled && b.fouled) return 0
  let rowScore: number
  if (a.fouled) {
    rowScore = -6
  } else if (b.fouled) {
    rowScore = 6
  } else {
    const sum = cmpRank(a.top, b.top) + cmpRank(a.mid, b.mid) + cmpRank(a.bot, b.bot)
    rowScore = sum === 3 ? 6 : sum === -3 ? -6 : sum
  }
  return rowScore + a.royalties - b.royalties
}
