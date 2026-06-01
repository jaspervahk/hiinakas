import type { Card, Board, HandRank, Rank } from './types'
import { HandCategory } from './types'

// ── Fast inline 5-card evaluator (no Map allocation) ──────────────────────
//
// Mirrors the semantics of evaluate5 but uses fixed-size arrays.
// Used in the hot bonus-solver loop.
function fastEval5(c0: Card, c1: Card, c2: Card, c3: Card, c4: Card): HandRank {
  // Rank counts indexed by rank (2..14 → indices 2..14)
  const counts = new Int8Array(15)
  counts[c0.rank]++
  counts[c1.rank]++
  counts[c2.rank]++
  counts[c3.rank]++
  counts[c4.rank]++

  const flush = c0.suit === c1.suit && c1.suit === c2.suit && c2.suit === c3.suit && c3.suit === c4.suit

  // Sort ranks desc (insertion sort on 5 elements)
  const r = [c0.rank, c1.rank, c2.rank, c3.rank, c4.rank]
  for (let i = 1; i < 5; i++) {
    const v = r[i]!
    let j = i - 1
    while (j >= 0 && r[j]! < v) { r[j + 1] = r[j]!; j-- }
    r[j + 1] = v
  }

  // Frequency descriptors (0 = none)
  let q4 = 0, q3 = 0
  let pairHi = 0, pairLo = 0
  const kickers: number[] = []
  for (let rv = 14; rv >= 2; rv--) {
    const c = counts[rv]
    if (c === 4) q4 = rv
    else if (c === 3) q3 = rv
    else if (c === 2) {
      if (pairHi === 0) pairHi = rv
      else if (pairLo === 0) pairLo = rv
    } else if (c === 1) kickers.push(rv)
  }

  // Straight detection
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
  if (q4 !== 0) {
    const kicker = kickers[0]!
    return { category: HandCategory.Quads, tiebreakers: [q4 as Rank, kicker as Rank] }
  }
  if (q3 !== 0 && pairHi !== 0) {
    return { category: HandCategory.FullHouse, tiebreakers: [q3 as Rank, pairHi as Rank] }
  }
  if (flush) {
    return { category: HandCategory.Flush, tiebreakers: r as Rank[] }
  }
  if (straightHi !== 0) {
    return { category: HandCategory.Straight, tiebreakers: [straightHi as Rank] }
  }
  if (q3 !== 0) {
    return { category: HandCategory.Trips, tiebreakers: [q3, ...kickers] as Rank[] }
  }
  if (pairHi !== 0 && pairLo !== 0) {
    const kicker = kickers[0]!
    return { category: HandCategory.TwoPair, tiebreakers: [pairHi as Rank, pairLo as Rank, kicker as Rank] }
  }
  if (pairHi !== 0) {
    return { category: HandCategory.OnePair, tiebreakers: [pairHi, ...kickers] as Rank[] }
  }
  return { category: HandCategory.HighCard, tiebreakers: r as Rank[] }
}

function fastEval3(c0: Card, c1: Card, c2: Card): HandRank {
  const r = [c0.rank, c1.rank, c2.rank]
  for (let i = 1; i < 3; i++) {
    const v = r[i]!
    let j = i - 1
    while (j >= 0 && r[j]! < v) { r[j + 1] = r[j]!; j-- }
    r[j + 1] = v
  }
  if (r[0] === r[1] && r[1] === r[2]) {
    return { category: HandCategory.Trips, tiebreakers: [r[0]!] }
  }
  if (r[0] === r[1]) {
    return { category: HandCategory.OnePair, tiebreakers: [r[0]!, r[2]!] }
  }
  if (r[1] === r[2]) {
    return { category: HandCategory.OnePair, tiebreakers: [r[1]!, r[0]!] }
  }
  return { category: HandCategory.HighCard, tiebreakers: r as Rank[] }
}

// Inline compare (avoids array allocation in tiebreaker loop)
function cmpRank(a: HandRank, b: HandRank): number {
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

function fastRoyalties(top: HandRank, mid: HandRank, bot: HandRank): number {
  let total = 0

  // Top
  if (top.category === HandCategory.Trips) {
    total += 10 + (top.tiebreakers[0]! - 2)
  } else if (top.category === HandCategory.OnePair) {
    const pr = top.tiebreakers[0]!
    if (pr >= 6) total += pr - 5
  }

  // Middle
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

  // Bottom
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
function forEachComboIdx(n: number, k: number, cb: (buf: Int32Array) => void): void {
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

// Exhaustive search over all legal 3-5-5 boards from `cards` (13/14/15),
// discarding `numDiscard` (0/1/2). Returns the non-fouled board with the
// highest royalty total.
export function bestBonusBoard(cards: readonly Card[], numDiscard: number): Board {
  const expected = 13 + numDiscard
  if (cards.length !== expected) {
    throw new Error(`bestBonusBoard: expected ${expected} cards for numDiscard=${numDiscard}, got ${cards.length}`)
  }

  let bestBoard: Board | null = null
  let bestRoy = -1

  const cardsArr = cards as readonly Card[]
  const total = cardsArr.length

  forEachComboIdx(total, 13, (toPlaceIdx) => {
    const toPlace: Card[] = new Array(13)
    for (let i = 0; i < 13; i++) toPlace[i] = cardsArr[toPlaceIdx[i]!]!

    forEachComboIdx(13, 5, (botIdx) => {
      const b0 = toPlace[botIdx[0]!]!, b1 = toPlace[botIdx[1]!]!,
            b2 = toPlace[botIdx[2]!]!, b3 = toPlace[botIdx[3]!]!,
            b4 = toPlace[botIdx[4]!]!
      const botRank = fastEval5(b0, b1, b2, b3, b4)

      const inBot = new Uint8Array(13)
      inBot[botIdx[0]!] = 1; inBot[botIdx[1]!] = 1; inBot[botIdx[2]!] = 1
      inBot[botIdx[3]!] = 1; inBot[botIdx[4]!] = 1

      const remaining8Idx = new Int32Array(8)
      {
        let w = 0
        for (let i = 0; i < 13; i++) if (!inBot[i]) remaining8Idx[w++] = i
      }

      forEachComboIdx(8, 5, (midSel) => {
        const m0 = toPlace[remaining8Idx[midSel[0]!]!]!
        const m1 = toPlace[remaining8Idx[midSel[1]!]!]!
        const m2 = toPlace[remaining8Idx[midSel[2]!]!]!
        const m3 = toPlace[remaining8Idx[midSel[3]!]!]!
        const m4 = toPlace[remaining8Idx[midSel[4]!]!]!
        const midRank = fastEval5(m0, m1, m2, m3, m4)
        if (cmpRank(midRank, botRank) > 0) return

        const inMid = new Uint8Array(8)
        inMid[midSel[0]!] = 1; inMid[midSel[1]!] = 1; inMid[midSel[2]!] = 1
        inMid[midSel[3]!] = 1; inMid[midSel[4]!] = 1

        let t0: Card | undefined, t1: Card | undefined, t2: Card | undefined
        for (let i = 0; i < 8; i++) {
          if (inMid[i]) continue
          const c = toPlace[remaining8Idx[i]!]!
          if (!t0) t0 = c
          else if (!t1) t1 = c
          else t2 = c
        }
        if (!t0 || !t1 || !t2) return

        const topRank = fastEval3(t0, t1, t2)
        if (cmpRank(topRank, midRank) > 0) return

        const roy = fastRoyalties(topRank, midRank, botRank)
        if (roy > bestRoy) {
          bestRoy = roy
          bestBoard = {
            top: [t0, t1, t2],
            middle: [m0, m1, m2, m3, m4],
            bottom: [b0, b1, b2, b3, b4],
          }
        }
      })
    })
  })

  if (bestBoard) return bestBoard
  const sorted = [...cardsArr].sort((a, b) => b.rank - a.rank).slice(0, 13)
  return {
    bottom: sorted.slice(0, 5),
    middle: sorted.slice(5, 10),
    top:    sorted.slice(10, 13),
  }
}

