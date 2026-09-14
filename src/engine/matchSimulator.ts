// Bot-vs-bot match simulator: any two BotSpecs can occupy the two seats.
// Produces a MatchHandRecord with full replay data for every decision.

import { Deck } from './deck'
import { applyPlacement } from './placement'
import { scoreTable } from './scoring'
import { isFoul, royalties, topRoyalty, middleRoyalty, bottomRoyalty, bonusTrigger, bonusDealCount } from './rules'
import { evaluate3, evaluate5 } from './evaluate'
import { bestBonusBoard } from './bestBonus'
import { mctsPickPlacement } from './mcts'
import { getBotMove } from './mc'
import type { InfoState } from './mc'
import { royaltyMctsPickPlacement, royaltyNnMctsPickPlacement } from './royaltyMcts'
import type { NNModel } from './wasmModel'
import type { Card, PartialBoard, Board, BonusQualifier, RuleSet } from './types'
import { CLASSIC_RULES } from './types'
import type { Placement } from './placement'
import type {
  MatchHandRecord, PlayerMatchRecord, StreetSnap, BotSpec,
  BonusRoundRecord, BonusRoundPlayerRecord,
} from './matchTypes'

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

// Models available for whichever seat needs them; only the kinds actually
// requested by botA/botB need to be populated.
export interface MatchModels {
  nn?: NNModel
  royaltyNn?: NNModel
}

function pickPlacement(
  spec: BotSpec,
  state: InfoState,
  rng: () => number,
  models: MatchModels,
): Placement {
  switch (spec.kind) {
    case 'nn-mcts':
      if (!models.nn) throw new Error('nn-mcts bot requires the NN model to be loaded')
      return mctsPickPlacement(
        state, models.nn,
        { nSims: spec.sims, maxDepth: 2, nnOpponents: true, ...(spec.rootTopK !== undefined ? { rootTopK: spec.rootTopK } : {}) },
        rng,
      )
    case 'royalty-mcts':
      return royaltyMctsPickPlacement(state, spec.sims, rng)
    case 'royalty-nn':
      if (!models.royaltyNn) throw new Error('royalty-nn bot requires the royalty NN model to be loaded')
      return royaltyNnMctsPickPlacement(state, models.royaltyNn, spec.sims, rng)
    case 'heuristic':
      return getBotMove(state, spec.sims, rng)
  }
}

// Safety cap on chain length — see simulate.ts. The chain ends on its own
// because re-triggering needs a side-game player to qualify; this only guards
// against a pathological deal.
const MAX_BONUS_ROUNDS = 32

export function runMatchHand(
  idx: number,
  seed: number,
  botA: BotSpec,
  botB: BotSpec,
  models: MatchModels,
  rules: RuleSet = CLASSIC_RULES,
): MatchHandRecord {
  const nnRng  = mulberry32((seed ^ 0x1A2B3C4D) >>> 0)
  const royRng = mulberry32((seed ^ 0x5E6F7A8B) >>> 0)

  // ── Normal game ─────────────────────────────────────────────────────────────

  const deck = new Deck(seed)
  const streetSizes = [5, 3, 3, 3, 3] as const

  const dealt: [Card[][], Card[][]] = [[], []]
  for (let s = 0; s < streetSizes.length; s++) {
    dealt[0].push(deck.deal(streetSizes[s]!))
    dealt[1].push(deck.deal(streetSizes[s]!))
  }

  const boards: [PartialBoard, PartialBoard] = [
    { top: [], middle: [], bottom: [] },
    { top: [], middle: [], bottom: [] },
  ]
  const discards: [Card[], Card[]] = [[], []]
  const allStreets: [StreetSnap[], StreetSnap[]] = [[], []]

  for (let s = 0; s < streetSizes.length; s++) {
    const snap0 = { top: [...boards[0].top], middle: [...boards[0].middle], bottom: [...boards[0].bottom] }
    const snap1 = { top: [...boards[1].top], middle: [...boards[1].middle], bottom: [...boards[1].bottom] }

    const pl0 = pickPlacement(
      botA,
      { board: snap0, hand: dealt[0][s]!, street: s, revealedOpponentBoards: [snap1], discards: discards[0] },
      nnRng, models,
    )
    const pl1 = pickPlacement(
      botB,
      { board: snap1, hand: dealt[1][s]!, street: s, revealedOpponentBoards: [snap0], discards: discards[1] },
      royRng, models,
    )

    boards[0] = applyPlacement(snap0, pl0)
    boards[1] = applyPlacement(snap1, pl1)
    allStreets[0].push({ hand: dealt[0][s]!, placement: pl0, boardAfter: boards[0] })
    allStreets[1].push({ hand: dealt[1][s]!, placement: pl1, boardAfter: boards[1] })
    if (pl0.discard) discards[0].push(pl0.discard)
    if (pl1.discard) discards[1].push(pl1.discard)
  }

  const finalBoards = boards as unknown as [Board, Board]
  const normalScores = scoreTable([finalBoards[0], finalBoards[1]])

  function makeRec(p: 0 | 1): PlayerMatchRecord {
    const b = finalBoards[p]
    const fouled = isFoul(b)
    const tRoy = fouled ? 0 : topRoyalty(b.top)
    const mRoy = fouled ? 0 : middleRoyalty(b.middle)
    const bRoy = fouled ? 0 : bottomRoyalty(b.bottom)
    return {
      streets: allStreets[p],
      finalBoard: b,
      foul: fouled,
      royaltiesEarned: tRoy + mRoy + bRoy,
      topRoyalty: tRoy,
      midRoyalty: mRoy,
      botRoyalty: bRoy,
      topCategory: evaluate3(b.top).category,
      midCategory: evaluate5(b.middle).category,
      botCategory: evaluate5(b.bottom).category,
    }
  }

  const rec0 = makeRec(0)
  const rec1 = makeRec(1)

  // ── Bonus round ─────────────────────────────────────────────────────────────

  let roundSeed = ((seed ^ 0x1B2D3C4E) * 1664525 + 1013904223) >>> 0

  const qual0 = !rec0.foul && bonusTrigger(finalBoards[0], rules) !== null
  const qual1 = !rec1.foul && bonusTrigger(finalBoards[1], rules) !== null

  const bonusRounds: BonusRoundRecord[] = []
  let bonusScore: [number, number] = [0, 0]

  // Who enters the next round on a one-shot board. Everyone else plays the
  // side game. Only a side-game board can re-trigger: a 13-15 card bonus board
  // never does (docs/01_RULES_AND_SCORING.md section 8, extended by
  // RuleSet.allowBonusRecursion).
  let entry: [BonusQualifier | null, BonusQualifier | null] = [
    qual0 ? bonusTrigger(finalBoards[0], rules) : null,
    qual1 ? bonusTrigger(finalBoards[1], rules) : null,
  ]

  for (let round = 0; round < MAX_BONUS_ROUNDS && (entry[0] || entry[1]); round++) {
    const deck = new Deck(roundSeed)
    const boards: [Board | null, Board | null] = [null, null]
    const recs: [BonusRoundPlayerRecord | null, BonusRoundPlayerRecord | null] = [null, null]

    // One-shot boards for this round's qualifiers.
    for (const p of [0, 1] as const) {
      const q = entry[p]
      if (!q) continue
      const n = bonusDealCount(q)
      const cards = deck.deal(n)
      const board = bestBonusBoard(cards, n - 13)
      boards[p] = board
      const foul = isFoul(board)
      recs[p] = { qualifier: q, cards, board, foul, royalties: foul ? 0 : royalties(board) }
    }

    // Side game for everyone else. They see each other but never a bonus board.
    const sideList = ([0, 1] as const).filter(p => entry[p] === null)
    // The bonus-board players are invisible during play but are still scored
    // against this side game at showdown. Passing their tiers is NOT optional:
    // heads-up, a side-game player has no visible opponent at all, so without
    // this every rollout scores a one-board table, scoreTable's pairwise loop
    // never runs, and every candidate evaluates to exactly 0 — the bot would
    // then return an arbitrary first candidate. Mirrors what the live game does
    // (game/bonusBotResolver.ts).
    const invisibleBonusOpponents = ([0, 1] as const)
      .map(p => entry[p])
      .filter((q): q is BonusQualifier => q !== null)
    if (sideList.length > 0) {
      const sideSizes = [5, 3, 3, 3, 3] as const
      const sideBoards: PartialBoard[] = sideList.map(() => ({ top: [], middle: [], bottom: [] }))
      const sideDisc: Card[][] = sideList.map(() => [])
      const sideSS: StreetSnap[][] = sideList.map(() => [])

      for (let st = 0; st < sideSizes.length; st++) {
        const snaps = sideBoards.map(b =>
          ({ top: [...b.top], middle: [...b.middle], bottom: [...b.bottom] })
        )
        for (let i = 0; i < sideList.length; i++) {
          const p = sideList[i]!
          const hand = deck.deal(sideSizes[st]!)
          const info = {
            board: snaps[i]!,
            hand,
            street: st,
            revealedOpponentBoards: snaps.filter((_, j) => j !== i),
            discards: sideDisc[i]!,
            inBonusRound: true,
            invisibleBonusOpponents,
            rules,
          }
          const pl = p === 0
            ? pickPlacement(botA, info, nnRng, models)
            : pickPlacement(botB, info, royRng, models)
          sideBoards[i] = applyPlacement(snaps[i]!, pl)
          sideSS[i]!.push({ hand, placement: pl, boardAfter: sideBoards[i]! })
          if (pl.discard) sideDisc[i]!.push(pl.discard)
        }
      }

      for (let i = 0; i < sideList.length; i++) {
        const p = sideList[i]!
        const sb = sideBoards[i] as Board
        boards[p] = sb
        const foul = isFoul(sb)
        recs[p] = { qualifier: null, streets: sideSS[i]!, board: sb, foul, royalties: foul ? 0 : royalties(sb) }
      }
    }

    const nets = scoreTable([boards[0] as Board, boards[1] as Board])
    const score: [number, number] = [nets[0]!, nets[1]!]
    bonusScore = [bonusScore[0] + score[0], bonusScore[1] + score[1]]
    bonusRounds.push({
      round,
      players: [recs[0] as BonusRoundPlayerRecord, recs[1] as BonusRoundPlayerRecord],
      score,
    })

    // Mirror round 0 onto the flat per-player fields the Arena replay reads.
    if (round === 0) {
      for (const p of [0, 1] as const) {
        const rec = p === 0 ? rec0 : rec1
        const r = recs[p]!
        if (r.qualifier) {
          rec.bonusCards = r.cards
          rec.bonusBoard = r.board
          rec.bonusFoul = r.foul
          rec.bonusRoyalties = r.royalties
        } else {
          rec.sideStreets = r.streets
          rec.sideBoard = r.board
          rec.sideFoul = r.foul
          rec.sideRoyalties = r.royalties
        }
      }
    }

    if (!rules.allowBonusRecursion) break
    entry = [
      recs[0]!.qualifier === null ? bonusTrigger(boards[0] as Board, rules) : null,
      recs[1]!.qualifier === null ? bonusTrigger(boards[1] as Board, rules) : null,
    ]
    roundSeed = ((roundSeed ^ 0x9E3779B9) * 1664525 + 1013904223) >>> 0
  }

  const bonusTriggerPlayer: MatchHandRecord['bonusTriggerPlayer'] =
    qual0 && qual1 ? 2 : qual0 ? 0 : qual1 ? 1 : -1

  return {
    idx,
    seed,
    players: [rec0, rec1],
    normalScore: [normalScores[0]!, normalScores[1]!],
    bonusScore,
    totalScore: [normalScores[0]! + bonusScore[0], normalScores[1]! + bonusScore[1]],
    bonusTriggered: bonusRounds.length > 0,
    bonusTriggerPlayer,
    ...(bonusRounds.length > 0 ? { bonusRounds } : {}),
  }
}
