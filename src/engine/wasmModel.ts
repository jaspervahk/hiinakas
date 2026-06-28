// Unified NNModel interface for MLP value-network inference.
//
// Two backends implement this interface:
//   createJSModel   — pure TypeScript, always available
//   createWasmModel — Rust/SIMD WASM, 5-15× faster; used in worker + selfplay
//
// Both are obtained via factory functions. Callers never touch MLPWeights or
// the WASM MlpModel class directly — the interface hides which backend is active.

import { parseMLPWeights, mlpForward } from './mlpInference'

// ── Interface ──────────────────────────────────────────────────────────────

export interface NNModel {
  readonly inputDim: number
  /** Multiply raw forward() output by this to get expected game-point value. */
  readonly outputScale: number
  /** Single forward pass. Returns raw scalar (not yet × outputScale). */
  forward(input: Float32Array): number
  /**
   * n samples packed flat: [sample_0..., sample_1..., ...], each of length inputDim.
   * Returns Float32Array of n raw scalars (not yet × outputScale).
   * Crosses the JS↔WASM boundary once for all n samples.
   */
  forwardBatch(inputs: Float32Array, n: number): Float32Array
}

// ── JS fallback (always available) ────────────────────────────────────────

export function createJSModel(buffer: ArrayBuffer): NNModel {
  const w = parseMLPWeights(buffer)
  const dim = w.inputDim
  return {
    inputDim: w.inputDim,
    outputScale: w.outputScale,
    forward(input) { return mlpForward(w, input) },
    forwardBatch(inputs, n) {
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        out[i] = mlpForward(w, inputs.subarray(i * dim, (i + 1) * dim))
      }
      return out
    },
  }
}

// ── WASM wrapper ───────────────────────────────────────────────────────────
//
// Caller is responsible for WASM init (call initWasm() or initSync() from
// ofc_nn.js) and for constructing the MlpModel instance. This makes wasmModel.ts
// environment-agnostic: the browser worker uses async init(), the Node.js
// selfplay script uses initSync() with bytes from disk.
//
// Structural typing avoids importing ofc_nn.js here, which would force WASM
// init at module load time in contexts that only need the JS fallback.

export interface RawMlpModel {
  input_dim(): number
  output_scale(): number
  forward(input: Float32Array): number
  forward_batch(inputs: Float32Array, n: number): Float32Array
}

export function createWasmModel(m: RawMlpModel): NNModel {
  return {
    get inputDim() { return m.input_dim() },
    get outputScale() { return m.output_scale() },
    forward(input) { return m.forward(input) },
    forwardBatch(inputs, n) { return m.forward_batch(inputs, n) },
  }
}
