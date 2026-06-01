import type { Card } from '../engine/index'

const RANK_LABELS: Record<number, string> = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
}

const SUIT_SYMBOLS: Record<string, string> = {
  s: '♠', c: '♣', h: '♥', d: '♦',
}

function isRed(suit: string): boolean {
  return suit === 'h' || suit === 'd'
}

interface CardViewProps {
  card?: Card        // undefined = empty slot
  selected?: boolean
  pending?: boolean
  onClick?: () => void
  size?: 'sm' | 'md'
  dim?: boolean      // visually de-emphasised (e.g. about-to-discard)
}

export function CardView({ card, selected, pending, onClick, size = 'md', dim }: CardViewProps) {
  const isSmall = size === 'sm'

  if (!card) {
    return (
      <div
        className={
          `border border-dashed border-gray-700 rounded-md flex items-center justify-center ` +
          `bg-transparent select-none ` +
          (isSmall ? 'w-9 h-12' : 'w-11 h-[60px]')
        }
      />
    )
  }

  const rankLabel = RANK_LABELS[card.rank] ?? String(card.rank)
  const suitSymbol = SUIT_SYMBOLS[card.suit] ?? card.suit
  const red = isRed(card.suit)

  let textColor = red ? 'text-red-400' : 'text-slate-100'
  let borderColor = 'border-gray-700'
  let ring = ''

  if (selected) {
    ring = 'ring-2 ring-yellow-400'
    borderColor = 'border-yellow-500'
  } else if (pending) {
    ring = 'ring-1 ring-emerald-500'
    borderColor = 'border-emerald-600'
  }

  if (dim) {
    textColor = red ? 'text-red-900' : 'text-gray-600'
    borderColor = 'border-gray-800'
  }

  const cursor = onClick ? 'cursor-pointer hover:brightness-110 active:scale-95 transition-all' : 'cursor-default'

  return (
    <div
      onClick={onClick}
      className={
        `rounded-md border select-none flex flex-col items-center justify-center ` +
        `leading-none font-semibold bg-gray-900 ` +
        `${isSmall ? 'w-9 h-12 text-xs gap-0.5' : 'w-11 h-[60px] text-sm gap-1'} ` +
        `${textColor} ${borderColor} ${ring} ${cursor}`
      }
    >
      <span>{rankLabel}</span>
      <span className="opacity-80">{suitSymbol}</span>
    </div>
  )
}
