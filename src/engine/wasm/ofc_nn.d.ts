/* tslint:disable */
/* eslint-disable */

export class MlpModel {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Single-sample forward pass.
     * `input` must be a Float32Array of length `input_dim`.
     * Returns the raw normalised scalar (not yet multiplied by output_scale).
     */
    forward(input: Float32Array): number;
    /**
     * Batched forward pass for `n` samples packed contiguously.
     *
     * `inputs`  — Float32Array of length `n * input_dim` (row-major: sample 0
     *             occupies [0..input_dim], sample 1 [input_dim..2*input_dim], …).
     * Returns   — Float32Array of length `n` with one raw scalar per sample.
     *
     * Crossing the JS↔WASM boundary once for all n samples (instead of n times)
     * and running n independent GEMVs in a tight Rust loop gives 2-4× extra
     * throughput on top of the SIMD speedup from the single-sample path.
     */
    forward_batch(inputs: Float32Array, n: number): Float32Array;
    /**
     * Input dimension (525 for current models, 473 for legacy).
     */
    input_dim(): number;
    /**
     * Parse an OFCW binary weight file and construct the model.
     */
    constructor(data: Uint8Array);
    /**
     * Raw output scale: multiply forward() result by this to get game points.
     */
    output_scale(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mlpmodel_free: (a: number, b: number) => void;
    readonly mlpmodel_forward: (a: number, b: number, c: number) => number;
    readonly mlpmodel_forward_batch: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly mlpmodel_input_dim: (a: number) => number;
    readonly mlpmodel_new: (a: number, b: number, c: number) => void;
    readonly mlpmodel_output_scale: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
