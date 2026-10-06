// Street-0 opening book, used as the ROLLOUT policy's five-card decision —
// i.e. how a simulated opponent opens inside a Monte-Carlo rollout. The bot's
// own street-0 move is still chosen by the MC search; this only replaces the
// greedy scorer's guess at what the opponent does.
//
// Why a rule table rather than scoring: the rollout policy is called ~41,760
// times for a single street-0 decision, and the opponent's five-card placement
// is 232 of the 320 candidate-scorings per rollout. A lookup removes that
// entirely, which measured 1.9x faster on a street-0 decision (318ms -> 169ms
// at sims=20).
//
// Measured effect on simulated hands (n=20000), versus scoring every candidate
// with heuristicPlacement:
//
//                      foul     royalties   top qualifies
//   greedy scorer      30.5%       0.81          1.18%
//   this book          14.1%       1.51          2.19%
//
// Strength, however, is a different question and was measured separately:
// head-to-head over 2000 mirrored pairs at sims=20 this was +0.155 +/- 0.546
// pts/hand, i.e. NOT a significant improvement. That is expected in hindsight —
// at street 0 the opponent's board is empty, so opponent-model quality barely
// affects which opening is best. It is shipped for the speed, which buys extra
// rollouts, not as a strength gain. Do not re-litigate those numbers without
// re-running the comparison.
//
// The rules themselves were specified by the project owner; the comments record
// intent so they are not "simplified" into something else later. Top is kept
// deliberately weak (empty, one low card, or a lone ace) because top > middle
// is 54% of the greedy scorer's fouls.

import type { Card, PartialBoard } from './types'
import type { Placement } from './placement'

const mk = (top: Card[], mid: Card[], bot: Card[]): Placement =>
  ({ topAdd: top, middleAdd: mid, bottomAdd: bot, discard: null })

const desc = (cs: readonly Card[]) => [...cs].sort((a, b) => b.rank - a.rank)

function without(all: readonly Card[], used: readonly Card[]): Card[] {
  const out = [...all]
  for (const u of used) {
    const i = out.findIndex(c => c.rank === u.rank && c.suit === u.suit)
    if (i !== -1) out.splice(i, 1)
  }
  return out
}

// Open-ended = four consecutive ranks with BOTH ends completable. A run
// r..r+3 qualifies iff 2 <= r <= 10: the low end is always live (r=2 completes
// with the ace playing low, r>=3 with r-1), the high end needs r+4 <= 14. So
// J-Q-K-A is one-ended and excluded, A-2-3-4 is not a consecutive run at all,
// and gutshots such as 5-6-7-9 never match.
function openEndedRun(cards: readonly Card[]): Card[] | null {
  const byRank = new Map<number, Card>()
  for (const c of cards) if (!byRank.has(c.rank)) byRank.set(c.rank, c)
  for (let r = 2; r <= 10; r++) {
    if (byRank.has(r) && byRank.has(r + 1) && byRank.has(r + 2) && byRank.has(r + 3)) {
      return [byRank.get(r)!, byRank.get(r + 1)!, byRank.get(r + 2)!, byRank.get(r + 3)!]
    }
  }
  return null
}

function largestSuitGroup(cards: readonly Card[]): Card[] {
  const sc = new Map<string, Card[]>()
  for (const c of cards) { const a = sc.get(c.suit) ?? []; a.push(c); sc.set(c.suit, a) }
  let best: Card[] = []
  for (const cs of sc.values()) if (cs.length > best.length) best = cs
  return best
}

// One pair: the pair always goes to the bottom; where the three loose cards go
// depends on whether anything outranks the pair, and on holding an ace.
function onePairRule(cards: readonly Card[], pair: Card[]): Placement {
  const others = desc(without(cards, pair))
  if (!others.some(c => c.rank > pair[0]!.rank)) {
    const lowest = others[others.length - 1]!
    return mk([], without(others, [lowest]), [...pair, lowest])
  }
  const ace = others.find(c => c.rank === 14)
  if (ace) {
    // Ace up top plays for a future AA (a 15-card bonus round); the higher of
    // the two leftovers backs up the bottom, the lower sits in the middle.
    const two = desc(without(others, [ace]))
    return mk([ace], [two[1]!], [...pair, two[0]!])
  }
  return mk([], others.slice(1), [...pair, others[0]!])
}

// No pair, no three-flush: two high cards anchor the bottom. An ace goes up
// top only when the hand has the high cards to back a run at AA.
function noPairOffsuitRule(cards: readonly Card[]): Placement {
  const s = desc(cards)
  const ace = s.find(c => c.rank === 14)
  if (ace) {
    const others = desc(without(s, [ace]))
    if (others.filter(c => c.rank >= 8).length >= 2) {
      return mk([ace], others.slice(2), others.slice(0, 2))
    }
  }
  return mk([s[4]!], [s[2]!, s[3]!], [s[0]!, s[1]!])
}

// Places all five opening cards. Returns null only for a malformed hand, so
// callers can fall back rather than throw.
export function openingPlacement(cards: readonly Card[]): Placement | null {
  if (cards.length !== 5) return null

  const rc = new Map<number, Card[]>()
  for (const c of cards) { const a = rc.get(c.rank) ?? []; a.push(c); rc.set(c.rank, a) }
  const groups = [...rc.values()].sort((a, b) => b.length - a.length)
  const suited = largestSuitGroup(cards)
  const ranks = [...rc.keys()].sort((a, b) => a - b)

  // A made five-card straight needs five distinct ranks; check the wheel too.
  const made5 = rc.size === 5 && (
    ranks[4]! - ranks[0]! === 4 ||
    (ranks[0] === 2 && ranks[1] === 3 && ranks[2] === 4 && ranks[3] === 5 && ranks[4] === 14)
  )
  const isFullHouse = groups[0]!.length === 3 && groups[1]?.length === 2
  const isQuads = groups[0]!.length === 4
  const isTrips = groups[0]!.length === 3 && !isFullHouse
  const isTwoPair = groups[0]!.length === 2 && groups[1]?.length === 2
  const isOnePair = groups[0]!.length === 2 && groups[1]?.length !== 2

  // Made hands go to the bottom whole: full house, flush, or straight.
  if (isFullHouse || suited.length >= 5 || made5) return mk([], [], [...cards])
  if (isQuads) return mk([], without(cards, groups[0]!), groups[0]!)
  if (isTrips) return mk([], without(cards, groups[0]!), groups[0]!)
  if (isTwoPair) {
    const four = [...groups[0]!, ...groups[1]!]
    return mk([], without(cards, four), four)
  }
  // A four-flush outranks a straight draw: with both, the flush is taken.
  if (suited.length === 4) return mk([], without(cards, suited), suited)
  // With a pair plus an open-ended run, the run uses one of the paired cards
  // and the duplicate becomes the odd card in the middle.
  const run = openEndedRun(cards)
  if (run) return mk([], without(cards, run), run)

  if (isOnePair) return onePairRule(cards, groups[0]!)
  if (suited.length === 3) return mk([], without(cards, suited), suited)
  return noPairOffsuitRule(cards)
}

// The rollout policy's placement: the book opens, the greedy scorer handles
// streets 1-4 (where it enumerates 27 candidates rather than 232, and where
// boards actually interact).
export function openingOrNull(
  _board: PartialBoard, hand: readonly Card[], street: number,
): Placement | null {
  return street === 0 ? openingPlacement(hand) : null
}
