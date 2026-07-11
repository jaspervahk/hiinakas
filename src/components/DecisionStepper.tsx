// One-by-one decision review overlay. Works identically whether `decisions`
// came from a freshly-computed session analysis or a reopened saved one —
// both are ReviewDecision[] (see game/sessionAnalysisTypes.ts).

import { useEffect, useMemo, useState } from 'react'
import type { ReviewDecision } from '../game/sessionAnalysisTypes'
import type { Placement } from '../engine/placement'
import type { PendingRows } from '../game/types'
import { BoardView } from './BoardView'
import { CardView } from './CardView'
import { CandidateList } from './CandidateList'

interface DecisionStepperProps {
  decisions: ReviewDecision[]
  players: string[]
  onClose: () => void
}

type SegmentFilter = 'all' | 'normal_play' | 'bonus_play'
type SortMode = 'chronological' | 'evLoss'

function toPending(p: Placement): PendingRows {
  return { top: [...p.topAdd], middle: [...p.middleAdd], bottom: [...p.bottomAdd] }
}

export function DecisionStepper({ decisions, players, onClose }: DecisionStepperProps) {
  const [player, setPlayer] = useState<string>('all')
  const [segment, setSegment] = useState<SegmentFilter>('all')
  const [gameId, setGameId] = useState<string>('all')
  const [street, setStreet] = useState<number | 'all'>('all')
  const [minEvLoss, setMinEvLoss] = useState(0)
  const [sort, setSort] = useState<SortMode>('evLoss')
  const [index, setIndex] = useState(0)

  const gameIds = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const d of decisions) {
      if (!seen.has(d.gameId)) { seen.add(d.gameId); out.push(d.gameId) }
    }
    return out
  }, [decisions])

  const filtered = useMemo(() => {
    let list = decisions.filter(d =>
      (player === 'all' || d.username === player) &&
      (segment === 'all' || d.segment === segment) &&
      (gameId === 'all' || d.gameId === gameId) &&
      (street === 'all' || d.street === street) &&
      d.evLost >= minEvLoss
    )
    list = sort === 'evLoss'
      ? [...list].sort((a, b) => b.evLost - a.evLost)
      : [...list].sort((a, b) => a.gameTime.localeCompare(b.gameTime) || a.street - b.street)
    return list
  }, [decisions, player, segment, gameId, street, minEvLoss, sort])

  useEffect(() => {
    setIndex(i => Math.min(i, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowLeft' || e.key === ',') setIndex(i => Math.max(0, i - 1))
      if (e.key === 'ArrowRight' || e.key === '.') setIndex(i => Math.min(filtered.length - 1, i + 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [filtered.length, onClose])

  const d = filtered[index]
  const isOptimal = d ? d.evLost < 0.05 : false

  return (
    <div className="fixed inset-0 z-50 bg-gray-950 overflow-y-auto">
      <div className="max-w-4xl mx-auto px-4 py-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-gray-100 font-semibold text-sm">Decision Review</h2>
          <div className="flex items-center gap-3">
            <span className="text-gray-500 text-xs font-mono">
              {filtered.length === 0 ? '0 / 0' : `${index + 1} / ${filtered.length}`}
            </span>
            <button onClick={onClose} className="text-gray-500 hover:text-gray-200 text-sm">✕ Close</button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 bg-gray-900 rounded-lg px-3 py-2 text-xs">
          <label className="flex items-center gap-1 text-gray-500">
            <span>Player</span>
            <select value={player} onChange={e => setPlayer(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-gray-200">
              <option value="all">All</option>
              {players.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 text-gray-500">
            <span>Segment</span>
            <select value={segment} onChange={e => setSegment(e.target.value as SegmentFilter)}
              className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-gray-200">
              <option value="all">All</option>
              <option value="normal_play">Normal</option>
              <option value="bonus_play">Side game</option>
            </select>
          </label>
          <label className="flex items-center gap-1 text-gray-500">
            <span>Game</span>
            <select value={gameId} onChange={e => setGameId(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-gray-200 max-w-[8rem]">
              <option value="all">All</option>
              {gameIds.map((g, i) => <option key={g} value={g}>#{i + 1}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1 text-gray-500">
            <span>Street</span>
            <select
              value={street === 'all' ? 'all' : String(street)}
              onChange={e => setStreet(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-gray-200"
            >
              <option value="all">All</option>
              {[0, 1, 2, 3, 4].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <div className="flex items-center gap-1">
            <button onClick={() => setMinEvLoss(0)} className={`px-1.5 py-1 rounded ${minEvLoss === 0 ? 'bg-indigo-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>All</button>
            <button onClick={() => setMinEvLoss(0.1)} className={`px-1.5 py-1 rounded ${minEvLoss === 0.1 ? 'bg-amber-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>Mistakes (&gt;0.1)</button>
            <button onClick={() => setMinEvLoss(1)} className={`px-1.5 py-1 rounded ${minEvLoss === 1 ? 'bg-red-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>Big (&gt;1)</button>
          </div>
          <label className="flex items-center gap-1 text-gray-500 ml-auto">
            <span>Sort</span>
            <select value={sort} onChange={e => setSort(e.target.value as SortMode)}
              className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-gray-200">
              <option value="evLoss">Worst EV first</option>
              <option value="chronological">Chronological</option>
            </select>
          </label>
        </div>

        {!d ? (
          <p className="text-gray-600 text-sm text-center py-16 italic">No decisions match these filters.</p>
        ) : (
          <div className="space-y-4">
            {/* Nav + summary */}
            <div className="flex items-center justify-between">
              <button onClick={() => setIndex(i => Math.max(0, i - 1))} disabled={index === 0}
                className="px-3 py-1.5 rounded text-xs font-medium bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-300 transition-colors">
                ← Prev
              </button>
              <div className="text-center">
                <p className="text-gray-400 text-xs">
                  {d.username} · Street {d.street}
                  {d.segment === 'bonus_play' && <span className="text-purple-400 ml-1">[side game]</span>}
                </p>
                <p className={`text-sm font-semibold ${isOptimal ? 'text-emerald-400' : d.evLost > 1 ? 'text-red-400' : 'text-amber-400'}`}>
                  {isOptimal ? '✓ optimal' : `-${d.evLost.toFixed(2)} EV`}
                </p>
              </div>
              <button onClick={() => setIndex(i => Math.min(filtered.length - 1, i + 1))} disabled={index === filtered.length - 1}
                className="px-3 py-1.5 rounded text-xs font-medium bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-300 transition-colors">
                Next →
              </button>
            </div>

            {/* Dealt hand */}
            <div className="flex items-center justify-center gap-1.5">
              {d.hand.map((c, i) => <CardView key={i} card={c} size="sm" />)}
            </div>

            {/* Board panels */}
            <div className={`grid gap-4 ${isOptimal ? 'grid-cols-1 max-w-sm mx-auto' : 'grid-cols-1 sm:grid-cols-2'}`}>
              <BoardView board={d.board} pending={toPending(d.actualPlacement)} label="Played" showStatus />
              {!isOptimal && (
                <BoardView board={d.board} pending={toPending(d.bestPlacement)} label={`Best (+${(d.bestEV - d.playedEV).toFixed(1)} EV)`} showStatus />
              )}
            </div>

            {/* Rankings */}
            {d.topCandidates.length > 0 && (
              <div>
                <p className="text-gray-600 text-[10px] uppercase mb-1 text-center">Rankings (top {d.topCandidates.length})</p>
                <div className="max-w-md mx-auto">
                  <CandidateList topCandidates={d.topCandidates} actualPlacement={d.actualPlacement} bestEV={d.bestEV} />
                </div>
              </div>
            )}

            <p className="text-gray-700 text-[10px] text-center">
              ← / → to navigate · Esc to close
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
