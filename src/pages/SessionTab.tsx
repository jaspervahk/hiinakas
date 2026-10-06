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
  computeSessionStats,
  type P6Export,
  type DecisionPoint,
  type BonusDecisionPoint,
  type GameSummary,
} from '../game/sessionParser'
import type { ReviewDecision, PersistedBonusDecision, SavedAnalysisMeta } from '../game/sessionAnalysisTypes'
import { loadSessionAnalysis, saveSessionAnalysis } from '../firestore/sessionAnalysis'
import { SavedAnalysesList } from '../components/SavedAnalysesList'
import { CardChip, PlacementSummary, CandidateList } from '../components/CandidateList'
import { DecisionStepper } from '../components/DecisionStepper'
import { ReplaySession } from '../components/ReplaySession'
import { ChallengeHuubOverlay } from '../components/ChallengeHuubOverlay'
import { SentChallengesList } from '../components/SentChallengesList'
import { BotSimulationOverlay } from '../components/BotSimulationOverlay'
import { LuckAnalysisSection } from '../components/LuckAnalysisSection'
import { workerClient, MODEL_URLS } from '../worker/client'
import type { BotPolicy, BonusAnalysisResult } from '../worker/client'
import { DEFAULT_ROOT_TOP_K, DEFAULT_SIMS_FOR, MIN_SIMS, MAX_SIMS, clampSims } from '../worker/botPolicyDefaults'

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

// ── Player colour palette ─────────────────────────────────────────────────────
//
// Twelve entries, because a real session can have eleven players and the old
// four-colour palette made three separate people share a colour in the chart,
// the log header and the per-player cards.

const PLAYER_COLORS = [
  { text: 'text-indigo-400', bg: 'bg-indigo-900/20', border: 'border-indigo-800/40', dim: 'text-indigo-400/60', stroke: '#818cf8' },
  { text: 'text-amber-400',  bg: 'bg-amber-900/20',  border: 'border-amber-800/40',  dim: 'text-amber-400/60',  stroke: '#fbbf24' },
  { text: 'text-emerald-400',bg: 'bg-emerald-900/20',border: 'border-emerald-800/40',dim: 'text-emerald-400/60',stroke: '#34d399' },
  { text: 'text-rose-400',   bg: 'bg-rose-900/20',   border: 'border-rose-800/40',   dim: 'text-rose-400/60',   stroke: '#fb7185' },
  { text: 'text-sky-400',    bg: 'bg-sky-900/20',    border: 'border-sky-800/40',    dim: 'text-sky-400/60',    stroke: '#38bdf8' },
  { text: 'text-fuchsia-400',bg: 'bg-fuchsia-900/20',border: 'border-fuchsia-800/40',dim: 'text-fuchsia-400/60',stroke: '#e879f9' },
  { text: 'text-lime-400',   bg: 'bg-lime-900/20',   border: 'border-lime-800/40',   dim: 'text-lime-400/60',   stroke: '#a3e635' },
  { text: 'text-orange-400', bg: 'bg-orange-900/20', border: 'border-orange-800/40', dim: 'text-orange-400/60', stroke: '#fb923c' },
  { text: 'text-cyan-400',   bg: 'bg-cyan-900/20',   border: 'border-cyan-800/40',   dim: 'text-cyan-400/60',   stroke: '#22d3ee' },
  { text: 'text-violet-400', bg: 'bg-violet-900/20', border: 'border-violet-800/40', dim: 'text-violet-400/60', stroke: '#a78bfa' },
  { text: 'text-teal-400',   bg: 'bg-teal-900/20',   border: 'border-teal-800/40',   dim: 'text-teal-400/60',   stroke: '#2dd4bf' },
  { text: 'text-pink-400',   bg: 'bg-pink-900/20',   border: 'border-pink-800/40',   dim: 'text-pink-400/60',   stroke: '#f472b6' },
]
function pc(i: number) { return PLAYER_COLORS[i % PLAYER_COLORS.length]! }

// A session with many players renders far too much at once, so the heavy
// sections collapse. Anything above this is treated as a "big" session: the
// per-player card grids become one compact table and most sections start shut.
const MANY_PLAYERS = 4

// ── Collapsible section ───────────────────────────────────────────────────────

function Section({ title, meta, defaultOpen = true, right, children }: {
  title: ReactNode
  meta?: ReactNode          // shown next to the title, visible while collapsed
  defaultOpen?: boolean
  right?: ReactNode         // controls that belong to the section header
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-1.5 text-gray-300 text-sm font-medium hover:text-gray-100 transition-colors"
        >
          <span className={`text-gray-600 text-[10px] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
          {title}
          {meta && <span className="text-gray-600 text-xs font-normal">{meta}</span>}
        </button>
        {open && right}
      </div>
      {open && children}
    </div>
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

// ── Running score SVG chart (N players) ──────────────────────────────────────

// Above this many visible hands the per-hand dots are omitted: they overlap
// into noise and cost one SVG node per hand per player.
const DOT_LIMIT = 150

function RunningChart({ summaries, players, focus, from, to, W = 560, H = 130, hidden }: {
  summaries: GameSummary[]
  players: string[]
  focus: string | null
  // Visible window over hand indices; defaults to the whole session. Points
  // are indexed 0..N where 0 is the pre-session zero line.
  from?: number
  to?: number
  W?: number
  H?: number
  hidden?: Set<string>
}) {
  const PL = 36; const PR = 8; const PT = 16; const PB = 20
  const lo = from ?? 0
  const hi = to ?? summaries.length
  const span = Math.max(1, hi - lo)

  const vis = players.filter(p => !hidden?.has(p))
  // The y-scale follows the visible window, so zooming in actually resolves
  // detail instead of leaving every line flat against a session-wide range.
  const windowSummaries = summaries.slice(Math.max(0, lo), hi)
  const allValues = [0, ...windowSummaries.flatMap(s => vis.map(p => s.runs[p] ?? 0))]
  const yMin = Math.min(...allValues)
  const yMax = Math.max(0, ...allValues)
  const yRange = yMax - yMin || 1

  const toX = (i: number) => PL + ((i - lo) / span) * (W - PL - PR)
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
        if (hidden?.has(p)) return null
        const color = pc(pi)
        const values = [0, ...summaries.map(s => s.runs[p] ?? 0)]
        // Only the visible window is emitted, plus one point either side so the
        // line still enters and leaves the viewport correctly.
        const a = Math.max(0, Math.floor(lo) - 1)
        const b = Math.min(values.length, Math.ceil(hi) + 2)
        const points = values.slice(a, b).map((v, k) => `${toX(a + k)},${toY(v)}`).join(' ')
        // With a focus selected the other lines stay for context but recede,
        // which is the only way eleven overlapping series are readable.
        const faded = focus !== null && focus !== p
        return (
          <polyline key={p} points={points} fill="none" stroke={color.stroke}
            strokeWidth={focus === p ? 2 : 1.2} opacity={faded ? 0.18 : 1} />
        )
      })}

      {/* Per-hand markers. Only drawn for the visible window, and only when
          the window is sparse enough for them to mean anything — a full
          1400-hand session at eleven players would otherwise mount ~15000
          circles, which is what made this chart slow. Zooming in brings them
          back. */}
      {span <= DOT_LIMIT && windowSummaries.map((s, k) => {
        const i = Math.max(0, lo) + k
        return vis.map((p) => {
          const pi = players.indexOf(p)
          if (focus !== null && focus !== p) return null
          const busted = s.busts[p]
          return (
            <circle key={`${i}-${p}`} cx={toX(i + 1)} cy={toY(s.runs[p] ?? 0)}
              r={busted ? 2.5 : 1.5} fill={pc(pi).stroke}
              stroke={busted ? '#030712' : undefined} strokeWidth={busted ? 0.8 : undefined} />
          )
        })
      })}

      {/* X-axis labels, stepped so they never collide however far out we are */}
      {(() => {
        const step = Math.max(1, Math.ceil(span / 12))
        const out = []
        for (let n = Math.max(1, Math.ceil(lo)); n <= hi; n++) {
          if (n !== 1 && n % step !== 0 && n !== summaries.length) continue
          out.push(<text key={n} x={toX(n)} y={H - 4} textAnchor="middle" fontSize="7" fill="#4b5563">{n}</text>)
        }
        return out
      })()}

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

// ── Full-screen chart with pan and zoom ───────────────────────────────────────
//
// A 1400-hand session is about 0.4 px per hand in the inline strip, so the
// detail is simply not there to read. This keeps a window over hand indices
// and lets the wheel zoom it (around the cursor) and a drag pan it.

function ChartOverlay({ summaries, players, focus, onClose }: {
  summaries: GameSummary[]
  players: string[]
  focus: string | null
  onClose: () => void
}) {
  const N = summaries.length
  const MIN_SPAN = 5
  const [view, setView] = useState<{ from: number; to: number }>({ from: 0, to: N })
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const dragRef = useRef<{ x: number; from: number; to: number } | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const span = view.to - view.from
  const clampView = useCallback((from: number, to: number) => {
    const s = Math.max(MIN_SPAN, Math.min(N, to - from))
    const f = Math.max(0, Math.min(N - s, from))
    return { from: f, to: f + s }
  }, [N])

  // Zoom about the cursor so the hand under the pointer stays put.
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const box = boxRef.current?.getBoundingClientRect()
    if (!box) return
    const frac = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width))
    const anchorIdx = view.from + frac * span
    const factor = e.deltaY > 0 ? 1.25 : 0.8
    const newSpan = Math.max(MIN_SPAN, Math.min(N, span * factor))
    setView(clampView(anchorIdx - frac * newSpan, anchorIdx - frac * newSpan + newSpan))
  }, [view, span, N, clampView])

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, from: view.from, to: view.to }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    const box = boxRef.current?.getBoundingClientRect()
    if (!d || !box) return
    const shift = ((d.x - e.clientX) / box.width) * (d.to - d.from)
    setView(clampView(d.from + shift, d.to + shift))
  }
  const onPointerUp = () => { dragRef.current = null }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === '0') setView({ from: 0, to: N })
      if (e.key === '+' || e.key === '=') setView(v => clampView(v.from, v.from + (v.to - v.from) * 0.8))
      if (e.key === '-') setView(v => clampView(v.from, v.from + (v.to - v.from) * 1.25))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, N, clampView])

  const zoomPct = Math.round((N / Math.max(1, span)) * 100)

  return (
    <div className="fixed inset-0 z-50 bg-gray-950/95 flex flex-col p-4 gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3">
          <h3 className="text-gray-100 text-sm font-semibold">Running totals</h3>
          <span className="text-gray-500 text-xs tabular-nums">
            hands {Math.round(view.from) + 1}–{Math.round(view.to)} of {N} · {zoomPct}%
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <button onClick={() => setView(v => clampView(v.from, v.from + (v.to - v.from) * 1.25))}
            className="px-2 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700">−</button>
          <button onClick={() => setView(v => clampView(v.from, v.from + (v.to - v.from) * 0.8))}
            className="px-2 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700">+</button>
          <button onClick={() => setView({ from: 0, to: N })}
            className="px-2 py-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700">Reset</button>
          <button onClick={onClose} className="ml-2 px-2 py-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700">Close ✕</button>
        </div>
      </div>

      {/* Legend doubles as per-player visibility toggles — with eleven series
          that is the difference between a readable chart and a tangle. */}
      <div className="flex flex-wrap gap-1.5">
        {players.map((p, pi) => {
          const off = hidden.has(p)
          return (
            <button key={p}
              onClick={() => setHidden(h => { const n = new Set(h); if (n.has(p)) n.delete(p); else n.add(p); return n })}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border transition-colors ${
                off ? 'border-gray-800 text-gray-600' : `border-gray-700 ${pc(pi).text}`
              }`}
            >
              <span className="inline-block w-2 h-2 rounded-full"
                style={{ background: off ? '#374151' : pc(pi).stroke }} />
              {p}
            </button>
          )
        })}
        {hidden.size > 0 && (
          <button onClick={() => setHidden(new Set())} className="px-2 py-0.5 text-[11px] text-gray-500 hover:text-gray-300">
            show all
          </button>
        )}
      </div>

      <div
        ref={boxRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="flex-1 min-h-0 bg-gray-900 rounded-lg overflow-hidden cursor-grab active:cursor-grabbing touch-none"
      >
        <RunningChart
          summaries={summaries} players={players} focus={focus}
          from={view.from} to={view.to} W={1400} H={620} hidden={hidden}
        />
      </div>

      <p className="text-[10px] text-gray-600">
        Scroll to zoom · drag to pan · <span className="text-gray-500">+</span> / <span className="text-gray-500">−</span> zoom ·
        <span className="text-gray-500"> 0</span> reset · <span className="text-gray-500">Esc</span> close
        {span > DOT_LIMIT && <span className="ml-1">· zoom in past {DOT_LIMIT} hands to see per-hand dots</span>}
      </p>
    </div>
  )
}

// ── Analyzed decision ─────────────────────────────────────────────────────────
// ReviewDecision (src/game/sessionAnalysisTypes.ts) is flat — board/hand
// directly, not nested under infoState, and drops the full `candidates`
// ranking (never read after display, only `topCandidates` is) — so the same
// shape works whether it was just computed here or reopened from Firestore.

function buildAnalyzed(
  decisions: DecisionPoint[],
  results: Map<string, ScoredPlacement[]>,
): ReviewDecision[] {
  return decisions.flatMap(d => {
    const candidates = results.get(d.id)
    if (!candidates || candidates.length === 0) return []
    const best = candidates[0]!
    const bestEV = best.ev
    const played = candidates.find(c => matchesActual(c.placement, d.actualPlacement))
    const playedEV = played?.ev ?? bestEV
    const topCandidates = candidates.slice(0, 8).map(c => ({ placement: c.placement, ev: c.ev }))
    const { infoState, ...rest } = d
    return [{
      ...rest,
      board: infoState.board,
      hand: infoState.hand,
      topCandidates,
      bestPlacement: best.placement,
      playedEV,
      bestEV,
      evLost: bestEV - playedEV,
    }]
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

function sessionCacheKey(decisions: DecisionPoint[], mode: BotPolicy, sims: number, rootTopK: number): string {
  if (decisions.length === 0) return ''
  return `session_ev_${CACHE_VERSION}:${mode}:${sims}:${rootTopK}:${decisions[0]!.gameId}:${decisions[decisions.length - 1]!.gameId}:${decisions.length}`
}

// Returns false on failure (e.g. quota exceeded) so the caller can warn the
// user — this used to silently swallow the error, which meant a large
// session's cache write could fail with zero indication, leaving no local
// safety net if the later Firestore save also failed for an unrelated reason.
function saveToCache(key: string, analyzed: ReviewDecision[]): boolean {
  const slim: CachedDecision[] = analyzed.map(d => ({
    id: d.id, gameId: d.gameId, gameTime: d.gameTime,
    username: d.username, uid: d.uid,
    segment: d.segment, street: d.street,
    hand: [...d.hand],
    actualPlacement: d.actualPlacement, bestPlacement: d.bestPlacement,
    playedEV: d.playedEV, bestEV: d.bestEV, evLost: d.evLost,
    topCandidates: d.topCandidates,
  }))
  const json = JSON.stringify(slim)
  try {
    localStorage.setItem(key, json)
    return true
  } catch {
    // Quota exceeded — clear other stale session_ev_ entries (older
    // sessions/superseded cache-key formats) to make room, then retry once.
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('session_ev_') && k !== key) localStorage.removeItem(k)
      }
      localStorage.setItem(key, json)
      return true
    } catch {
      return false
    }
  }
}

function loadFromCache(key: string): ReviewDecision[] | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const cached = JSON.parse(raw) as CachedDecision[]
    return cached.map(c => ({
      ...c,
      board: { top: [], middle: [], bottom: [] }, // enriched later from decisions
    }))
  } catch { return null }
}

// ── Hand decision row (inside hand detail panel) ──────────────────────────────

function HandDecisionRow({ dec, ev }: { dec: ReviewDecision; ev?: ReviewDecision }) {
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
          {dec.hand.map((c, i) => <CardChip key={i} c={c} />)}
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
            <BoardMini board={dec.board} />
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
  gameDecs: ReviewDecision[]
  analyzedMap: Map<string, ReviewDecision>
  players: string[]
}) {
  if (gameDecs.length === 0) {
    return (
      <div className="bg-gray-950 border-t border-gray-800 px-4 py-3">
        <p className="text-gray-600 text-xs italic">No play-by-play data for this hand.</p>
      </div>
    )
  }

  // Only the players who actually took part in THIS hand. The session's player
  // list is the union across every hand, so on an eleven-player session a
  // two-handed hand was rendering nine "No data" columns.
  const present = players
    .map((pname, pi) => ({
      pname, pi,
      decs: gameDecs.filter(d => d.username === pname).sort((a, b) => a.street - b.street),
    }))
    .filter(x => x.decs.length > 0)

  if (present.length === 0) {
    return (
      <div className="bg-gray-950 border-t border-gray-800 px-4 py-3">
        <p className="text-gray-600 text-xs italic">No play-by-play data for this hand.</p>
      </div>
    )
  }

  return (
    <div className="bg-gray-950 border-t border-gray-800 px-4 py-3">
      <div className={`grid gap-4 ${present.length === 1 ? 'grid-cols-1' : present.length === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'}`}>
        {present.map(({ pname, pi, decs }) => (
          <div key={pname}>
            <p className={`${pc(pi).text} text-[10px] uppercase tracking-wider font-medium mb-2`}>{pname}</p>
            {decs.map(d => <HandDecisionRow key={d.id} dec={d} ev={analyzedMap.get(d.id)} />)}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Blunder card ──────────────────────────────────────────────────────────────

function BlunderCard({ d, freshBoard, rank, gameNumber, onJumpToGame }: {
  d: ReviewDecision; freshBoard?: PartialBoard; rank: number
  gameNumber?: number; onJumpToGame?: () => void
}) {
  const [open, setOpen] = useState(false)
  const isOptimal = d.evLost < 0.05
  // Prefer the freshly-parsed board (decisionsById) over d.board, since d may
  // still carry the cache's empty placeholder board pre-enrichment (see the
  // cache-restore effect above).
  const board = freshBoard ?? d.board

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      <div
        className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-800/30 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <span className="text-gray-500 text-xs">#{rank}</span>
          {gameNumber != null && (
            <button
              onClick={e => { e.stopPropagation(); onJumpToGame?.() }}
              className="text-indigo-400 hover:text-indigo-300 hover:underline text-xs shrink-0"
              title="Jump to this game in the Game Log"
            >
              Game #{gameNumber}
            </button>
          )}
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
          <span className="flex gap-0.5">{d.hand.map((c, i) => <CardChip key={i} c={c} />)}</span>
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

// ── Bonus round card ───────────────────────────────────────────────────────────

function BonusCard({ d, result, rank, gameNumber, onJumpToGame }: {
  d: BonusDecisionPoint; result?: BonusAnalysisResult; rank: number
  gameNumber?: number; onJumpToGame?: () => void
}) {
  const [open, setOpen] = useState(false)
  const isOptimal = result != null && result.evLost < 0.05

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
      <div
        className="flex items-center justify-between p-3 cursor-pointer hover:bg-gray-800/30 transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex items-center gap-2">
          <span className="text-gray-500 text-xs">#{rank}</span>
          {gameNumber != null && (
            <button
              onClick={e => { e.stopPropagation(); onJumpToGame?.() }}
              className="text-indigo-400 hover:text-indigo-300 hover:underline text-xs shrink-0"
              title="Jump to this game in the Game Log"
            >
              Game #{gameNumber}
            </button>
          )}
          <span className="text-gray-300 text-xs font-medium">
            {new Date(d.gameTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {' · '}{13 + d.numDiscard} cards
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!result ? (
            <span className="text-gray-600 text-xs">—</span>
          ) : result.actualFoul ? (
            <span className="text-red-400 text-sm font-semibold">fouled</span>
          ) : (
            <span className={`text-sm font-semibold ${isOptimal ? 'text-emerald-400' : result.evLost > 5 ? 'text-red-400' : 'text-amber-400'}`}>
              {isOptimal ? 'optimal' : `-${result.evLost.toFixed(1)} roy`}
            </span>
          )}
          <span className="text-gray-600 text-[10px]">{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {open && (
        <div className="border-t border-gray-800 px-3 py-3 bg-gray-950/60 space-y-3">
          <div>
            <p className="text-gray-600 text-[10px] uppercase mb-1">Dealt</p>
            <span className="inline-flex flex-wrap gap-0.5">
              {d.cards.map((c, i) => <CardChip key={i} c={c} />)}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-gray-600 text-[10px] uppercase mb-1">Played</p>
              <BoardMini board={d.actualBoard} />
            </div>
            {result && (
              <div>
                <p className="text-emerald-600 text-[10px] uppercase mb-1">Best</p>
                <BoardMini board={result.bestBoard} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Summary stat card ─────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color, action }: {
  label: string; value: string | number; sub?: ReactNode; color?: string; action?: ReactNode
}) {
  return (
    <div className="bg-gray-900 rounded-lg p-3 flex flex-col gap-0.5">
      <div className="flex items-center justify-between">
        <span className="text-gray-500 text-[10px] uppercase tracking-wider">{label}</span>
        {action}
      </div>
      <span className={`text-lg font-bold ${color ?? 'text-gray-100'}`}>{value}</span>
      {sub && <span className="text-gray-500 text-xs">{sub}</span>}
    </div>
  )
}

// Win rate at one table size. Returned separately per size because heads-up
// and three-handed baselines differ (~50% vs ~33%), so a blended rate mostly
// reflects which tables someone sat at.
function sizeRate(t: { games: number; wins: number; ties: number } | undefined) {
  if (!t || t.games === 0) return null
  return { ...t, pct: Math.round(100 * t.wins / t.games) }
}

function SizeRateCell({ t }: { t: { games: number; wins: number; ties: number } | undefined }) {
  const r = sizeRate(t)
  if (!r) return <span className="text-gray-700">—</span>
  return (
    <span title={`${r.wins} wins, ${r.ties} ties in ${r.games} games`}>
      <span className="text-gray-300">{r.pct}%</span>
      <span className="ml-1 text-[10px] text-gray-600">{r.wins}/{r.games}</span>
    </span>
  )
}

// ── Compact player table ──────────────────────────────────────────────────────
//
// One row per player instead of one card each. Eleven cards in a four-column
// grid is three rows of boxes you have to read individually; this is scannable
// and sortable, and it keeps the per-player actions reachable.

type PlayerSort = 'total' | 'name' | 'busts' | 'ev' | 'games' | 'win2' | 'win3'

// Declared at module level: nesting it inside PlayerTable gave it a new
// component identity on every render.
function SortTh({ k, label, align = 'right', sort, setSort }: {
  k: PlayerSort; label: string; align?: 'left' | 'right'
  sort: PlayerSort; setSort: (s: PlayerSort) => void
}) {
  return (
    <th className={`py-1.5 px-2 font-normal ${align === 'left' ? 'text-left' : 'text-right'}`}>
      <button onClick={() => setSort(k)} className={`hover:text-gray-300 transition-colors ${sort === k ? 'text-gray-300' : ''}`}>
        {label}{sort === k ? ' ▾' : ''}
      </button>
    </th>
  )
}

function PlayerTable({ players, stats, evTotals, blunderCounts, focus, setFocus, onSimulate, onChallenge }: {
  players: string[]
  stats: {
    finalRuns: Record<string, number>; wins: Record<string, number>; ties: Record<string, number>
    busts: Record<string, number>; bustCost: Record<string, number>; gamesPlayed: Record<string, number>
    bySize: Record<string, Record<number, { games: number; wins: number; ties: number }>>
  }
  evTotals: Record<string, number> | null
  blunderCounts: Map<string, number>
  focus: string | null
  setFocus: (p: string | null) => void
  onSimulate: (p: string) => void
  onChallenge: (p: string) => void
}) {
  const [sort, setSort] = useState<PlayerSort>('total')
  const idx = useMemo(() => new Map(players.map((p, i) => [p, i])), [players])

  const rows = useMemo(() => {
    const r = [...players]
    r.sort((a, b) => {
      if (sort === 'name') return a.localeCompare(b)
      if (sort === 'busts') return (stats.busts[b] ?? 0) - (stats.busts[a] ?? 0)
      if (sort === 'games') return (stats.gamesPlayed[b] ?? 0) - (stats.gamesPlayed[a] ?? 0)
      if (sort === 'win2' || sort === 'win3') {
        const size = sort === 'win2' ? 2 : 3
        // Players with no games at that size sort last rather than as 0%.
        const rate = (p: string) => sizeRate(stats.bySize[p]?.[size])?.pct ?? -1
        return rate(b) - rate(a)
      }
      if (sort === 'ev') return (evTotals?.[b] ?? 0) - (evTotals?.[a] ?? 0)
      return (stats.finalRuns[b] ?? 0) - (stats.finalRuns[a] ?? 0)
    })
    return r
  }, [players, sort, stats, evTotals])

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <SortTh k="name" label="Player" align="left" sort={sort} setSort={setSort} />
            <SortTh k="games" label="Games" sort={sort} setSort={setSort} />
            <SortTh k="total" label="Total" sort={sort} setSort={setSort} />
            <SortTh k="win2" label="2p win" sort={sort} setSort={setSort} />
            <SortTh k="win3" label="3p win" sort={sort} setSort={setSort} />
            <SortTh k="busts" label="Fouls" sort={sort} setSort={setSort} />
            <th className="py-1.5 px-2 font-normal text-right">Foul cost</th>
            {evTotals && <SortTh k="ev" label="EV lost" sort={sort} setSort={setSort} />}
            {evTotals && <th className="py-1.5 px-2 font-normal text-right">Blunders</th>}
            <th className="py-1.5 px-2 font-normal text-right"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => {
            const pi = idx.get(p) ?? 0
            const run = stats.finalRuns[p] ?? 0
            const games = stats.gamesPlayed[p] ?? 0
            const lost = evTotals?.[p] ?? 0
            const isFocus = focus === p
            return (
              <tr key={p}
                className={`border-b border-gray-800/40 transition-colors ${isFocus ? 'bg-indigo-950/30' : 'hover:bg-gray-800/40'}`}>
                <td className="py-1.5 px-2">
                  <button onClick={() => setFocus(isFocus ? null : p)}
                    title={isFocus ? 'Clear focus' : `Focus on ${p}`}
                    className={`${pc(pi).text} font-medium hover:underline`}>
                    {p}
                  </button>
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-gray-300 whitespace-nowrap">
                  {games}
                  {(() => {
                    const per = stats.bySize[p] ?? {}
                    const parts = Object.keys(per).map(Number).sort()
                      .filter(sz => (per[sz]?.games ?? 0) > 0)
                    if (parts.length < 2) return null
                    return <span className="ml-1 text-[10px] text-gray-600">({parts.map(sz => `${sz}p ${per[sz]!.games}`).join(' · ')})</span>
                  })()}
                </td>
                <td className={`py-1.5 px-2 text-right tabular-nums font-semibold ${run >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {run > 0 ? '+' : ''}{run}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">
                  <SizeRateCell t={stats.bySize[p]?.[2]} />
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap">
                  <SizeRateCell t={stats.bySize[p]?.[3]} />
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-gray-400">{stats.busts[p] ?? 0}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-red-400/80">
                  {(stats.bustCost[p] ?? 0) !== 0 ? stats.bustCost[p] : '—'}
                </td>
                {evTotals && (
                  <td className="py-1.5 px-2 text-right tabular-nums text-amber-400/90">
                    {lost !== 0 ? `−${lost.toFixed(1)}` : '—'}
                  </td>
                )}
                {evTotals && (
                  <td className="py-1.5 px-2 text-right tabular-nums text-gray-500">{blunderCounts.get(p) ?? 0}</td>
                )}
                <td className="py-1.5 px-2 text-right whitespace-nowrap">
                  <button onClick={() => onSimulate(p)} className="text-[10px] text-teal-400 hover:text-teal-300">Simulate</button>
                  <span className="text-gray-700 mx-1">·</span>
                  <button onClick={() => onChallenge(p)} className="text-[10px] text-amber-400 hover:text-amber-300">Challenge</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── Game log table ────────────────────────────────────────────────────────────

const LOG_PAGE_SIZE = 50

function GameLogTable({ summaries, players, analyzed, decisions, selectedGame, setSelectedGame, focus, page, setPage }: {
  summaries: GameSummary[]
  players: string[]
  analyzed: ReviewDecision[]
  decisions: ReviewDecision[]   // shell entries (board/hand, placeholder EV) for not-yet-analyzed rows
  selectedGame: string | null
  setSelectedGame: (gameId: string | null) => void
  focus: string | null
  page: number
  setPage: (n: number) => void
}) {
  const decisionsByGame = useMemo(() => {
    const map = new Map<string, ReviewDecision[]>()
    for (const d of decisions) {
      const arr = map.get(d.gameId) ?? []
      arr.push(d)
      map.set(d.gameId, arr)
    }
    return map
  }, [decisions])

  const analyzedMap = useMemo(() => {
    const map = new Map<string, ReviewDecision>()
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
  // Focusing a player narrows the log to their columns; eleven score columns
  // plus eleven EV columns is wider than any screen.
  const cols = focus && players.includes(focus) ? [focus] : players
  const colSpan = 3 + cols.length + (hasEV ? cols.length : 0)

  // Only one page of rows is mounted. All 1400 rows x 25 columns is ~35000
  // cells, which makes the whole page sluggish to scroll and to re-render.
  const pageCount = Math.max(1, Math.ceil(summaries.length / LOG_PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const from = current * LOG_PAGE_SIZE
  const pageRows = summaries.slice(from, from + LOG_PAGE_SIZE)

  return (
    <div className="space-y-2">
    {pageCount > 1 && (
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-600">
          hands {from + 1}–{Math.min(from + LOG_PAGE_SIZE, summaries.length)} of {summaries.length}
        </span>
        <div className="flex items-center gap-1">
          <button onClick={() => setPage(0)} disabled={current === 0}
            className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 disabled:opacity-30 hover:text-gray-200">«</button>
          <button onClick={() => setPage(current - 1)} disabled={current === 0}
            className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 disabled:opacity-30 hover:text-gray-200">‹</button>
          <span className="text-gray-500 tabular-nums px-1">{current + 1} / {pageCount}</span>
          <button onClick={() => setPage(current + 1)} disabled={current >= pageCount - 1}
            className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 disabled:opacity-30 hover:text-gray-200">›</button>
          <button onClick={() => setPage(pageCount - 1)} disabled={current >= pageCount - 1}
            className="px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 disabled:opacity-30 hover:text-gray-200">»</button>
        </div>
      </div>
    )}
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="text-gray-500 border-b border-gray-800">
            <th className="text-left py-1.5 px-2 font-normal">#</th>
            <th className="text-left py-1.5 px-2 font-normal">Time</th>
            {cols.map((p) => (
              <th key={p} className={`text-right py-1.5 px-2 font-normal ${pc(players.indexOf(p)).text}`}>{p}</th>
            ))}
            <th className="text-center py-1.5 px-2 font-normal">Bust</th>
            {hasEV && cols.map((p) => (
              <th key={`ev-${p}`} className={`text-right py-1.5 px-2 font-normal ${pc(players.indexOf(p)).dim}`}>EV lost</th>
            ))}
            <th className="w-5"></th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((s, pageIdx) => {
            const i = from + pageIdx
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
                  {cols.map((p, ci) => {
                    const pts = s.points[p] ?? 0
                    // Running total in parentheses when it fits: for the first
                    // of two columns, or whenever a single player is focused.
                    const showRun = cols.length === 1 || (ci === 0 && cols.length === 2)
                    return (
                      <td key={p} className={`py-1 px-2 text-right font-mono font-medium ${pts > 0 ? 'text-emerald-400' : pts < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                        {pts > 0 ? '+' : ''}{pts}
                        {showRun && (
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
                  {hasEV && cols.map((p) => (
                    <td key={`ev-${p}`} className={`py-1 px-2 text-right font-mono ${pc(players.indexOf(p)).dim}`}>
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
  const [analyzed, setAnalyzed] = useState<ReviewDecision[]>([])
  const [noModel, setNoModel] = useState(false)
  const [analysisMode, setAnalysisMode] = useState<'heuristic' | 'nn'>('heuristic')
  const [sims, setSims] = useState(DEFAULT_SIMS_FOR.nn)
  const [rootTopK, setRootTopK] = useState(DEFAULT_ROOT_TOP_K)
  const [selectedGame, setSelectedGame] = useState<string | null>(null)
  const [focusPlayer, setFocusPlayer] = useState<string | null>(null)
  const [logPage, setLogPage] = useState(0)
  const [chartFullscreen, setChartFullscreen] = useState(false)
  const [bonusAnalyzing, setBonusAnalyzing] = useState(false)
  const [bonusAnalyzeProgress, setBonusAnalyzeProgress] = useState<{ done: number; total: number } | null>(null)
  const [bonusAnalyzed, setBonusAnalyzed] = useState<Map<string, BonusAnalysisResult>>(new Map())
  // A saved analysis, reopened from Firestore — fully replaces the live-
  // parsed values below (no re-upload, no InfoState, no recompute) while set.
  const [savedView, setSavedView] = useState<{
    meta: SavedAnalysisMeta
    decisions: ReviewDecision[]
    bonusDecisions: PersistedBonusDecision[]
  } | null>(null)
  const [showSavedList, setShowSavedList] = useState(false)
  const [showStepper, setShowStepper] = useState(false)
  const [replayTarget, setReplayTarget] = useState<string | null>(null)
  const [huubChallengeTarget, setHuubChallengeTarget] = useState<string | null>(null)
  const [botSimTarget, setBotSimTarget] = useState<string | null>(null)
  const [showSentChallenges, setShowSentChallenges] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'naming' | 'saving' | 'saved' | 'error'>('idle')
  const [saveName, setSaveName] = useState('')
  // True if the local recompute-avoidance cache failed to write (e.g. quota
  // exceeded) — means there's no local safety net, so Save-to-Firestore is
  // the only way to avoid losing this analysis if you navigate away.
  const [cacheWarning, setCacheWarning] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const gameLogRef = useRef<HTMLDivElement>(null)
  const handleFile = useCallback((file: File) => {
    setError(''); setAnalyzed([]); setNoModel(false)
    setPickerKeys(new Set()); setActiveGroups(null); setAnalysisMode('heuristic'); setSims(DEFAULT_SIMS_FOR.heuristic); setSelectedGame(null)
    setBonusAnalyzed(new Map()); setBonusAnalyzeProgress(null); setSavedView(null); setCacheWarning(false)
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

  const loadSaved = useCallback(async (analysisId: string) => {
    const loaded = await loadSessionAnalysis(analysisId)
    if (!loaded) return
    setSavedView(loaded)
    setAnalyzed(loaded.decisions)
    setBonusAnalyzed(new Map(loaded.bonusDecisions.flatMap(bd => {
      if (bd.bestBoard === undefined) return []  // never EV-analyzed before saving
      return [[bd.id, {
        id: bd.id, bestBoard: bd.bestBoard, bestRoyalties: bd.bestRoyalties!,
        actualRoyalties: bd.actualRoyalties!, actualFoul: bd.actualFoul!, evLost: bd.evLost!,
      }] as const]
    })))
    setSelectedGame(null)
    setShowSavedList(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const parseResult = useMemo(() => {
    const empty = {
      decisions: [] as DecisionPoint[], bonusDecisions: [] as BonusDecisionPoint[],
      summaries: [] as GameSummary[], allPlayers: [] as string[], parseError: '',
    }
    if (!rawData || !activeGroups || activeGroups.length === 0) return empty
    try {
      const result = parseSessionGames(rawData.games, activeGroups)
      return { ...result, parseError: '' }
    } catch (e) {
      return { ...empty, parseError: e instanceof Error ? e.message : String(e) }
    }
  }, [rawData, activeGroups])
  const {
    decisions: liveDecisions, bonusDecisions: liveBonusDecisions,
    summaries: liveSummaries, allPlayers: liveAllPlayers, parseError: liveParseError,
  } = parseResult

  // Effective values used throughout the rest of this component — prefer a
  // reopened saved analysis over the live-parsed upload when one is open.
  // savedView.decisions/bonusDecisions dropped the raw InfoState (see
  // sessionAnalysisTypes.ts), so `decisions`/`bonusDecisions` below stay
  // empty in saved mode; that's fine, they're only used for live-mode-only
  // paths (worker requests, board-enrichment fallback) that don't apply once
  // everything is already fully analyzed.
  const summaries = savedView ? savedView.meta.summaries : liveSummaries
  const allPlayers = savedView ? savedView.meta.playerNames : liveAllPlayers
  const decisions = savedView ? [] : liveDecisions
  const bonusDecisions: BonusDecisionPoint[] = savedView
    ? savedView.bonusDecisions.map(bd => ({
        id: bd.id, gameId: bd.gameId, gameTime: bd.gameTime, username: bd.username, uid: bd.uid,
        numDiscard: bd.numDiscard, cards: bd.cards, actualBoard: bd.actualBoard,
      }))
    : liveBonusDecisions
  const parseError = savedView ? '' : liveParseError

  const groups = useMemo(() => rawData ? detectPlayerGroups(rawData.games) : [], [rawData])

  const decisionsById = useMemo(() => new Map(decisions.map(d => [d.id, d])), [decisions])

  // Shell ReviewDecisions for rows not yet analyzed (board/hand only; the EV
  // fields are placeholders never displayed — HandDecisionRow/BlunderCard only
  // read them via the separate `analyzed`/analyzedMap lookup once available).
  const decisionShells: ReviewDecision[] = useMemo(() => decisions.map(d => {
    const { infoState, ...rest } = d
    return {
      ...rest,
      board: infoState.board,
      hand: infoState.hand,
      bestPlacement: d.actualPlacement,
      playedEV: 0,
      bestEV: 0,
      evLost: 0,
      topCandidates: [],
    }
  }), [decisions])

  // Restore from cache, enriching boards from freshly-parsed decisions.
  // Depends on analysisMode/sims/rootTopK too (not just decisions) — a prior
  // version only re-checked once when decisions first populated, so changing
  // the mode/sims picker afterward (to match what a previous run actually
  // used) never re-triggered a fresh cache lookup with the corrected key.
  useEffect(() => {
    if (decisions.length === 0 || analyzed.length > 0) return
    const key = sessionCacheKey(decisions, analysisMode, sims, rootTopK)
    const cached = key ? loadFromCache(key) : null
    if (!cached || cached.length === 0) return
    const enriched = cached.map(a => {
      const src = decisionsById.get(a.id)
      if (!src) return a
      return { ...a, board: src.infoState.board }
    })
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnalyzed(enriched)
  }, [decisions, analysisMode, sims, rootTopK]) // eslint-disable-line react-hooks/exhaustive-deps

  // Per-player stats from summaries.
  // Win/bust calculations use s.playerNames (the actual players in each game)
  // so that multi-group selections (e.g. A vs B + A vs B vs C) work correctly.
  const stats = useMemo(() => {
    if ((!activeGroups && !savedView) || allPlayers.length === 0 || summaries.length === 0) return null
    return computeSessionStats(summaries, allPlayers)
  }, [activeGroups, allPlayers, summaries, savedView])

  const runAnalysis = useCallback(async () => {
    if (decisions.length === 0) return
    setAnalyzing(true); setNoModel(false); setAnalyzeProgress(null); setAnalyzed([]); setCacheWarning(false)
    try {
      const positions = decisions.map(d => ({ id: d.id, state: d.infoState }))
      const partialMap = new Map<string, import('../engine/mc').ScoredPlacement[]>()

      if (analysisMode === 'nn') {
        const loaded = await workerClient.loadModel(MODEL_URLS.v2)
        if (!loaded) { setNoModel(true); return }
      }

      const results = await workerClient.analyzePositions(
        positions,
        sims,
        (done, total, item) => {
          partialMap.set(item.id, item.candidates)
          setAnalyzeProgress({ done, total })
          setAnalyzed(buildAnalyzed(decisions, partialMap))
        },
        analysisMode,
        analysisMode === 'nn' ? rootTopK : undefined,
      )

      if (results.length > 0 && !results[0]!.hasModel) { setNoModel(true); return }

      // If the worker crashed mid-run, results is []. Use partialMap so we don't
      // wipe whatever was already computed and displayed.
      const sourceMap = results.length > 0
        ? new Map(results.map(r => [r.id, r.candidates]))
        : partialMap
      const built = buildAnalyzed(decisions, sourceMap)
      setAnalyzed(built)
      const key = sessionCacheKey(decisions, analysisMode, sims, rootTopK)
      if (key && results.length > 0) {
        const cached = saveToCache(key, built)
        setCacheWarning(!cached)
      }
    } finally {
      setAnalyzing(false); setAnalyzeProgress(null)
    }
  }, [decisions, analysisMode, sims, rootTopK])

  const runBonusAnalysis = useCallback(async () => {
    if (bonusDecisions.length === 0) return
    setBonusAnalyzing(true); setBonusAnalyzeProgress(null)
    try {
      const positions = bonusDecisions.map(d => ({
        id: d.id, cards: d.cards, numDiscard: d.numDiscard, actualBoard: d.actualBoard,
      }))
      const partialMap = new Map<string, BonusAnalysisResult>()
      const results = await workerClient.analyzeBonusPositions(positions, (done, total, item) => {
        partialMap.set(item.id, item)
        setBonusAnalyzeProgress({ done, total })
        setBonusAnalyzed(new Map(partialMap))
      })
      setBonusAnalyzed(new Map(results.map(r => [r.id, r])))
    } finally {
      setBonusAnalyzing(false); setBonusAnalyzeProgress(null)
    }
  }, [bonusDecisions])

  const suggestedSaveName = useCallback(() => {
    const dateStr = summaries.length > 0 ? new Date(summaries[0]!.gameTime).toLocaleDateString() : ''
    return `${allPlayers.join(' vs ')} — ${dateStr} (${summaries.length} games)`
  }, [summaries, allPlayers])

  const confirmSave = useCallback(async (name: string) => {
    setSaveState('saving')
    // Always persist the base fields (cards/actualBoard) regardless of whether
    // bonus analysis was run — the Save button is only gated on the main EV
    // analysis, so a session can be saved having never run "Analyze bonus" at
    // all. Dropping unanalyzed entries here used to silently lose every
    // bonus-round board for every player in that case.
    const persistedBonus: PersistedBonusDecision[] = bonusDecisions.map(bd => {
      const r = bonusAnalyzed.get(bd.id)
      return {
        id: bd.id, gameId: bd.gameId, gameTime: bd.gameTime, username: bd.username, uid: bd.uid,
        numDiscard: bd.numDiscard, cards: bd.cards, actualBoard: bd.actualBoard,
        ...(r ? {
          bestBoard: r.bestBoard, bestRoyalties: r.bestRoyalties,
          actualRoyalties: r.actualRoyalties, actualFoul: r.actualFoul, evLost: r.evLost,
        } : {}),
      }
    })
    const id = await saveSessionAnalysis({
      name: name.trim() || suggestedSaveName(),
      summaries, decisions: analyzed, bonusDecisions: persistedBonus,
      playerNames: allPlayers,
      analysisMode: savedView ? savedView.meta.analysisMode : analysisMode,
      sims: savedView ? savedView.meta.sims : sims,
      rootTopK: savedView ? savedView.meta.rootTopK : rootTopK,
    })
    setSaveState(id ? 'saved' : 'error')
    if (id) setTimeout(() => setSaveState('idle'), 3000)
  }, [summaries, analyzed, bonusDecisions, bonusAnalyzed, allPlayers, analysisMode, sims, rootTopK, savedView, suggestedSaveName])

  // Game log row number (1-based, matching the Game Log table's # column) so
  // mistakes can be cross-referenced to the full board state for all players.
  const gameNumberByGameId = useMemo(() => {
    const m = new Map<string, number>()
    summaries.forEach((s, i) => m.set(s.gameId, i + 1))
    return m
  }, [summaries])

  // The log is paginated, so jumping to a hand must turn to its page first —
  // otherwise "jump to game" from a blunder card scrolls to a log that does not
  // contain the hand it just selected.
  const gameIndexByGameId = useMemo(() => {
    const m = new Map<string, number>()
    summaries.forEach((s, i) => m.set(s.gameId, i))
    return m
  }, [summaries])

  const jumpToGame = useCallback((gameId: string) => {
    setSelectedGame(gameId)
    const idx = gameIndexByGameId.get(gameId)
    if (idx !== undefined) setLogPage(Math.floor(idx / LOG_PAGE_SIZE))
    gameLogRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [gameIndexByGameId])

  const blundersByPlayer = useMemo(() => {
    if ((!activeGroups && !savedView) || allPlayers.length === 0 || analyzed.length === 0) return new Map<string, ReviewDecision[]>()
    const map = new Map<string, ReviewDecision[]>()
    for (const p of allPlayers) {
      map.set(p, analyzed.filter(d => d.username === p).sort((a, b) => b.evLost - a.evLost))
    }
    return map
  }, [analyzed, allPlayers, activeGroups, savedView])

  const evTotalsByPlayer = useMemo(() => {
    if ((!activeGroups && !savedView) || allPlayers.length === 0 || analyzed.length === 0) return null
    const map: Record<string, number> = {}
    for (const d of analyzed) {
      map[d.username] = (map[d.username] ?? 0) + d.evLost
    }
    return map
  }, [analyzed, activeGroups, allPlayers, savedView])

  // EV lost split by the kind of decision it came from. A normal-round street,
  // a side-game street and a one-shot bonus board are different problems with
  // different per-decision scales, so a single blended average hides which one
  // is actually costing points.
  const evBreakdown = useMemo(() => {
    const blank = () => ({
      normal: { n: 0, total: 0 }, side: { n: 0, total: 0 }, bonus: { n: 0, total: 0 },
    })
    const map: Record<string, ReturnType<typeof blank>> = {}
    for (const p of allPlayers) map[p] = blank()
    for (const d of analyzed) {
      const e = map[d.username] ?? (map[d.username] = blank())
      const k = d.segment === 'bonus_play' ? 'side' : 'normal'
      e[k].n++
      e[k].total += d.evLost
    }
    for (const bd of bonusDecisions) {
      const res = bonusAnalyzed.get(bd.id)
      if (!res) continue
      const e = map[bd.username] ?? (map[bd.username] = blank())
      e.bonus.n++
      e.bonus.total += res.evLost
    }
    return map
  }, [analyzed, bonusDecisions, bonusAnalyzed, allPlayers])

  const bonusByPlayer = useMemo(() => {
    if ((!activeGroups && !savedView) || allPlayers.length === 0) return new Map<string, BonusDecisionPoint[]>()
    const map = new Map<string, BonusDecisionPoint[]>()
    for (const p of allPlayers) {
      const list = bonusDecisions.filter(d => d.username === p)
        .sort((a, b) => (bonusAnalyzed.get(b.id)?.evLost ?? 0) - (bonusAnalyzed.get(a.id)?.evLost ?? 0))
      map.set(p, list)
    }
    return map
  }, [bonusDecisions, allPlayers, activeGroups, bonusAnalyzed, savedView])

  // ── No file ───────────────────────────────────────────────────────────────

  if (!rawData && !savedView) {
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
        <button onClick={() => setShowSavedList(true)} className="text-indigo-400 hover:text-indigo-300 hover:underline text-xs">
          or open a saved analysis →
        </button>
        {showSavedList && (
          <SavedAnalysesList
            onOpen={loadSaved}
            onClose={() => setShowSavedList(false)}
          />
        )}
      </div>
    )
  }

  // ── Group selector ────────────────────────────────────────────────────────

  if (!activeGroups && !savedView) {
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
  // Narrows every per-player section to one person. The alternative on an
  // eleven-player session is eleven of everything on one page.
  const shown = focusPlayer && players.includes(focusPlayer) ? [focusPlayer] : players
  const big = players.length > MANY_PLAYERS

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-gray-100 font-semibold text-sm flex items-center gap-2 flex-wrap">
            {big ? (
              <>
                <span>{players.length} players</span>
                <select
                  value={focusPlayer ?? ''}
                  onChange={e => { setFocusPlayer(e.target.value || null); setLogPage(0) }}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-gray-200 font-normal"
                >
                  <option value="">All players</option>
                  {players.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                {focusPlayer && (
                  <button onClick={() => setFocusPlayer(null)} className="text-gray-500 hover:text-gray-300 text-xs font-normal">
                    clear
                  </button>
                )}
              </>
            ) : (
              players.map((p, i) => (
                <span key={p}>
                  {i > 0 && <span className="text-gray-500 mx-2">vs</span>}
                  <span className={pc(i).text}>{p}</span>
                </span>
              ))
            )}
          </h2>
          {summaries.length > 0 && (() => {
            const start = new Date(summaries[0]!.gameTime)
            const end = new Date(summaries.at(-1)!.gameTime)
            const fmtDate = (d: Date) => d.toLocaleDateString()
            const fmtTime = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            const sameDay = start.toDateString() === end.toDateString()
            const range = sameDay
              ? `${fmtDate(start)} · ${fmtTime(start)}–${fmtTime(end)}`
              : `${fmtDate(start)} ${fmtTime(start)} – ${fmtDate(end)} ${fmtTime(end)}`
            return (
              <p className="text-gray-500 text-xs mt-0.5">
                {range} · {summaries.length} hands
                {savedView && <span className="ml-2 text-indigo-400">· saved: {savedView.meta.name}</span>}
              </p>
            )
          })()}
          {cacheWarning && !savedView && (
            <p className="text-amber-400 text-xs mt-1">
              ⚠ Local backup failed (session too large for browser storage) — use "Save analysis" below now to avoid losing this if you navigate away.
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setShowSentChallenges(true)} className="text-gray-500 hover:text-gray-300 text-xs">
            Sent Huub challenges →
          </button>
          {analyzed.length > 0 && (
            <button onClick={() => setShowStepper(true)} className="text-emerald-400 hover:text-emerald-300 text-xs font-medium">
              Review decisions →
            </button>
          )}
          {analyzed.length > 0 && saveState === 'idle' && (
            <button onClick={() => { setSaveName(suggestedSaveName()); setSaveState('naming') }} className="text-indigo-400 hover:text-indigo-300 text-xs">
              Save analysis
            </button>
          )}
          {saveState === 'naming' && (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmSave(saveName); if (e.key === 'Escape') setSaveState('idle') }}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white w-56"
              />
              <button onClick={() => confirmSave(saveName)} className="px-2 py-1 rounded text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">
                Save
              </button>
              <button onClick={() => setSaveState('idle')} className="text-gray-500 hover:text-gray-300 text-xs">Cancel</button>
            </div>
          )}
          {saveState === 'saving' && <span className="text-gray-500 text-xs">Saving…</span>}
          {saveState === 'saved' && <span className="text-emerald-400 text-xs">Saved ✓</span>}
          {saveState === 'error' && (
            <span className="flex items-center gap-1.5 text-xs">
              <span className="text-red-400">Save failed</span>
              <button onClick={() => confirmSave(saveName)} className="text-indigo-400 hover:text-indigo-300">Retry</button>
            </span>
          )}
          {savedView ? (
            <button onClick={() => { setSavedView(null); setAnalyzed([]); setBonusAnalyzed(new Map()); setShowSavedList(true) }} className="text-gray-600 hover:text-gray-400 text-xs">
              ← Saved Analyses
            </button>
          ) : (
            <button onClick={() => setActiveGroups(null)} className="text-gray-600 hover:text-gray-400 text-xs">
              ← Change
            </button>
          )}
        </div>
      </div>

      {/* Summary stats — a table when there are many players, cards when few */}
      {stats && big && (
        <PlayerTable
          players={players} stats={stats} evTotals={evTotalsByPlayer}
          blunderCounts={new Map(players.map(p => [p, blundersByPlayer.get(p)?.length ?? 0]))}
          focus={focusPlayer} setFocus={p => { setFocusPlayer(p); setLogPage(0) }}
          onSimulate={setBotSimTarget} onChallenge={setHuubChallengeTarget}
        />
      )}
      {stats && !big && (
        <div className={`grid gap-2 grid-cols-2 ${players.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-4'}`}>
          {players.map((p, pi) => {
            const run = stats.finalRuns[p] ?? 0
            return (
              <StatCard key={p}
                label={`${p} total`}
                value={`${run > 0 ? '+' : ''}${run}`}
                sub={
                  <span className="flex flex-col gap-0.5">
                    <span>{stats.gamesPlayed[p] ?? 0} games · {stats.ties[p] ?? 0} ties · {stats.busts[p] ?? 0} busts</span>
                    <span className="text-[10px] text-gray-600">
                      {[2, 3].map(sz => {
                        const r = sizeRate(stats.bySize[p]?.[sz])
                        return r ? `${sz}p ${r.wins}/${r.games} (${r.pct}%)` : null
                      }).filter(Boolean).join(' · ') || 'no completed games'}
                    </span>
                  </span>
                }
                color={run >= 0 ? pc(pi).text : 'text-red-400'}
                action={
                  <span className="flex items-center gap-2">
                    <button
                      onClick={() => setBotSimTarget(p)}
                      className="text-[10px] text-teal-400 hover:text-teal-300 transition-colors"
                    >
                      Simulate →
                    </button>
                    <button
                      onClick={() => setHuubChallengeTarget(p)}
                      className="text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
                    >
                      Challenge →
                    </button>
                  </span>
                } />
            )
          })}
          {players.length === 2 && (
            <StatCard
              label="record"
              value={`${stats.wins[players[0]!] ?? 0}W / ${stats.wins[players[1]!] ?? 0}L`}
              sub={(stats.ties[players[0]!] ?? 0) > 0 ? `${stats.ties[players[0]!]} ties` : undefined}
              color={pc(0).text} />
          )}
        </div>
      )}

      {/* Bust context */}
      {stats && shown.some(p => (stats.busts[p] ?? 0) > 0) && (
        <div className="bg-gray-900/60 rounded-lg px-4 py-3 text-xs text-gray-400 space-y-1">
          {shown.map((p) => {
            const pi = players.indexOf(p)
            const n = stats.busts[p] ?? 0
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
        <Section
          title="Running totals"
          meta={`· ${summaries.length} hands`}
          defaultOpen={!big}
          right={
            <button onClick={() => setChartFullscreen(true)}
              className="text-indigo-400 hover:text-indigo-300 text-xs">
              Expand ⤢
            </button>
          }
        >
          <div className="bg-gray-900 rounded-lg p-3">
            <RunningChart summaries={summaries} players={players} focus={focusPlayer} />
            <p className="text-[10px] text-gray-600 mt-1">
              Solid dots = regular hands · filled dot = bust
              {focusPlayer && <span className="ml-1 text-gray-500">· other players dimmed</span>}
            </p>
          </div>
        </Section>
      )}

      {/* EV analysis */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-gray-300 text-sm font-medium">
            EV Analysis
            {analyzed.length > 0 && <span className="ml-2 text-gray-600 text-xs font-normal">· {analyzed.length} decisions</span>}
          </h3>
          {savedView ? (
            <span className="text-[10px] text-gray-500">
              Ground truth: {savedView.meta.analysisMode} @ {savedView.meta.sims} sims
              {savedView.meta.analysisMode === 'nn' && ` (top-${savedView.meta.rootTopK})`}
            </span>
          ) : (
          <div className="flex items-center gap-2">
            {/* Analysis mode selector */}
            <div className="flex rounded overflow-hidden border border-gray-700 text-[10px]">
              <button
                onClick={() => { setAnalysisMode('heuristic'); setSims(DEFAULT_SIMS_FOR.heuristic); setAnalyzed([]); setNoModel(false) }}
                className={`px-2 py-1 transition-colors ${analysisMode === 'heuristic' ? 'bg-emerald-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                MC
              </button>
              <button
                onClick={() => { setAnalysisMode('nn'); setSims(DEFAULT_SIMS_FOR.nn); setAnalyzed([]); setNoModel(false) }}
                title="Experimental value network. Its output is unbounded and it does not reliably recognise a fouled board, so EVs can be wildly off."
                className={`px-2 py-1 transition-colors ${analysisMode === 'nn' ? 'bg-indigo-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                NN + MCTS
              </button>
            </div>
            {/* Sims / root top-K controls */}
            <label className="flex items-center gap-1 text-[10px] text-gray-500">
              <span>Sims</span>
              <input
                type="number"
                className="w-16 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-[10px]"
                value={sims}
                min={MIN_SIMS}
                max={MAX_SIMS}
                step={50}
                onChange={e => setSims(clampSims(Number(e.target.value)))}
              />
            </label>
            {analysisMode === 'nn' && (
              <label className="flex items-center gap-1 text-[10px] text-gray-500">
                <span>Root top-K</span>
                <input
                  type="number"
                  className="w-14 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-[10px]"
                  value={rootTopK}
                  min={1}
                  max={500}
                  onChange={e => setRootTopK(Math.max(1, Math.min(500, Number(e.target.value))))}
                />
              </label>
            )}
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
          )}
        </div>

        {!savedView && analysisMode === 'nn' && (
          <p className="text-amber-500/80 text-[11px]">
            NN + MCTS is experimental: its value net is unbounded and does not reliably detect a
            fouled board, so individual EVs can be far outside the range a hand can actually score.
            MC is the reference.
          </p>
        )}

        {!savedView && noModel && (
          <div className="flex items-center justify-between bg-amber-900/20 rounded px-3 py-2">
            <p className="text-amber-400 text-xs">Model unavailable at /models/policy.bin — training may still be in progress.</p>
            <button onClick={runAnalysis} className="ml-3 shrink-0 px-2 py-1 text-xs rounded bg-amber-800/40 hover:bg-amber-700/40 text-amber-300 transition-colors">
              Retry
            </button>
          </div>
        )}

        {evTotalsByPlayer && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-1.5 px-2 font-normal">Player</th>
                  <th className="text-right py-1.5 px-2 font-normal">EV lost</th>
                  <th className="text-right py-1.5 px-2 font-normal">Normal <span className="text-gray-700">avg/dec</span></th>
                  <th className="text-right py-1.5 px-2 font-normal">Side game <span className="text-gray-700">avg/dec</span></th>
                  <th className="text-right py-1.5 px-2 font-normal">Bonus <span className="text-gray-700">avg/board</span></th>
                  <th className="py-1.5 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const pi = players.indexOf(p)
                  const b = evBreakdown[p]
                  const total = evTotalsByPlayer[p] ?? 0
                  const Cell = ({ part }: { part?: { n: number; total: number } }) => {
                    if (!part || part.n === 0) return <span className="text-gray-700">—</span>
                    return (
                      <span title={`${part.total.toFixed(1)} lost over ${part.n}`}>
                        <span className="text-amber-400/90">−{(part.total / part.n).toFixed(2)}</span>
                        <span className="ml-1 text-[10px] text-gray-600">n={part.n}</span>
                      </span>
                    )
                  }
                  return (
                    <tr key={p} className="border-b border-gray-800/40">
                      <td className={`py-1.5 px-2 ${pc(pi).text} font-medium`}>{p}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-red-400">
                        {total !== 0 ? `−${total.toFixed(1)}` : '—'}
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap"><Cell part={b?.normal} /></td>
                      <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap"><Cell part={b?.side} /></td>
                      <td className="py-1.5 px-2 text-right tabular-nums whitespace-nowrap"><Cell part={b?.bonus} /></td>
                      <td className="py-1.5 px-2 text-right">
                        <button onClick={() => setReplayTarget(p)} className="text-[10px] text-indigo-400 hover:text-indigo-300">
                          Replay →
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {Object.values(evBreakdown).every(b => b.bonus.n === 0) && bonusDecisions.length > 0 && (
              <p className="text-[10px] text-gray-600 mt-1">Bonus column fills in after running Bonus Analysis below.</p>
            )}
          </div>
        )}

        {analyzed.length > 0 && (
          <Section title="Top mistakes" meta={`· worst 5 per player`} defaultOpen={false}>
            <div className="space-y-2">
              {shown.map((p) => {
                const pi = players.indexOf(p)
                const blist = blundersByPlayer.get(p) ?? []
                const normalList = blist.filter(d => d.segment === 'normal_play')
                const sideList = blist.filter(d => d.segment === 'bonus_play')
                if (normalList.length === 0 && sideList.length === 0) return null
                const worst = normalList[0]?.evLost ?? 0
                return (
                  <Section
                    key={p}
                    title={<span><span className={pc(pi).text}>{p}</span> — top mistakes</span>}
                    meta={worst > 0 ? `· worst −${worst.toFixed(1)}` : undefined}
                    defaultOpen={shown.length === 1}
                  >
                    <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                      {normalList.slice(0, 5).map((d, i) => (
                        <BlunderCard
                          key={d.id} d={d} freshBoard={decisionsById.get(d.id)?.infoState.board} rank={i + 1}
                          gameNumber={gameNumberByGameId.get(d.gameId)}
                          onJumpToGame={() => jumpToGame(d.gameId)}
                        />
                      ))}
                    </div>
                    {sideList.length > 0 && (
                      <div className="mt-2 space-y-2">
                        <p className="text-purple-400 text-[10px] font-medium uppercase tracking-wider">side-game mistakes</p>
                        <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                          {sideList.slice(0, 5).map((d, i) => (
                            <BlunderCard
                              key={d.id} d={d} freshBoard={decisionsById.get(d.id)?.infoState.board} rank={i + 1}
                              gameNumber={gameNumberByGameId.get(d.gameId)}
                              onJumpToGame={() => jumpToGame(d.gameId)}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </Section>
                )
              })}
            </div>
          </Section>
        )}
      </div>

      {parseError && (
        <p className="text-red-400 text-xs bg-red-900/20 rounded px-3 py-2">Parse error: {parseError}</p>
      )}

      {/* Bonus rounds — the one-shot 13/14/15-card board, solved exhaustively */}
      {bonusDecisions.length > 0 && (
        <Section
          title="Bonus Rounds"
          meta={`· ${bonusDecisions.length} boards`}
          defaultOpen={false}
          right={
            <div className="flex items-center gap-2">
              {bonusAnalyzing && bonusAnalyzeProgress && (
                <span className="text-xs text-gray-400">
                  {bonusAnalyzeProgress.done}/{bonusAnalyzeProgress.total} boards…
                </span>
              )}
              {!bonusAnalyzing && bonusAnalyzed.size === 0 && (
                <button onClick={runBonusAnalysis}
                  className="px-3 py-1 rounded text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors">
                  Run Bonus Analysis ({bonusDecisions.length})
                </button>
              )}
              {!bonusAnalyzing && bonusAnalyzed.size > 0 && (
                <button onClick={runBonusAnalysis}
                  className="px-3 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">
                  Rerun
                </button>
              )}
            </div>
          }
        >
          {/* Each player's boards fold independently — one player can easily
              have dozens, and a dozen players' worth of cards is most of the
              page otherwise. */}
          <div className="space-y-2">
            {shown.map((p) => {
              const pi = players.indexOf(p)
              const blist = bonusByPlayer.get(p) ?? []
              if (blist.length === 0) return null
              return (
                <Section
                  key={p}
                  title={<span><span className={pc(pi).text}>{p}</span> — bonus boards</span>}
                  meta={`· ${blist.length}`}
                  defaultOpen={shown.length === 1 && blist.length <= 12}
                >
                  <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                    {blist.map((d, i) => (
                      <BonusCard
                        key={d.id} d={d} result={bonusAnalyzed.get(d.id)} rank={i + 1}
                        gameNumber={gameNumberByGameId.get(d.gameId)}
                        onJumpToGame={() => jumpToGame(d.gameId)}
                      />
                    ))}
                  </div>
                </Section>
              )
            })}
          </div>
        </Section>
      )}

      {/* Luck analysis */}
      {summaries.length > 0 && (
        <LuckAnalysisSection
          players={players}
          summaries={summaries}
          streetDecisions={savedView ? analyzed : decisionShells}
          bonusBoardDecisions={bonusDecisions}
        />
      )}

      {/* Game log */}
      {summaries.length > 0 && (
        <div ref={gameLogRef}>
          <Section
            title="Game Log"
            meta={`· ${summaries.length} hands · click a row for play-by-play`}
            defaultOpen={!big}
          >
            <GameLogTable
              summaries={summaries} players={players} analyzed={analyzed} decisions={savedView ? analyzed : decisionShells}
              selectedGame={selectedGame} setSelectedGame={setSelectedGame}
              focus={focusPlayer} page={logPage} setPage={setLogPage}
            />
          </Section>
        </div>
      )}

      {showStepper && (
        <DecisionStepper decisions={analyzed} players={players} onClose={() => setShowStepper(false)} />
      )}

      {replayTarget && (
        <ReplaySession
          username={replayTarget}
          summaries={summaries}
          streetDecisions={savedView ? analyzed : decisionShells}
          bonusBoardDecisions={bonusDecisions}
          onClose={() => setReplayTarget(null)}
        />
      )}

      {botSimTarget && (
        <BotSimulationOverlay
          username={botSimTarget}
          summaries={summaries}
          streetDecisions={savedView ? analyzed : decisionShells}
          bonusBoardDecisions={bonusDecisions}
          onClose={() => setBotSimTarget(null)}
        />
      )}

      {huubChallengeTarget && (
        <ChallengeHuubOverlay
          username={huubChallengeTarget}
          summaries={summaries}
          streetDecisions={savedView ? analyzed : decisionShells}
          bonusBoardDecisions={bonusDecisions}
          onClose={() => setHuubChallengeTarget(null)}
        />
      )}

      {showSentChallenges && (
        <SentChallengesList onClose={() => setShowSentChallenges(false)} />
      )}

      {chartFullscreen && (
        <ChartOverlay
          summaries={summaries} players={players} focus={focusPlayer}
          onClose={() => setChartFullscreen(false)}
        />
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
