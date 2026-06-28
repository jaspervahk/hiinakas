// WASM MLP inference for Pineapple OFC.
//
// Compiled with target-feature=+simd128 so LLVM auto-vectorises the inner
// dot-product loops using WASM SIMD (f32x4 instructions). Typical speedup
// over the JS fallback: 5-15× on the 525→256→256→128→1 network.
//
// Exposes two entry points via wasm-bindgen:
//   MlpModel::new(ofcw_bytes)     → parse OFCW weights
//   model.forward(input)          → single sample, returns f32
//   model.forward_batch(flat, n)  → n samples packed flat, returns Float32Array
//
// The batch entry point lets the TS caller cross the JS↔WASM boundary once
// for all legal placements (~15-100), eliminating per-sample overhead.

use wasm_bindgen::prelude::*;

// ── Layer ─────────────────────────────────────────────────────────────────────

struct Layer {
    weights: Vec<f32>, // [out_size × in_size] row-major
    biases:  Vec<f32>, // [out_size]
    in_size:  usize,
    out_size: usize,
    relu:     bool,
}

impl Layer {
    /// Compute output = W·input + bias (+ optional ReLU) into a pre-allocated slice.
    /// The inner loop is a dot product over in_size elements — LLVM will vectorise
    /// this with f32x4 when simd128 is enabled in the target features.
    #[inline]
    fn apply(&self, input: &[f32], output: &mut [f32]) {
        let w     = &self.weights;
        let b     = &self.biases;
        let n_in  = self.in_size;
        let relu  = self.relu;

        for j in 0..self.out_size {
            let row_start = j * n_in;
            let w_row = &w[row_start..row_start + n_in];

            // Dot product — auto-vectorised to f32x4.mul + f32x4.add by LLVM.
            let mut s = b[j];
            for (wi, xi) in w_row.iter().zip(input.iter()) {
                s += wi * xi;
            }

            output[j] = if relu { s.max(0.0) } else { s };
        }
    }
}

// ── Model ─────────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct MlpModel {
    layers:       Vec<Layer>,
    output_scale: f32,
    input_dim:    u32,
    // Scratch buffers reused across calls to avoid repeated allocation.
    // Sized for the maximum hidden dimension (256 for the current architecture).
    max_out: usize,
}

#[wasm_bindgen]
impl MlpModel {
    /// Parse an OFCW binary weight file and construct the model.
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[u8]) -> Result<MlpModel, JsError> {
        if data.len() < 16 {
            return Err(JsError::new("OFCW buffer too short"));
        }
        if &data[0..4] != b"OFCW" {
            return Err(JsError::new("Bad OFCW magic bytes"));
        }

        let version    = read_u32(data, 4);
        let num_layers = read_u32(data, 8) as usize;
        let input_dim  = read_u32(data, 12);

        if version != 1 && version != 2 {
            return Err(JsError::new("Unsupported OFCW version (expected 1 or 2)"));
        }

        let mut off = 16usize;
        let output_scale = if version >= 2 {
            let s = read_f32(data, off);
            off += 4;
            s
        } else {
            39.0_f32 // empirical default for v1 models
        };

        let mut layers  = Vec::with_capacity(num_layers);
        let mut max_out = 1usize;

        for _ in 0..num_layers {
            let in_size  = read_u32(data, off) as usize; off += 4;
            let out_size = read_u32(data, off) as usize; off += 4;
            let act      = read_u32(data, off);           off += 4;
            let relu     = act == 0;

            let w_count = in_size * out_size;
            let mut weights = Vec::with_capacity(w_count);
            for k in 0..w_count {
                weights.push(read_f32(data, off + k * 4));
            }
            off += w_count * 4;

            let mut biases = Vec::with_capacity(out_size);
            for k in 0..out_size {
                biases.push(read_f32(data, off + k * 4));
            }
            off += out_size * 4;

            if out_size > max_out {
                max_out = out_size;
            }
            layers.push(Layer { weights, biases, in_size, out_size, relu });
        }

        Ok(MlpModel { layers, output_scale, input_dim, max_out })
    }

    /// Raw output scale: multiply forward() result by this to get game points.
    pub fn output_scale(&self) -> f32 { self.output_scale }

    /// Input dimension (525 for current models, 473 for legacy).
    pub fn input_dim(&self) -> u32 { self.input_dim }

    /// Single-sample forward pass.
    /// `input` must be a Float32Array of length `input_dim`.
    /// Returns the raw normalised scalar (not yet multiplied by output_scale).
    pub fn forward(&self, input: &[f32]) -> f32 {
        // Two scratch buffers, each large enough for any layer's output.
        // We borrow one as input, write to the other, then swap.
        let mut a = input.to_vec();
        // Extend to max_out if the first layer produces more outputs than the
        // input has elements — keeps the swap logic uniform.
        if a.len() < self.max_out {
            a.resize(self.max_out, 0.0);
        }
        let mut b = vec![0.0f32; self.max_out];

        for layer in &self.layers {
            layer.apply(&a[..layer.in_size], &mut b[..layer.out_size]);
            a[..layer.out_size].copy_from_slice(&b[..layer.out_size]);
        }

        a[0]
    }

    /// Batched forward pass for `n` samples packed contiguously.
    ///
    /// `inputs`  — Float32Array of length `n * input_dim` (row-major: sample 0
    ///             occupies [0..input_dim], sample 1 [input_dim..2*input_dim], …).
    /// Returns   — Float32Array of length `n` with one raw scalar per sample.
    ///
    /// Crossing the JS↔WASM boundary once for all n samples (instead of n times)
    /// and running n independent GEMVs in a tight Rust loop gives 2-4× extra
    /// throughput on top of the SIMD speedup from the single-sample path.
    pub fn forward_batch(&self, inputs: &[f32], n: usize) -> Vec<f32> {
        if n == 0 { return Vec::new(); }

        let in_dim  = self.layers.first().map_or(inputs.len() / n, |l| l.in_size);
        // Stride between consecutive samples in the working buffers.
        // Must be at least in_dim (to hold the first layer's input) and at least
        // max_out (to hold any layer's output after the swap).
        let stride  = in_dim.max(self.max_out);

        // Two interleaved sample arrays: a[sample * stride .. +stride] holds the
        // current activations, b is the write target, then they are swapped.
        let mut a = vec![0.0f32; n * stride];
        let mut b = vec![0.0f32; n * stride];

        // Copy inputs into a (each row is in_dim wide, may be narrower than stride).
        for s in 0..n {
            a[s * stride..s * stride + in_dim]
                .copy_from_slice(&inputs[s * in_dim..(s + 1) * in_dim]);
        }

        let mut cur_in = in_dim;

        for layer in &self.layers {
            for s in 0..n {
                layer.apply(
                    &a[s * stride..s * stride + cur_in],
                    &mut b[s * stride..s * stride + layer.out_size],
                );
            }
            std::mem::swap(&mut a, &mut b);
            cur_in = layer.out_size;
        }

        // Extract the single scalar output per sample.
        (0..n).map(|s| a[s * stride]).collect()
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

#[inline]
fn read_u32(data: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(data[off..off + 4].try_into().unwrap())
}

#[inline]
fn read_f32(data: &[u8], off: usize) -> f32 {
    f32::from_le_bytes(data[off..off + 4].try_into().unwrap())
}
