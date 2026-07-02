import type { Card } from '../engine/index'
import type { Placement } from '../engine/placement'
import type { CoachResult } from '../coach/useCoach'
import type { CoachMode } from '../game/types'

interface CoachPanelProps {
  nnResult: CoachResult
  royaltyResult: CoachResult
  mode: CoachMode
  onModeChange: (mode: CoachMode) => void
  enabled: boolean
  onToggle: () => void
  onSelectPlacement?: (placement: Placement) => void
}

const SUIT_SYMBOLS: Record<string, string> = { s: '♠', c: '♣', h: '♥', d: '♦' }
const RANK_LABELS: Record<number, string> = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
}

function cardLabel(c: Card): string {
  return `${RANK_LABELS[c.rank] ?? c.rank}${SUIT_SYMBOLS[c.suit] ?? c.suit}`
}

const SUIT_COLORS: Record<string, string> = {
  s: 'text-slate-300', h: 'text-red-400', d: 'text-orange-400', c: 'text-emerald-400',
}
const SUIT_COLORS_DIM: Record<string, string> = {
  s: 'text-slate-500', h: 'text-red-600', d: 'text-orange-700', c: 'text-emerald-700',
}

function CardChips({ cards }: { cards: readonly Card[] }) {
  if (cards.length === 0) return <span className="text-gray-700">—</span>
  return (
    <span className="inline-flex flex-wrap gap-1">
      {cards.map((c, i) => (
        <span key={i} className={`text-[11px] font-medium tabular-nums ${SUIT_COLORS[c.suit] ?? 'text-slate-300'}`}>
          {cardLabel(c)}
        </span>
      ))}
    </span>
  )
}

interface PlacementTableProps {
  result: CoachResult
  matchIndex: number | null
  label: string
  accentColor: string   // tailwind text colour for the label chip
  onSelectPlacement?: (placement: Placement) => void
}

function PlacementTable({ result, matchIndex, label, accentColor, onSelectPlacement }: PlacementTableProps) {
  const { placements, isComputing, rolloutsDone } = result
  const top = placements.slice(0, 10)
  const bestEV = top[0]?.ev ?? 0

  const statusLabel = rolloutsDone === 0
    ? (isComputing ? (label === 'NN' ? 'NN · refining…' : 'computing…') : label)
    : isComputing
      ? `${rolloutsDone} rollouts…`
      : `${rolloutsDone} rollouts`

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className={`text-[10px] font-semibold uppercase tracking-widest ${accentColor}`}>{label}</span>
        {isComputing && (
          <span className="inline-block w-2.5 h-2.5 border border-gray-600 border-t-indigo-400 rounded-full animate-spin" />
        )}
        <span className="text-[10px] text-gray-600 tabular-nums">{statusLabel}</span>
      </div>

      {top.length === 0 ? (
        <p className="text-xs text-gray-500 py-2 animate-pulse">Computing…</p>
      ) : (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800/60">
              <th className="px-1 py-1 font-medium">#</th>
              <th className="px-1 py-1 font-medium">Top</th>
              <th className="px-1 py-1 font-medium">Mid</th>
              <th className="px-1 py-1 font-medium">Bot</th>
              <th className="px-1 py-1 font-medium">Disc</th>
              <th className="px-1 py-1 font-medium text-right">EV</th>
              <th className="px-1 py-1 font-medium text-right">Gap</th>
            </tr>
          </thead>
          <tbody>
            {top.map((sp, i) => {
              const gap = sp.ev - bestEV
              const isMatch = matchIndex === i
              return (
                <tr
                  key={i}
                  onClick={onSelectPlacement ? () => onSelectPlacement(sp.placement) : undefined}
                  className={[
                    'border-b border-gray-800/40 last:border-0',
                    isMatch ? 'bg-amber-950/40 ring-1 ring-amber-500/40' : '',
                    onSelectPlacement ? 'cursor-pointer hover:bg-gray-800/50 active:bg-gray-700/50' : '',
                  ].join(' ')}
                >
                  <td className="px-1 py-1 text-gray-500 tabular-nums">{i + 1}</td>
                  <td className="px-1 py-1"><CardChips cards={sp.placement.topAdd} /></td>
                  <td className="px-1 py-1"><CardChips cards={sp.placement.middleAdd} /></td>
                  <td className="px-1 py-1"><CardChips cards={sp.placement.bottomAdd} /></td>
                  <td className="px-1 py-1">
                    {sp.placement.discard ? (
                      <span className={`text-[11px] opacity-70 ${SUIT_COLORS_DIM[sp.placement.discard.suit] ?? 'text-slate-500'}`}>
                        {cardLabel(sp.placement.discard)}
                      </span>
                    ) : <span className="text-gray-700">—</span>}
                  </td>
                  <td className={`px-1 py-1 text-right tabular-nums font-semibold ${sp.ev > 0 ? 'text-green-400' : sp.ev < 0 ? 'text-red-400' : 'text-gray-300'}`}>
                    {sp.ev > 0 ? '+' : ''}{sp.ev.toFixed(1)}
                  </td>
                  <td className="px-1 py-1 text-right tabular-nums text-gray-500">
                    {i === 0 ? '—' : gap.toFixed(1)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function CoachPanel({ nnResult, royaltyResult, mode, onModeChange, enabled, onToggle, onSelectPlacement }: CoachPanelProps) {
  const activeResult = mode === 'royalty' ? royaltyResult : nnResult
  const isComputing = mode === 'both'
    ? (nnResult.isComputing || royaltyResult.isComputing)
    : activeResult.isComputing

  // Collapsed view
  if (!enabled) {
    const bestLine = activeResult.placements[0]
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-gray-500 uppercase tracking-widest shrink-0">EV Coach</span>
          {isComputing && (
            <span className="inline-block w-3 h-3 border border-gray-600 border-t-indigo-400 rounded-full animate-spin shrink-0" />
          )}
          {bestLine && !isComputing && (
            <span className={`text-xs font-semibold tabular-nums ${bestLine.ev > 0 ? 'text-green-400' : bestLine.ev < 0 ? 'text-red-400' : 'text-gray-400'}`}>
              Best EV {bestLine.ev > 0 ? '+' : ''}{bestLine.ev.toFixed(2)}
            </span>
          )}
        </div>
        <button
          onClick={onToggle}
          className="text-xs px-2.5 py-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors shrink-0"
        >
          Show
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-gray-700/60 bg-gray-900/70 p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-300 uppercase tracking-widest font-semibold">EV Coach</span>
          {isComputing && (
            <span className="inline-block w-3 h-3 border border-gray-600 border-t-indigo-400 rounded-full animate-spin" />
          )}
          {/* Mode toggle */}
          <div className="flex rounded overflow-hidden border border-gray-700 text-[10px]">
            {(['nn', 'royalty', 'both'] as const).map(m => (
              <button
                key={m}
                onClick={() => onModeChange(m)}
                className={[
                  'px-2 py-0.5 transition-colors',
                  mode === m
                    ? 'bg-indigo-700 text-white'
                    : 'bg-gray-800 text-gray-500 hover:text-gray-300',
                ].join(' ')}
              >
                {m === 'nn' ? 'NN' : m === 'royalty' ? 'Roy' : 'Both'}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={onToggle}
          className="text-xs px-2.5 py-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 transition-colors"
        >
          Hide
        </button>
      </div>

      {mode === 'both' ? (
        <div className="flex gap-3 overflow-x-auto">
          <PlacementTable
            result={nnResult}
            matchIndex={nnResult.matchIndex}
            label="NN"
            accentColor="text-indigo-400"
            onSelectPlacement={onSelectPlacement}
          />
          <div className="w-px bg-gray-800 shrink-0" />
          <PlacementTable
            result={royaltyResult}
            matchIndex={royaltyResult.matchIndex}
            label="Royalty"
            accentColor="text-amber-400"
            onSelectPlacement={onSelectPlacement}
          />
        </div>
      ) : (
        <PlacementTable
          result={activeResult}
          matchIndex={activeResult.matchIndex}
          label={mode === 'royalty' ? 'Royalty' : 'NN'}
          accentColor={mode === 'royalty' ? 'text-amber-400' : 'text-indigo-400'}
          onSelectPlacement={onSelectPlacement}
        />
      )}
    </div>
  )
}
