import { describe, it, expect } from 'vitest'
import { chunkArray, DECISIONS_PER_CHUNK } from '../sessionAnalysis'

describe('chunkArray', () => {
  it('returns no chunks for an empty array', () => {
    expect(chunkArray([], 175)).toEqual([])
  })

  it('splits N items into ceil(N/size) chunks and rejoins to the original array', () => {
    const items = Array.from({ length: 4001 }, (_, i) => i)
    const chunks = chunkArray(items, DECISIONS_PER_CHUNK)
    expect(chunks.length).toBe(Math.ceil(items.length / DECISIONS_PER_CHUNK))
    expect(chunks.every(c => c.length <= DECISIONS_PER_CHUNK)).toBe(true)
    expect(chunks.flat()).toEqual(items)
  })

  it('puts everything in one chunk when the array is smaller than the chunk size', () => {
    const items = [1, 2, 3]
    const chunks = chunkArray(items, 175)
    expect(chunks).toEqual([[1, 2, 3]])
  })
})
