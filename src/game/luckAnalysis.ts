// Per-street "luck" analysis for a historical hand: for each decision point,
// luck = (best EV achievable given the cards you actually got) minus (best
// EV averaged over many hypothetical alternate hands sampled from the same
// remaining deck, holding the board and opponents' boards fixed at that same
// point in time). This isolates variance in the deal from decision quality —
// the latter is already covered by the existing EV coach's evLost metric.
//
// Reuses the same InfoState shape and the same analyzePositions worker RPC
// the EV coach already uses (just batching "actual" + N sampled hands into
// one call per decision point) — no new engine primitives, only a new outer
// Monte Carlo loop around existing machinery. Built from the flat
// ReviewDecision/BonusDecisionPoint shapes (via replayBuilder.ts), not a raw
// InfoState field, since ReviewDecision deliberately drops that after
// analysis and a reopened saved analysis has no raw decisions at all.

import type { Card, InfoState, Board, BonusQualifier, Placement } from '../engine/index'
import { FULL_DECK, bonusTrigger, scoreTable, bestBonusBoard } from '../engine/index'
import type { BotPolicy } from '../worker/client'
import {
  buildHandReplayData, buildTargetOwnHistory, foldPlacements, resolveBonusOutcomeBoard,
} from './replayBuilder'
import type { ReviewDecision } from './sessionAnalysisTypes'
import type { BonusDecisionPoint, GameSummary } from './sessionParser'

export type AnalyzePositionsFn = (
  positions: Array<{ id: string; state: InfoState }>,
  rollouts: number,
  policy: BotPolicy,
  rootTopK: number | undefined,
) => Promise<Array<{ id: string; candidates: Array<{ ev: number }> }>>

export interface StreetLuck {
  segment: 'normal' | 'side' | 'bonus_oneshot'
  street: number   // 0-4 for normal/side; 0 for the single bonus_oneshot decision
  actualEV: number
  baselineEV: number
  luck: number      // actualEV - baselineEV
}

export interface HandLuck {
  gameId: string
  streets: StreetLuck[]
  totalLuck: number
}

// ── Seeded sampling (deterministic: same seed -> same sequence) ────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Partial Fisher-Yates: only the last `n` positions need shuffling to sample
// n cards without replacement from `pool`.
function sampleWithoutReplacement(pool: readonly Card[], n: number, rng: () => number): Card[] {
  const arr = [...pool]
  const m = arr.length
  for (let i = m - 1; i >= m - n; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = arr[i]!; arr[i] = arr[j]!; arr[j] = tmp
  }
  return arr.slice(m - n)
}

function cardKey(c: Card): string { return `${c.rank}${c.suit}` }

function remainingDeck(excluded: readonly Card[]): Card[] {
  const seen = new Set(excluded.map(cardKey))
  return FULL_DECK.filter(c => !seen.has(cardKey(c)))
}

function average(nums: readonly number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length
}

function placementCards(p: Placement): Card[] {
  return [...p.topAdd, ...p.middleAdd, ...p.bottomAdd, ...(p.discard ? [p.discard] : [])]
}

// Runs one street's worth of "actual vs N hypothetical hands" through the
// injected analyzePositions, holding `board`/`revealedOpponentBoards`/
// `discards` fixed and only varying `hand`.
async function evaluateStreetLuck(
  segment: StreetLuck['segment'],
  street: number,
  board: InfoState['board'],
  actualHand: Card[],
  revealedOpponentBoards: InfoState['revealedOpponentBoards'],
  discards: Card[],
  deck: readonly Card[],
  policy: BotPolicy,
  sims: number,
  rootTopK: number | undefined,
  outerSamples: number,
  rng: () => number,
  analyzePositions: AnalyzePositionsFn,
  extra?: Pick<InfoState, 'inBonusRound' | 'invisibleBonusOpponents'>,
): Promise<StreetLuck> {
  const baseState: InfoState = { board, hand: actualHand, street, revealedOpponentBoards, discards, ...extra }
  const positions: Array<{ id: string; state: InfoState }> = [{ id: 'actual', state: baseState }]
  for (let k = 0; k < outerSamples; k++) {
    const sample = sampleWithoutReplacement(deck, actualHand.length, rng)
    positions.push({ id: `s${k}`, state: { ...baseState, hand: sample } })
  }

  const results = await analyzePositions(positions, sims, policy, rootTopK)
  const byId = new Map(results.map(r => [r.id, r]))
  const actualEV = byId.get('actual')!.candidates[0]!.ev
  const sampledEVs = positions.slice(1).map(p => byId.get(p.id)!.candidates[0]!.ev)
  const baselineEV = average(sampledEVs)

  return { segment, street, actualEV, baselineEV, luck: actualEV - baselineEV }
}

export interface ComputeHandLuckOptions {
  policy: BotPolicy
  sims: number
  rootTopK: number | undefined
  outerSamples: number
  seed: number
  analyzePositions: AnalyzePositionsFn
}

export async function computeHandLuck(
  gameId: string,
  targetUsername: string,
  streetDecisions: ReviewDecision[],
  bonusBoardDecisions: BonusDecisionPoint[],
  summaries: GameSummary[],
  opts: ComputeHandLuckOptions,
): Promise<HandLuck> {
  const { policy, sims, rootTopK, outerSamples, seed, analyzePositions } = opts
  const rng = mulberry32(seed)

  const hand = buildHandReplayData(gameId, targetUsername, streetDecisions, bonusBoardDecisions, summaries)
  const ownHistory = buildTargetOwnHistory(gameId, targetUsername, streetDecisions, bonusBoardDecisions)
  const opponentPlacements = hand.replay.opponentNormalPlacements   // [oppIdx][street 0-4]

  const streets: StreetLuck[] = []

  // ── Normal round: streets 0-4 ──────────────────────────────────────────
  for (let s = 0; s <= 4; s++) {
    const boardBefore = foldPlacements(ownHistory.normalPlacements.slice(0, s))
    const placementAtS = ownHistory.normalPlacements[s]!
    const actualHand = placementCards(placementAtS)
    const discardsBefore = ownHistory.normalPlacements.slice(0, s).map(p => p.discard).filter((c): c is Card => c !== null)
    const oppBoardsBefore = opponentPlacements.map(streetsForOpp => foldPlacements(streetsForOpp.slice(0, s)))
    const oppDiscardsBefore = opponentPlacements.flatMap(streetsForOpp =>
      streetsForOpp.slice(0, s).map(p => p.discard).filter((c): c is Card => c !== null),
    )

    const deck = remainingDeck([
      ...boardBefore.top, ...boardBefore.middle, ...boardBefore.bottom, ...discardsBefore,
      ...oppBoardsBefore.flatMap(b => [...b.top, ...b.middle, ...b.bottom]), ...oppDiscardsBefore,
    ])

    streets.push(await evaluateStreetLuck(
      'normal', s, boardBefore, actualHand, oppBoardsBefore, discardsBefore,
      deck, policy, sims, rootTopK, outerSamples, rng, analyzePositions,
    ))
  }

  // ── Bonus / side game (only if this hand actually reached one) ────────
  if (ownHistory.bonusOutcome) {
    if (ownHistory.bonusOutcome.qualifies) {
      // One-shot: target qualified for a bonus board. Luck = best achievable
      // EV from the actual dealt cards vs. from hypothetical alternate deals,
      // scored head-to-head against every opponent's actual (frozen) bonus/
      // side board — mirrors reducer.ts's finalizeBonusScoring, which scores
      // one-shot and side boards together via one scoreTable call.
      const dealt = bonusBoardDecisions.find(d => d.gameId === gameId && d.username === targetUsername)
      if (!dealt) throw new Error(`computeHandLuck: missing bonus deal for ${targetUsername} in ${gameId}`)

      const oppBoardsForScoring = hand.replay.opponentBonusOutcomes
        .map(resolveBonusOutcomeBoard)
        .filter((b): b is Board => b !== null)
      // Only OTHER one-shot qualifiers share target's bonus deck (side-game
      // players draw from a wholly separate deck — see reducer.ts's
      // startBonus(): bonusDeck vs sideDeck are independent Deck instances).
      const oneShotOpponentCards = hand.replay.opponentBonusOutcomes
        .filter((o): o is { qualifies: true; board: Board } => o !== null && o.qualifies)
        .flatMap(o => [...o.board.top, ...o.board.middle, ...o.board.bottom])

      const deck = remainingDeck(oneShotOpponentCards)
      const actualBoard = bestBonusBoard(dealt.cards, dealt.numDiscard)
      const actualEV = scoreTable([actualBoard, ...oppBoardsForScoring])[0]!

      const sampledEVs: number[] = []
      for (let k = 0; k < outerSamples; k++) {
        const sample = sampleWithoutReplacement(deck, dealt.cards.length, rng)
        const sampleBoard = bestBonusBoard(sample, dealt.numDiscard)
        sampledEVs.push(scoreTable([sampleBoard, ...oppBoardsForScoring])[0]!)
      }
      const baselineEV = average(sampledEVs)
      streets.push({ segment: 'bonus_oneshot', street: 0, actualEV, baselineEV, luck: actualEV - baselineEV })
    } else {
      // Side game: target didn't qualify, played a 5-street mini-round.
      // Qualifying opponents are invisible (their boards don't factor into
      // this InfoState's revealedOpponentBoards, only invisibleBonusOpponents'
      // tier), matching useCoach.ts's buildInfoState side-game branch exactly.
      const sideOpponentEntries = hand.replay.opponentBonusOutcomes
        .map((o, i) => ({ o, i }))
        .filter((e): e is { o: { qualifies: false; placements: Placement[] }; i: number } =>
          e.o !== null && !e.o.qualifies,
        )
      const invisibleBonusOpponents: BonusQualifier[] = hand.replay.opponentBonusOutcomes
        .map((o, i) => ({ o, i }))
        .filter((e): e is { o: { qualifies: true; board: Board }; i: number } => e.o !== null && e.o.qualifies)
        .map(({ i }) => bonusTrigger(foldPlacements(opponentPlacements[i]!)))
        .filter((q): q is BonusQualifier => q !== null)

      for (let ss = 0; ss <= 4; ss++) {
        const boardBefore = foldPlacements(ownHistory.bonusOutcome.placements.slice(0, ss))
        const placementAtSs = ownHistory.bonusOutcome.placements[ss]!
        const actualHand = placementCards(placementAtSs)
        const discardsBefore = ownHistory.bonusOutcome.placements.slice(0, ss).map(p => p.discard).filter((c): c is Card => c !== null)
        const oppBoardsBefore = sideOpponentEntries.map(({ o }) => foldPlacements(o.placements.slice(0, ss)))
        const oppDiscardsBefore = sideOpponentEntries.flatMap(({ o }) =>
          o.placements.slice(0, ss).map(p => p.discard).filter((c): c is Card => c !== null),
        )
        const deck = remainingDeck([
          ...boardBefore.top, ...boardBefore.middle, ...boardBefore.bottom, ...discardsBefore,
          ...oppBoardsBefore.flatMap(b => [...b.top, ...b.middle, ...b.bottom]), ...oppDiscardsBefore,
        ])

        streets.push(await evaluateStreetLuck(
          'side', ss, boardBefore, actualHand, oppBoardsBefore, discardsBefore,
          deck, policy, sims, rootTopK, outerSamples, rng, analyzePositions,
          { inBonusRound: true, invisibleBonusOpponents },
        ))
      }
    }
  }

  return { gameId, streets, totalLuck: streets.reduce((a, s) => a + s.luck, 0) }
}
