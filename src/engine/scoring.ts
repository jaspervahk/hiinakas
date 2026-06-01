import type { Board, PairResult } from './types'
import { isFoul, royalties } from './rules'
import { evaluate3, evaluate5, compareHandRank } from './evaluate'

// ── Pairwise scoring ───────────────────────────────────────────────────────
//
// Formula (per spec):
//   pairingRowScore + aRoyalties - bRoyalties
// where pairingRowScore:
//   both bust      → 0
//   a bust only    → -6 (b "scoops" a via bust)
//   b bust only    → +6 (a "scoops" b via bust)
//   neither bust   → sum of per-row results (±1 each), upgraded to ±6 on a clean sweep

export function scorePair(boardA: Board, boardB: Board): PairResult {
  const aFoul = isFoul(boardA)
  const bFoul = isFoul(boardB)

  if (aFoul && bFoul) return { aNet: 0, bNet: 0 }

  const aRoy = aFoul ? 0 : royalties(boardA)
  const bRoy = bFoul ? 0 : royalties(boardB)

  let rowScore: number // from A's perspective
  if (aFoul) {
    rowScore = -6
  } else if (bFoul) {
    rowScore = +6
  } else {
    const topCmp = compareHandRank(evaluate3(boardA.top), evaluate3(boardB.top))
    const midCmp = compareHandRank(evaluate5(boardA.middle), evaluate5(boardB.middle))
    const botCmp = compareHandRank(evaluate5(boardA.bottom), evaluate5(boardB.bottom))
    const sum = topCmp + midCmp + botCmp
    // Clean sweep (±3) upgrades to scoop (±6)
    rowScore = sum === 3 ? 6 : sum === -3 ? -6 : sum
  }

  const aNet = rowScore + aRoy - bRoy
  return { aNet, bNet: -aNet }
}

// ── Table scoring (2- or 3-player) ────────────────────────────────────────
// Returns per-player net scores; the array sums to 0 (zero-sum guarantee).

export function scoreTable(boards: Board[]): number[] {
  const nets = new Array<number>(boards.length).fill(0)
  for (let i = 0; i < boards.length; i++) {
    for (let j = i + 1; j < boards.length; j++) {
      const { aNet, bNet } = scorePair(boards[i]!, boards[j]!)
      nets[i]! += aNet
      nets[j]! += bNet
    }
  }
  return nets
}
