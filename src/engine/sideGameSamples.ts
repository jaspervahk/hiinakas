// Decodes the static side-game sample boards (see
// scripts/compute-side-game-samples.ts for how they're generated and why)
// once at module load. Mirrors bonusOpponentSamples.ts's decode pattern —
// kept as a separate module since this pool represents a different opponent
// scenario (a non-qualifying player's final side-game board, not a
// bonus-eligible player's one-shot board).
import type { Board } from './types'
import { parseCard } from './deck'
import { SIDE_GAME_SAMPLES } from './sideGameSamplesData'

function decodeBoard(encoded: string): Board {
  const cards = []
  for (let i = 0; i < encoded.length; i += 2) cards.push(parseCard(encoded.slice(i, i + 2)))
  return { top: cards.slice(0, 3), middle: cards.slice(3, 8), bottom: cards.slice(8, 13) }
}

const DECODED: readonly Board[] = SIDE_GAME_SAMPLES.map(decodeBoard)

export function getSideGamePool(): readonly Board[] {
  return DECODED
}
