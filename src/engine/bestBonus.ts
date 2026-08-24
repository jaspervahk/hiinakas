import type { Card, Board } from './types'
import type { RNG } from './mc'
import { fastEval5, fastEval3, cmpRank, fastRoyalties, forEachComboIdx } from './fastEvaluate'

// Exhaustive search over all legal 3-5-5 boards from `cards` (13/14/15),
// discarding `numDiscard` (0/1/2). Returns the non-fouled board with the
// highest royalty total (first found wins ties — see bonusOpponentScoring.ts
// for the opponent-aware tie-breaker used by real-gameplay callers; this
// plain version is kept intentionally simple/fast and behaviorally
// unchanged for callers where throughput matters more than kicker-level
// precision, e.g. matchSimulator.ts's bulk bot-vs-bot arena matches and
// simulate.ts's self-play training data generation).
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

// Same exhaustive search as bestBonusBoard, but instead of keeping only the
// first-found max-royalty board, collects a bounded, uniformly-random sample
// of every board that ties for the max royalty (reservoir sampling — works
// without knowing the eventual tie count up front, which can range from
// single digits to several thousand; see bonusOpponentScoring.ts for why
// these ties matter: royalties on middle/bottom are flat per category, so
// many different kicker/card choices routinely tie).
//
// Deliberately a separate loop from bestBonusBoard (not a shared
// callback-based search) so bestBonusBoard's hot bulk-simulation callers
// (matchSimulator.ts, simulate.ts) are completely unaffected by this —
// no added per-candidate callback-invocation overhead in their path.
export interface BonusTieSearchResult {
  readonly bestRoy: number
  readonly ties: readonly Board[] // up to tieCap boards, all achieving bestRoy
}

export function searchBonusBoardTies(
  cards: readonly Card[],
  numDiscard: number,
  rng: RNG,
  tieCap: number,
): BonusTieSearchResult {
  const expected = 13 + numDiscard
  if (cards.length !== expected) {
    throw new Error(`searchBonusBoardTies: expected ${expected} cards for numDiscard=${numDiscard}, got ${cards.length}`)
  }

  let bestRoy = -1
  const ties: Board[] = []
  let seenAtBest = 0 // total count of boards achieving bestRoy seen so far (for reservoir sampling)

  const cardsArr = cards as readonly Card[]
  const total = cardsArr.length

  const consider = (board: Board, roy: number): void => {
    if (roy > bestRoy) {
      bestRoy = roy
      ties.length = 0
      ties.push(board)
      seenAtBest = 1
      return
    }
    if (roy !== bestRoy) return
    seenAtBest++
    if (ties.length < tieCap) {
      ties.push(board)
    } else {
      const j = Math.floor(rng() * seenAtBest)
      if (j < tieCap) ties[j] = board
    }
  }

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
        consider({ top: [t0, t1, t2], middle: [m0, m1, m2, m3, m4], bottom: [b0, b1, b2, b3, b4] }, roy)
      })
    })
  })

  if (ties.length > 0) return { bestRoy, ties }
  // Degenerate fallback (no legal non-fouling board at all) — mirrors
  // bestBonusBoard's own fallback, wrapped as a single-entry tie set.
  const sorted = [...cardsArr].sort((a, b) => b.rank - a.rank).slice(0, 13)
  const fallback: Board = { bottom: sorted.slice(0, 5), middle: sorted.slice(5, 10), top: sorted.slice(10, 13) }
  return { bestRoy: -1, ties: [fallback] }
}
