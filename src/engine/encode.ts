// Feature encoding for the value network.
//
// Encodes a board state (after placement) as a fixed 473-dim Float32Array:
//   - 9 card rows × 52 binary features (own top/mid/bot + up to 2 opp top/mid/bot)
//   - 5 street one-hot features
//
// The "after placement" convention means hand is empty; the NN learns
// V(board_after_placing, opp_boards_visible, street) → expected net score.
// At inference time: enumerate legal placements, encode state-after each, pick argmax.

import type { Card, PartialBoard } from './types'
import type { InfoState } from './mc'

export const ENCODE_DIM = 9 * 52 + 5   // 473

function cardIdx(c: Card): number {
  const suitOrd: Record<string, number> = { s: 0, c: 1, h: 2, d: 3 }
  return (suitOrd[c.suit] ?? 0) * 13 + (c.rank - 2)
}

function fillRow(buf: Float32Array, offset: number, cards: readonly Card[]): void {
  for (const c of cards) buf[offset + cardIdx(c)] = 1
}

// Encode a board state produced after a placement decision.
// oppBoards: opponent boards as revealed at the start of this street (0–2 entries).
export function encodeBoardState(
  board: PartialBoard,
  street: number,
  oppBoards: readonly PartialBoard[],
): Float32Array {
  const buf = new Float32Array(ENCODE_DIM)
  let off = 0

  // Own board (3 rows)
  fillRow(buf, off, board.top);    off += 52
  fillRow(buf, off, board.middle); off += 52
  fillRow(buf, off, board.bottom); off += 52

  // Street one-hot (5 dims)
  buf[off + Math.min(street, 4)] = 1; off += 5

  // Opponent boards (up to 2, zero-padded for 2-player games)
  for (let i = 0; i < 2; i++) {
    const b: PartialBoard = oppBoards[i] ?? { top: [], middle: [], bottom: [] }
    fillRow(buf, off, b.top);    off += 52
    fillRow(buf, off, b.middle); off += 52
    fillRow(buf, off, b.bottom); off += 52
  }

  return buf
}

// Convenience wrapper for encoding from an InfoState (ignores the hand field).
// Used when the InfoState has hand=[] (i.e., after-placement state).
export function encodeInfoState(info: InfoState): Float32Array {
  return encodeBoardState(info.board, info.street, info.revealedOpponentBoards)
}
