/*
 * WASM Engine stub — Phase 6
 *
 * To activate the Rust/WASM core:
 * 1. Build the Rust crate: cd rust/ofc-engine && wasm-pack build --target web
 * 2. Copy the generated pkg/ into public/wasm/
 * 3. Update initWasm() below to import the wasm init function
 * 4. Call createEngine() which will return WasmEngine once loaded
 *
 * The WasmEngine implements the same EngineInterface so zero UI changes are needed.
 * Self-play training runs offline (see rust/trainer/), weights are exported to
 * Firebase Storage (/models/policy-v{n}.bin) and loaded in the Worker at startup.
 */
import type { EngineInterface } from './interface'
import { LocalEngine } from './interface'
import type { Card, HandRank, Board, PartialBoard, BonusQualifier } from './types'
import type { Placement } from './placement'

export class WasmEngine implements EngineInterface {
  // Delegates to LocalEngine until WASM is loaded.
  private inner: EngineInterface = new LocalEngine()

  evaluate3(cards: readonly Card[]): HandRank { return this.inner.evaluate3(cards) }
  evaluate5(cards: readonly Card[]): HandRank { return this.inner.evaluate5(cards) }
  compareHandRank(a: HandRank, b: HandRank): number { return this.inner.compareHandRank(a, b) }
  isFoul(board: Board): boolean { return this.inner.isFoul(board) }
  royalties(board: Board): number { return this.inner.royalties(board) }
  bonusTrigger(board: Board): BonusQualifier | null { return this.inner.bonusTrigger(board) }
  bonusDealCount(q: BonusQualifier): number { return this.inner.bonusDealCount(q) }
  scoreTable(boards: Board[]): number[] { return this.inner.scoreTable(boards) }
  legalPlacements(board: PartialBoard, dealt: readonly Card[], street: number): Placement[] {
    return this.inner.legalPlacements(board, dealt, street)
  }
  applyPlacement(board: PartialBoard, p: Placement): PartialBoard { return this.inner.applyPlacement(board, p) }
  heuristicPlacement(board: PartialBoard, dealt: readonly Card[], street: number, oppBoards: readonly PartialBoard[] = []): Placement {
    return this.inner.heuristicPlacement(board, dealt, street, oppBoards)
  }
  bestBonusBoard(cards: Card[], numDiscard: number): Board { return this.inner.bestBonusBoard(cards, numDiscard) }
}

export async function initWasm(): Promise<void> {
  // No-op until the Rust crate is wired in. See file header.
  return
}

export function createEngine(): EngineInterface {
  // Returns WasmEngine; if WASM is not loaded, falls back transparently to LocalEngine.
  return new WasmEngine()
}
