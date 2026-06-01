import type { Card } from '../engine/index'
import type { CoachResult } from '../coach/useCoach'

interface CoachPanelProps {
  result: CoachResult
  enabled: boolean
  onToggle: () => void
}

const SUIT_SYMBOLS: Record<string, string> = { s: '♠', c: '♣', h: '♥', d: '♦' }
const RANK_LABELS: Record<number, string> = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
}

function cardLabel(c: Card): string {
  return `${RANK_LABELS[c.rank] ?? c.rank}${SUIT_SYMBOLS[c.suit] ?? c.suit}`
}

function isRedSuit(s: string): boolean { return s === 'h' || s === 'd' }

function CardChips({ cards }: { cards: readonly Card[] }) {
  if (cards.length === 0) return <span className="text-gray-700">—</span>
  return (
    <span className="inline-flex flex-wrap gap-1">
      {cards.map((c, i) => (
        <span
          key={i}
          className={`text-[11px] font-medium tabular-nums ${isRedSuit(c.suit) ? 'text-red-400' : 'text-slate-200'}`}
        >
          {cardLabel(c)}
        </span>
      ))}
    </span>
  )
}

export function CoachPanel({ result, enabled, onToggle }: CoachPanelProps) {
  if (!enabled) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3 flex items-center justify-between gap-3">
        <span className="text-xs text-gray-500 uppercase tracking-widest">EV Coach</span>
        <button
          onClick={onToggle}
          className="text-xs px-2.5 py-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
        >
          Show
        </button>
      </div>
    )
  }

  const { placements, isComputing, rolloutsDone, matchIndex } = result
  const top = placements.slice(0, 10)
  const bestEV = placements[0]?.ev ?? 0

  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-900/70 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-300 uppercase tracking-widest font-semibold">EV Coach</span>
          <span className="text-[10px] text-gray-500 tabular-nums">
            {isComputing ? `Computing… ${rolloutsDone} rollouts` : `${rolloutsDone} rollouts`}
          </span>
        </div>
        <button
          onClick={onToggle}
          className="text-xs px-2.5 py-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
        >
          Hide
        </button>
      </div>

      {top.length === 0 ? (
        <p className="text-xs text-gray-500 py-2">Computing best lines…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-800/60">
                <th className="px-1.5 py-1 font-medium">#</th>
                <th className="px-1.5 py-1 font-medium">Top</th>
                <th className="px-1.5 py-1 font-medium">Mid</th>
                <th className="px-1.5 py-1 font-medium">Bot</th>
                <th className="px-1.5 py-1 font-medium">Disc</th>
                <th className="px-1.5 py-1 font-medium text-right">EV</th>
                <th className="px-1.5 py-1 font-medium text-right">Gap</th>
              </tr>
            </thead>
            <tbody>
              {top.map((sp, i) => {
                const gap = sp.ev - bestEV
                const isMatch = matchIndex === i
                return (
                  <tr
                    key={i}
                    className={`border-b border-gray-800/40 last:border-0 ${isMatch ? 'bg-amber-950/40 ring-1 ring-amber-500/40' : ''}`}
                  >
                    <td className="px-1.5 py-1 text-gray-500 tabular-nums">{i + 1}</td>
                    <td className="px-1.5 py-1"><CardChips cards={sp.placement.topAdd} /></td>
                    <td className="px-1.5 py-1"><CardChips cards={sp.placement.middleAdd} /></td>
                    <td className="px-1.5 py-1"><CardChips cards={sp.placement.bottomAdd} /></td>
                    <td className="px-1.5 py-1">
                      {sp.placement.discard ? (
                        <span className={`text-[11px] ${isRedSuit(sp.placement.discard.suit) ? 'text-red-400/70' : 'text-slate-400'}`}>
                          {cardLabel(sp.placement.discard)}
                        </span>
                      ) : <span className="text-gray-700">—</span>}
                    </td>
                    <td className={`px-1.5 py-1 text-right tabular-nums font-semibold ${sp.ev > 0 ? 'text-green-400' : sp.ev < 0 ? 'text-red-400' : 'text-gray-300'}`}>
                      {sp.ev.toFixed(2)}
                    </td>
                    <td className="px-1.5 py-1 text-right tabular-nums text-gray-500">
                      {i === 0 ? '—' : gap.toFixed(2)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
