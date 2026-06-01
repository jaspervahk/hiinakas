import type { Card } from '../engine/index'
import { CardView } from './CardView'

interface HandViewProps {
  cards: Card[]
  selected: Card | null
  onSelect: (card: Card) => void
  /** Index of the card that will be auto-discarded (streets 1-4 when only 1 remains) */
  discardIndex?: number
}

function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit
}

export function HandView({ cards, selected, onSelect, discardIndex }: HandViewProps) {
  if (cards.length === 0) return null
  return (
    <div className="flex gap-2 flex-wrap justify-center">
      {cards.map((card, i) => {
        const isDiscard = discardIndex !== undefined && i === discardIndex
        return (
          <div key={`${card.rank}${card.suit}-${i}`} className="flex flex-col items-center gap-1">
            <CardView
              card={card}
              selected={!!selected && sameCard(selected, card)}
              onClick={isDiscard ? undefined : () => onSelect(card)}
              dim={isDiscard}
            />
            {isDiscard && (
              <span className="text-[10px] text-gray-600 uppercase tracking-wide">discard</span>
            )}
          </div>
        )
      })}
    </div>
  )
}
