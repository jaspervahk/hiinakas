import type { Board, Card, PartialBoard } from '../engine/index'
import { evaluate3, evaluate5, compareHandRank, royalties, isFoul } from '../engine/index'
import { CardView } from './CardView'
import type { PendingRows } from '../game/types'

const HAND_NAMES: Record<number, string> = {
  0: 'High card', 1: 'Pair', 2: 'Two pair', 3: 'Trips',
  4: 'Straight', 5: 'Flush', 6: 'Full house', 7: 'Quads',
  8: 'Straight flush', 9: 'Royal flush',
}

function handLabel(cards: readonly Card[], isTop: boolean): string {
  const required = isTop ? 3 : 5
  if (cards.length !== required) return ''
  try {
    const rank = isTop ? evaluate3(cards) : evaluate5(cards)
    return HAND_NAMES[rank.category] ?? ''
  } catch { return '' }
}

// Quick live foul check on partial hands: warns if placed top > placed middle.
function liveIsFouling(board: PartialBoard, pending: PendingRows): boolean {
  const top = [...board.top, ...pending.top]
  const mid = [...board.middle, ...pending.middle]
  if (top.length === 0 || mid.length === 0) return false
  try {
    const topRank = evaluate3(top)
    const midRank = evaluate3(mid) // approx: evaluate3 on any length
    return compareHandRank(topRank, midRank) > 0
  } catch { return false }
}

interface RowProps {
  label: string
  max: number
  placed: readonly Card[]
  pending: Card[]
  isHuman: boolean
  isTop?: boolean
  isAvailable?: boolean   // card selected and row has space
  onRowClick?: () => void
  onPendingRemove?: (index: number) => void
}

function RowDisplay({ label, max, placed, pending, isHuman, isTop, isAvailable, onRowClick, onPendingRemove }: RowProps) {
  const total = placed.length + pending.length
  const empty = max - total
  const allCards = [...placed, ...pending]
  const lbl = handLabel(allCards, isTop ?? false)

  return (
    <div
      onClick={isAvailable ? onRowClick : undefined}
      className={[
        'flex items-center gap-2 px-3 py-1.5 rounded-md transition-colors',
        isAvailable
          ? 'cursor-pointer bg-indigo-950/60 hover:bg-indigo-900/60 ring-1 ring-indigo-700/50'
          : 'cursor-default',
      ].join(' ')}
    >
      <span className="text-[11px] text-gray-500 w-7 shrink-0 font-medium uppercase tracking-wide">{label}</span>
      <div className="flex gap-1">
        {placed.map((c, i) => (
          <CardView key={`p${i}`} card={c} size="sm" />
        ))}
        {pending.map((c, i) => (
          <CardView
            key={`pnd${i}`}
            card={c}
            pending
            size="sm"
            onClick={isHuman && onPendingRemove ? () => onPendingRemove(i) : undefined}
          />
        ))}
        {Array.from({ length: empty }, (_, i) => (
          <CardView key={`e${i}`} size="sm" />
        ))}
      </div>
      {lbl && (
        <span className="text-[11px] text-gray-500 ml-1 shrink-0">{lbl}</span>
      )}
    </div>
  )
}

interface BoardViewProps {
  board: PartialBoard
  pending?: PendingRows
  label?: string
  isHuman?: boolean
  /** Whether a card is selected and rows should show clickable targets */
  cardSelected?: boolean
  onRowClick?: (row: 'top' | 'middle' | 'bottom') => void
  onPendingRemove?: (row: 'top' | 'middle' | 'bottom', index: number) => void
  showStatus?: boolean
  /** During placing: show live foul warning */
  showLiveFoul?: boolean
}

export function BoardView({
  board, pending, label, isHuman, cardSelected, onRowClick, onPendingRemove, showStatus, showLiveFoul,
}: BoardViewProps) {
  const pnd = pending ?? { top: [], middle: [], bottom: [] }

  const topSpace    = 3 - board.top.length - pnd.top.length
  const middleSpace = 5 - board.middle.length - pnd.middle.length
  const bottomSpace = 5 - board.bottom.length - pnd.bottom.length

  const topAvail    = cardSelected && topSpace > 0
  const middleAvail = cardSelected && middleSpace > 0
  const bottomAvail = cardSelected && bottomSpace > 0

  const isComplete = board.top.length === 3 && board.middle.length === 5 && board.bottom.length === 5

  let statusText = ''
  let statusColor = 'text-gray-500'

  if (showStatus && isComplete) {
    if (isFoul(board as Board)) {
      statusText = 'Foul'
      statusColor = 'text-red-400'
    } else {
      const r = royalties(board as Board)
      statusText = r > 0 ? `+${r} royalties` : ''
      statusColor = 'text-amber-400'
    }
  }

  const foulingLive = showLiveFoul && pending && liveIsFouling(board, pnd)

  return (
    <div className={[
      'rounded-xl border p-2 min-w-[230px]',
      isHuman ? 'border-gray-600 bg-gray-900/80' : 'border-gray-700/60 bg-gray-900/40',
    ].join(' ')}>
      {(label || statusText || foulingLive) && (
        <div className="flex items-center justify-between mb-1 px-1">
          <span className={`text-xs font-semibold uppercase tracking-wider ${isHuman ? 'text-gray-300' : 'text-gray-500'}`}>
            {label}
          </span>
          {foulingLive && (
            <span className="text-xs font-semibold text-red-400">Foul risk</span>
          )}
          {!foulingLive && statusText && (
            <span className={`text-xs font-semibold ${statusColor}`}>{statusText}</span>
          )}
        </div>
      )}
      <RowDisplay
        label="Top"
        max={3}
        placed={board.top}
        pending={pnd.top}
        isHuman={!!isHuman}
        isTop
        isAvailable={topAvail}
        onRowClick={() => onRowClick?.('top')}
        onPendingRemove={idx => onPendingRemove?.('top', idx)}
      />
      <RowDisplay
        label="Mid"
        max={5}
        placed={board.middle}
        pending={pnd.middle}
        isHuman={!!isHuman}
        isAvailable={middleAvail}
        onRowClick={() => onRowClick?.('middle')}
        onPendingRemove={idx => onPendingRemove?.('middle', idx)}
      />
      <RowDisplay
        label="Bot"
        max={5}
        placed={board.bottom}
        pending={pnd.bottom}
        isHuman={!!isHuman}
        isAvailable={bottomAvail}
        onRowClick={() => onRowClick?.('bottom')}
        onPendingRemove={idx => onPendingRemove?.('bottom', idx)}
      />
    </div>
  )
}
