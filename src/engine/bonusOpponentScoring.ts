// The opponent-aware bonus-board solver: picks, among every board that ties
// for the max royalty (see bestBonus.ts's searchBonusBoardTies — these ties
// are common and sometimes number in the thousands, since middle/bottom
// royalties are flat per category), the one that performs best against a
// field of opponent boards. See scripts/compute-bonus-samples.ts and
// scripts/compute-side-game-samples.ts for where the sample pools this
// compares against come from.
//
// Performance: naively calling scorePair (scoring.ts) here would cost
// seconds (measured ~10-22us/call, up to 24 redundant slow evaluate3/
// evaluate5 calls per invocation). Every board here is ranked exactly once
// via fastEvaluate.ts's rankBoard (opponent-pool boards are ranked once at
// module load and reused across every call; each tied candidate is ranked
// once per solve), then compared via fastScorePair's near-zero-cost pure
// comparison — this is what keeps thousands of candidates x full
// thousand-board opponent pools well under 100ms.
import type { Board, BonusQualifier, Card } from './types'
import type { RNG } from './mc'
import { searchBonusBoardTies } from './bestBonus'
import { rankBoard, fastScorePair, type RankedBoard } from './fastEvaluate'
import { getBonusOpponentPool } from './bonusOpponentSamples'
import { getSideGamePool } from './sideGameSamples'

// A real opponent's situation, as far as this decision's info-set hygiene
// allows it to be known:
//  - {tier}: known to be bonus-eligible at this tier, exact cards unknown —
//    scored against a sample of realistic boards for that tier.
//  - 'side': known to be playing the non-qualifying side game — scored
//    against a sample of realistic side-game final boards.
//  - {board}: exact final board already known (e.g. historical/replay
//    analysis) — scored directly, no sampling needed, strictly more
//    accurate than either sampled scenario above when available.
// Any 2-player or 3-player combination is just an array of 0, 1, or 2 of
// these — the algorithm below is a plain loop, so every combination (both
// bonus-eligible, both side-game, one of each, exact boards mixed with
// scenarios, etc.) is handled without special-casing.
export type OpponentRef =
  | { readonly tier: BonusQualifier }
  | 'side'
  | { readonly board: Board }

// Reservoir-sampling tie cap — see bestBonus.ts's searchBonusBoardTies.
// Comfortably above the observed worst case (3712 raw ties across a 30-hand
// probe); at this size the fast scorer still keeps total cost low.
const TIE_CAP = 3000

const RANKED_POOL_CACHE = new Map<BonusQualifier | 'side', readonly RankedBoard[]>()
function rankedPoolFor(scenario: BonusQualifier | 'side'): readonly RankedBoard[] {
  const cached = RANKED_POOL_CACHE.get(scenario)
  if (cached) return cached
  const boards = scenario === 'side' ? getSideGamePool() : getBonusOpponentPool(scenario)
  const ranked = boards.map(rankBoard)
  RANKED_POOL_CACHE.set(scenario, ranked)
  return ranked
}

// The fallback field used when no real opponents are known at all (e.g. the
// standalone Analyzer bonus solver, where no game/table exists) — the union
// of every scenario's pool, equally weighted, representing "an unknown mix
// of possible opponents" rather than skipping tie-breaking entirely.
let genericFieldCache: readonly RankedBoard[] | null = null
function genericField(): readonly RankedBoard[] {
  if (genericFieldCache) return genericFieldCache
  genericFieldCache = [
    ...rankedPoolFor('QQ'), ...rankedPoolFor('KK'), ...rankedPoolFor('AA_OR_TRIPS'), ...rankedPoolFor('side'),
  ]
  return genericFieldCache
}

function avgVsPool(candidate: RankedBoard, pool: readonly RankedBoard[]): number {
  let sum = 0
  for (const rb of pool) sum += fastScorePair(candidate, rb)
  return sum / pool.length
}

// Total net score of `candidate` against every entry in `opponents`: exact
// boards score directly; scenario refs average over their full ranked pool.
// Empty `opponents` (no real game context known) falls back to the generic
// field, itself averaged rather than summed (it stands in for "one unknown
// opponent," not a specific number of them).
function scoreCandidateVsOpponents(
  candidate: RankedBoard,
  opponents: readonly OpponentRef[],
): number {
  if (opponents.length === 0) return avgVsPool(candidate, genericField())

  let total = 0
  for (const opp of opponents) {
    if (opp === 'side') total += avgVsPool(candidate, rankedPoolFor('side'))
    else if ('tier' in opp) total += avgVsPool(candidate, rankedPoolFor(opp.tier))
    else total += fastScorePair(candidate, rankBoard(opp.board))
  }
  return total
}

// Solves for the best 3-5-5 bonus board from `cards` (13/14/15,
// `numDiscard` = cards.length - 13), maximizing royalties first (matching
// bestBonusBoard exactly) and breaking ties among royalty-maximal boards by
// expected performance against `opponents`. Pass an empty array (or a
// generic call site with no real game context) to use the fallback generic
// field. Deterministic for a given `rng` sequence (both the reservoir
// sampling of ties and, implicitly, the ranked-pool averaging are
// deterministic given the static sample data).
export function solveBonusVsOpponents(
  cards: readonly Card[],
  numDiscard: number,
  opponents: readonly OpponentRef[],
  rng: RNG,
): Board {
  const { ties } = searchBonusBoardTies(cards, numDiscard, rng, TIE_CAP)
  if (ties.length === 1) return ties[0]!

  let best = ties[0]!
  let bestScore = -Infinity
  for (const board of ties) {
    const score = scoreCandidateVsOpponents(rankBoard(board), opponents)
    if (score > bestScore) { bestScore = score; best = board }
  }
  return best
}
