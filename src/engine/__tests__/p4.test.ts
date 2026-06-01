import { describe, it, expect } from 'vitest'
import { bestBonusBoard } from '../bestBonus'
import { isFoul, royalties } from '../rules'
import { parseCards } from '../deck'

describe('bestBonusBoard', () => {
  it('QQ qualifier: 13 cards → valid non-fouled board', () => {
    const cards = parseCards(['As','Ah','Ac','Kd','Kh','Qc','Qs','Jd','Jh','Tc','Ts','9d','8c'])
    const board = bestBonusBoard(cards, 0)
    expect(board.top.length).toBe(3)
    expect(board.middle.length).toBe(5)
    expect(board.bottom.length).toBe(5)
    expect(isFoul(board)).toBe(false)
  })

  it('KK qualifier: 14 cards → valid non-fouled board', () => {
    const cards = parseCards(['As','Ah','Kd','Kh','Kc','Qd','Qh','Jd','Jh','Tc','Ts','9d','8c','7h'])
    const board = bestBonusBoard(cards, 1)
    expect(isFoul(board)).toBe(false)
    expect(royalties(board)).toBeGreaterThan(0)
  }, 30_000)

  it('AA/trips qualifier: 15 cards → valid non-fouled board', () => {
    const cards = parseCards(['As','Ah','Ad','Kd','Kh','Kc','Qd','Qh','Jd','Jh','Tc','9d','8c','7h','6s'])
    const board = bestBonusBoard(cards, 2)
    expect(isFoul(board)).toBe(false)
  }, 60_000)

  it('maximizes royalties compared to naive sort', () => {
    // Royal flush possible: A K Q J T of spades
    const cards = parseCards(['As','Ks','Qs','Js','Ts','2d','3d','4d','5d','6d','7d','8d','9d'])
    const board = bestBonusBoard(cards, 0)
    expect(isFoul(board)).toBe(false)
    // Royal flush in bottom = +25 royalties
    const roy = royalties(board)
    expect(roy).toBeGreaterThanOrEqual(25)
  })
})
