// Engine public boundary — the UI and worker import only from here.

export type { Card, Rank, Suit, HandRank, Board, PartialBoard, BonusQualifier, PairResult } from './types'
export { HandCategory } from './types'

export { Deck, FULL_DECK, RANKS, SUITS, parseCard, parseCards } from './deck'
export { evaluate3, evaluate5, compareHandRank } from './evaluate'
export { isFoul, royalties, bonusTrigger, bonusDealCount } from './rules'
export { scorePair, scoreTable } from './scoring'

// P2
export type { Placement } from './placement'
export { legalPlacements, applyPlacement } from './placement'
export { heuristicPlacement } from './heuristic'
export type { InfoState, ScoredPlacement, MCOptions, RNG } from './mc'
export { computeEV, runMC, getBotMove } from './mc'

// P4
export { bestBonusBoard } from './bestBonus'
