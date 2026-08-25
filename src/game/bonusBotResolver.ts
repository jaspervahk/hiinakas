// Resolves live bot opponents' bonus-round decisions (one-shot bonus board
// and 5-street side game) using the same quality machinery already used for
// the human's coach/Live Coach recommendations — the kicker-aware
// solveBonusVsOpponents solver for one-shot boards, and MC-rollout-based
// getBotMove for side-game streets — instead of the crude synchronous
// fallbacks (botOneShotBonus/botSideGamesInterleaved in reducer.ts) that
// remain in place only for the replay path (see reducer.ts's startBonus()).
//
// Pure aside from the injected getBotMove/solveBonus calls: no React, no
// worker import — mirrors botSimulator.ts's dependency-injection pattern so
// this stays trivially testable with stub functions.

import { emptyBoard } from './types'
import type { GameState } from './types'
import type { Card, PartialBoard, InfoState } from '../engine/index'
import type { OpponentRef } from '../worker/client'
import type { GetBotMoveFn, SolveBonusFn } from './botSimulator'

const DISCARD_FOR_TIER = { QQ: 0, KK: 1, AA_OR_TRIPS: 2 } as const

export interface BonusBotResolution {
  botBonusBoards: PartialBoard[]
  botSideBoards: PartialBoard[]
}

export async function resolveBonusBots(
  state: GameState,
  getBotMove: GetBotMoveFn,
  solveBonus: SolveBonusFn,
): Promise<BonusBotResolution> {
  const { humanBonusQualifier, botBonusQualifiers, botBonusCards, sidePreDealt, appSettings, seed } = state
  const policy = appSettings.botPolicy
  const sims = appSettings.botSims
  const rootTopK = appSettings.botRootTopK

  // ── One-shot bonus bots ────────────────────────────────────────────────
  const botBonusBoards: PartialBoard[] = await Promise.all(
    botBonusQualifiers.map(async (q, i) => {
      if (!q) return emptyBoard()
      const opponents: OpponentRef[] = [
        humanBonusQualifier === null ? 'side' : { tier: humanBonusQualifier },
        ...botBonusQualifiers
          .map((otherQ, j): OpponentRef | null => {
            if (j === i) return null
            return otherQ === null ? 'side' : { tier: otherQ }
          })
          .filter((x): x is OpponentRef => x !== null),
      ]
      const stepSeed = (seed ^ ((i + 1) * 0x9e3779b9)) | 0
      const board = await solveBonus(botBonusCards[i]!, DISCARD_FOR_TIER[q], opponents, stepSeed)
      return { top: board.top, middle: board.middle, bottom: board.bottom }
    })
  )

  // ── Side-game bots ──────────────────────────────────────────────────────
  const humanInSide = humanBonusQualifier === null
  const botInSide = botBonusQualifiers.map(q => q === null)
  const invisibleBonusOpponents = [
    ...(humanBonusQualifier !== null ? [humanBonusQualifier] : []),
    ...botBonusQualifiers.filter((q): q is NonNullable<typeof q> => q !== null),
  ]

  const sideBotIndices: number[] = []
  const sideBotDealt: Card[][][] = []
  {
    let sideIdx = humanInSide ? 1 : 0
    for (let i = 0; i < botInSide.length; i++) {
      if (botInSide[i]) {
        sideBotIndices.push(i)
        sideBotDealt.push(sidePreDealt[sideIdx]!)
        sideIdx++
      }
    }
  }

  const n = sideBotIndices.length
  const boards: PartialBoard[] = Array.from({ length: n }, () => emptyBoard())
  const discardsByBot: Card[][] = Array.from({ length: n }, () => [])

  for (let s = 0; s <= 4; s++) {
    const snapshots: PartialBoard[] = boards.map(b => ({ top: [...b.top], middle: [...b.middle], bottom: [...b.bottom] }))
    const placements = await Promise.all(
      snapshots.map(async (own, k) => {
        const botIdx = sideBotIndices[k]!
        const hand = sideBotDealt[k]![s]!
        const oppBoards = snapshots.filter((_, j) => j !== k)
        const infoState: InfoState = {
          board: own,
          hand,
          street: s,
          revealedOpponentBoards: oppBoards,
          discards: discardsByBot[k],
          inBonusRound: true,
          invisibleBonusOpponents,
        }
        const stepSeed = (seed ^ ((botIdx + 1) * 0x9e3779b9 + s * 0x85ebca6b)) | 0
        return getBotMove(infoState, sims, stepSeed, policy, policy === 'nn' ? rootTopK : undefined)
      })
    )
    for (let k = 0; k < n; k++) {
      const pl = placements[k]!
      boards[k] = { top: [...boards[k]!.top, ...pl.topAdd], middle: [...boards[k]!.middle, ...pl.middleAdd], bottom: [...boards[k]!.bottom, ...pl.bottomAdd] }
      if (pl.discard) discardsByBot[k]!.push(pl.discard)
    }
  }

  const botSideBoards: PartialBoard[] = botBonusQualifiers.map(() => emptyBoard())
  for (let k = 0; k < n; k++) {
    botSideBoards[sideBotIndices[k]!] = boards[k]!
  }

  return { botBonusBoards, botSideBoards }
}
