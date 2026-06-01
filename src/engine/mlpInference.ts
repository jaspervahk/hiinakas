// Pure TypeScript MLP forward pass — no external dependencies.
// Compatible with weights exported by scripts/train.py.
//
// Binary weight file format (little-endian):
//   magic:      u8[4]  "OFCW"
//   version:    u32    = 1
//   num_layers: u32
//   input_dim:  u32    = 473
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
}

export function parseMLPWeights(buffer: ArrayBuffer): MLPWeights {
  const view = new DataView(buffer)
  let off = 0

  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  )
  if (magic !== 'OFCW') throw new Error(`Bad magic: ${magic}`)
  off += 4

  const version = view.getUint32(off, true); off += 4
  if (version !== 1) throw new Error(`Unsupported version: ${version}`)

  const numLayers = view.getUint32(off, true); off += 4
  const inputDim  = view.getUint32(off, true); off += 4

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

  return { layers, inputDim }
}

// Forward pass. Returns the scalar output (expected net score).
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
