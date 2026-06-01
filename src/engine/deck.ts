import type { Card, Rank, Suit } from './types'

export const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
export const SUITS: readonly Suit[] = ['c', 'd', 'h', 's']

export const FULL_DECK: readonly Card[] = RANKS.flatMap(rank =>
  SUITS.map(suit => Object.freeze({ rank, suit }) as Card)
)

// Mulberry32 — fast, good-quality 32-bit PRNG. Same seed → same sequence always.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Deck {
  private readonly cards: Card[]
  readonly seed: number

  constructor(seed: number) {
    this.seed = seed
    this.cards = [...FULL_DECK]
    const rng = mulberry32(seed)
    // Fisher-Yates shuffle
    for (let i = this.cards.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      const tmp = this.cards[i] as Card
      this.cards[i] = this.cards[j] as Card
      this.cards[j] = tmp
    }
  }

  deal(n: number): Card[] {
    if (n > this.cards.length) {
      throw new Error(`Cannot deal ${n} from ${this.cards.length} remaining`)
    }
    return this.cards.splice(0, n)
  }

  get remaining(): number {
    return this.cards.length
  }
}

// ── Card parsing helpers (used by tests and the analyzer) ──────────────────

const RANK_CHAR: Record<string, Rank> = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6,
  '7': 7, '8': 8, '9': 9, 'T': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14,
}
const VALID_SUITS = new Set<string>(['c', 'd', 'h', 's'])

export function parseCard(s: string): Card {
  const rankChar = s[0]?.toUpperCase() ?? ''
  const suitChar = s[s.length - 1]?.toLowerCase() ?? ''
  const rank = RANK_CHAR[rankChar]
  if (rank === undefined) throw new Error(`Bad rank in "${s}"`)
  if (!VALID_SUITS.has(suitChar)) throw new Error(`Bad suit in "${s}"`)
  return { rank, suit: suitChar as Suit }
}

export function parseCards(strs: string[]): Card[] {
  return strs.map(parseCard)
}
