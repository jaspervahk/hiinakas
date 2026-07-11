// Small shared card/placement display pieces used by both SessionTab.tsx
// (bulk EV-loss review) and DecisionStepper.tsx (one-by-one review) — kept
// out of SessionTab.tsx to avoid a circular import (SessionTab imports
// DecisionStepper, so DecisionStepper can't import back from SessionTab).

import type { Card } from '../engine/types'
import type { Placement } from '../engine/placement'
import { matchesActual } from '../game/sessionParser'

const RANK_LABELS: Record<number, string> = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
}
const SUIT_SYM: Record<string, string> = { s: '♠', c: '♣', h: '♥', d: '♦' }
const SUIT_COLOR: Record<string, string> = {
  s: 'text-slate-200', c: 'text-emerald-400', h: 'text-red-400', d: 'text-orange-400',
}
function cl(c: Card) { return `${RANK_LABELS[c.rank] ?? c.rank}${SUIT_SYM[c.suit] ?? c.suit}` }

export function CardChip({ c }: { c: Card }) {
  return <span className={`inline-block font-mono text-xs ${SUIT_COLOR[c.suit] ?? 'text-slate-200'}`}>{cl(c)}</span>
}

function CardRow({ label, cards }: { label: string; cards: readonly Card[] }) {
  if (cards.length === 0) return null
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-gray-500 text-[10px]">{label}:</span>
      {cards.map((c, i) => <CardChip key={i} c={c} />)}
    </span>
  )
}

export function PlacementSummary({ p }: { p: Placement }) {
  return (
    <span className="inline-flex flex-wrap gap-x-2 gap-y-0.5">
      {p.topAdd.length > 0 && <CardRow label="T" cards={p.topAdd} />}
      {p.middleAdd.length > 0 && <CardRow label="M" cards={p.middleAdd} />}
      {p.bottomAdd.length > 0 && <CardRow label="B" cards={p.bottomAdd} />}
      {p.discard && (
        <span className="inline-flex items-center gap-1">
          <span className="text-gray-500 text-[10px]">disc:</span>
          <span className="text-gray-400 line-through text-xs font-mono">{cl(p.discard)}</span>
        </span>
      )}
    </span>
  )
}

export function CandidateList({ topCandidates, actualPlacement, bestEV }: {
  topCandidates: Array<{ placement: Placement; ev: number }>
  actualPlacement: Placement
  bestEV: number
}) {
  return (
    <div className="space-y-0.5">
      {topCandidates.map((c, i) => {
        const isPlayed = matchesActual(c.placement, actualPlacement)
        const isBest = i === 0
        const evDiff = c.ev - bestEV
        return (
          <div key={i} className={`flex items-center gap-1.5 text-xs rounded px-1.5 py-0.5 ${
            isPlayed ? 'bg-amber-950/60 border border-amber-800/30' : isBest ? 'bg-emerald-950/40' : ''
          }`}>
            <span className="text-gray-600 w-3 shrink-0 text-right">{i + 1}</span>
            <span className="flex-1 min-w-0"><PlacementSummary p={c.placement} /></span>
            <span className={`font-mono text-xs shrink-0 ${c.ev >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {c.ev >= 0 ? '+' : ''}{c.ev.toFixed(1)}
            </span>
            {isBest && <span className="text-emerald-500 text-[10px] shrink-0">↑best</span>}
            {isPlayed && <span className="text-amber-300 text-[10px] shrink-0">▶played</span>}
            {isPlayed && evDiff < -0.05 && (
              <span className="text-red-400 text-[10px] shrink-0">({evDiff.toFixed(1)})</span>
            )}
          </div>
        )
      })}
    </div>
  )
}
