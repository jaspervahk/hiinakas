import {
  Deck,
  heuristicPlacement, applyPlacement,
  bonusTrigger, bonusDealCount,
  scoreTable,
} from '../engine/index'
import type { Card, PartialBoard, Board } from '../engine/index'
import type { GameState, PendingRows, StreetLog, AppSettings } from './types'
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

// Compute all 5 streets of a bot side game up front.
function botFullSideGame(sideDealt: Card[][]): PartialBoard {
  let board: PartialBoard = emptyBoard()
  for (let s = 0; s <= 4; s++) {
    const hand = sideDealt[s]!
    board = applyPlacement(board, heuristicPlacement(board, hand, s))
  }
  return board
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
  | { type: 'SELECT_CARD'; card: Card }
  | { type: 'ASSIGN_TO_ROW'; row: 'top' | 'middle' | 'bottom' }
  | { type: 'REMOVE_PENDING'; row: 'top' | 'middle' | 'bottom'; index: number }
  | { type: 'LOCK_IN' }
  | { type: 'ADVANCE' }          // from revealing → next street or scoring
  | { type: 'START_BONUS' }      // from scoring → bonus round (if triggered)
  | { type: 'SKIP_BONUS' }       // from scoring → bonus_scoring (no bonus needed)
  | { type: 'LOCK_BONUS_ONESHOT' }
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
    appSettings: { coachEnabled: true, playerCount: 2 },
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

    // Bot placements
    const newBotBoards = state.botBoards.map((board, i) => {
      const botHand = state.preDealt[i + 1]![street]!
      const pl = heuristicPlacement(board, botHand, street)
      return applyPlacement(board, pl)
    })

    return {
      ...state,
      phase: 'revealing',
      humanBoard: newHumanBoard,
      botBoards: newBotBoards,
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

function startBonus(state: GameState): GameState {
  const { humanBoard, botBoards, normalScores, seed } = state
  const bonusSeed = seed + 1

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

  // Deal bonus cards for qualifiers; deal side game for non-qualifiers
  const humanBonusCards = humanQ ? bonusDeck.deal(bonusDealCount(humanQ)) : []
  const botBonusCards = botQs.map(q => q ? bonusDeck.deal(bonusDealCount(q)) : [])

  // Bot qualifier boards (one-shot) computed immediately
  const botBonusBoards: PartialBoard[] = botQs.map((q, i) =>
    q ? botOneShotBonus(botBonusCards[i]!) : emptyBoard()
  )

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
    const humanSide: Card[][] = []
    for (const cnt of sideDealtCounts) humanSide.push(sideDeck.deal(cnt))
    sidePreDealt.push(humanSide)
  }
  for (let i = 0; i < botQs.length; i++) {
    if (botInSide[i]) {
      const botSide: Card[][] = []
      for (const cnt of sideDealtCounts) botSide.push(sideDeck.deal(cnt))
      sidePreDealt.push(botSide)
    }
  }

  // Pre-compute bot non-qualifying side game boards
  const botSideBoards: PartialBoard[] = []
  let sideIdx = humanInSide ? 1 : 0
  for (let i = 0; i < botQs.length; i++) {
    if (botInSide[i]) {
      botSideBoards.push(botFullSideGame(sidePreDealt[sideIdx]!))
      sideIdx++
    } else {
      botSideBoards.push(emptyBoard()) // not participating in side game
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
