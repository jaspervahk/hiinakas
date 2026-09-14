import { describe, it, expect } from 'vitest'
import { evaluate3, evaluate5 } from '../evaluate'
import { fastEval3, fastEval5 } from '../fastEvaluate'
import { heuristicPlacement } from '../heuristic'
import { legalPlacements, applyPlacement } from '../placement'
import { FULL_DECK } from '../deck'
import type { Card, PartialBoard, HandRank } from '../types'

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled(rng: () => number): Card[] {
  const a = [...FULL_DECK] as Card[]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = a[i]!; a[i] = a[j]!; a[j] = tmp
  }
  return a
}

const rankKey = (r: HandRank) => `${r.category}:${r.tiebreakers.join(',')}`

// heuristic.ts uses fastEvaluate's rank functions rather than evaluate.ts's in
// its hot path (it is the rollout policy, so it runs millions of times per
// decision). That swap is only sound while the two agree exactly — not just on
// category, but on the full tiebreaker tuple, since handRankScore encodes
// every element and the heuristic's argmax is decided on those scores.
describe('fastEval3/fastEval5 match evaluate3/evaluate5 exactly', () => {
  it('agrees on 20000 random 5-card hands', () => {
    const rng = mulberry32(20250914)
    for (let i = 0; i < 20000; i++) {
      const d = shuffled(rng)
      expect(rankKey(fastEval5(d[0]!, d[1]!, d[2]!, d[3]!, d[4]!)))
        .toBe(rankKey(evaluate5(d.slice(0, 5))))
    }
  })

  it('agrees on 20000 random 3-card hands', () => {
    const rng = mulberry32(987654)
    for (let i = 0; i < 20000; i++) {
      const d = shuffled(rng)
      expect(rankKey(fastEval3(d[0]!, d[1]!, d[2]!)))
        .toBe(rankKey(evaluate3(d.slice(0, 3))))
    }
  })

  it('agrees on hands built to hit every category, including the wheel', () => {
    const cases: string[][] = [
      ['As', 'Ks', 'Qs', 'Js', 'Ts'],   // royal flush
      ['9h', '8h', '7h', '6h', '5h'],   // straight flush
      ['Ah', '5c', '4d', '3s', '2h'],   // wheel straight (ace plays low)
      ['As', '5s', '4s', '3s', '2s'],   // steel wheel
      ['7c', '7d', '7h', '7s', '2c'],   // quads
      ['Kc', 'Kd', 'Kh', '4s', '4c'],   // full house
      ['Ac', 'Jc', '8c', '5c', '2c'],   // flush
      ['9c', '8d', '7h', '6s', '5c'],   // straight
      ['Qc', 'Qd', 'Qh', '9s', '4c'],   // trips
      ['Jc', 'Jd', '6h', '6s', '3c'],   // two pair
      ['Tc', 'Td', '8h', '5s', '2c'],   // one pair
      ['Ac', 'Jd', '9h', '6s', '3c'],   // high card
    ]
    const parse = (s: string): Card => {
      const R: Record<string, number> = { A: 14, K: 13, Q: 12, J: 11, T: 10 }
      const r = (R[s[0]!] ?? Number(s[0]))
      return { rank: r as Card['rank'], suit: s[1] as Card['suit'] }
    }
    for (const c of cases) {
      const d = c.map(parse)
      expect(rankKey(fastEval5(d[0]!, d[1]!, d[2]!, d[3]!, d[4]!)))
        .toBe(rankKey(evaluate5(d)))
    }
  })
})

// Behavior lock. heuristicPlacement is the rollout policy behind the bot, the
// coach and the analyzer, so a change to its scoring silently changes every EV
// in the app. Optimizations to it are expected to be bit-identical; this pins
// the moves it makes over a broad corpus so one that isn't cannot pass
// unnoticed. A deliberate strategy change should update the digest in the same
// commit that makes it, with the reason in the message.
describe('heuristicPlacement behavior lock', () => {
  // Positions come from random LEGAL play rather than heuristic play, so the
  // corpus stays fixed even when the heuristic's own choices change.
  function corpus(): Array<{ board: PartialBoard; hand: Card[]; street: number; opps: PartialBoard[] }> {
    const out: Array<{ board: PartialBoard; hand: Card[]; street: number; opps: PartialBoard[] }> = []
    for (let g = 0; g < 40; g++) {
      const rng = mulberry32(1000 + g)
      const players = g % 3 === 0 ? 3 : 2
      const deck = shuffled(rng)
      let di = 0
      const boards: PartialBoard[] = Array.from({ length: players }, () => ({ top: [], middle: [], bottom: [] }))
      for (let s = 0; s <= 4; s++) {
        const n = s === 0 ? 5 : 3
        const hands: Card[][] = []
        for (let p = 0; p < players; p++) { hands.push(deck.slice(di, di + n)); di += n }
        out.push({ board: boards[0]!, hand: hands[0]!, street: s, opps: boards.slice(1) })
        for (let p = 0; p < players; p++) {
          const legal = legalPlacements(boards[p]!, hands[p]!, s)
          boards[p] = applyPlacement(boards[p]!, legal[Math.floor(rng() * legal.length)]!)
        }
      }
    }
    return out
  }

  it('picks the same move in every corpus position', () => {
    const cs = (c: Card) => `${c.rank}${c.suit}`
    const positions = corpus()
    expect(positions.length).toBe(200)

    // FNV-1a over every chosen placement, so one differing move fails the test.
    let h = 0x811c9dc5
    for (const p of positions) {
      const pl = heuristicPlacement(p.board, p.hand, p.street, p.opps)
      const s = `${pl.topAdd.map(cs).join('.')}/${pl.middleAdd.map(cs).join('.')}/`
        + `${pl.bottomAdd.map(cs).join('.')}/${pl.discard ? cs(pl.discard) : '-'};`
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193) >>> 0
      }
    }
    expect(h.toString(16)).toBe('6af05040')
  })
})

// smallScore counts ranks in a module-level scratch buffer (RANK_COUNTS) so it
// allocates nothing per call. That is only sound while scoring never
// interleaves with itself. runMC is a generator and the worker drives two of
// them concurrently when a newer coach request supersedes an older one
// (engine.worker.ts awaits between batches), so this pins the property: a
// generator suspended at a yield must not be able to observe another one's
// leftover counts.
describe('scoring is safe against interleaved runMC generators', () => {
  it('interleaved generators produce the same EVs as sequential ones', async () => {
    const { runMC } = await import('../mc')
    const mk = (seed: number) => {
      const rng = mulberry32(seed)
      const d = shuffled(rng)
      return {
        state: {
          board: { top: [d[0]!], middle: [d[1]!, d[2]!], bottom: [d[3]!, d[4]!] },
          hand: [d[5]!, d[6]!, d[7]!],
          street: 2,
          revealedOpponentBoards: [{ top: [d[8]!], middle: [d[9]!], bottom: [d[10]!] }],
        },
        seed,
      }
    }
    const a = mk(11), b = mk(22)
    const drain = (s: typeof a) => {
      let last: unknown[] = []
      for (const r of runMC(s.state, { totalRollouts: 12, batchSize: 3 }, mulberry32(s.seed))) last = r
      return last
    }
    const seqA = drain(a), seqB = drain(b)

    // Now step both generators in lockstep, alternating between them.
    const ga = runMC(a.state, { totalRollouts: 12, batchSize: 3 }, mulberry32(a.seed))
    const gb = runMC(b.state, { totalRollouts: 12, batchSize: 3 }, mulberry32(b.seed))
    let la: unknown[] = [], lb: unknown[] = []
    for (;;) {
      const ra = ga.next(), rb = gb.next()
      if (!ra.done) la = ra.value
      if (!rb.done) lb = rb.value
      if (ra.done && rb.done) break
    }
    expect(la).toEqual(seqA)
    expect(lb).toEqual(seqB)
  })
})
