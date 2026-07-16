import {
  Deck,
  heuristicPlacement, applyPlacement,
  bonusTrigger, bonusDealCount,
  scoreTable,
} from '../engine/index'
import type { Card, PartialBoard, Board, Placement } from '../engine/index'
import type { GameState, PendingRows, StreetLog, AppSettings, ReplayConfig } from './types'
import { emptyPending, emptyBoard } from './types'

// ── Helpers ───────────────────────────────────────────────────────────────────

function sameCard(a: Card, b: Card): boolean { return a.rank === b.rank && a.suit === b.suit }

// Pre-deal cards for all players across 5 streets.
// Order: interleaved by player per street (street 0 all players, then street 1, …).
function preDeal(playerCount: number, seed: number): Card[][][] {
  const deck = new Deck(seed)
  // [player][street]
  const result: Card[][][] = Array.from({ length: playerCount }, () => [])
  // Street 0: 5 each; streets 1-4: 3 each
  const counts = [5, 3, 3, 3, 3]
  for (let s = 0; s <= 4; s++) {
    for (let p = 0; p < playerCount; p++) {
      result[p]!.push(deck.deal(counts[s]!))
    }
  }
  return result
}

// Greedy one-shot bot bonus placement: strongest 5 → bottom, next 5 → middle, 3 → top.
function botOneShotBonus(cards: Card[]): PartialBoard {
  const sorted = [...cards].sort((a, b) => b.rank - a.rank)
  const toPlace = sorted.slice(0, 13) // best 13 cards
  return {
    bottom: toPlace.slice(0, 5),
    middle: toPlace.slice(5, 10),
    top:    toPlace.slice(10, 13),
  }
}

// Compute all 5 streets of MULTIPLE bots' side games together, interleaved
// street-by-street so each one sees the others' revealed boards from
// previous streets — matching how side-gamers actually play (see
// docs/01_RULES_AND_SCORING.md section 8 and simulate.ts's runBonusRound,
// which already interleaved this way for training-sample encoding; bot
// gameplay had been computing each side game in isolation instead).
function botSideGamesInterleaved(sideDealtList: Card[][][]): PartialBoard[] {
  const n = sideDealtList.length
  const boards: PartialBoard[] = Array.from({ length: n }, () => emptyBoard())
  for (let s = 0; s <= 4; s++) {
    const snapshots: PartialBoard[] = boards.map(b =>
      ({ top: [...b.top], middle: [...b.middle], bottom: [...b.bottom] })
    )
    for (let i = 0; i < n; i++) {
      const hand = sideDealtList[i]![s]!
      const oppBoards = snapshots.filter((_, j) => j !== i)
      const pl = heuristicPlacement(snapshots[i]!, hand, s, oppBoards)
      boards[i] = applyPlacement(snapshots[i]!, pl)
    }
  }
  return boards
}

// Remove first occurrence of card from array; returns new array.
function removeCard(arr: Card[], card: Card): Card[] {
  const idx = arr.findIndex(c => sameCard(c, card))
  if (idx === -1) return arr
  return [...arr.slice(0, idx), ...arr.slice(idx + 1)]
}

// ── Actions ───────────────────────────────────────────────────────────────────

export type Action =
  | { type: 'START_GAME'; playerCount: 2 | 3 }
  | { type: 'START_REPLAY'; playerCount: 2 | 3; preDealt: Card[][][]; replay: ReplayConfig }
  | { type: 'SELECT_CARD'; card: Card }
  | { type: 'ASSIGN_TO_ROW'; row: 'top' | 'middle' | 'bottom' }
  | { type: 'REMOVE_PENDING'; row: 'top' | 'middle' | 'bottom'; index: number }
  | { type: 'APPLY_COACH_PLACEMENT'; placement: Placement }  // apply a coach suggestion directly
  | { type: 'LOCK_IN' }
  | { type: 'ADVANCE' }          // from revealing → next street or scoring
  | { type: 'START_BONUS' }      // from scoring → bonus round (if triggered)
  | { type: 'SKIP_BONUS' }       // from scoring → bonus_scoring (no bonus needed)
  | { type: 'LOCK_BONUS_ONESHOT' }
  | { type: 'BOT_PLACED'; placements: Placement[] }   // async MC bot results
  | { type: 'RESTORE_SNAPSHOT'; snapshot: GameState } // undo to pre-lock state
  | { type: 'RESET' }
  | { type: 'RECORD_STREET_LOG'; log: StreetLog }
  | { type: 'UPDATE_SETTINGS'; settings: Partial<AppSettings> }

// ── Initial state ─────────────────────────────────────────────────────────────

export function makeInitialState(): GameState {
  return {
    phase: 'setup',
    context: 'normal',
    playerCount: 2,
    seed: 0,
    preDealt: [],
    street: 0,
    humanBoard: emptyBoard(),
    botBoards: [],
    humanHand: [],
    pending: emptyPending(),
    selectedCard: null,
    normalScores: [],
    humanBonusQualifier: null,
    botBonusQualifiers: [],
    humanBonusCards: [],
    botBonusCards: [],
    humanBonusBoard: emptyBoard(),
    botBonusBoards: [],
    sidePreDealt: [],
    sideStreet: 0,
    humanSideBoard: emptyBoard(),
    botSideBoards: [],
    bonusScores: [],
    totalScores: [],
    currentStreetLogs: [],
    appSettings: {
      coachEnabled: true, playerCount: 2, botPolicy: 'nn', coachMode: 'nn',
      botSims: 500, botRootTopK: 35, coachSims: 500, coachRootTopK: 35,
    },
    replay: null,
  }
}

// ── Reducer ───────────────────────────────────────────────────────────────────

export function gameReducer(state: GameState, action: Action): GameState {
  switch (action.type) {

    case 'RESET':
      return { ...makeInitialState(), appSettings: state.appSettings }

    case 'START_GAME': {
      const seed = Date.now()
      const { playerCount } = action
      const botCount = playerCount - 1
      const dealt = preDeal(playerCount, seed)
      const base = makeInitialState()
      return {
        ...base,
        appSettings: { ...state.appSettings, playerCount },
        phase: 'placing',
        context: 'normal',
        playerCount,
        seed,
        preDealt: dealt,
        street: 0,
        humanBoard: emptyBoard(),
        botBoards: Array.from({ length: botCount }, emptyBoard),
        humanHand: dealt[0]![0]!,
        pending: emptyPending(),
        selectedCard: null,
        currentStreetLogs: [],
      }
    }

    case 'START_REPLAY': {
      const { playerCount, preDealt, replay } = action
      const botCount = playerCount - 1
      const base = makeInitialState()
      return {
        ...base,
        appSettings: { ...state.appSettings, playerCount },
        phase: 'placing',
        context: 'normal',
        playerCount,
        seed: replay.fallbackSeed,
        preDealt,
        street: 0,
        humanBoard: emptyBoard(),
        botBoards: Array.from({ length: botCount }, emptyBoard),
        humanHand: preDealt[0]![0]!,
        pending: emptyPending(),
        selectedCard: null,
        currentStreetLogs: [],
        replay,
      }
    }

    case 'RECORD_STREET_LOG': {
      return { ...state, currentStreetLogs: [...state.currentStreetLogs, action.log] }
    }

    case 'UPDATE_SETTINGS': {
      return {
        ...state,
        appSettings: { ...state.appSettings, ...action.settings },
      }
    }

    case 'SELECT_CARD': {
      const { card } = action
      // Deselect if already selected
      if (state.selectedCard && sameCard(state.selectedCard, card)) {
        return { ...state, selectedCard: null }
      }
      return { ...state, selectedCard: card }
    }

    case 'ASSIGN_TO_ROW': {
      if (!state.selectedCard) return state
      const { row } = action
      const card = state.selectedCard

      // Check space against the board actively being built
      const currentBoard =
        state.phase === 'bonus_oneshot' ? state.humanBonusBoard
        : state.context === 'side' ? state.humanSideBoard
        : state.humanBoard
      const alreadyInRow = state.pending[row].length + currentBoard[row].length
      const maxRow = row === 'top' ? 3 : 5
      if (alreadyInRow >= maxRow) return state

      const newPending: PendingRows = {
        ...state.pending,
        [row]: [...state.pending[row], card],
      }
      const newHand = removeCard(state.humanHand, card)
      return { ...state, pending: newPending, humanHand: newHand, selectedCard: null }
    }

    case 'REMOVE_PENDING': {
      const { row, index } = action
      const card = state.pending[row][index]
      if (!card) return state
      const newRowArr = [...state.pending[row]]
      newRowArr.splice(index, 1)
      const newPending: PendingRows = { ...state.pending, [row]: newRowArr }
      return { ...state, pending: newPending, humanHand: [...state.humanHand, card], selectedCard: null }
    }

    case 'APPLY_COACH_PLACEMENT': {
      if (state.phase !== 'placing') return state
      const { placement } = action
      // Reconstruct full hand (hand + all currently pending cards).
      const fullHand = [
        ...state.humanHand,
        ...state.pending.top,
        ...state.pending.middle,
        ...state.pending.bottom,
      ]
      // Remove placed cards from the full hand; the remainder is the discard (or empty on street 0).
      const placed = [...placement.topAdd, ...placement.middleAdd, ...placement.bottomAdd]
      const remaining = [...fullHand]
      for (const c of placed) {
        const idx = remaining.findIndex(h => sameCard(h, c))
        if (idx !== -1) remaining.splice(idx, 1)
      }
      return {
        ...state,
        pending: { top: [...placement.topAdd], middle: [...placement.middleAdd], bottom: [...placement.bottomAdd] },
        humanHand: remaining,
        selectedCard: null,
      }
    }

    case 'LOCK_IN': {
      if (state.phase === 'bonus_oneshot') return lockBonusOneshot(state)
      return lockNormalOrSide(state)
    }

    case 'ADVANCE': {
      return advance(state)
    }

    case 'START_BONUS': {
      return startBonus(state)
    }

    case 'SKIP_BONUS': {
      return {
        ...state,
        phase: 'bonus_scoring',
        bonusScores: state.normalScores.map(() => 0),
        totalScores: state.normalScores,
      }
    }

    case 'LOCK_BONUS_ONESHOT': {
      return lockBonusOneshot(state)
    }

    case 'BOT_PLACED': {
      if (state.phase !== 'bot_thinking') return state  // stale dispatch guard
      const newBotBoards = state.botBoards.map((board, i) =>
        applyPlacement(board, action.placements[i]!)
      )
      return { ...state, phase: 'revealing', botBoards: newBotBoards }
    }

    case 'RESTORE_SNAPSHOT':
      return action.snapshot

    default:
      return state
  }
}

// ── Lock normal/side game street ──────────────────────────────────────────────

function lockNormalOrSide(state: GameState): GameState {
  const { context, street, sideStreet, pending, humanHand } = state
  const isStreet0 = context === 'normal' ? street === 0 : sideStreet === 0
  const totalPending = pending.top.length + pending.middle.length + pending.bottom.length
  const required = isStreet0 ? 5 : 2
  if (totalPending !== required) return state // not ready

  // Discard = remaining card in hand (streets 1-4)
  const discard = !isStreet0 && humanHand.length > 0 ? humanHand[0]! : null

  // Build human's placement and apply
  const humanPlacement = {
    topAdd: pending.top,
    middleAdd: pending.middle,
    bottomAdd: pending.bottom,
    discard,
  }

  if (context === 'normal') {
    const newHumanBoard = applyPlacement(state.humanBoard, humanPlacement)
    // Bots compute asynchronously via MC — GamePage's useEffect dispatches BOT_PLACED.
    return {
      ...state,
      phase: 'bot_thinking',
      humanBoard: newHumanBoard,
      humanHand: [],
      pending: emptyPending(),
      selectedCard: null,
    }
  } else {
    // Side game — bots' side boards are pre-computed; only update human's
    const newSideBoard = applyPlacement(state.humanSideBoard, humanPlacement)

    return {
      ...state,
      phase: 'revealing',
      humanSideBoard: newSideBoard,
      humanHand: [],
      pending: emptyPending(),
      selectedCard: null,
    }
  }
}

// ── Advance after reveal ──────────────────────────────────────────────────────

function advance(state: GameState): GameState {
  if (state.context === 'normal') {
    if (state.street < 4) {
      const nextStreet = state.street + 1
      return {
        ...state,
        phase: 'placing',
        street: nextStreet,
        humanHand: state.preDealt[0]![nextStreet]!,
        pending: emptyPending(),
        selectedCard: null,
      }
    }
    // Street 4 done → compute scores
    const allBoards: Board[] = [state.humanBoard as Board, ...(state.botBoards as Board[])]
    const nets = scoreTable(allBoards)
    return {
      ...state,
      phase: 'scoring',
      normalScores: nets,
    }
  } else {
    // Side game
    if (state.sideStreet < 4) {
      const nextSide = state.sideStreet + 1
      return {
        ...state,
        phase: 'placing',
        sideStreet: nextSide,
        humanHand: state.sidePreDealt[0]![nextSide]!,
        pending: emptyPending(),
        selectedCard: null,
      }
    }
    // Side game done → finalize bonus
    return finalizeBonusScoring(state)
  }
}

// ── Start bonus round ─────────────────────────────────────────────────────────

// Fold a frozen sequence of historical placements onto an empty board — used
// to reconstruct a replayed opponent's exact final side-game board without
// re-running any policy/heuristic.
function foldPlacements(placements: readonly Placement[]): PartialBoard {
  let board = emptyBoard()
  for (const p of placements) board = applyPlacement(board, p)
  return board
}

function startBonus(state: GameState): GameState {
  const { humanBoard, botBoards, normalScores, seed, replay } = state
  const bonusSeed = replay ? replay.fallbackSeed : seed + 1

  const humanQ = bonusTrigger(humanBoard as Board)
  const botQs = botBoards.map(b => bonusTrigger(b as Board))

  // If no qualifiers at all, skip to bonus_scoring
  const anyQualifier = humanQ !== null || botQs.some(q => q !== null)
  if (!anyQualifier) {
    return {
      ...state,
      phase: 'bonus_scoring',
      humanBonusQualifier: null,
      botBonusQualifiers: botQs,
      bonusScores: normalScores.map(() => 0),
      totalScores: normalScores,
    }
  }

  const bonusDeck = new Deck(bonusSeed)

  // The human's own bonus content: reuse the historical deal only if this
  // hand's replayed tier still matches history (their new play might have
  // reached a different tier, or none at all — in that case there's no
  // historical data to replay, so fall through to a fresh, deterministic deal
  // exactly like live play, just seeded from the replay's own fallback seed).
  const humanReplayMatches = replay?.humanBonusReplay != null && replay.humanBonusReplay.tier === humanQ
  const humanBonusCards =
    humanReplayMatches && replay!.humanBonusReplay!.tier !== null ? replay!.humanBonusReplay!.cards
    : humanQ ? bonusDeck.deal(bonusDealCount(humanQ))
    : []

  // Deal bonus cards for qualifiers; deal side game for non-qualifiers
  const botBonusCards = botQs.map(q => q ? bonusDeck.deal(bonusDealCount(q)) : [])

  // Bot qualifier boards (one-shot): use the frozen historical board when
  // replaying (opponents always replay verbatim, never recomputed); fall
  // back to the computed one-shot solver otherwise, or if replay data for
  // this specific opponent happens to be missing.
  const computedBotBonusBoards: PartialBoard[] = botQs.map((q, i) =>
    q ? botOneShotBonus(botBonusCards[i]!) : emptyBoard()
  )
  const botBonusBoards: PartialBoard[] = replay
    ? computedBotBonusBoards.map((b, i) => {
        const outcome = replay.opponentBonusOutcomes[i]
        return outcome && outcome.qualifies ? outcome.board : b
      })
    : computedBotBonusBoards

  // Side game: non-qualifying players
  // Deal side game cards from a separate section of the bonus deck
  const humanInSide = humanQ === null
  const botInSide = botQs.map(q => q === null)

  // Build side preDealt
  const sideSeed = bonusSeed + 1
  const sideDeck = new Deck(sideSeed)
  const sideDealtCounts = [5, 3, 3, 3, 3]

  const sidePreDealt: Card[][][] = []
  if (humanInSide) {
    const humanSide: Card[][] =
      humanReplayMatches && replay!.humanBonusReplay!.tier === null ? replay!.humanBonusReplay!.sideHands
      : sideDealtCounts.map(cnt => sideDeck.deal(cnt))
    sidePreDealt.push(humanSide)
  }
  for (let i = 0; i < botQs.length; i++) {
    if (botInSide[i]) {
      const botSide: Card[][] = []
      for (const cnt of sideDealtCounts) botSide.push(sideDeck.deal(cnt))
      sidePreDealt.push(botSide)
    }
  }

  // Pre-compute bot non-qualifying side game boards. Interleaved across all
  // participating bots (see botSideGamesInterleaved) so if more than one bot
  // is in the side game, they see each other's revealed boards, not just
  // cards in isolation.
  const botSideBoards: PartialBoard[] = new Array(botQs.length).fill(null)
  const sideBotIndices: number[] = []
  const sideBotDealt: Card[][][] = []
  {
    let sideIdx = humanInSide ? 1 : 0
    for (let i = 0; i < botQs.length; i++) {
      if (botInSide[i]) {
        sideBotIndices.push(i)
        sideBotDealt.push(sidePreDealt[sideIdx]!)
        sideIdx++
      } else {
        botSideBoards[i] = emptyBoard() // not participating in side game
      }
    }
  }
  const interleavedBoards = botSideGamesInterleaved(sideBotDealt)
  for (let k = 0; k < sideBotIndices.length; k++) {
    botSideBoards[sideBotIndices[k]!] = interleavedBoards[k]!
  }

  // Replay: replace each side-gaming opponent's computed board with their
  // frozen historical placements folded in order, when available.
  if (replay) {
    for (let i = 0; i < botQs.length; i++) {
      if (!botInSide[i]) continue
      const outcome = replay.opponentBonusOutcomes[i]
      if (outcome && !outcome.qualifies) botSideBoards[i] = foldPlacements(outcome.placements)
    }
  }

  if (humanInSide) {
    // Human plays side game interactively
    return {
      ...state,
      phase: 'placing',
      context: 'side',
      humanBonusQualifier: humanQ,
      botBonusQualifiers: botQs,
      humanBonusCards,
      botBonusCards,
      humanBonusBoard: emptyBoard(),
      botBonusBoards,
      sidePreDealt,
      sideStreet: 0,
      humanSideBoard: emptyBoard(),
      botSideBoards,
      humanHand: sidePreDealt[0]![0]!,
      pending: emptyPending(),
      selectedCard: null,
    }
  } else {
    // Human qualifies: bonus_oneshot
    return {
      ...state,
      phase: 'bonus_oneshot',
      context: 'normal',
      humanBonusQualifier: humanQ,
      botBonusQualifiers: botQs,
      humanBonusCards,
      botBonusCards,
      humanBonusBoard: emptyBoard(),
      botBonusBoards,
      sidePreDealt,
      sideStreet: 0,
      humanSideBoard: emptyBoard(),
      botSideBoards,
      humanHand: humanBonusCards,
      pending: emptyPending(),
      selectedCard: null,
    }
  }
}

// ── Lock bonus one-shot ───────────────────────────────────────────────────────

function lockBonusOneshot(state: GameState): GameState {
  const { pending } = state
  const totalPending = pending.top.length + pending.middle.length + pending.bottom.length
  if (totalPending !== 13) return state

  const humanBonusBoard: PartialBoard = {
    top: pending.top,
    middle: pending.middle,
    bottom: pending.bottom,
  }

  const newState: GameState = {
    ...state,
    humanBonusBoard,
    pending: emptyPending(),
    humanHand: [],
    selectedCard: null,
  }
  return finalizeBonusScoring(newState)
}

// ── Finalize bonus scoring ────────────────────────────────────────────────────

function finalizeBonusScoring(state: GameState): GameState {
  // Determine each player's bonus board
  const humanFinalBonus = state.humanBonusQualifier
    ? state.humanBonusBoard      // one-shot qualifier
    : state.humanSideBoard       // non-qualifier side game

  const botFinalBonus = state.botBonusQualifiers.map((q, i) =>
    q ? state.botBonusBoards[i]! : state.botSideBoards[i]!
  )

  const bonusBoards: Board[] = [humanFinalBonus as Board, ...(botFinalBonus as Board[])]
  const bonusNets = scoreTable(bonusBoards)
  const totalScores = state.normalScores.map((n, i) => n + (bonusNets[i] ?? 0))

  return {
    ...state,
    phase: 'bonus_scoring',
    humanBonusBoard: humanFinalBonus,
    botBonusBoards: botFinalBonus,
    bonusScores: bonusNets,
    totalScores,
  }
}
