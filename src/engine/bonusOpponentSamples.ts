// Decodes the static bonus-opponent sample boards (see
// scripts/compute-bonus-samples.ts for how they're generated and why) and
// exposes a cheap random-pick accessor for mc.ts's rollout(). Decoding
// happens once at module load — every rollout just wants a ready Board, not
// a re-parsed string.
import type { Board, BonusQualifier } from './types'
import { parseCard } from './deck'
import { BONUS_OPPONENT_SAMPLES } from './bonusOpponentSamplesData'

function decodeBoard(encoded: string): Board {
  const cards = []
  for (let i = 0; i < encoded.length; i += 2) cards.push(parseCard(encoded.slice(i, i + 2)))
  return { top: cards.slice(0, 3), middle: cards.slice(3, 8), bottom: cards.slice(8, 13) }
}

const DECODED: Record<BonusQualifier, readonly Board[]> = {
  QQ: BONUS_OPPONENT_SAMPLES.QQ.map(decodeBoard),
  KK: BONUS_OPPONENT_SAMPLES.KK.map(decodeBoard),
  AA_OR_TRIPS: BONUS_OPPONENT_SAMPLES.AA_OR_TRIPS.map(decodeBoard),
}

// One realistic (optimally-played) bonus board for `tier`, drawn uniformly
// at random via `rng`. Deterministic for a given rng sequence.
export function sampleBonusOpponentBoard(tier: BonusQualifier, rng: () => number): Board {
  const samples = DECODED[tier]
  return samples[Math.floor(rng() * samples.length)]!
}

// The full decoded pool for `tier` — used by bonusOpponentScoring.ts's
// tie-breaking solver, which (unlike mc.ts's single-pick-per-rollout use
// above) wants to average a candidate's performance across the whole pool.
export function getBonusOpponentPool(tier: BonusQualifier): readonly Board[] {
  return DECODED[tier]
}
