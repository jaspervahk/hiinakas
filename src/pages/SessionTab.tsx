// Session analysis tab: load a pokker6 JSON export, reconstruct per-decision
// InfoStates, run bulk NN evaluation, and surface EV-loss blunders + score stats.

import { Component, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Card, PartialBoard } from '../engine/types'
import type { ScoredPlacement } from '../engine/mc'
import type { Placement } from '../engine/placement'
import {
  parseSessionGames,
  detectPlayerPairs,
  matchesActual,
  type P6Export,
  type DecisionPoint,
  type GameSummary,
} from '../game/sessionParser'
import { workerClient } from '../worker/client'

// ── Error boundary ────────────────────────────────────────────────────────────

class SessionErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="py-12 text-center space-y-3">
          <p className="text-red-400 text-sm">Something went wrong loading the session.</p>
          <p className="text-gray-600 text-xs font-mono">{this.state.error}</p>
          <button onClick={() => this.setState({ error: null })} className="text-xs text-gray-500 hover:text-gray-300 underline">
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// ── Card display ──────────────────────────────────────────────────────────────

const RANK_LABELS: Record<number, string> = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
}
const SUIT_SYM: Record<string, string> = { s: '♠', c: '♣', h: '♥', d: '♦' }
const SUIT_COLOR: Record<string, string> = {
  s: 'text-slate-200', c: 'text-emerald-400', h: 'text-red-400', d: 'text-orange-400',
}
function cl(c: Card) { return `${RANK_LABELS[c.rank] ?? c.rank}${SUIT_SYM[c.suit] ?? c.suit}` }
function CardChip({ c }: { c: Card }) {
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

// ── Placement summary ─────────────────────────────────────────────────────────

function PlacementSummary({ p }: { p: Placement }) {
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

// ── Board mini display ────────────────────────────────────────────────────────

function BoardMini({ board }: { board: PartialBoard }) {
  const empty = board.top.length + board.middle.length + board.bottom.length === 0
  if (empty) return <span className="text-gray-600 italic text-xs">empty</span>
  return (
    <span className="inline-flex flex-col gap-0.5">
      {(['top', 'middle', 'bottom'] as const).map(row => {
        const cards = board[row]
        if (cards.length === 0) return null
        return (
          <span key={row} className="flex items-center gap-0.5">
            <span className="text-gray-600 text-[10px] w-3 shrink-0">{row[0]!.toUpperCase()}</span>
            {cards.map((c, i) => <CardChip key={i} c={c} />)}
          </span>
        )
      })}
    </span>
  )
}

// ── Candidate ranked list ─────────────────────────────────────────────────────

function CandidateList({ topCandidates, actualPlacement, bestEV }: {
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

// ── Running score SVG chart ───────────────────────────────────────────────────

function RunningChart({ summaries, p1, p2 }: { summaries: GameSummary[]; p1: string; p2: string }) {
  const W = 560; const H = 120
  const PL = 36; const PR = 8; const PT = 12; const PB = 20

  const values = [0, ...summaries.map(s => s.p2Run)]
  const yMin = Math.min(...values)
  const yMax = Math.max(0, ...values)
  const yRange = yMax - yMin || 1

  const toX = (i: number) => PL + (i / (values.length - 1)) * (W - PL - PR)
  const toY = (v: number) => PT + ((yMax - v) / yRange) * (H - PT - PB)
  const zeroY = toY(0)

  const linePoints = values.map((v, i) => `${toX(i)},${toY(v)}`).join(' ')
  const areaPath =
    `M${toX(0)},${zeroY} ` +
    values.map((v, i) => `L${toX(i)},${toY(v)}`).join(' ') +
    ` L${toX(values.length - 1)},${zeroY} Z`

  const final = summaries.at(-1)?.p1Run ?? 0
  const areaColor = final >= 0 ? '#10b981' : '#ef4444'
  const yTicks = [yMin, 0, yMax].filter((v, i, a) => a.indexOf(v) === i && Math.abs(v) > 2)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 140 }}>
      {yTicks.map(v => {
        const y = toY(v)
        return (
          <g key={v}>
            <line x1={PL - 3} y1={y} x2={W - PR} y2={y} stroke="#1f2937" strokeWidth="0.5" />
            <text x={PL - 5} y={y + 3} textAnchor="end" fontSize="7" fill="#6b7280">
              {v > 0 ? `+${v}` : v}
            </text>
          </g>
        )
      })}
      <line x1={PL} y1={zeroY} x2={W - PR} y2={zeroY} stroke="#374151" strokeWidth="0.8" strokeDasharray="3,3" />
      <path d={areaPath} fill={areaColor} fillOpacity="0.12" />
      <polyline points={linePoints} fill="none" stroke="#818cf8" strokeWidth="1.2" />
      {summaries.map((s, i) => {
        if (!s.p1Bust && !s.p2Bust) return null
        const x = toX(i + 1); const y = toY(s.p2Run)
        return <circle key={i} cx={x} cy={y} r="2.5"
          fill={s.p1Bust && s.p2Bust ? '#9333ea' : s.p1Bust ? '#ef4444' : '#f59e0b'}
          stroke="#030712" strokeWidth="0.5" />
      })}
      {summaries.map((s, i) => {
        if (s.p1Bust || s.p2Bust) return null
        return <circle key={i} cx={toX(i + 1)} cy={toY(s.p2Run)} r="1.5" fill="#818cf8" />
      })}
      {summaries.map((_, i) => {
        const n = i + 1
        if (n !== 1 && n % 5 !== 0 && n !== summaries.length) return null
        return <text key={i} x={toX(i + 1)} y={H - 4} textAnchor="middle" fontSize="7" fill="#4b5563">{n}</text>
      })}
      <circle cx={PL + 8} cy={PT - 4} r="2" fill="#ef4444" />
      <text x={PL + 12} y={PT - 1} fontSize="6.5" fill="#9ca3af">{p1} bust</text>
      <circle cx={PL + 60} cy={PT - 4} r="2" fill="#f59e0b" />
      <text x={PL + 64} y={PT - 1} fontSize="6.5" fill="#9ca3af">{p2} bust</text>
    </svg>
  )
}

// ── Analyzed decision ─────────────────────────────────────────────────────────

interface AnalyzedDecision extends DecisionPoint {
  candidates: ScoredPlacement[]
  topCandidates: Array<{ placement: Placement; ev: number }>
  bestPlacement: Placement
  playedEV: number
  bestEV: number
  evLost: number
}

function buildAnalyzed(
  decisions: DecisionPoint[],
  results: Map<string, ScoredPlacement[]>,
): AnalyzedDecision[] {
  return decisions.flatMap(d => {
    const candidates = results.get(d.id)
    if (!candidates || candidates.length === 0) return []
    const best = candidates[0]!
    const bestEV = best.ev
    const played = candidates.find(c => matchesActual(c.placement, d.actualPlacement))
    const playedEV = played?.ev ?? bestEV
    const topCandidates = candidates.slice(0, 8).map(c => ({ placement: c.placement, ev: c.ev }))
    return [{ ...d, candidates, topCandidates, bestPlacement: best.placement, playedEV, bestEV, evLost: bestEV - playedEV }]
  })
}

// ── Cache (localStorage) ──────────────────────────────────────────────────────

const CACHE_VERSION = 'v2'

interface CachedDecision {
  id: string; gameId: string; gameTime: string
  username: string; uid: string
  segment: 'normal_play' | 'bonus_play'; street: number
  hand: Card[]
  actualPlacement: Placement; bestPlacement: Placement
  playedEV: number; bestEV: number; evLost: number
  topCandidates: Array<{ placement: Placement; ev: number }>
}

function sessionCacheKey(decisions: DecisionPoint[]): string {
  if (decisions.length === 0) return ''
  return `session_ev_${CACHE_VERSION}:${decisions[0]!.gameId}:${decisions[decisions.length - 1]!.gameId}:${decisions.length}`
}

function saveToCache(key: string, analyzed: AnalyzedDecision[]): void {
  try {
    const slim: CachedDecision[] = analyzed.map(d => ({
      id: d.id, gameId: d.gameId, gameTime: d.gameTime,
      username: d.username, uid: d.uid,
      segment: d.segment, street: d.street,
      hand: [...d.infoState.hand],
      actualPlacement: d.actualPlacement, bestPlacement: d.bestPlacement,
      playedEV: d.playedEV, bestEV: d.bestEV, evLost: d.evLost,
      topCandidates: d.topCandidates,
    }))
    localStorage.setItem(key, JSON.stringify(slim))
  } catch { /* quota exceeded — silently ignore */ }
}

function loadFromCache(key: string): AnalyzedDecision[] | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const cached = JSON.parse(raw) as CachedDecision[]
    return cached.map(c => ({
      ...c,
      infoState: {
        board: { top: [], middle: [], bottom: [] }, // enriched later from decisions
        hand: c.hand,
        street: c.street,
        revealedOpponentBoards: [],
        discards: [],
      },
      candidates: [],
    }))
  } catch { return null }
}

// ── Hand decision row (per-street view inside HandDetail) ─────────────────────

function HandDecisionRow({ dec, ev }: { dec: DecisionPoint; ev?: AnalyzedDecision }) {
  const [open, setOpen] = useState(false)
  const hasEV = !!ev
  const isMistake = hasEV && ev.evLost > 0.1
  const isOptimal = hasEV && !isMistake

  return (
    <div className={`border-l-2 pl-2 mb-1 ${isMistake ? 'border-amber-700/60' : isOptimal ? 'border-emerald-800/50' : 'border-gray-800'}`}>
      {/* Summary row — always visible, always clickable */}
      <div
        className="flex items-start gap-2 cursor-pointer hover:bg-gray-800/30 rounded px-1 py-0.5 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <span className="text-gray-600 text-[10px] shrink-0 w-14 pt-0.5">
          Street {dec.street}
          {dec.segment === 'bonus_play' && <span className="text-purple-500 ml-1">[S]</span>}
        </span>
        <span className="flex gap-0.5 shrink-0">
          {dec.infoState.hand.map((c, i) => <CardChip key={i} c={c} />)}
        </span>
        <span className="text-gray-500 text-[10px] shrink-0 pt-0.5">→</span>
        <span className="flex-1 min-w-0 text-xs"><PlacementSummary p={dec.actualPlacement} /></span>
        {hasEV && (
          <span className={`text-xs shrink-0 font-mono ${isOptimal ? 'text-emerald-600' : isMistake ? 'text-amber-400' : 'text-gray-500'}`}>
            {isOptimal ? '✓' : `-${ev.evLost.toFixed(1)}`}
          </span>
        )}
        <span className="text-gray-700 text-[10px] shrink-0">{open ? '▲' : '▼'}</span>
      </div>

      {/* Expanded detail */}
      {open && (
        <div className="ml-16 mt-1 mb-2 space-y-2">
          {/* Board before this decision */}
          <div className="flex items-start gap-2">
            <span className="text-gray-600 text-[10px] uppercase shrink-0 w-10 pt-0.5">Board</span>
            <BoardMini board={dec.infoState.board} />
          </div>

          {/* EV comparison: played vs best */}
          {hasEV && (
            <div className="space-y-0.5">
              <div className="flex items-start gap-2">
                <span className={`text-[10px] uppercase shrink-0 w-10 pt-0.5 ${isMistake ? 'text-amber-700' : 'text-gray-600'}`}>
                  Played
                </span>
                <span className="text-xs flex-1"><PlacementSummary p={dec.actualPlacement} /></span>
                <span className={`text-xs font-mono shrink-0 ${ev.playedEV >= 0 ? 'text-gray-400' : 'text-red-400'}`}>
                  {ev.playedEV >= 0 ? '+' : ''}{ev.playedEV.toFixed(1)}
                </span>
              </div>
              {isMistake && (
                <div className="flex items-start gap-2">
                  <span className="text-emerald-700 text-[10px] uppercase shrink-0 w-10 pt-0.5">Best</span>
                  <span className="text-xs flex-1"><PlacementSummary p={ev.bestPlacement} /></span>
                  <span className="text-emerald-500 text-xs font-mono shrink-0">
                    {ev.bestEV >= 0 ? '+' : ''}{ev.bestEV.toFixed(1)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Full candidate rankings */}
          {ev && ev.topCandidates.length > 0 && (
            <div>
              <p className="text-gray-600 text-[10px] uppercase mb-0.5">Rankings (top {ev.topCandidates.length})</p>
              <CandidateList
                topCandidates={ev.topCandidates}
                actualPlacement={dec.actualPlacement}
                bestEV={ev.bestEV}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Hand detail panel (all decisions for one game) ────────────────────────────

function HandDetail({ gameDecs, analyzedMap, p1, p2 }: {
  gameDecs: DecisionPoint[]
  analyzedMap: Map<string, AnalyzedDecision>
  p1: string; p2: string
}) {
  const p1Decs = useMemo(
    () => gameDecs.filter(d => d.username === p1).sort((a, b) => a.street - b.street),
    [gameDecs, p1]
  )
  const p2Decs = useMemo(
    () => gameDecs.filter(d => d.username === p2).sort((a, b) => a.street - b.street),
    [gameDecs, p2]
  )

  if (gameDecs.length === 0) {
    return (
      <div className="bg-gray-950 border-t border-gray-800 px-4 py-3">
        <p className="text-gray-600 text-xs italic">No play-by-play data for this hand.</p>
      </div>
    )
  }

  return (
    <div className="bg-gray-950 border-t border-gray-800 px-4 py-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <p className="text-indigo-400 text-[10px] uppercase tracking-wider font-medium mb-2">{p1}</p>
          {p1Decs.length === 0
            ? <p className="text-gray-600 text-xs italic">No data</p>
            : p1Decs.map(d => <HandDecisionRow key={d.id} dec={d} ev={analyzedMap.get(d.id)} />)
          }
        </div>
        <div>
          <p className="text-amber-400 text-[10px] uppercase tracking-wider font-medium mb-2">{p2}</p>
          {p2Decs.length === 0
            ? <p className="text-gray-600 text-xs italic">No data</p>
            : p2Decs.map(d => <HandDecisionRow key={d.id} dec={d} ev={analyzedMap.get(d.id)} />)
          }
        </div>
      </div>
    </div>
  )
}

// ── Blunder card (expandable) ─────────────────────────────────────────────────

function BlunderCard({ d, dec, rank }: { d: AnalyzedDecision; dec?: DecisionPoint; rank: number }) {
  const [open, setOpen] = useState(false)
  const isOptimal = d.evLost < 0.05
  // Use the original DecisionPoint board (always has correct board; cache strips it)
  const board = dec?.infoState.board ?? d.infoState.board
  const hand = d.infoState.hand

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      {/* Always-visible summary */}
      <div
        className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-800/30 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <span className="text-gray-500 text-xs">#{rank}</span>
          <span className="text-gray-300 text-xs font-medium">
            {new Date(d.gameTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {' · '}Street {d.street}
            {d.segment === 'bonus_play' && <span className="ml-1 text-purple-400 text-[10px]">[side]</span>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-sm font-semibold ${isOptimal ? 'text-emerald-400' : d.evLost > 5 ? 'text-red-400' : 'text-amber-400'}`}>
            {isOptimal ? 'optimal' : `-${d.evLost.toFixed(1)} EV`}
          </span>
          <span className="text-gray-600 text-[10px]">{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Compact summary (always visible) */}
      <div className="px-3 pb-3 space-y-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500 w-10 shrink-0">Hand:</span>
          <span className="flex gap-0.5">{hand.map((c, i) => <CardChip key={i} c={c} />)}</span>
        </div>
        <div className="flex items-start gap-2 text-xs">
          <span className="text-gray-500 w-10 shrink-0">Played:</span>
          <PlacementSummary p={d.actualPlacement} />
        </div>
        {!isOptimal && (
          <div className="flex items-start gap-2 text-xs">
            <span className="text-emerald-600 w-10 shrink-0">Best:</span>
            <PlacementSummary p={d.bestPlacement} />
          </div>
        )}
      </div>

      {/* Expanded: board context + full candidate rankings */}
      {open && (
        <div className="border-t border-gray-800 px-3 py-3 bg-gray-950/60 space-y-3">
          <div>
            <p className="text-gray-600 text-[10px] uppercase mb-1">Board before decision</p>
            <BoardMini board={board} />
          </div>
          {d.topCandidates.length > 0 && (
            <div>
              <p className="text-gray-600 text-[10px] uppercase mb-1">All candidates (top {d.topCandidates.length})</p>
              <CandidateList
                topCandidates={d.topCandidates}
                actualPlacement={d.actualPlacement}
                bestEV={d.bestEV}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Summary stat card ─────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: {
  label: string; value: string | number; sub?: string; color?: string
}) {
  return (
    <div className="bg-gray-900 rounded-lg p-3 flex flex-col gap-0.5">
      <span className="text-gray-500 text-[10px] uppercase tracking-wider">{label}</span>
      <span className={`text-lg font-bold ${color ?? 'text-gray-100'}`}>{value}</span>
      {sub && <span className="text-gray-500 text-xs">{sub}</span>}
    </div>
  )
}

// ── Game log table with clickable hand drill-down ─────────────────────────────

function GameLogTable({ summaries, p1, p2, analyzed, decisions }: {
  summaries: GameSummary[]
  p1: string; p2: string
  analyzed: AnalyzedDecision[]
  decisions: DecisionPoint[]
}) {
  const [selectedGame, setSelectedGame] = useState<string | null>(null)

  const decisionsByGame = useMemo(() => {
    const map = new Map<string, DecisionPoint[]>()
    for (const d of decisions) {
      const arr = map.get(d.gameId) ?? []
      arr.push(d)
      map.set(d.gameId, arr)
    }
    return map
  }, [decisions])

  const analyzedMap = useMemo(() => {
    const map = new Map<string, AnalyzedDecision>()
    for (const d of analyzed) map.set(d.id, d)
    return map
  }, [analyzed])

  const evByGame = useMemo(() => {
    const map = new Map<string, { p1: number; p2: number }>()
    for (const d of analyzed) {
      const cur = map.get(d.gameId) ?? { p1: 0, p2: 0 }
      if (d.username === p1) cur.p1 += d.evLost
      else cur.p2 += d.evLost
      map.set(d.gameId, cur)
    }
    return map
  }, [analyzed, p1])

  const hasEV = analyzed.length > 0
  const colSpan = hasEV ? 9 : 7

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <th className="text-left py-1.5 px-2 font-normal">#</th>
            <th className="text-left py-1.5 px-2 font-normal">Time</th>
            <th className="text-right py-1.5 px-2 font-normal text-indigo-400">{p1}</th>
            <th className="text-right py-1.5 px-2 font-normal text-amber-400">{p2}</th>
            <th className="text-right py-1.5 px-2 font-normal">Running</th>
            <th className="text-center py-1.5 px-2 font-normal">Bust</th>
            {hasEV && <>
              <th className="text-right py-1.5 px-2 font-normal text-indigo-400/60">EV lost</th>
              <th className="text-right py-1.5 px-2 font-normal text-amber-400/60">EV lost</th>
            </>}
            <th className="w-5"></th>
          </tr>
        </thead>
        <tbody>
          {summaries.map((s, i) => {
            const ev = evByGame.get(s.gameId)
            const isSelected = selectedGame === s.gameId
            const gameDecs = decisionsByGame.get(s.gameId) ?? []
            const hasData = gameDecs.length > 0

            return (
              <Fragment key={s.gameId}>
                <tr
                  className={`border-b border-gray-900 transition-colors ${
                    hasData ? 'cursor-pointer' : ''
                  } ${isSelected ? 'bg-gray-800/50' : hasData ? 'hover:bg-gray-900/50' : ''}`}
                  onClick={() => hasData && setSelectedGame(isSelected ? null : s.gameId)}
                >
                  <td className="py-1 px-2 text-gray-600">{i + 1}</td>
                  <td className="py-1 px-2 text-gray-400">
                    {new Date(s.gameTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className={`py-1 px-2 text-right font-mono font-medium ${s.p1Points > 0 ? 'text-emerald-400' : s.p1Points < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                    {s.p1Points > 0 ? '+' : ''}{s.p1Points}
                  </td>
                  <td className={`py-1 px-2 text-right font-mono font-medium ${s.p2Points > 0 ? 'text-emerald-400' : s.p2Points < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                    {s.p2Points > 0 ? '+' : ''}{s.p2Points}
                  </td>
                  <td className={`py-1 px-2 text-right font-mono ${s.p2Run > 0 ? 'text-emerald-400' : s.p2Run < 0 ? 'text-red-400/80' : 'text-gray-500'}`}>
                    {s.p2Run > 0 ? '+' : ''}{s.p2Run}
                  </td>
                  <td className="py-1 px-2 text-center">
                    {s.p1Bust && s.p2Bust && <span className="text-purple-400">both</span>}
                    {s.p1Bust && !s.p2Bust && <span className="text-red-400">{p1}</span>}
                    {s.p2Bust && !s.p1Bust && <span className="text-amber-400">{p2}</span>}
                  </td>
                  {hasEV && <>
                    <td className="py-1 px-2 text-right font-mono text-indigo-400/60">
                      {ev ? `-${ev.p1.toFixed(1)}` : '—'}
                    </td>
                    <td className="py-1 px-2 text-right font-mono text-amber-400/60">
                      {ev ? `-${ev.p2.toFixed(1)}` : '—'}
                    </td>
                  </>}
                  <td className="py-1 px-2 text-gray-600 text-center">
                    {hasData && (isSelected ? '▲' : '▼')}
                  </td>
                </tr>
                {isSelected && (
                  <tr>
                    <td colSpan={colSpan} className="p-0">
                      <HandDetail
                        gameDecs={gameDecs}
                        analyzedMap={analyzedMap}
                        p1={p1} p2={p2}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Main SessionTab ───────────────────────────────────────────────────────────

function SessionTabInner() {
  const [rawData, setRawData] = useState<P6Export | null>(null)
  const [pair, setPair] = useState<[string, string] | null>(null)
  const [error, setError] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzed, setAnalyzed] = useState<AnalyzedDecision[]>([])
  const [noModel, setNoModel] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback((file: File) => {
    setError(''); setAnalyzed([]); setNoModel(false); setPair(null)
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target?.result as string) as P6Export
        if (!Array.isArray(parsed.games)) throw new Error('Not a valid pokker6 export')
        setRawData(parsed)
        const pairs = detectPlayerPairs(parsed.games)
        if (pairs.length === 1) setPair([pairs[0]!.p1, pairs[0]!.p2])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to parse file')
      }
    }
    reader.readAsText(file)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const [parseError, setParseError] = useState('')
  const { decisions, summaries } = useMemo(() => {
    if (!rawData || !pair) return { decisions: [] as DecisionPoint[], summaries: [] as GameSummary[] }
    try {
      return parseSessionGames(rawData.games, pair[0], pair[1])
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e))
      return { decisions: [] as DecisionPoint[], summaries: [] as GameSummary[] }
    }
  }, [rawData, pair])

  const pairs = useMemo(() => rawData ? detectPlayerPairs(rawData.games) : [], [rawData])

  // Map for quick lookup of original DecisionPoints (always has correct board from JSON)
  const decisionsById = useMemo(() => new Map(decisions.map(d => [d.id, d])), [decisions])

  // Restore from cache, then enrich boards from freshly-parsed decisions
  useEffect(() => {
    if (decisions.length === 0 || analyzed.length > 0) return
    const key = sessionCacheKey(decisions)
    const cached = key ? loadFromCache(key) : null
    if (!cached || cached.length === 0) return
    const enriched = cached.map(a => {
      const src = decisionsById.get(a.id)
      if (!src) return a
      return { ...a, infoState: { ...a.infoState, board: src.infoState.board } }
    })
    setAnalyzed(enriched)
  }, [decisions]) // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    if (summaries.length === 0) return null
    let p1Wins = 0, p2Wins = 0, ties = 0
    let p1SoloBusts = 0, p2SoloBusts = 0, bothBusts = 0
    let p1BustCost = 0, p2BustCost = 0
    for (const s of summaries) {
      if (s.p1Points > s.p2Points) p1Wins++
      else if (s.p2Points > s.p1Points) p2Wins++
      else ties++
      if (s.p1Bust && s.p2Bust) { bothBusts++ }
      else if (s.p1Bust) { p1SoloBusts++; p1BustCost += s.p1Points }
      else if (s.p2Bust) { p2SoloBusts++; p2BustCost += s.p2Points }
    }
    const final = summaries.at(-1)!
    return { total: summaries.length, p1Wins, p2Wins, ties, p1Total: final.p1Run, p2Total: final.p2Run, p1SoloBusts, p2SoloBusts, bothBusts, p1BustCost, p2BustCost }
  }, [summaries])

  const runAnalysis = useCallback(async () => {
    if (decisions.length === 0) return
    setAnalyzing(true); setNoModel(false)
    try {
      const positions = decisions.map(d => ({ id: d.id, state: d.infoState }))
      let results = await workerClient.analyzePositions(positions)
      if (results.length > 0 && !results[0]!.hasModel) {
        const loaded = await workerClient.loadModel()
        if (!loaded) { setNoModel(true); return }
        results = await workerClient.analyzePositions(positions)
        if (results.length > 0 && !results[0]!.hasModel) { setNoModel(true); return }
      }
      const map = new Map(results.map(r => [r.id, r.candidates]))
      const built = buildAnalyzed(decisions, map)
      setAnalyzed(built)
      const key = sessionCacheKey(decisions)
      if (key) saveToCache(key, built)
    } finally {
      setAnalyzing(false)
    }
  }, [decisions])

  const blunders = useMemo(() => {
    if (!pair || analyzed.length === 0) return { p1: [] as AnalyzedDecision[], p2: [] as AnalyzedDecision[] }
    const p1 = analyzed.filter(d => d.username === pair[0]).sort((a, b) => b.evLost - a.evLost)
    const p2 = analyzed.filter(d => d.username === pair[1]).sort((a, b) => b.evLost - a.evLost)
    return { p1, p2 }
  }, [analyzed, pair])

  const evTotals = useMemo(() => {
    if (!pair || analyzed.length === 0) return null
    const p1Lost = analyzed.filter(d => d.username === pair[0]).reduce((s, d) => s + d.evLost, 0)
    const p2Lost = analyzed.filter(d => d.username === pair[1]).reduce((s, d) => s + d.evLost, 0)
    return { p1: p1Lost, p2: p2Lost }
  }, [analyzed, pair])

  // ── No file loaded ────────────────────────────────────────────────────────

  if (!rawData) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <input ref={fileRef} type="file" accept=".json" className="hidden"
          onChange={e => { if (e.target.files?.[0]) handleFile(e.target.files[0]) }} />
        <div
          className="border-2 border-dashed border-gray-700 rounded-xl p-10 text-center cursor-pointer hover:border-indigo-500 transition-colors"
          onDrop={handleDrop} onDragOver={e => e.preventDefault()} onClick={() => fileRef.current?.click()}
        >
          <p className="text-gray-400 mb-2">Drop a pokker6 export JSON here</p>
          <p className="text-gray-600 text-sm">or click to select file</p>
        </div>
        {error && <p className="text-red-400 text-sm">{error}</p>}
      </div>
    )
  }

  // ── Pair selector ─────────────────────────────────────────────────────────

  if (!pair) {
    return (
      <div className="space-y-4 py-8">
        <p className="text-gray-400 text-sm text-center">Select a head-to-head matchup to analyse:</p>
        <div className="flex flex-col gap-2 max-w-sm mx-auto">
          {pairs.map(p => (
            <button key={`${p.p1}|${p.p2}`} onClick={() => setPair([p.p1, p.p2])}
              className="px-4 py-3 rounded-lg bg-gray-800 hover:bg-gray-700 text-left transition-colors">
              <span className="text-gray-200 font-medium">{p.p1} vs {p.p2}</span>
              <span className="ml-2 text-gray-500 text-sm">{p.count} games</span>
            </button>
          ))}
        </div>
        <div className="text-center">
          <button onClick={() => { setRawData(null); setPair(null) }} className="text-gray-600 hover:text-gray-400 text-xs">
            Load different file
          </button>
        </div>
      </div>
    )
  }

  // ── Full analysis ─────────────────────────────────────────────────────────

  const [p1, p2] = pair

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-gray-100 font-semibold text-sm">
            <span className="text-indigo-400">{p1}</span>
            <span className="text-gray-500 mx-2">vs</span>
            <span className="text-amber-400">{p2}</span>
          </h2>
          {summaries.length > 0 && (
            <p className="text-gray-500 text-xs mt-0.5">
              {new Date(summaries[0]!.gameTime).toLocaleDateString()} ·{' '}
              {new Date(summaries[0]!.gameTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–
              {new Date(summaries.at(-1)!.gameTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
              {summaries.length} hands
            </p>
          )}
        </div>
        <button onClick={() => { setPair(null); setAnalyzed([]) }} className="text-gray-600 hover:text-gray-400 text-xs">
          ← Change
        </button>
      </div>

      {/* Summary stats */}
      {stats && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard label={`${p1} record`}
            value={`${stats.p1Wins}W / ${stats.p2Wins}L`}
            sub={stats.ties > 0 ? `${stats.ties} ties` : undefined}
            color="text-indigo-400" />
          <StatCard label={`${p1} total`}
            value={`${stats.p1Total > 0 ? '+' : ''}${stats.p1Total}`}
            sub={`${p2}: ${stats.p2Total > 0 ? '+' : ''}${stats.p2Total}`}
            color={stats.p1Total >= 0 ? 'text-emerald-400' : 'text-red-400'} />
          <StatCard label={`${p1} busts`}
            value={stats.p1SoloBusts}
            sub={`cost: ${stats.p1BustCost} pts`}
            color={stats.p1SoloBusts > 0 ? 'text-red-400' : 'text-gray-400'} />
          <StatCard label={`${p2} busts`}
            value={stats.p2SoloBusts}
            sub={`cost: ${stats.p2BustCost} pts`}
            color={stats.p2SoloBusts > 0 ? 'text-amber-400' : 'text-gray-400'} />
        </div>
      )}

      {/* Bust context */}
      {stats && (stats.p1SoloBusts > 0 || stats.p2SoloBusts > 0) && (
        <div className="bg-gray-900/60 rounded-lg px-4 py-3 text-xs text-gray-400 space-y-1">
          {stats.p1SoloBusts > 0 && (
            <p>
              <span className="text-indigo-400">{p1}</span> fouled {stats.p1SoloBusts}× (direct cost{' '}
              <span className="text-red-400">{stats.p1BustCost} pts</span>). Without those hands{' '}
              {p1} would be at{' '}
              <span className={stats.p1Total - stats.p1BustCost >= 0 ? 'text-emerald-400' : 'text-gray-300'}>
                {stats.p1Total - stats.p1BustCost > 0 ? '+' : ''}{stats.p1Total - stats.p1BustCost}
              </span>.
            </p>
          )}
          {stats.p2SoloBusts > 0 && (
            <p>
              <span className="text-amber-400">{p2}</span> fouled {stats.p2SoloBusts}× (direct cost{' '}
              <span className="text-red-400">{stats.p2BustCost} pts</span>). Without those hands{' '}
              {p2} would be at{' '}
              <span className={stats.p2Total - stats.p2BustCost >= 0 ? 'text-emerald-400' : 'text-gray-300'}>
                {stats.p2Total - stats.p2BustCost > 0 ? '+' : ''}{stats.p2Total - stats.p2BustCost}
              </span>.
            </p>
          )}
          {stats.bothBusts > 0 && (
            <p className="text-gray-600">{stats.bothBusts} hand(s) where both fouled — no points either way.</p>
          )}
        </div>
      )}

      {/* Running chart */}
      {summaries.length > 0 && (
        <div className="bg-gray-900 rounded-lg p-3">
          <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-2">Running total ({p2} perspective)</p>
          <RunningChart summaries={summaries} p1={p1} p2={p2} />
          <p className="text-[10px] text-gray-600 mt-1">
            Red dot = {p1} bust · Amber dot = {p2} bust · Purple = both bust
          </p>
        </div>
      )}

      {/* EV analysis */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-gray-300 text-sm font-medium">EV Analysis</h3>
          {analyzed.length === 0 && !noModel && (
            <button
              onClick={runAnalysis}
              disabled={analyzing || decisions.length === 0}
              className="px-3 py-1 rounded text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            >
              {analyzing ? `Analysing ${decisions.length} positions…` : `Run Analysis (${decisions.length} decisions)`}
            </button>
          )}
          {analyzed.length > 0 && (
            <button
              onClick={runAnalysis}
              disabled={analyzing}
              className="px-3 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-gray-300 transition-colors"
            >
              {analyzing ? 'Reanalysing…' : 'Rerun'}
            </button>
          )}
        </div>

        {noModel && (
          <div className="flex items-center justify-between bg-amber-900/20 rounded px-3 py-2">
            <p className="text-amber-400 text-xs">
              Model unavailable at /models/policy.bin — training may still be in progress.
            </p>
            <button onClick={runAnalysis} className="ml-3 shrink-0 px-2 py-1 text-xs rounded bg-amber-800/40 hover:bg-amber-700/40 text-amber-300 transition-colors">
              Retry
            </button>
          </div>
        )}

        {evTotals && (
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-gray-900 rounded-lg p-3">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">{p1} EV lost</p>
              <p className="text-xl font-bold text-red-400">-{evTotals.p1.toFixed(1)}</p>
              <p className="text-xs text-gray-600">avg {(evTotals.p1 / (blunders.p1.length || 1)).toFixed(2)}/decision</p>
            </div>
            <div className="bg-gray-900 rounded-lg p-3">
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">{p2} EV lost</p>
              <p className="text-xl font-bold text-red-400">-{evTotals.p2.toFixed(1)}</p>
              <p className="text-xs text-gray-600">avg {(evTotals.p2 / (blunders.p2.length || 1)).toFixed(2)}/decision</p>
            </div>
          </div>
        )}

        {analyzed.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <p className="text-indigo-400 text-xs font-medium uppercase tracking-wider">{p1} — top mistakes</p>
              {blunders.p1.slice(0, 5).map((d, i) => (
                <BlunderCard key={d.id} d={d} dec={decisionsById.get(d.id)} rank={i + 1} />
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-amber-400 text-xs font-medium uppercase tracking-wider">{p2} — top mistakes</p>
              {blunders.p2.slice(0, 5).map((d, i) => (
                <BlunderCard key={d.id} d={d} dec={decisionsById.get(d.id)} rank={i + 1} />
              ))}
            </div>
          </div>
        )}

        {analyzed.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <p className="text-emerald-400 text-xs font-medium uppercase tracking-wider">{p1} — best plays</p>
              {[...blunders.p1].sort((a, b) => a.evLost - b.evLost).slice(0, 3).map((d, i) => (
                <BlunderCard key={d.id} d={d} dec={decisionsById.get(d.id)} rank={i + 1} />
              ))}
            </div>
            <div className="space-y-2">
              <p className="text-emerald-400 text-xs font-medium uppercase tracking-wider">{p2} — best plays</p>
              {[...blunders.p2].sort((a, b) => a.evLost - b.evLost).slice(0, 3).map((d, i) => (
                <BlunderCard key={d.id} d={d} dec={decisionsById.get(d.id)} rank={i + 1} />
              ))}
            </div>
          </div>
        )}
      </div>

      {parseError && (
        <p className="text-red-400 text-xs bg-red-900/20 rounded px-3 py-2">Parse error: {parseError}</p>
      )}

      {/* Game log — rows are clickable to drill into per-street hand replay */}
      {summaries.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-gray-300 text-sm font-medium">Game Log</h3>
            <span className="text-gray-600 text-xs">· click a row to see play-by-play</span>
          </div>
          <GameLogTable summaries={summaries} p1={p1} p2={p2} analyzed={analyzed} decisions={decisions} />
        </div>
      )}
    </div>
  )
}

export function SessionTab() {
  return (
    <SessionErrorBoundary>
      <SessionTabInner />
    </SessionErrorBoundary>
  )
}
