import type { Board, PairResult } from './types'
import { rankBoard, fastScorePair } from './fastEvaluate'
import type { RankedBoard } from './fastEvaluate'
import { evaluate3, evaluate5, compareHandRank } from './evaluate'
import { topRoyalty, middleRoyalty, bottomRoyalty } from './rules'

// rankBoard reads its cards positionally, so it requires a genuinely complete
// 3-5-5 board. Most callers guarantee that, but not all: the analyzer lets a
// user describe any position they like, including a later street with rows
// that aren't filled in yet, and the evaluate.ts path these functions used to
// take returned a (meaningless but harmless) answer for those rather than
// reading past the end of a row. Incomplete boards therefore keep the old
// tolerant behavior; the three length checks are free next to the
// re-evaluation they replace.
function rankBoardTolerant(b: Board): RankedBoard {
  if (b.top.length === 3 && b.middle.length === 5 && b.bottom.length === 5) {
    return rankBoard(b)
  }
  const top = evaluate3(b.top)
  const mid = evaluate5(b.middle)
  const bot = evaluate5(b.bottom)
  const fouled = compareHandRank(top, mid) > 0 || compareHandRank(mid, bot) > 0
  const royalties = fouled
    ? 0
    : topRoyalty(b.top) + middleRoyalty(b.middle) + bottomRoyalty(b.bottom)
  return { top, mid, bot, fouled, royalties }
}

// ── Pairwise scoring ───────────────────────────────────────────────────────
//
// Formula (per spec):
//   pairingRowScore + aRoyalties - bRoyalties
// where pairingRowScore:
//   both bust      → 0
//   a bust only    → -6 (b "scoops" a via bust)
//   b bust only    → +6 (a "scoops" b via bust)
//   neither bust   → sum of per-row results (±1 each), upgraded to ±6 on a clean sweep

// Each board is ranked once — top/middle/bottom HandRank, foul status and
// royalties together — and the formula then runs on those ranks. It used to
// evaluate every row about three times per call: isFoul evaluated all three
// rows, royalties re-evaluated them (via its own isFoul plus the three
// per-row royalty functions), and the row comparisons evaluated them a third
// time. The formula itself is unchanged; fastScorePair is the same
// expression over already-ranked boards, cross-checked against a reference
// implementation in scoringFastPath.test.ts.
export function scorePair(boardA: Board, boardB: Board): PairResult {
  const aNet = fastScorePair(rankBoardTolerant(boardA), rankBoardTolerant(boardB))
  // Negating a zero net (both boards fouled) would hand back -0, which is
  // numerically equal to 0 but not Object.is-equal to it — enough to fail a
  // strict toBe(0) and to surface as "-0" anywhere a net is stringified.
  return { aNet, bNet: aNet === 0 ? 0 : -aNet }
}

// ── Table scoring (2- or 3-player) ────────────────────────────────────────
// Returns per-player net scores; the array sums to 0 (zero-sum guarantee).

export function scoreTable(boards: Board[]): number[] {
  const n = boards.length
  const nets = new Array<number>(n).fill(0)
  // Rank each board once for the whole table rather than once per pairing:
  // in a 3-player table every board takes part in two pairings, so going
  // through scorePair ranked all of them twice.
  const ranked = boards.map(rankBoardTolerant)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const aNet = fastScorePair(ranked[i]!, ranked[j]!)
      nets[i]! += aNet
      nets[j]! -= aNet // zero-sum by construction: bNet is always -aNet
    }
  }
  return nets
}
