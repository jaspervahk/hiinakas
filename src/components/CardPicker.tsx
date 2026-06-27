import type { Card, Rank, Suit } from '../engine/index'

const RANKS_DESC: Rank[] = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]
const SUITS_ORDER: Suit[] = ['s', 'h', 'd', 'c']

const RANK_LABELS: Record<number, string> = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
}
const SUIT_SYMBOLS: Record<string, string> = { s: '♠', c: '♣', h: '♥', d: '♦' }

function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit
}
const SUIT_COLORS: Record<string, { normal: string; selected: string }> = {
  s: { normal: 'text-slate-300', selected: 'text-slate-100' },
  h: { normal: 'text-red-400',   selected: 'text-red-300'   },
  d: { normal: 'text-orange-400', selected: 'text-orange-300' },
  c: { normal: 'text-emerald-400', selected: 'text-emerald-300' },
}

interface CardPickerProps {
  used: Card[]
  selected: Card | null
  onSelect: (card: Card | null) => void
}

export function CardPicker({ used, selected, onSelect }: CardPickerProps) {
  const usedKey = new Set(used.map(c => `${c.rank}${c.suit}`))
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-2">
      {SUITS_ORDER.map(suit => (
        <div key={suit} className="flex items-center gap-1 mb-1 last:mb-0">
          <span className={`w-5 text-center text-xs ${SUIT_COLORS[suit]?.normal ?? 'text-slate-300'}`}>
            {SUIT_SYMBOLS[suit]}
          </span>
          <div className="flex gap-1 flex-wrap">
            {RANKS_DESC.map(rank => {
              const card: Card = { rank, suit }
              const key = `${rank}${suit}`
              const isUsed = usedKey.has(key)
              const isSel = !!selected && sameCard(selected, card)
              return (
                <button
                  key={key}
                  disabled={isUsed && !isSel}
                  onClick={() => {
                    if (isSel) onSelect(null)
                    else if (!isUsed) onSelect(card)
                  }}
                  className={[
                    'w-7 h-8 text-[11px] rounded border font-medium transition-colors tabular-nums',
                    isUsed && !isSel
                      ? 'bg-gray-950 border-gray-800 text-gray-700 cursor-not-allowed'
                      : isSel
                        ? 'bg-yellow-500/20 border-yellow-500 ring-1 ring-yellow-400 ' + (SUIT_COLORS[suit]?.selected ?? 'text-slate-100')
                        : 'bg-gray-800 border-gray-700 hover:border-gray-500 ' + (SUIT_COLORS[suit]?.normal ?? 'text-slate-200'),
                  ].join(' ')}
                >
                  {RANK_LABELS[rank]}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
