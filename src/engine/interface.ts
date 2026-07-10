import type {
  Card, HandRank, Board, PartialBoard, BonusQualifier,
} from './types'
import type { Placement } from './placement'
import { evaluate3, evaluate5, compareHandRank } from './evaluate'
import { isFoul, royalties, bonusTrigger, bonusDealCount } from './rules'
import { scoreTable } from './scoring'
import { legalPlacements, applyPlacement } from './placement'
import { heuristicPlacement } from './heuristic'
import { bestBonusBoard } from './bestBonus'

// Common interface for the engine. A Rust→WASM core can implement this
// alongside LocalEngine; the UI never needs to know which one is active.
export interface EngineInterface {
  evaluate3(cards: readonly Card[]): HandRank
  evaluate5(cards: readonly Card[]): HandRank
  compareHandRank(a: HandRank, b: HandRank): number
  isFoul(board: Board): boolean
  royalties(board: Board): number
  bonusTrigger(board: Board): BonusQualifier | null
  bonusDealCount(q: BonusQualifier): number
  scoreTable(boards: Board[]): number[]
  legalPlacements(board: PartialBoard, dealt: readonly Card[], street: number): Placement[]
  applyPlacement(board: PartialBoard, p: Placement): PartialBoard
  heuristicPlacement(board: PartialBoard, dealt: readonly Card[], street: number, oppBoards?: readonly PartialBoard[]): Placement
  bestBonusBoard(cards: Card[], numDiscard: number): Board
}

export class LocalEngine implements EngineInterface {
  evaluate3(cards: readonly Card[]): HandRank { return evaluate3(cards) }
  evaluate5(cards: readonly Card[]): HandRank { return evaluate5(cards) }
  compareHandRank(a: HandRank, b: HandRank): number { return compareHandRank(a, b) }
  isFoul(board: Board): boolean { return isFoul(board) }
  royalties(board: Board): number { return royalties(board) }
  bonusTrigger(board: Board): BonusQualifier | null { return bonusTrigger(board) }
  bonusDealCount(q: BonusQualifier): number { return bonusDealCount(q) }
  scoreTable(boards: Board[]): number[] { return scoreTable(boards) }
  legalPlacements(board: PartialBoard, dealt: readonly Card[], street: number): Placement[] {
    return legalPlacements(board, dealt, street)
  }
  applyPlacement(board: PartialBoard, p: Placement): PartialBoard { return applyPlacement(board, p) }
  heuristicPlacement(board: PartialBoard, dealt: readonly Card[], street: number, oppBoards: readonly PartialBoard[] = []): Placement {
    return heuristicPlacement(board, dealt, street, oppBoards)
  }
  bestBonusBoard(cards: Card[], numDiscard: number): Board { return bestBonusBoard(cards, numDiscard) }
}

// Singleton — UI/worker import this rather than internal engine modules.
export const engine: EngineInterface = new LocalEngine()
