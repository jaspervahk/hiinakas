// Headlessly plays one historical hand through the same gameReducer used by
// live play and the interactive Replay feature, except the "human" seat's
// every decision is supplied by a bot policy (getBotMove) instead of UI
// clicks. Opponents always replay their frozen historical placements
// verbatim, exactly as they do for a human-driven replay — see
// replayBuilder.ts and reducer.ts's startBonus()/lockNormalOrSide() for why
// that's already correct and needs no duplication here.
//
// Pure aside from the injected getBotMove call: no React, no Firebase, no
// worker import — the caller supplies whichever WorkerClient.getBotMove it
// wants (see worker/client.ts), which keeps this module trivially testable
// with a stub bot function.

import { gameReducer, makeInitialState } from './reducer'
import { buildInfoState } from '../coach/useCoach'
import type { HandReplayData } from './replayBuilder'
import type { GameState } from './types'
import { bestBonusBoard } from '../engine/index'
import type { Board, InfoState, Placement } from '../engine/index'
import type { BotPolicy } from '../worker/client'

export type GetBotMoveFn = (
  state: InfoState,
  rollouts: number,
  seed: number,
  policy?: BotPolicy,
  rootTopK?: number,
) => Promise<Placement>

export interface BotSimResult {
  totalScores: number[]   // [target, ...opponents] — same order as HandReplayData's preDealt/replay
  board: Board            // target's final normal-round board
  bonusBoard: Board | null   // target's one-shot or side-game board, if any bonus round happened
  // One entry per opponent (same order as HandReplayData.opponentNames) — their
  // one-shot or side-game board for this hand, if they played one, else null.
  // Deterministic regardless of who's driving the target's seat: an opponent's
  // own board never changes (always the frozen historical placements), and
  // their bonus/side content is either the frozen historical outcome or a
  // fresh deal seeded from replay.fallbackSeed — same either way every run.
  opponentBonusBoards: (Board | null)[]
}

const DISCARD_FOR_TIER = { QQ: 0, KK: 1, AA_OR_TRIPS: 2 } as const

// A one-shot bonus board is a solved combinatorial-optimum problem (maximize
// royalties on a fixed 13/14/15 cards), not a multi-street policy decision —
// so it's always played via the exact solver the coach panel already
// recommends to a human, regardless of which street-level policy was picked.
function pickBonusOneshotPlacement(state: GameState): Placement {
  const q = state.humanBonusQualifier
  if (!q) throw new Error('botSimulator: bonus_oneshot phase with no qualifier')
  const board = bestBonusBoard(state.humanBonusCards, DISCARD_FOR_TIER[q])
  return { topAdd: board.top, middleAdd: board.middle, bottomAdd: board.bottom, discard: null }
}

function boardHasCards(b: { top: readonly unknown[]; middle: readonly unknown[]; bottom: readonly unknown[] }): boolean {
  return b.top.length + b.middle.length + b.bottom.length > 0
}

export async function simulateHandWithBot(
  hand: HandReplayData,
  policy: BotPolicy,
  sims: number,
  rootTopK: number | undefined,
  seed: number,
  getBotMove: GetBotMoveFn,
): Promise<BotSimResult> {
  let state: GameState = gameReducer(makeInitialState(), {
    type: 'START_REPLAY',
    playerCount: hand.playerCount,
    preDealt: hand.preDealt,
    replay: hand.replay,
  })

  // Generous but finite — a real hand takes at most ~15 phase transitions
  // (5 normal streets x 2 + a handful of bonus/side steps); this only guards
  // against a genuine reducer bug wedging the loop forever.
  let guard = 0
  const MAX_STEPS = 200

  while (state.phase !== 'bonus_scoring') {
    if (++guard > MAX_STEPS) {
      throw new Error(`simulateHandWithBot: exceeded ${MAX_STEPS} steps — reducer stuck in phase "${state.phase}"`)
    }

    switch (state.phase) {
      case 'placing': {
        const infoState = buildInfoState(state)
        if (!infoState) throw new Error(`simulateHandWithBot: could not build InfoState in phase "${state.phase}"`)
        const stepSeed = (seed ^ ((state.street * 31 + state.sideStreet * 17 + (state.context === 'side' ? 1 : 0)) * 0x9e3779b9)) | 0
        const placement = await getBotMove(infoState, sims, stepSeed, policy, policy === 'nn' ? rootTopK : undefined)
        state = gameReducer(state, { type: 'APPLY_COACH_PLACEMENT', placement })
        state = gameReducer(state, { type: 'LOCK_IN' })
        break
      }
      case 'bonus_oneshot': {
        const placement = pickBonusOneshotPlacement(state)
        state = gameReducer(state, { type: 'APPLY_COACH_PLACEMENT', placement })
        state = gameReducer(state, { type: 'LOCK_IN' })
        break
      }
      case 'bot_thinking': {
        const placements = state.replay!.opponentNormalPlacements.map(streets => streets[state.street]!)
        state = gameReducer(state, { type: 'BOT_PLACED', placements })
        break
      }
      case 'revealing': {
        state = gameReducer(state, { type: 'ADVANCE' })
        break
      }
      case 'scoring': {
        state = gameReducer(state, { type: 'START_BONUS' })
        break
      }
      default:
        throw new Error(`simulateHandWithBot: unexpected phase "${state.phase}"`)
    }
  }

  const bonusBoard =
    state.humanBonusQualifier !== null ? (state.humanBonusBoard as Board)
    : boardHasCards(state.humanSideBoard) ? (state.humanSideBoard as Board)
    : null

  const opponentBonusBoards = state.botBonusQualifiers.map((q, i) => {
    if (q !== null) return state.botBonusBoards[i] as Board
    // botSideBoards/botBonusBoards are only populated per-opponent-index once
    // startBonus() actually runs the bonus/side branch — the "nobody
    // qualified anywhere" skip path (reducer.ts's early SKIP_BONUS-equivalent
    // return) leaves them at their initial empty [] from makeInitialState().
    const side = state.botSideBoards[i]
    return side && boardHasCards(side) ? (side as Board) : null
  })

  return {
    totalScores: state.totalScores,
    board: state.humanBoard as Board,
    bonusBoard,
    opponentBonusBoards,
  }
}
