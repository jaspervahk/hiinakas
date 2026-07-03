import type { PartialBoard, Board } from './types'
import { isFoul } from './rules'
import { evaluate3, evaluate5, compareHandRank } from './evaluate'
import { applyPlacement } from './placement'
import type { Placement } from './placement'

// Returns true when already-complete row pairs in a partial board provably
// violate top ≤ middle ≤ bottom, regardless of what fills the remaining slots.
//
// Three sufficient conditions (each independently conclusive):
//   1. top(3) and middle(5) both complete and top > middle
//   2. middle(5) and bottom(5) both complete and middle > bottom
//   3. top(3) and bottom(5) both complete (middle not yet) and top > bottom
//      — because no value of middle can satisfy top ≤ middle AND middle ≤ bottom
//        when top > bottom.
function guaranteedFoulPartial(board: PartialBoard): boolean {
  const topFull = board.top.length    === 3
  const midFull = board.middle.length === 5
  const botFull = board.bottom.length === 5

  if (topFull && midFull) {
    if (compareHandRank(evaluate3(board.top), evaluate5(board.middle)) > 0) return true
  }
  if (midFull && botFull) {
    if (compareHandRank(evaluate5(board.middle), evaluate5(board.bottom)) > 0) return true
  }
  if (topFull && botFull && !midFull) {
    if (compareHandRank(evaluate3(board.top), evaluate5(board.bottom)) > 0) return true
  }
  return false
}

// Returns the subset of placements that cannot be proven to guarantee a foul.
//
// Street 4 (last): the board is complete after placement — isFoul is definitive.
// Earlier streets: only prunes when already-complete row pairs violate ordering.
//   This is conservative: it never prunes a genuinely safe option, but may leave
//   some guaranteed-foul options in place when they cannot be detected yet.
//
// Falls back to the full list when every option is guaranteed-foul, so callers
// always receive at least one option to play.
export function foulSafePlacements(
  board: PartialBoard,
  placements: Placement[],
  street: number,
): Placement[] {
  if (placements.length <= 1) return placements

  const safe = placements.filter(p => {
    const after = applyPlacement(board, p)
    if (street === 4) return !isFoul(after as Board)
    return !guaranteedFoulPartial(after)
  })

  return safe.length > 0 ? safe : placements
}
