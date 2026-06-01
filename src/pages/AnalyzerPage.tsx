import { useMemo, useRef, useState } from 'react'
import type { AppPage } from '../App'
import type { Card, PartialBoard, ScoredPlacement, InfoState, Board } from '../engine/index'
import { bestBonusBoard, royalties, isFoul } from '../engine/index'
import { CardPicker } from '../components/CardPicker'
import { BoardView } from '../components/BoardView'
import { workerClient } from '../worker/client'

interface AnalyzerPageProps {
  onNavigate: (p: AppPage) => void
}

type Tab = 'position' | 'bonus'

const RANK_LABELS: Record<number, string> = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
}
const SUIT_SYMBOLS: Record<string, string> = { s: '♠', c: '♣', h: '♥', d: '♦' }

function cardLabel(c: Card): string {
  return `${RANK_LABELS[c.rank] ?? c.rank}${SUIT_SYMBOLS[c.suit] ?? c.suit}`
}
function sameCard(a: Card, b: Card): boolean { return a.rank === b.rank && a.suit === b.suit }
function isRed(suit: string): boolean { return suit === 'h' || suit === 'd' }

export default function AnalyzerPage({ onNavigate }: AnalyzerPageProps) {
  const [tab, setTab] = useState<Tab>('position')

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-800/80">
        <button
          onClick={() => onNavigate('game')}
          className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
        >
          ← Back
        </button>
        <span className="text-sm font-semibold text-gray-200">Analyzer</span>
        <span className="w-12" />
      </header>

      <div className="max-w-4xl mx-auto p-4">
        <div className="flex gap-2 mb-4">
          {([['position', 'Position'], ['bonus', 'Bonus Solver']] as const).map(([id, lbl]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={[
                'px-4 py-1.5 rounded-md text-xs font-medium uppercase tracking-wider transition-colors',
                tab === id ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200',
              ].join(' ')}
            >
              {lbl}
            </button>
          ))}
        </div>

        {tab === 'position' && <PositionTab />}
        {tab === 'bonus' && <BonusTab />}
      </div>
    </div>
  )
}

// ── Position tab ────────────────────────────────────────────────────────────

type Slot = 'yourTop' | 'yourMid' | 'yourBot' | 'yourHand' | 'oppTop' | 'oppMid' | 'oppBot'

function maxFor(slot: Slot): number {
  if (slot === 'yourTop' || slot === 'oppTop') return 3
  if (slot === 'yourMid' || slot === 'oppMid') return 5
  if (slot === 'yourBot' || slot === 'oppBot') return 5
  // yourHand
  return 5
}

function PositionTab() {
  const [playerCount, setPlayerCount] = useState<2 | 3>(2)
  const [street, setStreet] = useState<number>(0)
  const [selected, setSelected] = useState<Card | null>(null)
  const [yourBoard, setYourBoard] = useState<PartialBoard>({ top: [], middle: [], bottom: [] })
  const [yourHand, setYourHand] = useState<Card[]>([])
  const [oppBoards, setOppBoards] = useState<PartialBoard[]>([
    { top: [], middle: [], bottom: [] },
  ])

  // Resize opp boards when playerCount changes
  function handlePlayerCount(n: 2 | 3) {
    setPlayerCount(n)
    setOppBoards(prev => {
      const next = [...prev]
      while (next.length < n - 1) next.push({ top: [], middle: [], bottom: [] })
      while (next.length > n - 1) next.pop()
      return next
    })
  }

  const used = useMemo<Card[]>(() => {
    const acc: Card[] = []
    acc.push(...yourBoard.top, ...yourBoard.middle, ...yourBoard.bottom, ...yourHand)
    for (const b of oppBoards) acc.push(...b.top, ...b.middle, ...b.bottom)
    return acc
  }, [yourBoard, yourHand, oppBoards])

  function place(slot: Slot, oppIdx?: number) {
    if (!selected) return
    const max = maxFor(slot)
    const card = selected

    const inUse = used.some(c => sameCard(c, card))
    if (inUse) return

    if (slot === 'yourHand') {
      if (yourHand.length >= max) return
      setYourHand(h => [...h, card])
    } else if (slot.startsWith('your')) {
      const row: 'top' | 'middle' | 'bottom' = slot === 'yourTop' ? 'top' : slot === 'yourMid' ? 'middle' : 'bottom'
      const cur = yourBoard[row].length
      if (cur >= max) return
      setYourBoard(b => ({ ...b, [row]: [...b[row], card] }))
    } else {
      const idx = oppIdx ?? 0
      const row: 'top' | 'middle' | 'bottom' = slot === 'oppTop' ? 'top' : slot === 'oppMid' ? 'middle' : 'bottom'
      setOppBoards(boards => boards.map((b, i) => {
        if (i !== idx) return b
        if (b[row].length >= max) return b
        return { ...b, [row]: [...b[row], card] }
      }))
    }
    setSelected(null)
  }

  function removeFromHand(idx: number) {
    setYourHand(h => h.filter((_, i) => i !== idx))
  }
  function removeFromBoard(row: 'top' | 'middle' | 'bottom', idx: number) {
    setYourBoard(b => ({ ...b, [row]: b[row].filter((_, i) => i !== idx) }))
  }
  function removeFromOpp(oppIdx: number, row: 'top' | 'middle' | 'bottom', idx: number) {
    setOppBoards(boards => boards.map((b, i) => i === oppIdx ? { ...b, [row]: b[row].filter((_, j) => j !== idx) } : b))
  }

  // ── Validation ───────────────────────────────────────────────────────────
  const validation = useMemo(() => {
    const errors: string[] = []
    // Duplicate cards
    const keys = used.map(c => `${c.rank}${c.suit}`)
    if (new Set(keys).size !== keys.length) errors.push('Duplicate cards detected.')

    // Row caps already enforced by place(). Validate hand size for street.
    const handReq = street === 0 ? 5 : 3
    if (yourHand.length !== 0 && yourHand.length !== handReq) {
      errors.push(`Hand for street ${street + 1} should be ${handReq} cards (or empty).`)
    }
    // Board sizes plausibility: each row within caps and totals reasonable
    if (yourBoard.top.length > 3) errors.push('Your top row exceeds 3.')
    if (yourBoard.middle.length > 5) errors.push('Your middle row exceeds 5.')
    if (yourBoard.bottom.length > 5) errors.push('Your bottom row exceeds 5.')
    for (let i = 0; i < oppBoards.length; i++) {
      const b = oppBoards[i]!
      if (b.top.length > 3) errors.push(`Opponent ${i + 1} top row exceeds 3.`)
      if (b.middle.length > 5) errors.push(`Opponent ${i + 1} middle row exceeds 5.`)
      if (b.bottom.length > 5) errors.push(`Opponent ${i + 1} bottom row exceeds 5.`)
    }

    return errors
  }, [used, street, yourBoard, yourHand, oppBoards])

  const [results, setResults] = useState<ScoredPlacement[]>([])
  const [computing, setComputing] = useState(false)
  const [doneRollouts, setDoneRollouts] = useState(0)
  const cancelRef = useRef<(() => void) | null>(null)

  function analyze() {
    if (yourHand.length === 0) return
    if (validation.length > 0) return
    if (cancelRef.current) cancelRef.current()

    const state: InfoState = {
      board: yourBoard,
      hand: yourHand,
      street,
      revealedOpponentBoards: oppBoards.slice(0, playerCount - 1),
    }
    const seed = (Date.now() & 0xffffffff) | 0
    setResults([])
    setComputing(true)
    setDoneRollouts(0)
    cancelRef.current = workerClient.streamMC(
      state,
      { totalRollouts: 1000, batchSize: 50 },
      seed,
      (r) => {
        const sorted = [...r].sort((a, b) => b.ev - a.ev)
        setResults(sorted)
        setDoneRollouts(r[0]?.n ?? 0)
      },
      (r) => {
        const sorted = [...r].sort((a, b) => b.ev - a.ev)
        setResults(sorted)
        setDoneRollouts(r[0]?.n ?? 1000)
        setComputing(false)
        cancelRef.current = null
      },
    )
  }

  const bestEV = results[0]?.ev ?? 0
  const canAnalyze = validation.length === 0 && yourHand.length > 0

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-gray-500">Players</span>
          <div className="flex gap-1">
            {([2, 3] as const).map(n => (
              <button
                key={n}
                onClick={() => handlePlayerCount(n)}
                className={`px-3 py-1 text-xs rounded ${playerCount === n ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400'}`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-gray-500">Street</span>
          <div className="flex gap-1">
            {[0, 1, 2, 3, 4].map(s => (
              <button
                key={s}
                onClick={() => setStreet(s)}
                className={`px-3 py-1 text-xs rounded ${street === s ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400'}`}
              >
                {s + 1}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Pick a card</p>
        <CardPicker used={used} selected={selected} onSelect={setSelected} />
        {selected && (
          <p className="text-xs text-amber-400 mt-2">
            {cardLabel(selected)} selected — click a target slot below
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Your board</p>
          <ClickableBoardView
            board={yourBoard}
            label="You"
            isHuman
            cardSelected={!!selected}
            onPlace={(row) => place(`your${row === 'top' ? 'Top' : row === 'middle' ? 'Mid' : 'Bot'}` as Slot)}
            onRemoveCard={(row, idx) => removeFromBoard(row, idx)}
          />
        </div>
        {oppBoards.slice(0, playerCount - 1).map((b, i) => (
          <div key={i}>
            <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Opponent {i + 1}</p>
            <ClickableBoardView
              board={b}
              label={`Opp ${i + 1}`}
              cardSelected={!!selected}
              onPlace={(row) => place(`opp${row === 'top' ? 'Top' : row === 'middle' ? 'Mid' : 'Bot'}` as Slot, i)}
              onRemoveCard={(row, idx) => removeFromOpp(i, row, idx)}
            />
          </div>
        ))}
      </div>

      <div
        onClick={() => place('yourHand')}
        className={[
          'rounded-xl border p-3',
          selected
            ? 'border-indigo-700 bg-indigo-950/40 cursor-pointer hover:bg-indigo-900/40'
            : 'border-gray-800 bg-gray-900/40',
        ].join(' ')}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-widest text-gray-500">Your hand (click to add)</span>
          <span className="text-[10px] text-gray-600 tabular-nums">{yourHand.length} / {street === 0 ? 5 : 3}</span>
        </div>
        {yourHand.length === 0 ? (
          <p className="text-xs text-gray-700 italic">Empty — select a card and click here</p>
        ) : (
          <div className="flex gap-1 flex-wrap" onClick={(e) => e.stopPropagation()}>
            {yourHand.map((c, i) => (
              <button
                key={i}
                onClick={() => removeFromHand(i)}
                className={`px-2 py-1 text-xs rounded bg-gray-800 hover:bg-red-900/50 border border-gray-700 ${isRed(c.suit) ? 'text-red-400' : 'text-slate-200'}`}
                title="Remove"
              >
                {cardLabel(c)}
              </button>
            ))}
          </div>
        )}
      </div>

      {validation.length > 0 && (
        <div className="rounded-xl border border-red-800/60 bg-red-950/30 p-3">
          {validation.map((e, i) => <p key={i} className="text-xs text-red-300">{e}</p>)}
        </div>
      )}

      <button
        onClick={analyze}
        disabled={!canAnalyze || computing}
        className={[
          'self-start px-6 py-2 rounded-lg text-sm font-medium transition-colors',
          !canAnalyze || computing
            ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
            : 'bg-emerald-600 hover:bg-emerald-500 text-white',
        ].join(' ')}
      >
        {computing ? `Analyzing… ${doneRollouts} rollouts` : 'Analyze'}
      </button>

      {results.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-widest text-gray-300 font-semibold">Ranked EV</span>
            <span className="text-[10px] text-gray-500 tabular-nums">
              {computing ? `Computing… ${doneRollouts}` : `${doneRollouts} rollouts`}
            </span>
          </div>
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
                  <th className="px-1.5 py-1 font-medium text-right">σ</th>
                  <th className="px-1.5 py-1 font-medium text-right">Gap</th>
                </tr>
              </thead>
              <tbody>
                {results.slice(0, 20).map((sp, i) => (
                  <tr key={i} className="border-b border-gray-800/40 last:border-0">
                    <td className="px-1.5 py-1 text-gray-500 tabular-nums">{i + 1}</td>
                    <td className="px-1.5 py-1">{sp.placement.topAdd.map(cardLabel).join(' ') || '—'}</td>
                    <td className="px-1.5 py-1">{sp.placement.middleAdd.map(cardLabel).join(' ') || '—'}</td>
                    <td className="px-1.5 py-1">{sp.placement.bottomAdd.map(cardLabel).join(' ') || '—'}</td>
                    <td className="px-1.5 py-1 text-gray-400">{sp.placement.discard ? cardLabel(sp.placement.discard) : '—'}</td>
                    <td className={`px-1.5 py-1 text-right tabular-nums font-semibold ${sp.ev > 0 ? 'text-green-400' : sp.ev < 0 ? 'text-red-400' : 'text-gray-300'}`}>
                      {sp.ev.toFixed(2)}
                    </td>
                    <td className="px-1.5 py-1 text-right tabular-nums text-gray-500">{Math.sqrt(sp.variance).toFixed(2)}</td>
                    <td className="px-1.5 py-1 text-right tabular-nums text-gray-500">
                      {i === 0 ? '—' : (sp.ev - bestEV).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

interface ClickableBoardViewProps {
  board: PartialBoard
  label: string
  isHuman?: boolean
  cardSelected: boolean
  onPlace: (row: 'top' | 'middle' | 'bottom') => void
  onRemoveCard: (row: 'top' | 'middle' | 'bottom', idx: number) => void
}

function ClickableBoardView({ board, label, isHuman, cardSelected, onPlace, onRemoveCard }: ClickableBoardViewProps) {
  return (
    <BoardView
      board={board}
      label={label}
      isHuman={isHuman}
      cardSelected={cardSelected}
      onRowClick={onPlace}
      onPendingRemove={onRemoveCard}
    />
  )
}

// ── Bonus solver tab ─────────────────────────────────────────────────────────

function BonusTab() {
  const [selected, setSelected] = useState<Card | null>(null)
  const [cards, setCards] = useState<Card[]>([])
  const [result, setResult] = useState<PartialBoard | null>(null)
  const [solving, setSolving] = useState(false)

  const numDiscard = cards.length === 13 ? 0 : cards.length === 14 ? 1 : cards.length === 15 ? 2 : -1

  function addSelected() {
    if (!selected) return
    if (cards.some(c => sameCard(c, selected))) return
    if (cards.length >= 15) return
    setCards(arr => [...arr, selected])
    setSelected(null)
  }

  function remove(idx: number) {
    setCards(arr => arr.filter((_, i) => i !== idx))
    setResult(null)
  }

  function solve() {
    if (numDiscard < 0) return
    setSolving(true)
    setResult(null)
    // Defer so UI updates before the heavy synchronous solve.
    setTimeout(() => {
      try {
        const board = bestBonusBoard(cards, numDiscard)
        setResult(board)
      } catch (e) {
        console.error('bestBonusBoard error', e)
      } finally {
        setSolving(false)
      }
    }, 0)
  }

  const discarded: Card[] = useMemo(() => {
    if (!result) return []
    const used = new Set([
      ...result.top, ...result.middle, ...result.bottom,
    ].map(c => `${c.rank}${c.suit}`))
    return cards.filter(c => !used.has(`${c.rank}${c.suit}`))
  }, [result, cards])

  const roy = result ? royalties(result as Board) : 0
  const isFouled = result && result.top.length === 3 && result.middle.length === 5 && result.bottom.length === 5
    ? isFoul(result as Board) : false

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Pick a card</p>
        <CardPicker used={cards} selected={selected} onSelect={setSelected} />
        <div className="mt-2 flex gap-2">
          <button
            onClick={addSelected}
            disabled={!selected || cards.length >= 15}
            className="text-xs px-3 py-1 rounded bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed text-white"
          >
            Add card
          </button>
          <button
            onClick={() => { setCards([]); setResult(null) }}
            className="text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-widest text-gray-500">Cards</span>
          <span className="text-[10px] text-gray-600 tabular-nums">
            {cards.length} cards · {numDiscard < 0 ? 'need 13–15' : `${numDiscard} discard${numDiscard === 1 ? '' : 's'}`}
          </span>
        </div>
        {cards.length === 0 ? (
          <p className="text-xs text-gray-700 italic">Empty — select cards above (13 / 14 / 15)</p>
        ) : (
          <div className="flex gap-1 flex-wrap">
            {cards.map((c, i) => (
              <button
                key={i}
                onClick={() => remove(i)}
                className={`px-2 py-1 text-xs rounded bg-gray-800 hover:bg-red-900/50 border border-gray-700 ${isRed(c.suit) ? 'text-red-400' : 'text-slate-200'}`}
                title="Remove"
              >
                {cardLabel(c)}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={solve}
        disabled={numDiscard < 0 || solving}
        className={[
          'self-start px-6 py-2 rounded-lg text-sm font-medium transition-colors',
          numDiscard < 0 || solving
            ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
            : 'bg-emerald-600 hover:bg-emerald-500 text-white',
        ].join(' ')}
      >
        {solving ? 'Solving…' : 'Solve'}
      </button>

      {result && (
        <div className="rounded-xl border border-amber-700/40 bg-amber-950/20 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-widest text-amber-300 font-semibold">Optimal board</span>
            <span className="text-[11px] tabular-nums text-amber-200">
              {isFouled ? 'No legal arrangement (best-effort)' : `+${roy} royalties`}
            </span>
          </div>
          <BoardView board={result} />
          {discarded.length > 0 && (
            <div className="mt-2 text-[11px] text-gray-400">
              Discarded: {discarded.map(cardLabel).join(' ')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
