// Pure TypeScript MLP forward pass — no external dependencies.
// Compatible with weights exported by scripts/train.py.
//
// Binary weight file format (little-endian):
//   magic:        u8[4]  "OFCW"
//   version:      u32    = 2  (v1 = original, v2 adds output_scale)
//   num_layers:   u32
//   input_dim:    u32    = 525
//   output_scale: f32    (v2 only) multiply raw output to get game points
//   Per layer:
//     in_size:    u32
//     out_size:   u32
//     activation: u32  (0 = relu, 1 = linear)
//     weights:    f32[out_size * in_size]  row-major
//     biases:     f32[out_size]

export interface MLPLayer {
  weights: Float32Array  // [out_size × in_size] row-major
  biases: Float32Array
  inSize: number
  outSize: number
  relu: boolean
}

export interface MLPWeights {
  layers: MLPLayer[]
  inputDim: number
  // Multiply raw model output (≈[-1,1]) by this to get expected net score in game points.
  // v2 models store the exact training y_scale; v1 models use the empirical estimate.
  outputScale: number
}

// v1 models were trained with y_scale = max(|labels|) across the training window.
// Observed range across recent batches is ~39 pts (royalties + scoop bonuses).
const DEFAULT_OUTPUT_SCALE_V1 = 39.0

export function parseMLPWeights(buffer: ArrayBuffer): MLPWeights {
  const view = new DataView(buffer)
  let off = 0

  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  )
  if (magic !== 'OFCW') throw new Error(`Bad magic: ${magic}`)
  off += 4

  const version = view.getUint32(off, true); off += 4
  if (version !== 1 && version !== 2) throw new Error(`Unsupported version: ${version}`)

  const numLayers = view.getUint32(off, true); off += 4
  const inputDim  = view.getUint32(off, true); off += 4

  const outputScale = version >= 2
    ? view.getFloat32(off, true) + (off += 4, 0)
    : DEFAULT_OUTPUT_SCALE_V1

  const layers: MLPLayer[] = []
  for (let l = 0; l < numLayers; l++) {
    const inSize    = view.getUint32(off, true); off += 4
    const outSize   = view.getUint32(off, true); off += 4
    const activation = view.getUint32(off, true); off += 4
    const relu = activation === 0

    const wLen = inSize * outSize
    const weights = new Float32Array(buffer, off, wLen); off += wLen * 4
    const biases  = new Float32Array(buffer, off, outSize); off += outSize * 4

    // Copy to avoid holding a reference to the full buffer at a potentially unaligned offset.
    layers.push({
      weights: new Float32Array(weights),
      biases: new Float32Array(biases),
      inSize, outSize, relu,
    })
  }

  return { layers, inputDim, outputScale }
}

// Forward pass. Returns the raw scalar output (normalized, multiply by outputScale for points).
export function mlpForward(weights: MLPWeights, input: Float32Array): number {
  let x: Float32Array = input
  for (const layer of weights.layers) {
    const out = new Float32Array(layer.outSize)
    const w = layer.weights
    const b = layer.biases
    for (let j = 0; j < layer.outSize; j++) {
      let sum = b[j]!
      const base = j * layer.inSize
      for (let i = 0; i < layer.inSize; i++) {
        sum += x[i]! * w[base + i]!
      }
      out[j] = layer.relu ? (sum > 0 ? sum : 0) : sum
    }
    x = out
  }
  return x[0]!
}
