import { useState, useRef, useCallback, useEffect } from 'react'
import type { AppPage } from '../App'
import { arenaWorkerClient, ROYALTY_MODEL_URL } from '../worker/client'
import type { MatchHandRecord, BotKind, BotSpec } from '../worker/client'
import { BoardView } from '../components/BoardView'
import type { PartialBoard } from '../engine/types'

interface ArenaPageProps {
  onNavigate: (p: AppPage) => void
}

// ── Config defaults ──────────────────────────────────────────────────────────

const DEFAULT_HANDS      = 100
const DEFAULT_SIMS       = 500
const DEFAULT_SEED       = 42
const DEFAULT_ROOT_TOP_K = 35

const BOT_KINDS: BotKind[] = ['nn-mcts', 'royalty-mcts', 'royalty-nn', 'heuristic']

const BOT_KIND_LABELS: Record<BotKind, string> = {
  'nn-mcts': 'NN+MCTS',
  'royalty-mcts': 'Royalty MCTS',
  'royalty-nn': 'Royalty NN',
  'heuristic': 'Heuristic MC',
}

const BOT_KIND_SHORT: Record<BotKind, string> = {
  'nn-mcts': 'NN',
  'royalty-mcts': 'RoyM',
  'royalty-nn': 'RoyNN',
  'heuristic': 'Heur',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Middle / bottom: category index → [label, royalty mid, royalty bot]
const MID_ROWS: [string, number, number][] = [
  ['High card',     0,  0],
  ['One pair',      0,  0],
  ['Two pair',      0,  0],
  ['Trips',         2,  0],
  ['Straight',      4,  2],
  ['Flush',         8,  4],
  ['Full house',   12,  6],
  ['Quads',        20, 10],
  ['Straight flush',30, 15],
  ['Royal flush',  50, 25],
]

// Top row royalty value → label (distinguishes pair rank / trips rank)
const TOP_PAIR_LABELS: Record<number, string> = {
  1: '66', 2: '77', 3: '88', 4: '99', 5: 'TT', 6: 'JJ', 7: 'QQ', 8: 'KK', 9: 'AA',
}
const TOP_TRIPS_LABELS: Record<number, string> = {
  10: '222', 11: '333', 12: '444', 13: '555', 14: '666',
  15: '777', 16: '888', 17: '999', 18: 'TTT', 19: 'JJJ',
  20: 'QQQ', 21: 'KKK', 22: 'AAA',
}

function sign(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

function pct(n: number, d: number): string {
  if (d === 0) return '—'
  return `${((n / d) * 100).toFixed(1)}%`
}

// ── Config panel ─────────────────────────────────────────────────────────────

interface BotConfig {
  kind: BotKind
  sims: number
  rootTopK: number
}

interface Config {
  hands: number
  seed: number
  botA: BotConfig
  botB: BotConfig
}

function BotConfigEditor({ label, cfg, onChange }: {
  label: string
  cfg: BotConfig
  onChange: (c: BotConfig) => void
}) {
  return (
    <div className="flex flex-col gap-1 bg-gray-900 border border-gray-800 rounded p-2">
      <span className="text-xs text-gray-400 font-medium">{label}</span>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Bot</span>
          <select
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-sm"
            value={cfg.kind}
            onChange={e => onChange({ ...cfg, kind: e.target.value as BotKind })}
          >
            {BOT_KINDS.map(k => <option key={k} value={k}>{BOT_KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Sims</span>
          <input
            type="number"
            className="w-24 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-sm"
            value={cfg.sims}
            min={1}
            max={10_000}
            onChange={e => onChange({ ...cfg, sims: Math.max(1, Math.min(10_000, Number(e.target.value))) })}
          />
        </label>
        {cfg.kind === 'nn-mcts' && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-500">Root top-K</span>
            <input
              type="number"
              className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-sm"
              value={cfg.rootTopK}
              min={1}
              max={500}
              onChange={e => onChange({ ...cfg, rootTopK: Math.max(1, Math.min(500, Number(e.target.value))) })}
            />
          </label>
        )}
      </div>
    </div>
  )
}

function ConfigPanel({ cfg, onChange, onStart }: {
  cfg: Config
  onChange: (c: Config) => void
  onStart: () => void
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-400">Hands</span>
          <input
            type="number"
            className="w-32 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-sm"
            value={cfg.hands}
            min={1}
            max={100_000}
            onChange={e => onChange({ ...cfg, hands: Math.max(1, Math.min(100_000, Number(e.target.value))) })}
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-400">Seed</span>
          <div className="flex gap-1">
            <input
              type="number"
              className="w-28 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-sm"
              value={cfg.seed}
              min={0}
              max={2_147_483_647}
              onChange={e => onChange({ ...cfg, seed: Math.max(0, Math.min(2_147_483_647, Number(e.target.value))) })}
            />
            <button
              onClick={() => onChange({ ...cfg, seed: Math.floor(Math.random() * 2_147_483_647) })}
              className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded text-sm"
              title="Random seed"
            >
              ⟳
            </button>
          </div>
        </div>
        <button
          onClick={onStart}
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium"
        >
          Run
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <BotConfigEditor label="Bot A" cfg={cfg.botA} onChange={botA => onChange({ ...cfg, botA })} />
        <BotConfigEditor label="Bot B" cfg={cfg.botB} onChange={botB => onChange({ ...cfg, botB })} />
      </div>
    </div>
  )
}

// ── Stats ────────────────────────────────────────────────────────────────────

interface RunStats {
  hands: number
  totalA: number
  totalB: number
  bustsA: number
  bustsB: number
  bonusHands: number
  bonusTriggeredByA: number
  bonusTriggeredByB: number
  bonusTriggeredByBoth: number
  bonusFoulA: number
  bonusFoulB: number
  sideFoulA: number
  sideFoulB: number
  // Category distributions (index = HandCategory value, length 10)
  topCatA: number[]; topCatB: number[]
  midCatA: number[]; midCatB: number[]
  botCatA: number[]; botCatB: number[]
  // Top row royalty sub-dist: distinguishes pair rank (1-9) and trips rank (10-22)
  topRoyA: Record<number, number>; topRoyB: Record<number, number>
  royA: number
  royB: number
}

function emptyStats(): RunStats {
  return {
    hands: 0, totalA: 0, totalB: 0,
    bustsA: 0, bustsB: 0,
    bonusHands: 0, bonusTriggeredByA: 0, bonusTriggeredByB: 0, bonusTriggeredByBoth: 0,
    bonusFoulA: 0, bonusFoulB: 0, sideFoulA: 0, sideFoulB: 0,
    topCatA: new Array(10).fill(0), topCatB: new Array(10).fill(0),
    midCatA: new Array(10).fill(0), midCatB: new Array(10).fill(0),
    botCatA: new Array(10).fill(0), botCatB: new Array(10).fill(0),
    topRoyA: {}, topRoyB: {},
    royA: 0, royB: 0,
  }
}

function accumulate(s: RunStats, hands: MatchHandRecord[]): RunStats {
  const n: RunStats = {
    ...s,
    topCatA: [...s.topCatA], topCatB: [...s.topCatB],
    midCatA: [...s.midCatA], midCatB: [...s.midCatB],
    botCatA: [...s.botCatA], botCatB: [...s.botCatB],
    topRoyA: { ...s.topRoyA }, topRoyB: { ...s.topRoyB },
  }

  for (const h of hands) {
    n.hands++
    n.totalA += h.totalScore[0]
    n.totalB += h.totalScore[1]
    const [p0, p1] = h.players
    if (p0.foul) n.bustsA++
    if (p1.foul) n.bustsB++
    // Only count row categories for non-fouled boards; fouled boards get the Foul row instead.
    if (!p0.foul) {
      n.topCatA[p0.topCategory]++
      n.midCatA[p0.midCategory]++
      n.botCatA[p0.botCategory]++
      if (p0.topRoyalty > 0) n.topRoyA[p0.topRoyalty] = (n.topRoyA[p0.topRoyalty] ?? 0) + 1
    }
    if (!p1.foul) {
      n.topCatB[p1.topCategory]++
      n.midCatB[p1.midCategory]++
      n.botCatB[p1.botCategory]++
      if (p1.topRoyalty > 0) n.topRoyB[p1.topRoyalty] = (n.topRoyB[p1.topRoyalty] ?? 0) + 1
    }
    n.royA += p0.royaltiesEarned
    n.royB += p1.royaltiesEarned
    if (h.bonusTriggered) {
      n.bonusHands++
      if (h.bonusTriggerPlayer === 0 || h.bonusTriggerPlayer === 2) n.bonusTriggeredByA++
      if (h.bonusTriggerPlayer === 1 || h.bonusTriggerPlayer === 2) n.bonusTriggeredByB++
      if (h.bonusTriggerPlayer === 2) n.bonusTriggeredByBoth++
      if (p0.bonusFoul) n.bonusFoulA++
      if (p1.bonusFoul) n.bonusFoulB++
      if (p0.sideFoul) n.sideFoulA++
      if (p1.sideFoul) n.sideFoulB++
    }
  }
  return n
}

type CatRow = { label: string; royLabel: string; a: number; b: number }

function RowTable({ rows, total, labelA, labelB }: { rows: CatRow[]; total: number; labelA: string; labelB: string }) {
  return (
    <table className="text-xs w-full">
      <thead>
        <tr className="text-gray-600">
          <th className="text-left py-0.5">Hand</th>
          <th className="text-left py-0.5 pl-2">Roy</th>
          <th className="text-right py-0.5 text-blue-300">{labelA}</th>
          <th className="text-right py-0.5 text-amber-300">{labelB}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          if (r.a === 0 && r.b === 0) return null
          return (
            <tr key={i} className={`border-t border-gray-800 ${r.royLabel === '' ? 'text-gray-500' : 'text-gray-200'}`}>
              <td className="py-0.5 pr-1">{r.label}</td>
              <td className="py-0.5 pl-2 text-amber-500 tabular-nums">{r.royLabel}</td>
              <td className="py-0.5 text-right tabular-nums">{pct(r.a, total)}</td>
              <td className="py-0.5 text-right tabular-nums">{pct(r.b, total)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function buildTopRows(s: RunStats): CatRow[] {
  const rows: CatRow[] = []
  rows.push({ label: 'Foul', royLabel: '', a: s.bustsA, b: s.bustsB })
  // High card
  rows.push({ label: 'High card', royLabel: '', a: s.topCatA[0]!, b: s.topCatB[0]! })
  // Non-scoring pairs (22–55): total pairs minus scoring pairs (royalty 1–9)
  const scoringPairsA = Object.entries(s.topRoyA).filter(([k]) => +k <= 9).reduce((a, [, v]) => a + v, 0)
  const scoringPairsB = Object.entries(s.topRoyB).filter(([k]) => +k <= 9).reduce((a, [, v]) => a + v, 0)
  const lowPairA = s.topCatA[1]! - scoringPairsA
  const lowPairB = s.topCatB[1]! - scoringPairsB
  if (lowPairA > 0 || lowPairB > 0)
    rows.push({ label: 'Pair 2–5', royLabel: '', a: lowPairA, b: lowPairB })
  // Scoring pairs 66–AA (+1 to +9)
  for (let r = 1; r <= 9; r++) {
    const a = s.topRoyA[r] ?? 0
    const b = s.topRoyB[r] ?? 0
    if (a > 0 || b > 0)
      rows.push({ label: TOP_PAIR_LABELS[r]!, royLabel: `+${r}`, a, b })
  }
  // Trips by rank (+10 to +22)
  for (let r = 10; r <= 22; r++) {
    const a = s.topRoyA[r] ?? 0
    const b = s.topRoyB[r] ?? 0
    if (a > 0 || b > 0)
      rows.push({ label: TOP_TRIPS_LABELS[r]!, royLabel: `+${r}`, a, b })
  }
  return rows
}

function buildMidRows(s: RunStats): CatRow[] {
  return [
    { label: 'Foul', royLabel: '', a: s.bustsA, b: s.bustsB },
    ...MID_ROWS.map(([label, midRoy], i) => ({
      label,
      royLabel: midRoy > 0 ? `+${midRoy}` : '',
      a: s.midCatA[i]!,
      b: s.midCatB[i]!,
    })),
  ]
}

function buildBotRows(s: RunStats): CatRow[] {
  return [
    { label: 'Foul', royLabel: '', a: s.bustsA, b: s.bustsB },
    ...MID_ROWS.map(([label, , botRoy], i) => ({
      label,
      royLabel: botRoy > 0 ? `+${botRoy}` : '',
      a: s.botCatA[i]!,
      b: s.botCatB[i]!,
    })),
  ]
}

function StatsPanel({ s, labelA, labelB }: { s: RunStats; labelA: string; labelB: string }) {
  if (s.hands === 0) return null

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
      {/* Summary */}
      <div className="bg-gray-900 rounded p-4 space-y-1">
        <div className="text-gray-400 font-medium mb-2">Summary ({s.hands} hands)</div>
        <Row label="Total score"          a={sign(s.totalA)}   b={sign(s.totalB)} />
        <Row label="Avg / hand"           a={(s.totalA  / s.hands).toFixed(2)} b={(s.totalB / s.hands).toFixed(2)} />
        <Row label="Bust rate"            a={pct(s.bustsA, s.hands)} b={pct(s.bustsB, s.hands)} />
        <Row label="Avg royalties / hand" a={(s.royA / s.hands).toFixed(2)} b={(s.royB / s.hands).toFixed(2)} />
        <div className="pt-2 border-t border-gray-800 text-gray-400">
          Bonus games: {s.bonusHands} ({pct(s.bonusHands, s.hands)})
        </div>
        <Row label={`Triggered by ${labelA}`} a={String(s.bonusTriggeredByA)}    b="" />
        <Row label={`Triggered by ${labelB}`} a=""  b={String(s.bonusTriggeredByB)} />
        <Row label="Triggered by both"    a={String(s.bonusTriggeredByBoth)}  b="" />
        <Row label="Bonus foul"           a={pct(s.bonusFoulA, s.bonusTriggeredByA)} b={pct(s.bonusFoulB, s.bonusTriggeredByB)} />
        <Row label="Side foul"            a={pct(s.sideFoulA, s.bonusHands - s.bonusTriggeredByA)} b={pct(s.sideFoulB, s.bonusHands - s.bonusTriggeredByB)} />
      </div>

      {/* Per-row hand distributions */}
      <div className="space-y-3">
        {[
          { label: 'Top row', rows: buildTopRows(s) },
          { label: 'Middle row', rows: buildMidRows(s) },
          { label: 'Bottom row', rows: buildBotRows(s) },
        ].map(({ label, rows }) => (
          <div key={label} className="bg-gray-900 rounded p-3">
            <div className="text-gray-400 text-xs font-medium mb-1">{label}</div>
            <RowTable rows={rows} total={s.hands} labelA={labelA} labelB={labelB} />
          </div>
        ))}
      </div>
    </div>
  )
}

function Row({ label, a, b }: { label: string; a: string; b: string }) {
  return (
    <div className="flex justify-between text-gray-200">
      <span className="text-gray-400">{label}</span>
      <span className="text-xs flex gap-6">
        <span className="text-blue-300 w-14 text-right">{a}</span>
        <span className="text-amber-300 w-14 text-right">{b}</span>
      </span>
    </div>
  )
}

// ── Hand list ────────────────────────────────────────────────────────────────

type SortKey = 'idx' | 'aScore' | 'bScore' | 'totalA' | 'totalB'

function HandList({ hands, labelA, labelB, onSelect }: {
  hands: MatchHandRecord[]
  labelA: string
  labelB: string
  onSelect: (h: MatchHandRecord) => void
}) {
  const [sort, setSort] = useState<SortKey>('idx')
  const [asc, setAsc] = useState(false)

  function toggle(k: SortKey) {
    if (sort === k) setAsc(a => !a)
    else { setSort(k); setAsc(false) }
  }

  const sorted = [...hands].sort((a, b) => {
    const va = sort === 'idx' ? a.idx
      : sort === 'aScore' ? a.normalScore[0]
      : sort === 'bScore' ? a.normalScore[1]
      : sort === 'totalA' ? a.totalScore[0]
      : a.totalScore[1]
    const vb = sort === 'idx' ? b.idx
      : sort === 'aScore' ? b.normalScore[0]
      : sort === 'bScore' ? b.normalScore[1]
      : sort === 'totalA' ? b.totalScore[0]
      : b.totalScore[1]
    return asc ? va - vb : vb - va
  })

  function Th({ k, label }: { k: SortKey; label: string }) {
    return (
      <th
        className="cursor-pointer py-1 px-2 text-right text-gray-400 hover:text-gray-200 select-none"
        onClick={() => toggle(k)}
      >
        {label}{sort === k ? (asc ? ' ↑' : ' ↓') : ''}
      </th>
    )
  }

  return (
    <div className="overflow-auto max-h-[50vh]">
      <table className="w-full text-xs min-w-[480px]">
        <thead className="sticky top-0 bg-gray-950">
          <tr>
            <Th k="idx" label="#" />
            <th className="py-1 px-2 text-gray-400 text-left">Bonus</th>
            <th className="py-1 px-2 text-gray-400 text-left">Foul</th>
            <Th k="aScore" label={`${labelA} norm`} />
            <Th k="bScore" label={`${labelB} norm`} />
            <Th k="totalA" label={`${labelA} total`} />
            <Th k="totalB" label={`${labelB} total`} />
          </tr>
        </thead>
        <tbody>
          {sorted.map(h => (
            <tr
              key={h.idx}
              className="border-t border-gray-800 cursor-pointer hover:bg-gray-800"
              onClick={() => onSelect(h)}
            >
              <td className="py-0.5 px-2 text-right text-gray-400">{h.idx + 1}</td>
              <td className="py-0.5 px-2 text-gray-400">{h.bonusTriggered ? `P${h.bonusTriggerPlayer === 2 ? '0+1' : h.bonusTriggerPlayer}` : ''}</td>
              <td className="py-0.5 px-2 text-gray-400">
                {[h.players[0].foul && labelA, h.players[1].foul && labelB].filter(Boolean).join(' ')}
              </td>
              <td className={`py-0.5 px-2 text-right ${h.normalScore[0] >= 0 ? 'text-green-400' : 'text-red-400'}`}>{sign(h.normalScore[0])}</td>
              <td className={`py-0.5 px-2 text-right ${h.normalScore[1] >= 0 ? 'text-green-400' : 'text-red-400'}`}>{sign(h.normalScore[1])}</td>
              <td className={`py-0.5 px-2 text-right font-medium ${h.totalScore[0] >= 0 ? 'text-blue-300' : 'text-red-400'}`}>{sign(h.totalScore[0])}</td>
              <td className={`py-0.5 px-2 text-right font-medium ${h.totalScore[1] >= 0 ? 'text-amber-300' : 'text-red-400'}`}>{sign(h.totalScore[1])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Replay ───────────────────────────────────────────────────────────────────

function cardKey(c: { rank: number; suit: string }) { return `${c.rank}${c.suit}` }

function ReplayView({ hand, labelA, labelB, onClose }: {
  hand: MatchHandRecord
  labelA: string
  labelB: string
  onClose: () => void
}) {
  const [street, setStreet] = useState(0)
  const [section, setSection] = useState<'normal' | 'bonus' | 'side'>('normal')

  const [p0, p1] = hand.players
  const maxStreet = 4

  function boardAtStreet(streets: { boardAfter: PartialBoard }[], s: number): PartialBoard {
    if (s < 0 || streets.length === 0) return { top: [], middle: [], bottom: [] }
    return streets[Math.min(s, streets.length - 1)]!.boardAfter
  }

  const sections = ['normal'] as string[]
  if (hand.bonusTriggered) {
    if (p0.bonusBoard || p1.bonusBoard) sections.push('bonus')
    if (p0.sideBoard || p1.sideBoard) sections.push('side')
  }

  const showStreetNav = section === 'normal' || section === 'side'
  const sideStreets0 = p0.sideStreets ?? []
  const sideStreets1 = p1.sideStreets ?? []
  const maxSideStreet = Math.max(sideStreets0.length, sideStreets1.length) - 1

  const board0: PartialBoard = section === 'normal'
    ? boardAtStreet(p0.streets, street)
    : section === 'side'
    ? boardAtStreet(sideStreets0, street)
    : p0.bonusBoard ?? { top: [], middle: [], bottom: [] }

  const board1: PartialBoard = section === 'normal'
    ? boardAtStreet(p1.streets, street)
    : section === 'side'
    ? boardAtStreet(sideStreets1, street)
    : p1.bonusBoard ?? { top: [], middle: [], bottom: [] }

  const effectiveMax = section === 'side' ? maxSideStreet : maxStreet

  function changeSection(s: string) {
    setSection(s as typeof section)
    setStreet(0)
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-900 rounded-lg p-5 max-w-3xl w-full space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-white font-medium">
            Hand #{hand.idx + 1} — seed {hand.seed}
          </h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-sm">Close</button>
        </div>

        <div className="flex gap-2 text-sm">
          {sections.map(s => (
            <button
              key={s}
              onClick={() => changeSection(s)}
              className={`px-3 py-1 rounded ${section === s ? 'bg-blue-700 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        {showStreetNav && (
          <div className="flex items-center gap-3">
            <button
              disabled={street === 0}
              onClick={() => setStreet(s => s - 1)}
              className="px-2 py-0.5 bg-gray-800 rounded text-gray-300 disabled:opacity-40 text-sm"
            >←</button>
            <span className="text-gray-400 text-sm">Street {street + 1} / {effectiveMax + 1}</span>
            <button
              disabled={street >= effectiveMax}
              onClick={() => setStreet(s => s + 1)}
              className="px-2 py-0.5 bg-gray-800 rounded text-gray-300 disabled:opacity-40 text-sm"
            >→</button>
          </div>
        )}

        {/* Hand dealt this street */}
        {showStreetNav && (() => {
          const snaps0 = section === 'normal' ? p0.streets : sideStreets0
          const snaps1 = section === 'normal' ? p1.streets : sideStreets1
          const h0 = snaps0[street]?.hand ?? []
          const h1 = snaps1[street]?.hand ?? []
          return (
            <div className="grid grid-cols-2 gap-4 text-xs text-gray-400">
              <div>
                <div className="mb-1 text-blue-300 font-medium">{labelA} dealt</div>
                <div className="flex gap-1 flex-wrap">
                  {h0.map(c => <span key={cardKey(c)} className="bg-gray-800 px-1 rounded">{c.rank}{c.suit}</span>)}
                </div>
              </div>
              <div>
                <div className="mb-1 text-amber-300 font-medium">{labelB} dealt</div>
                <div className="flex gap-1 flex-wrap">
                  {h1.map(c => <span key={cardKey(c)} className="bg-gray-800 px-1 rounded">{c.rank}{c.suit}</span>)}
                </div>
              </div>
            </div>
          )
        })()}

        {/* Boards */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-blue-300 text-xs font-medium mb-1">
              {labelA} {p0.foul ? '(FOUL)' : `+${p0.royaltiesEarned} roy`}
            </div>
            <BoardView board={board0} showStatus={section === 'normal' && street === 4} />
          </div>
          <div>
            <div className="text-amber-300 text-xs font-medium mb-1">
              {labelB} {p1.foul ? '(FOUL)' : `+${p1.royaltiesEarned} roy`}
            </div>
            <BoardView board={board1} showStatus={section === 'normal' && street === 4} />
          </div>
        </div>

        {/* Scores */}
        {section === 'normal' && street === 4 && (
          <div className="text-sm text-gray-300 border-t border-gray-800 pt-3 space-y-1">
            <div>Normal: {labelA} {sign(hand.normalScore[0])} / {labelB} {sign(hand.normalScore[1])}</div>
            {hand.bonusTriggered && (
              <div>Bonus: {labelA} {sign(hand.bonusScore[0])} / {labelB} {sign(hand.bonusScore[1])}</div>
            )}
            <div className="font-medium">Total: {labelA} {sign(hand.totalScore[0])} / {labelB} {sign(hand.totalScore[1])}</div>
          </div>
        )}

        {section === 'bonus' && (
          <div className="text-xs text-gray-400 space-y-1">
            {p0.bonusCards && <div className="text-blue-300">{labelA} bonus cards: {p0.bonusCards.map(c => `${c.rank}${c.suit}`).join(' ')}</div>}
            {p1.bonusCards && <div className="text-amber-300">{labelB} bonus cards: {p1.bonusCards.map(c => `${c.rank}${c.suit}`).join(' ')}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function ArenaPage({ onNavigate }: ArenaPageProps) {
  const [cfg, setCfg] = useState<Config>({
    hands: DEFAULT_HANDS,
    seed: DEFAULT_SEED,
    botA: { kind: 'nn-mcts', sims: DEFAULT_SIMS, rootTopK: DEFAULT_ROOT_TOP_K },
    botB: { kind: 'royalty-mcts', sims: DEFAULT_SIMS, rootTopK: DEFAULT_ROOT_TOP_K },
  })
  const [royaltyNnStatus, setRoyaltyNnStatus] = useState<'idle' | 'loading' | 'loaded' | 'unavailable'>('idle')

  const needsRoyaltyNn = cfg.botA.kind === 'royalty-nn' || cfg.botB.kind === 'royalty-nn'

  // Load the royalty NN model when either seat selects that policy.
  useEffect(() => {
    if (!needsRoyaltyNn) return
    if (royaltyNnStatus !== 'idle') return
    setRoyaltyNnStatus('loading')
    arenaWorkerClient.loadRoyaltyModel(ROYALTY_MODEL_URL).then(ok => {
      setRoyaltyNnStatus(ok ? 'loaded' : 'unavailable')
    })
  }, [needsRoyaltyNn, royaltyNnStatus])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [total, setTotal] = useState(0)
  const [hands, setHands] = useState<MatchHandRecord[]>([])
  const [stats, setStats] = useState<RunStats>(emptyStats())
  const [selected, setSelected] = useState<MatchHandRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)
  // Authoritative accumulator — survives stop without depending on promise resolution.
  const handsRef = useRef<MatchHandRecord[]>([])

  const labelA = BOT_KIND_LABELS[cfg.botA.kind]
  const labelB = BOT_KIND_LABELS[cfg.botB.kind]
  const shortA = BOT_KIND_SHORT[cfg.botA.kind]
  const shortB = BOT_KIND_SHORT[cfg.botB.kind]

  const start = useCallback(() => {
    handsRef.current = []
    setError(null)
    setHands([])
    setStats(emptyStats())
    setProgress(0)
    setTotal(cfg.hands)
    setRunning(true)

    const botASpec: BotSpec = { kind: cfg.botA.kind, sims: cfg.botA.sims, rootTopK: cfg.botA.rootTopK }
    const botBSpec: BotSpec = { kind: cfg.botB.kind, sims: cfg.botB.sims, rootTopK: cfg.botB.rootTopK }

    const { promise, cancel } = arenaWorkerClient.runMatch(
      cfg.hands,
      cfg.seed,
      botASpec,
      botBSpec,
      (done, tot, batch) => {
        handsRef.current = [...handsRef.current, ...batch]
        setProgress(done)
        setTotal(tot)
        setHands(prev => [...prev, ...batch])
        setStats(s => accumulate(s, batch))
      },
    )
    cancelRef.current = cancel
    promise.then(allHands => {
      handsRef.current = allHands
      setHands(allHands)
      setRunning(false)
      cancelRef.current = null
    }).catch(err => {
      setError(String(err))
      // Don't clear hands/stats — show whatever completed before the error.
      setRunning(false)
    })
  }, [cfg])

  const stop = useCallback(() => {
    cancelRef.current?.()
    cancelRef.current = null
    // Snapshot accumulated hands/stats so they survive the worker restart.
    const snapshot = handsRef.current
    setHands(snapshot)
    setStats(accumulate(emptyStats(), snapshot))
    setRunning(false)
  }, [])

  const hasResults = hands.length > 0

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200 p-4 space-y-4">
      <div className="flex items-center gap-4">
        <button onClick={() => onNavigate('game')} className="text-gray-500 hover:text-gray-300 text-sm">← Back</button>
        <h1 className="text-lg font-semibold text-white">Arena — {labelA} vs {labelB}</h1>
        {needsRoyaltyNn && royaltyNnStatus === 'loading' && (
          <span className="text-xs text-gray-400">Loading royalty NN…</span>
        )}
        {needsRoyaltyNn && royaltyNnStatus === 'unavailable' && (
          <span className="text-xs text-red-400">Royalty NN unavailable — falling back to MCTS</span>
        )}
        {needsRoyaltyNn && royaltyNnStatus === 'loaded' && (
          <span className="text-xs text-green-400">Royalty NN loaded</span>
        )}
      </div>

      <div className="flex items-end gap-4 flex-wrap">
        <ConfigPanel cfg={cfg} onChange={setCfg} onStart={start} />
        {running && (
          <button onClick={stop} className="px-4 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded text-sm">
            Stop
          </button>
        )}
      </div>

      {error && <div className="text-red-400 text-sm">{error}</div>}

      {(running || hasResults) && (
        <>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-300 font-medium tabular-nums">
              {progress} / {total} hands
            </span>
            {running && (
              <div className="w-48 h-1.5 bg-gray-800 rounded">
                <div
                  className="h-1.5 bg-blue-500 rounded transition-all"
                  style={{ width: `${total > 0 ? (progress / total) * 100 : 0}%` }}
                />
              </div>
            )}
            {!running && hasResults && <span className="text-gray-500 text-xs">stopped</span>}
            {hasResults && (
              <>
                <span className="text-blue-300 tabular-nums ml-2">{shortA} avg {(stats.totalA / stats.hands).toFixed(2)}</span>
                <span className="text-amber-300 tabular-nums">{shortB} avg {(stats.totalB / stats.hands).toFixed(2)}</span>
              </>
            )}
          </div>

          {hasResults && <StatsPanel s={stats} labelA={shortA} labelB={shortB} />}

          {hasResults && (
            <div className="bg-gray-900 rounded p-3">
              <div className="text-gray-400 text-sm font-medium mb-2">
                Hands — click to replay
                <span className="text-xs text-gray-500 ml-2">(headers sortable)</span>
              </div>
              <HandList hands={hands} labelA={shortA} labelB={shortB} onSelect={setSelected} />
            </div>
          )}
        </>
      )}

      {selected && (
        <ReplayView hand={selected} labelA={labelA} labelB={labelB} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}
