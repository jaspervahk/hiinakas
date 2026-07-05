// Session analysis tab: load a pokker6 JSON export, reconstruct per-decision
// InfoStates, run bulk NN evaluation, and surface EV-loss blunders + score stats.
// Supports 2- and 3-player game sessions.

import { Component, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Card, PartialBoard } from '../engine/types'
import type { ScoredPlacement } from '../engine/mc'
import type { Placement } from '../engine/placement'
import {
  parseSessionGames,
  detectPlayerGroups,
  matchesActual,
  type P6Export,
  type DecisionPoint,
  type GameSummary,
} from '../game/sessionParser'
import { workerClient, MODEL_URLS } from '../worker/client'
import type { BotPolicy } from '../worker/client'

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

// ── Player colour palette (up to 4 players) ───────────────────────────────────

const PLAYER_COLORS = [
  { text: 'text-indigo-400', bg: 'bg-indigo-900/20', border: 'border-indigo-800/40', dim: 'text-indigo-400/60', stroke: '#818cf8' },
  { text: 'text-amber-400',  bg: 'bg-amber-900/20',  border: 'border-amber-800/40',  dim: 'text-amber-400/60',  stroke: '#fbbf24' },
  { text: 'text-emerald-400',bg: 'bg-emerald-900/20',border: 'border-emerald-800/40',dim: 'text-emerald-400/60',stroke: '#34d399' },
  { text: 'text-rose-400',   bg: 'bg-rose-900/20',   border: 'border-rose-800/40',   dim: 'text-rose-400/60',   stroke: '#fb7185' },
]
function pc(i: number) { return PLAYER_COLORS[i % PLAYER_COLORS.length]! }

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

// ── Running score SVG chart (N players) ──────────────────────────────────────

function RunningChart({ summaries, players }: { summaries: GameSummary[]; players: string[] }) {
  const W = 560; const H = 130
  const PL = 36; const PR = 8; const PT = 16; const PB = 20

  const allValues = [0, ...summaries.flatMap(s => players.map(p => s.runs[p] ?? 0))]
  const yMin = Math.min(...allValues)
  const yMax = Math.max(0, ...allValues)
  const yRange = yMax - yMin || 1

  const toX = (i: number) => PL + (i / summaries.length) * (W - PL - PR)
  const toY = (v: number) => PT + ((yMax - v) / yRange) * (H - PT - PB)
  const zeroY = toY(0)
  const yTicks = [yMin, 0, yMax].filter((v, i, a) => a.indexOf(v) === i && Math.abs(v) > 2)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 150 }}>
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

      {/* Line per player */}
      {players.map((p, pi) => {
        const color = pc(pi)
        const values = [0, ...summaries.map(s => s.runs[p] ?? 0)]
        const points = values.map((v, i) => `${toX(i)},${toY(v)}`).join(' ')
        return <polyline key={p} points={points} fill="none" stroke={color.stroke} strokeWidth="1.2" />
      })}

      {/* Bust markers */}
      {summaries.map((s, i) => {
        const bustPlayers = players.filter(p => s.busts[p])
        if (bustPlayers.length === 0) return null
        return bustPlayers.map((p) => {
          const pIdx = players.indexOf(p)
          const y = toY(s.runs[p] ?? 0)
          return <circle key={`${i}-${p}`} cx={toX(i + 1)} cy={y} r="2.5"
            fill={pc(pIdx).stroke} stroke="#030712" strokeWidth="0.8" />
        })
      })}

      {/* Regular dots */}
      {summaries.map((s, i) => {
        return players.map((p, pi) => {
          if (s.busts[p]) return null
          return <circle key={`${i}-${p}`} cx={toX(i + 1)} cy={toY(s.runs[p] ?? 0)} r="1.5" fill={pc(pi).stroke} />
        })
      })}

      {/* X-axis labels */}
      {summaries.map((_, i) => {
        const n = i + 1
        if (n !== 1 && n % 5 !== 0 && n !== summaries.length) return null
        return <text key={i} x={toX(i + 1)} y={H - 4} textAnchor="middle" fontSize="7" fill="#4b5563">{n}</text>
      })}

      {/* Legend */}
      {players.map((p, pi) => (
        <g key={p}>
          <circle cx={PL + 8 + pi * 70} cy={PT - 5} r="2" fill={pc(pi).stroke} />
          <text x={PL + 13 + pi * 70} y={PT - 2} fontSize="6.5" fill="#9ca3af">{p}</text>
        </g>
      ))}
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

// ── Cache ─────────────────────────────────────────────────────────────────────

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

function sessionCacheKey(decisions: DecisionPoint[], mode: BotPolicy): string {
  if (decisions.length === 0) return ''
  return `session_ev_${CACHE_VERSION}:${mode}:${decisions[0]!.gameId}:${decisions[decisions.length - 1]!.gameId}:${decisions.length}`
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
  } catch { /* quota exceeded */ }
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

// ── Hand decision row (inside hand detail panel) ──────────────────────────────

function HandDecisionRow({ dec, ev }: { dec: DecisionPoint; ev?: AnalyzedDecision }) {
  const [open, setOpen] = useState(false)
  const hasEV = !!ev
  const isMistake = hasEV && ev.evLost > 0.1
  const isOptimal = hasEV && !isMistake

  return (
    <div className={`border-l-2 pl-2 mb-1 ${isMistake ? 'border-amber-700/60' : isOptimal ? 'border-emerald-800/50' : 'border-gray-800'}`}>
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
          <span className={`text-xs shrink-0 font-mono ${isOptimal ? 'text-emerald-600' : 'text-amber-400'}`}>
            {isOptimal ? '✓' : `-${ev.evLost.toFixed(1)}`}
          </span>
        )}
        <span className="text-gray-700 text-[10px] shrink-0">{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div className="ml-16 mt-1 mb-2 space-y-2">
          <div className="flex items-start gap-2">
            <span className="text-gray-600 text-[10px] uppercase shrink-0 w-10 pt-0.5">Board</span>
            <BoardMini board={dec.infoState.board} />
          </div>
          {hasEV && (
            <div className="space-y-0.5">
              <div className="flex items-start gap-2">
                <span className={`text-[10px] uppercase shrink-0 w-10 pt-0.5 ${isMistake ? 'text-amber-700' : 'text-gray-600'}`}>Played</span>
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
          {ev && ev.topCandidates.length > 0 && (
            <div>
              <p className="text-gray-600 text-[10px] uppercase mb-0.5">Rankings (top {ev.topCandidates.length})</p>
              <CandidateList topCandidates={ev.topCandidates} actualPlacement={dec.actualPlacement} bestEV={ev.bestEV} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Hand detail panel ─────────────────────────────────────────────────────────

function HandDetail({ gameDecs, analyzedMap, players }: {
  gameDecs: DecisionPoint[]
  analyzedMap: Map<string, AnalyzedDecision>
  players: string[]
}) {
  if (gameDecs.length === 0) {
    return (
      <div className="bg-gray-950 border-t border-gray-800 px-4 py-3">
        <p className="text-gray-600 text-xs italic">No play-by-play data for this hand.</p>
      </div>
    )
  }

  return (
    <div className="bg-gray-950 border-t border-gray-800 px-4 py-3">
      <div className={`grid gap-4 ${players.length === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'}`}>
        {players.map((pname, pi) => {
          const pDecs = gameDecs.filter(d => d.username === pname).sort((a, b) => a.street - b.street)
          return (
            <div key={pname}>
              <p className={`${pc(pi).text} text-[10px] uppercase tracking-wider font-medium mb-2`}>{pname}</p>
              {pDecs.length === 0
                ? <p className="text-gray-600 text-xs italic">No data</p>
                : pDecs.map(d => <HandDecisionRow key={d.id} dec={d} ev={analyzedMap.get(d.id)} />)
              }
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Blunder card ──────────────────────────────────────────────────────────────

function BlunderCard({ d, dec, rank }: { d: AnalyzedDecision; dec?: DecisionPoint; rank: number }) {
  const [open, setOpen] = useState(false)
  const isOptimal = d.evLost < 0.05
  const board = dec?.infoState.board ?? d.infoState.board

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
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

      <div className="px-3 pb-3 space-y-1">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500 w-10 shrink-0">Hand:</span>
          <span className="flex gap-0.5">{d.infoState.hand.map((c, i) => <CardChip key={i} c={c} />)}</span>
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

      {open && (
        <div className="border-t border-gray-800 px-3 py-3 bg-gray-950/60 space-y-3">
          <div>
            <p className="text-gray-600 text-[10px] uppercase mb-1">Board before decision</p>
            <BoardMini board={board} />
          </div>
          {d.topCandidates.length > 0 && (
            <div>
              <p className="text-gray-600 text-[10px] uppercase mb-1">All candidates (top {d.topCandidates.length})</p>
              <CandidateList topCandidates={d.topCandidates} actualPlacement={d.actualPlacement} bestEV={d.bestEV} />
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

// ── Game log table ────────────────────────────────────────────────────────────

function GameLogTable({ summaries, players, analyzed, decisions }: {
  summaries: GameSummary[]
  players: string[]
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
    const map = new Map<string, Record<string, number>>()
    for (const d of analyzed) {
      const cur = map.get(d.gameId) ?? {}
      cur[d.username] = (cur[d.username] ?? 0) + d.evLost
      map.set(d.gameId, cur)
    }
    return map
  }, [analyzed])

  const hasEV = analyzed.length > 0
  const nPlayers = players.length
  // columns: #, Time, [score per player], Bust, [EV per player if analysis], expand
  const colSpan = 3 + nPlayers + (hasEV ? nPlayers : 0)

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <th className="text-left py-1.5 px-2 font-normal">#</th>
            <th className="text-left py-1.5 px-2 font-normal">Time</th>
            {players.map((p, pi) => (
              <th key={p} className={`text-right py-1.5 px-2 font-normal ${pc(pi).text}`}>{p}</th>
            ))}
            <th className="text-center py-1.5 px-2 font-normal">Bust</th>
            {hasEV && players.map((p, pi) => (
              <th key={`ev-${p}`} className={`text-right py-1.5 px-2 font-normal ${pc(pi).dim}`}>EV lost</th>
            ))}
            <th className="w-5"></th>
          </tr>
        </thead>
        <tbody>
          {summaries.map((s, i) => {
            const ev = evByGame.get(s.gameId)
            const isSelected = selectedGame === s.gameId
            const gameDecs = decisionsByGame.get(s.gameId) ?? []
            const hasData = gameDecs.length > 0
            const bustNames = players.filter(p => s.busts[p])

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
                  {players.map((p, pi) => {
                    const pts = s.points[p] ?? 0
                    // Show running total in parentheses for first player only (to keep it compact)
                    return (
                      <td key={p} className={`py-1 px-2 text-right font-mono font-medium ${pts > 0 ? 'text-emerald-400' : pts < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                        {pts > 0 ? '+' : ''}{pts}
                        {pi === 0 && nPlayers === 2 && (
                          <span className={`ml-1 text-[10px] font-normal ${(s.runs[p] ?? 0) > 0 ? 'text-emerald-600' : 'text-red-600/70'}`}>
                            ({(s.runs[p] ?? 0) > 0 ? '+' : ''}{s.runs[p] ?? 0})
                          </span>
                        )}
                      </td>
                    )
                  })}
                  <td className="py-1 px-2 text-center">
                    {bustNames.length === 0 ? null : bustNames.length === s.playerNames.length
                      ? <span className="text-purple-400">all</span>
                      : bustNames.map((n, bi) => (
                        <span key={n} className={`${pc(players.indexOf(n)).text} ${bi > 0 ? 'ml-1' : ''}`}>{n}</span>
                      ))
                    }
                  </td>
                  {hasEV && players.map((p, pi) => (
                    <td key={`ev-${p}`} className={`py-1 px-2 text-right font-mono ${pc(pi).dim}`}>
                      {ev?.[p] != null ? `-${ev[p]!.toFixed(1)}` : '—'}
                    </td>
                  ))}
                  <td className="py-1 px-2 text-gray-600 text-center">
                    {hasData && (isSelected ? '▲' : '▼')}
                  </td>
                </tr>
                {isSelected && (
                  <tr>
                    <td colSpan={colSpan} className="p-0">
                      <HandDetail gameDecs={gameDecs} analyzedMap={analyzedMap} players={players} />
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
  // pickerKeys: group keys currently checked in the picker (not yet committed).
  // activeGroups: the committed selection that drives parsing and analysis; null = show picker.
  const [pickerKeys, setPickerKeys] = useState<Set<string>>(new Set())
  const [activeGroups, setActiveGroups] = useState<string[][] | null>(null)
  const [error, setError] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeProgress, setAnalyzeProgress] = useState<{ done: number; total: number } | null>(null)
  const [analyzed, setAnalyzed] = useState<AnalyzedDecision[]>([])
  const [noModel, setNoModel] = useState(false)
  const [analysisMode, setAnalysisMode] = useState<BotPolicy>('nn')
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = useCallback((file: File) => {
    setError(''); setAnalyzed([]); setNoModel(false)
    setPickerKeys(new Set()); setActiveGroups(null); setAnalysisMode('nn')
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target?.result as string) as P6Export
        if (!Array.isArray(parsed.games)) throw new Error('Not a valid pokker6 export')
        setRawData(parsed)
        const groups = detectPlayerGroups(parsed.games)
        if (groups.length === 1) {
          const key = groups[0]!.players.slice().sort().join('|')
          setPickerKeys(new Set([key]))
          setActiveGroups([groups[0]!.players])
        }
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

  const parseResult = useMemo(() => {
    const empty = { decisions: [] as DecisionPoint[], summaries: [] as GameSummary[], allPlayers: [] as string[], parseError: '' }
    if (!rawData || !activeGroups || activeGroups.length === 0) return empty
    try {
      const result = parseSessionGames(rawData.games, activeGroups)
      return { ...result, parseError: '' }
    } catch (e) {
      return { ...empty, parseError: e instanceof Error ? e.message : String(e) }
    }
  }, [rawData, activeGroups])
  const { decisions, summaries, allPlayers, parseError } = parseResult

  const groups = useMemo(() => rawData ? detectPlayerGroups(rawData.games) : [], [rawData])

  const decisionsById = useMemo(() => new Map(decisions.map(d => [d.id, d])), [decisions])

  // Restore from cache, enriching boards from freshly-parsed decisions
  useEffect(() => {
    if (decisions.length === 0 || analyzed.length > 0) return
    const key = sessionCacheKey(decisions, analysisMode)
    const cached = key ? loadFromCache(key) : null
    if (!cached || cached.length === 0) return
    const enriched = cached.map(a => {
      const src = decisionsById.get(a.id)
      if (!src) return a
      return { ...a, infoState: { ...a.infoState, board: src.infoState.board } }
    })
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnalyzed(enriched)
  }, [decisions]) // eslint-disable-line react-hooks/exhaustive-deps

  // Per-player stats from summaries.
  // Win/bust calculations use s.playerNames (the actual players in each game)
  // so that multi-group selections (e.g. A vs B + A vs B vs C) work correctly.
  const stats = useMemo(() => {
    if (!activeGroups || allPlayers.length === 0 || summaries.length === 0) return null

    const wins: Record<string, number> = {}
    const soloBusts: Record<string, number> = {}
    const bustCost: Record<string, number> = {}
    const allBustCount: Record<string, number> = {}
    for (const n of allPlayers) { wins[n] = 0; soloBusts[n] = 0; bustCost[n] = 0; allBustCount[n] = 0 }
    let ties = 0; let allBustHands = 0

    for (const s of summaries) {
      const gamePlayers = s.playerNames.length > 0 ? s.playerNames : allPlayers
      const scores = gamePlayers.map(p => s.points[p] ?? 0)
      const maxScore = Math.max(...scores)
      const winners = gamePlayers.filter(p => (s.points[p] ?? 0) === maxScore)
      if (winners.length === 1) wins[winners[0]!] = (wins[winners[0]!] ?? 0) + 1
      else ties++

      const bustCount = gamePlayers.filter(p => s.busts[p]).length
      if (bustCount === gamePlayers.length) {
        allBustHands++
        for (const p of gamePlayers) allBustCount[p] = (allBustCount[p] ?? 0) + 1
      } else {
        for (const p of gamePlayers) {
          if (s.busts[p]) {
            soloBusts[p] = (soloBusts[p] ?? 0) + 1
            bustCost[p] = (bustCost[p] ?? 0) + (s.points[p] ?? 0)
          }
        }
      }
    }

    const final = summaries.at(-1)!
    return { wins, ties, soloBusts, bustCost, allBustHands, allBustCount, finalRuns: final.runs }
  }, [activeGroups, allPlayers, summaries])

  const runAnalysis = useCallback(async () => {
    if (decisions.length === 0) return
    setAnalyzing(true); setNoModel(false); setAnalyzeProgress(null); setAnalyzed([])
    try {
      const positions = decisions.map(d => ({ id: d.id, state: d.infoState }))
      const partialMap = new Map<string, import('../engine/mc').ScoredPlacement[]>()

      if (analysisMode === 'nn') {
        const loaded = await workerClient.loadModel(MODEL_URLS.v2)
        if (!loaded) { setNoModel(true); return }
      }

      const results = await workerClient.analyzePositions(
        positions,
        // Heuristic MC brute-forces a full rollout per candidate with no NN/tree-search
        // guidance, so it needs a far smaller budget to stay usable over a whole session.
        analysisMode === 'heuristic' ? 20 : 200,
        (done, total, item) => {
          partialMap.set(item.id, item.candidates)
          setAnalyzeProgress({ done, total })
          setAnalyzed(buildAnalyzed(decisions, partialMap))
        },
        analysisMode,
      )

      if (results.length > 0 && !results[0]!.hasModel) { setNoModel(true); return }

      // If the worker crashed mid-run, results is []. Use partialMap so we don't
      // wipe whatever was already computed and displayed.
      const sourceMap = results.length > 0
        ? new Map(results.map(r => [r.id, r.candidates]))
        : partialMap
      const built = buildAnalyzed(decisions, sourceMap)
      setAnalyzed(built)
      const key = sessionCacheKey(decisions, analysisMode)
      if (key && results.length > 0) saveToCache(key, built)
    } finally {
      setAnalyzing(false); setAnalyzeProgress(null)
    }
  }, [decisions, analysisMode])

  const blundersByPlayer = useMemo(() => {
    if (!activeGroups || allPlayers.length === 0 || analyzed.length === 0) return new Map<string, AnalyzedDecision[]>()
    const map = new Map<string, AnalyzedDecision[]>()
    for (const p of allPlayers) {
      map.set(p, analyzed.filter(d => d.username === p).sort((a, b) => b.evLost - a.evLost))
    }
    return map
  }, [analyzed, allPlayers, activeGroups])

  const evTotalsByPlayer = useMemo(() => {
    if (!activeGroups || allPlayers.length === 0 || analyzed.length === 0) return null
    const map: Record<string, number> = {}
    for (const d of analyzed) {
      map[d.username] = (map[d.username] ?? 0) + d.evLost
    }
    return map
  }, [analyzed, activeGroups, allPlayers])

  // ── No file ───────────────────────────────────────────────────────────────

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

  // ── Group selector ────────────────────────────────────────────────────────

  if (!activeGroups) {
    const allSelected = groups.length > 0 && groups.every(g => pickerKeys.has(g.players.slice().sort().join('|')))
    const toggleGroup = (key: string) => {
      setPickerKeys(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    }
    const toggleAll = () => {
      if (allSelected) setPickerKeys(new Set())
      else setPickerKeys(new Set(groups.map(g => g.players.slice().sort().join('|'))))
    }
    const confirmSelection = () => {
      const selected = groups
        .filter(g => pickerKeys.has(g.players.slice().sort().join('|')))
        .map(g => g.players)
      if (selected.length === 0) return
      setActiveGroups(selected)
      setAnalyzed([])
    }
    const totalGames = groups
      .filter(g => pickerKeys.has(g.players.slice().sort().join('|')))
      .reduce((sum, g) => sum + g.count, 0)

    return (
      <div className="space-y-4 py-8">
        <p className="text-gray-400 text-sm text-center">
          Select game group{groups.length > 1 ? 's' : ''} to analyse:
        </p>
        <div className="flex flex-col gap-2 max-w-sm mx-auto">
          {groups.length > 1 && (
            <button onClick={toggleAll}
              className="px-3 py-1.5 rounded text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-500 transition-colors text-center">
              {allSelected ? 'Deselect all' : 'Select all'}
            </button>
          )}
          {groups.map(g => {
            const key = g.players.slice().sort().join('|')
            const checked = pickerKeys.has(key)
            return (
              <label key={key}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer transition-colors ${checked ? 'bg-indigo-900/30 border border-indigo-800/50' : 'bg-gray-800 hover:bg-gray-700 border border-transparent'}`}>
                <input type="checkbox" checked={checked} onChange={() => toggleGroup(key)} className="accent-indigo-500" />
                <span className="flex-1 text-gray-200 font-medium">
                  {g.players.map((p, i) => (
                    <span key={p}>
                      {i > 0 && <span className="text-gray-500 mx-1">vs</span>}
                      <span className={pc(i).text}>{p}</span>
                    </span>
                  ))}
                </span>
                <span className="text-gray-500 text-sm">{g.count} game{g.count !== 1 ? 's' : ''}</span>
              </label>
            )
          })}
          {pickerKeys.size > 0 && (
            <button onClick={confirmSelection}
              className="mt-1 px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">
              Analyse {totalGames} game{totalGames !== 1 ? 's' : ''} →
            </button>
          )}
        </div>
        <div className="text-center">
          <button onClick={() => { setRawData(null); setPickerKeys(new Set()); setActiveGroups(null) }} className="text-gray-600 hover:text-gray-400 text-xs">
            Load different file
          </button>
        </div>
      </div>
    )
  }

  // ── Full analysis ─────────────────────────────────────────────────────────

  const players = allPlayers

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-gray-100 font-semibold text-sm">
            {players.map((p, i) => (
              <span key={p}>
                {i > 0 && <span className="text-gray-500 mx-2">vs</span>}
                <span className={pc(i).text}>{p}</span>
              </span>
            ))}
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
        <button onClick={() => setActiveGroups(null)} className="text-gray-600 hover:text-gray-400 text-xs">
          ← Change
        </button>
      </div>

      {/* Summary stats — one card per player */}
      {stats && (
        <div className={`grid gap-2 grid-cols-2 ${players.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-4'}`}>
          {players.map((p, pi) => {
            const run = stats.finalRuns[p] ?? 0
            return (
              <StatCard key={p}
                label={`${p} total`}
                value={`${run > 0 ? '+' : ''}${run}`}
                sub={`${stats.wins[p] ?? 0}W · ${stats.ties} ties · ${stats.soloBusts[p] ?? 0} busts`}
                color={run >= 0 ? pc(pi).text : 'text-red-400'} />
            )
          })}
          {players.length === 2 && (
            <StatCard
              label="record"
              value={`${stats.wins[players[0]!] ?? 0}W / ${stats.wins[players[1]!] ?? 0}L`}
              sub={stats.ties > 0 ? `${stats.ties} ties` : undefined}
              color={pc(0).text} />
          )}
        </div>
      )}

      {/* Bust context */}
      {stats && players.some(p => (stats.soloBusts[p] ?? 0) > 0) && (
        <div className="bg-gray-900/60 rounded-lg px-4 py-3 text-xs text-gray-400 space-y-1">
          {players.map((p, pi) => {
            const n = stats.soloBusts[p] ?? 0
            if (n === 0) return null
            const cost = stats.bustCost[p] ?? 0
            const run = stats.finalRuns[p] ?? 0
            return (
              <p key={p}>
                <span className={pc(pi).text}>{p}</span> fouled {n}× (direct cost{' '}
                <span className="text-red-400">{cost} pts</span>). Without those hands{' '}
                {p} would be at{' '}
                <span className={run - cost >= 0 ? 'text-emerald-400' : 'text-gray-300'}>
                  {run - cost > 0 ? '+' : ''}{run - cost}
                </span>.
              </p>
            )
          })}
          {stats.allBustHands > 0 && (
            <p className="text-gray-600">{stats.allBustHands} hand(s) where all players fouled — no points either way.</p>
          )}
        </div>
      )}

      {/* Running chart */}
      {summaries.length > 0 && (
        <div className="bg-gray-900 rounded-lg p-3">
          <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-2">Running totals</p>
          <RunningChart summaries={summaries} players={players} />
          <p className="text-[10px] text-gray-600 mt-1">Solid dots = regular hands · filled dot = bust</p>
        </div>
      )}

      {/* EV analysis */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-gray-300 text-sm font-medium">EV Analysis</h3>
          <div className="flex items-center gap-2">
            {/* Analysis mode selector */}
            <div className="flex rounded overflow-hidden border border-gray-700 text-[10px]">
              <button
                onClick={() => { setAnalysisMode('nn'); setAnalyzed([]); setNoModel(false) }}
                className={`px-2 py-1 transition-colors ${analysisMode === 'nn' ? 'bg-indigo-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                NN + MCTS
              </button>
              <button
                onClick={() => { setAnalysisMode('royalty'); setAnalyzed([]); setNoModel(false) }}
                className={`px-2 py-1 transition-colors ${analysisMode === 'royalty' ? 'bg-amber-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                Royalty
              </button>
              <button
                onClick={() => { setAnalysisMode('heuristic'); setAnalyzed([]); setNoModel(false) }}
                className={`px-2 py-1 transition-colors ${analysisMode === 'heuristic' ? 'bg-teal-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                Heuristic
              </button>
            </div>
            {analyzing && analyzeProgress && (
              <span className="text-xs text-gray-400">
                {analyzeProgress.done}/{analyzeProgress.total} positions…
              </span>
            )}
            {(!analyzing && analyzed.length === 0 && !noModel) && (
              <button onClick={runAnalysis} disabled={decisions.length === 0}
                className="px-3 py-1 rounded text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white transition-colors">
                Run Analysis ({decisions.length})
              </button>
            )}
            {(!analyzing && analyzed.length > 0) && (
              <button onClick={runAnalysis}
                className="px-3 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">
                Rerun
              </button>
            )}
            {analyzing && !analyzeProgress && (
              <span className="text-xs text-gray-400">Loading model…</span>
            )}
          </div>
        </div>

        {noModel && (
          <div className="flex items-center justify-between bg-amber-900/20 rounded px-3 py-2">
            <p className="text-amber-400 text-xs">Model unavailable at /models/policy.bin — training may still be in progress.</p>
            <button onClick={runAnalysis} className="ml-3 shrink-0 px-2 py-1 text-xs rounded bg-amber-800/40 hover:bg-amber-700/40 text-amber-300 transition-colors">
              Retry
            </button>
          </div>
        )}

        {evTotalsByPlayer && (
          <div className={`grid gap-2 ${players.length === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
            {players.map((p, pi) => {
              const lost = evTotalsByPlayer[p] ?? 0
              const decCount = blundersByPlayer.get(p)?.length ?? 0
              return (
                <div key={p} className="bg-gray-900 rounded-lg p-3">
                  <p className={`text-[10px] uppercase tracking-wider ${pc(pi).text}`}>{p} EV lost</p>
                  <p className="text-xl font-bold text-red-400">-{lost.toFixed(1)}</p>
                  <p className="text-xs text-gray-600">avg {(lost / (decCount || 1)).toFixed(2)}/decision</p>
                </div>
              )
            })}
          </div>
        )}

        {analyzed.length > 0 && (
          <div className={`grid gap-4 ${players.length === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'}`}>
            {players.map((p, pi) => {
              const blist = blundersByPlayer.get(p) ?? []
              return (
                <div key={p} className="space-y-2">
                  <p className={`${pc(pi).text} text-xs font-medium uppercase tracking-wider`}>{p} — top mistakes</p>
                  {blist.slice(0, 5).map((d, i) => (
                    <BlunderCard key={d.id} d={d} dec={decisionsById.get(d.id)} rank={i + 1} />
                  ))}
                </div>
              )
            })}
          </div>
        )}

        {analyzed.length > 0 && (
          <div className={`grid gap-4 ${players.length === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'}`}>
            {players.map((p) => {
              const blist = blundersByPlayer.get(p) ?? []
              const best = [...blist].sort((a, b) => a.evLost - b.evLost).slice(0, 3)
              return (
                <div key={p} className="space-y-2">
                  <p className="text-emerald-400 text-xs font-medium uppercase tracking-wider">{p} — best plays</p>
                  {best.map((d, i) => (
                    <BlunderCard key={d.id} d={d} dec={decisionsById.get(d.id)} rank={i + 1} />
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {parseError && (
        <p className="text-red-400 text-xs bg-red-900/20 rounded px-3 py-2">Parse error: {parseError}</p>
      )}

      {/* Game log */}
      {summaries.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h3 className="text-gray-300 text-sm font-medium">Game Log</h3>
            <span className="text-gray-600 text-xs">· click a row to see play-by-play</span>
          </div>
          <GameLogTable summaries={summaries} players={players} analyzed={analyzed} decisions={decisions} />
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
