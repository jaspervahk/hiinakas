import type { Card, PartialBoard } from './types'

export interface Placement {
  readonly topAdd: readonly Card[]
  readonly middleAdd: readonly Card[]
  readonly bottomAdd: readonly Card[]
  readonly discard: Card | null // null on street 0
}

// Apply a placement to a partial board, returning the updated board.
export function applyPlacement(board: PartialBoard, p: Placement): PartialBoard {
  return {
    top:    [...board.top,    ...p.topAdd],
    middle: [...board.middle, ...p.middleAdd],
    bottom: [...board.bottom, ...p.bottomAdd],
  }
}

// ── Legal placement enumeration ────────────────────────────────────────────
//
// Street 0: place all 5 dealt cards (no discard).
// Streets 1-4: pick 1 of 3 to discard, place the other 2.
// Returns all valid assignments. Cards within a row are unordered (sets),
// so each assignment of specific card→row is a distinct placement.

export function legalPlacements(
  board: PartialBoard,
  dealt: readonly Card[],
  street: number,
): Placement[] {
  const topSpace    = 3 - board.top.length
  const middleSpace = 5 - board.middle.length
  const bottomSpace = 5 - board.bottom.length

  if (street === 0) {
    const result: Placement[] = []
    placeAll(dealt as Card[], 0, [], [], [], topSpace, middleSpace, bottomSpace, result)
    return result
  }

  // Streets 1-4: choose 1 discard, place the other 2
  const result: Placement[] = []
  for (let d = 0; d < dealt.length; d++) {
    const discard = dealt[d]!
    const toPlace: Card[] = []
    for (let i = 0; i < dealt.length; i++) {
      if (i !== d) toPlace.push(dealt[i]!)
    }
    placeAll(toPlace, 0, [], [], [], topSpace, middleSpace, bottomSpace, result, discard)
  }
  return result
}

function placeAll(
  cards: Card[],
  idx: number,
  topAdd: Card[],
  midAdd: Card[],
  botAdd: Card[],
  topSpace: number,
  midSpace: number,
  botSpace: number,
  out: Placement[],
  discard: Card | null = null,
): void {
  if (idx === cards.length) {
    out.push({ topAdd: [...topAdd], middleAdd: [...midAdd], bottomAdd: [...botAdd], discard })
    return
  }
  const card = cards[idx]!
  if (topAdd.length < topSpace) {
    topAdd.push(card)
    placeAll(cards, idx + 1, topAdd, midAdd, botAdd, topSpace, midSpace, botSpace, out, discard)
    topAdd.pop()
  }
  if (midAdd.length < midSpace) {
    midAdd.push(card)
    placeAll(cards, idx + 1, topAdd, midAdd, botAdd, topSpace, midSpace, botSpace, out, discard)
    midAdd.pop()
  }
  if (botAdd.length < botSpace) {
    botAdd.push(card)
    placeAll(cards, idx + 1, topAdd, midAdd, botAdd, topSpace, midSpace, botSpace, out, discard)
    botAdd.pop()
  }
}
