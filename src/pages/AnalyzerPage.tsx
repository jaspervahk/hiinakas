import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppPage } from '../App'
import type { Card, PartialBoard, ScoredPlacement, InfoState, Board, Placement } from '../engine/index'
import { bestBonusBoard, royalties, isFoul } from '../engine/index'
import { CardPicker } from '../components/CardPicker'
import { BoardView } from '../components/BoardView'
import { workerClient } from '../worker/client'
import { analyzerBridge } from '../game/analyzerBridge'
import { SessionTab } from './SessionTab'

interface AnalyzerPageProps {
  onNavigate: (p: AppPage) => void
}

type Tab = 'position' | 'bonus' | 'session'

const RANK_LABELS: Record<number, string> = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T',
  9: '9', 8: '8', 7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
}
const SUIT_SYMBOLS: Record<string, string> = { s: '♠', c: '♣', h: '♥', d: '♦' }
const SUIT_COLORS: Record<string, string> = {
  s: 'text-slate-300', h: 'text-red-400', d: 'text-orange-400', c: 'text-emerald-400',
}

function suitColor(suit: string): string { return SUIT_COLORS[suit] ?? 'text-slate-300' }
function cardLabel(c: Card): string {
  return `${RANK_LABELS[c.rank] ?? c.rank}${SUIT_SYMBOLS[c.suit] ?? c.suit}`
}
function sameCard(a: Card, b: Card): boolean { return a.rank === b.rank && a.suit === b.suit }

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
          {([['position', 'Position'], ['bonus', 'Bonus Solver'], ['session', 'Session']] as const).map(([id, lbl]) => (
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

        {tab === 'position' && <PositionTab onNavigate={onNavigate} />}
        {tab === 'bonus' && <BonusTab />}
        {tab === 'session' && <SessionTab />}
      </div>
    </div>
  )
}

// ── Slot system ──────────────────────────────────────────────────────────────
// SlotKey: 'you-hand' | 'you-top' | 'you-mid' | 'you-bot' | 'opp-N-top' | 'opp-N-mid' | 'opp-N-bot'

type RowKey = 'top' | 'middle' | 'bottom'
type SlotKey = string

function slotMax(key: SlotKey, street: number): number {
  if (key.endsWith('-top')) return 3
  if (key === 'you-hand') return street === 0 ? 5 : 3
  return 5
}

function slotCards(key: SlotKey, board: PartialBoard, hand: Card[], oppBoards: PartialBoard[]): Card[] {
  if (key === 'you-top') return [...board.top]
  if (key === 'you-mid') return [...board.middle]
  if (key === 'you-bot') return [...board.bottom]
  if (key === 'you-hand') return hand
  const [, idxStr, row] = key.split('-') as [string, string, string]
  const b = oppBoards[Number(idxStr)] ?? { top: [], middle: [], bottom: [] }
  return row === 'top' ? [...b.top] : row === 'mid' ? [...b.middle] : [...b.bottom]
}

function slotLabel(key: SlotKey, playerCount: number): string {
  if (key === 'you-hand') return 'Hand'
  if (key === 'you-top') return 'Your Top'
  if (key === 'you-mid') return 'Your Mid'
  if (key === 'you-bot') return 'Your Bot'
  const [, idxStr, row] = key.split('-') as [string, string, string]
  const rowLabel = row === 'top' ? 'Top' : row === 'mid' ? 'Mid' : 'Bot'
  return playerCount === 2 ? `Opp ${rowLabel}` : `Opp ${Number(idxStr) + 1} ${rowLabel}`
}

function orderedSlots(playerCount: number): SlotKey[] {
  const slots: SlotKey[] = ['you-hand', 'you-top', 'you-mid', 'you-bot']
  for (let i = 0; i < playerCount - 1; i++) {
    slots.push(`opp-${i}-top`, `opp-${i}-mid`, `opp-${i}-bot`)
  }
  return slots
}

// ── Position tab ─────────────────────────────────────────────────────────────

interface PositionSnapshot {
  yourBoard: PartialBoard
  yourHand: Card[]
  oppBoards: PartialBoard[]
}

function PositionTab({ onNavigate }: { onNavigate: (p: AppPage) => void }) {
  const [playerCount, setPlayerCount] = useState<2 | 3>(2)
  const [street, setStreet] = useState<number>(0)
  const [activeSlot, setActiveSlot] = useState<SlotKey>('you-hand')
  const [yourBoard, setYourBoard] = useState<PartialBoard>({ top: [], middle: [], bottom: [] })
  const [yourHand, setYourHand] = useState<Card[]>([])
  const [oppBoards, setOppBoards] = useState<PartialBoard[]>([
    { top: [], middle: [], bottom: [] },
  ])
  // Per-opponent: true = in a bonus game (fresh separate deck, not a side-game opponent)
  const [oppIsBonus, setOppIsBonus] = useState<boolean[]>([false])
  const historyRef = useRef<PositionSnapshot[]>([])
  const fromGameRef = useRef(false)

  // Pre-populate from game state if launched via the Analyse button
  useEffect(() => {
    const init = analyzerBridge.initialState
    if (!init) return
    analyzerBridge.initialState = null
    fromGameRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setYourBoard({
      top: [...init.board.top],
      middle: [...init.board.middle],
      bottom: [...init.board.bottom],
    })
    setYourHand([...init.hand])
    const numOpps = init.revealedOpponentBoards.length
    setPlayerCount(Math.min(3, numOpps + 1) as 2 | 3)
    setOppBoards(
      numOpps > 0
        ? init.revealedOpponentBoards.map(b => ({
            top: [...b.top],
            middle: [...b.middle],
            bottom: [...b.bottom],
          }))
        : [{ top: [], middle: [], bottom: [] }]
    )
    setStreet(init.street)
  }, [])

  function handlePlayerCount(n: 2 | 3) {
    setPlayerCount(n)
    setOppBoards(prev => {
      const next = [...prev]
      while (next.length < n - 1) next.push({ top: [], middle: [], bottom: [] })
      while (next.length > n - 1) next.pop()
      return next
    })
    setOppIsBonus(prev => {
      const next = [...prev]
      while (next.length < n - 1) next.push(false)
      while (next.length > n - 1) next.pop()
      return next
    })
  }

  function toggleOppBonus(i: number) {
    setOppIsBonus(prev => {
      const next = [...prev]
      next[i] = !next[i]
      return next
    })
    // If the active slot belongs to this opponent, reset to hand
    if (activeSlot.startsWith(`opp-${i}-`)) setActiveSlot('you-hand')
  }

  const used = useMemo<Card[]>(() => {
    const acc: Card[] = []
    acc.push(...yourBoard.top, ...yourBoard.middle, ...yourBoard.bottom, ...yourHand)
    // Bonus opponents play a separate game with a fresh deck — their cards are independent
    for (let i = 0; i < oppBoards.length; i++) {
      if (oppIsBonus[i]) continue
      const b = oppBoards[i]!
      acc.push(...b.top, ...b.middle, ...b.bottom)
    }
    return acc
  }, [yourBoard, yourHand, oppBoards, oppIsBonus])

  // Keep refs for snapshot capture
  const stateRefs = { yourBoard, yourHand, oppBoards }
  const yourBoardRef = useRef(yourBoard)
  // eslint-disable-next-line react-hooks/refs
  yourBoardRef.current = yourBoard
  const yourHandRef = useRef(yourHand)
  // eslint-disable-next-line react-hooks/refs
  yourHandRef.current = yourHand
  const oppBoardsRef = useRef(oppBoards)
  // eslint-disable-next-line react-hooks/refs
  oppBoardsRef.current = oppBoards

  function saveSnapshot() {
    historyRef.current = [
      ...historyRef.current.slice(-9),
      { yourBoard: yourBoardRef.current, yourHand: yourHandRef.current, oppBoards: oppBoardsRef.current },
    ]
  }

  const undo = useCallback(() => {
    const snap = historyRef.current.pop()
    if (!snap) return
    setYourBoard(snap.yourBoard)
    setYourHand(snap.yourHand)
    setOppBoards(snap.oppBoards)
  }, [])

  function placeInSlot(card: Card, key: SlotKey) {
    if (key === 'you-top') setYourBoard(b => ({ ...b, top: [...b.top, card] }))
    else if (key === 'you-mid') setYourBoard(b => ({ ...b, middle: [...b.middle, card] }))
    else if (key === 'you-bot') setYourBoard(b => ({ ...b, bottom: [...b.bottom, card] }))
    else if (key === 'you-hand') setYourHand(h => [...h, card])
    else {
      const [, idxStr, row] = key.split('-') as [string, string, string]
      const idx = Number(idxStr)
      const rowKey: RowKey = row === 'top' ? 'top' : row === 'mid' ? 'middle' : 'bottom'
      setOppBoards(boards => boards.map((b, i) =>
        i !== idx ? b : { ...b, [rowKey]: [...b[rowKey], card] }
      ))
    }
  }

  function removeFromSlot(key: SlotKey, cardIdx: number) {
    saveSnapshot()
    if (key === 'you-top') setYourBoard(b => ({ ...b, top: b.top.filter((_, i) => i !== cardIdx) }))
    else if (key === 'you-mid') setYourBoard(b => ({ ...b, middle: b.middle.filter((_, i) => i !== cardIdx) }))
    else if (key === 'you-bot') setYourBoard(b => ({ ...b, bottom: b.bottom.filter((_, i) => i !== cardIdx) }))
    else if (key === 'you-hand') setYourHand(h => h.filter((_, i) => i !== cardIdx))
    else {
      const [, idxStr, row] = key.split('-') as [string, string, string]
      const idx = Number(idxStr)
      const rowKey: RowKey = row === 'top' ? 'top' : row === 'mid' ? 'middle' : 'bottom'
      setOppBoards(boards => boards.map((b, i) =>
        i !== idx ? b : { ...b, [rowKey]: b[rowKey].filter((_, j) => j !== cardIdx) }
      ))
    }
  }

  function handleCardClick(card: Card) {
    const cur = slotCards(activeSlot, yourBoard, yourHand, oppBoards)
    const max = slotMax(activeSlot, street)
    if (cur.length >= max) return
    if (used.some(c => sameCard(c, card))) return
    saveSnapshot()
    placeInSlot(card, activeSlot)
    // Auto-advance when slot fills up (skip bonus opponent slots)
    if (cur.length + 1 >= max) {
      const order = orderedSlots(playerCount).filter(key => {
        if (!key.startsWith('opp-')) return true
        const idx = Number(key.split('-')[1])
        return !oppIsBonus[idx]
      })
      const idx = order.indexOf(activeSlot)
      for (let i = idx + 1; i < order.length; i++) {
        const next = order[i]!
        const nextCards = slotCards(next, yourBoard, yourHand, oppBoards)
        if (nextCards.length < slotMax(next, street)) {
          setActiveSlot(next)
          return
        }
      }
    }
  }

  // ── Validation ──────────────────────────────────────────────────────────────
  const errors = useMemo(() => {
    const errs: string[] = []
    const keys = used.map(c => `${c.rank}${c.suit}`)
    if (new Set(keys).size !== keys.length) errs.push('Duplicate cards detected.')
    const handReq = street === 0 ? 5 : 3
    if (yourHand.length !== 0 && yourHand.length !== handReq)
      errs.push(`Hand for street ${street + 1} should be ${handReq} cards (or empty).`)
    if (yourBoard.top.length > 3) errs.push('Your top row exceeds 3.')
    if (yourBoard.middle.length > 5) errs.push('Your middle row exceeds 5.')
    if (yourBoard.bottom.length > 5) errs.push('Your bottom row exceeds 5.')
    for (let i = 0; i < oppBoards.length; i++) {
      if (oppIsBonus[i]) continue
      const b = oppBoards[i]!
      if (b.top.length > 3) errs.push(`Opp ${i + 1} top exceeds 3.`)
      if (b.middle.length > 5) errs.push(`Opp ${i + 1} middle exceeds 5.`)
      if (b.bottom.length > 5) errs.push(`Opp ${i + 1} bottom exceeds 5.`)
    }
    return errs
  }, [used, street, yourBoard, yourHand, oppBoards, oppIsBonus])

  const [results, setResults] = useState<ScoredPlacement[]>([])
  const [computing, setComputing] = useState(false)
  const [doneRollouts, setDoneRollouts] = useState(0)
  const cancelRef = useRef<(() => void) | null>(null)

  function applyPlacement(pl: Placement) {
    // When launched from a game, send the placement back and return
    if (fromGameRef.current) {
      // eslint-disable-next-line react-hooks/immutability
    analyzerBridge.pendingPlacement = pl
      onNavigate('game')
      return
    }
    saveSnapshot()
    setYourBoard(b => ({
      top: [...b.top, ...pl.topAdd],
      middle: [...b.middle, ...pl.middleAdd],
      bottom: [...b.bottom, ...pl.bottomAdd],
    }))
    const placed = [...pl.topAdd, ...pl.middleAdd, ...pl.bottomAdd, ...(pl.discard ? [pl.discard] : [])]
    setYourHand(h => {
      const rem = [...h]
      for (const c of placed) {
        const idx = rem.findIndex(r => sameCard(r, c))
        if (idx !== -1) rem.splice(idx, 1)
      }
      return rem
    })
    if (cancelRef.current) { cancelRef.current(); cancelRef.current = null }
    setResults([])
    setDoneRollouts(0)
    setComputing(false)
  }

  function analyze() {
    if (yourHand.length === 0 || errors.length > 0) return
    if (cancelRef.current) cancelRef.current()
    const state: InfoState = {
      board: yourBoard,
      hand: yourHand,
      street,
      // Bonus opponents use a fresh separate deck — exclude from scoring pool
      revealedOpponentBoards: oppBoards.slice(0, playerCount - 1).filter((_, i) => !oppIsBonus[i]),
    }
    const seed = (Date.now() & 0xffffffff) | 0
    setResults([])
    setComputing(true)
    setDoneRollouts(0)
    cancelRef.current = workerClient.streamMC(
      state,
      { totalRollouts: 2000, batchSize: 20 },
      seed,
      (r) => {
        setResults([...r].sort((a, b) => b.ev - a.ev))
        setDoneRollouts(r[0]?.n ?? 0)
      },
      (r) => {
        setResults([...r].sort((a, b) => b.ev - a.ev))
        setDoneRollouts(r[0]?.n ?? 2000)
        setComputing(false)
        cancelRef.current = null
      },
    )
  }

  function clear() {
    historyRef.current = []
    setYourBoard({ top: [], middle: [], bottom: [] })
    setYourHand([])
    setOppBoards(Array.from({ length: playerCount - 1 }, () => ({ top: [], middle: [], bottom: [] })))
    setOppIsBonus(Array.from({ length: playerCount - 1 }, () => false))
    setResults([])
    setDoneRollouts(0)
    setActiveSlot('you-hand')
  }

  const bestEV = results[0]?.ev ?? 0
  const canAnalyze = errors.length === 0 && yourHand.length > 0
  const slots = orderedSlots(playerCount)

  // Group slots for display
  const youSlots = slots.filter(s => s.startsWith('you-'))
  const oppSlotGroups: SlotKey[][] = []
  for (let i = 0; i < playerCount - 1; i++) {
    oppSlotGroups.push(slots.filter(s => s.startsWith(`opp-${i}-`)))
  }

  void stateRefs  // suppress unused warning

  return (
    <div className="flex flex-col gap-5">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-gray-500">Players</span>
          <div className="flex gap-1">
            {([2, 3] as const).map(n => (
              <button key={n} onClick={() => handlePlayerCount(n)}
                className={`px-3 py-1 text-xs rounded ${playerCount === n ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-gray-500">Street</span>
          <div className="flex gap-1">
            {[0, 1, 2, 3, 4].map(s => (
              <button key={s} onClick={() => setStreet(s)}
                className={`px-3 py-1 text-xs rounded ${street === s ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>
                {s + 1}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Slot selector */}
      <div className="flex flex-col gap-2">
        <span className="text-[10px] uppercase tracking-widest text-gray-500">Place cards into →</span>
        <div className="flex flex-wrap gap-1.5">
          <div className="flex gap-1.5 flex-wrap">
            {youSlots.map(key => {
              const cur = slotCards(key, yourBoard, yourHand, oppBoards)
              const max = slotMax(key, street)
              const isFull = cur.length >= max
              const isActive = activeSlot === key
              return (
                <button
                  key={key}
                  onClick={() => setActiveSlot(key)}
                  className={[
                    'px-2.5 py-1 rounded text-xs font-medium transition-colors tabular-nums',
                    isActive
                      ? 'bg-indigo-600 text-white ring-1 ring-indigo-400'
                      : isFull
                        ? 'bg-gray-800 text-gray-600 border border-gray-700'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700',
                  ].join(' ')}
                >
                  {slotLabel(key, playerCount)}{' '}
                  <span className={isFull ? 'text-emerald-500' : 'opacity-60'}>{cur.length}/{max}</span>
                </button>
              )
            })}
          </div>
          {oppSlotGroups.map((group, gi) => (
            <div key={gi} className="flex gap-1.5 flex-wrap items-center">
              <span className="self-center text-gray-700 text-xs">|</span>
              {oppIsBonus[gi] ? (
                <span className="text-[10px] text-amber-600/70 italic px-1">
                  {playerCount === 2 ? 'Opp' : `Opp ${gi + 1}`} — bonus game
                </span>
              ) : group.map(key => {
                const cur = slotCards(key, yourBoard, yourHand, oppBoards)
                const max = slotMax(key, street)
                const isFull = cur.length >= max
                const isActive = activeSlot === key
                return (
                  <button
                    key={key}
                    onClick={() => setActiveSlot(key)}
                    className={[
                      'px-2.5 py-1 rounded text-xs font-medium transition-colors tabular-nums',
                      isActive
                        ? 'bg-amber-700 text-white ring-1 ring-amber-500'
                        : isFull
                          ? 'bg-gray-800 text-gray-600 border border-gray-700'
                          : 'bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700',
                    ].join(' ')}
                  >
                    {slotLabel(key, playerCount)}{' '}
                    <span className={isFull ? 'text-emerald-500' : 'opacity-60'}>{cur.length}/{max}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Card picker */}
      <div>
        <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">
          Click a card → goes to <span className="text-indigo-400 font-semibold">{slotLabel(activeSlot, playerCount)}</span>
        </p>
        <CardPicker
          used={used}
          selected={null}
          onSelect={c => c && handleCardClick(c)}
        />
      </div>

      {/* Placed cards display */}
      <div className="flex flex-wrap gap-6">
        <SlotGroup
          title="You"
          slots={[
            { key: 'you-top', label: 'Top', cards: [...yourBoard.top], max: 3 },
            { key: 'you-mid', label: 'Mid', cards: [...yourBoard.middle], max: 5 },
            { key: 'you-bot', label: 'Bot', cards: [...yourBoard.bottom], max: 5 },
            { key: 'you-hand', label: 'Hand', cards: yourHand, max: slotMax('you-hand', street) },
          ]}
          activeSlot={activeSlot}
          onRemove={removeFromSlot}
        />
        {oppBoards.slice(0, playerCount - 1).map((b, i) => (
          <div key={i}>
            <div className="flex items-center gap-2 mb-1.5">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">
                {playerCount === 2 ? 'Opponent' : `Opp ${i + 1}`}
              </p>
              <button
                onClick={() => toggleOppBonus(i)}
                className={[
                  'px-2 py-0.5 text-[10px] font-medium rounded transition-colors border',
                  oppIsBonus[i]
                    ? 'bg-amber-900/40 text-amber-300 border-amber-700/60'
                    : 'bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300 hover:border-gray-600',
                ].join(' ')}
              >
                Bonus game
              </button>
            </div>
            {oppIsBonus[i] ? (
              <div className="text-[10px] text-gray-600 italic px-1">
                Playing bonus — separate deck, not a scoring opponent
              </div>
            ) : (
              <SlotGroup
                title=""
                slots={[
                  { key: `opp-${i}-top`, label: 'Top', cards: [...b.top], max: 3 },
                  { key: `opp-${i}-mid`, label: 'Mid', cards: [...b.middle], max: 5 },
                  { key: `opp-${i}-bot`, label: 'Bot', cards: [...b.bottom], max: 5 },
                ]}
                activeSlot={activeSlot}
                onRemove={removeFromSlot}
              />
            )}
          </div>
        ))}
      </div>

      {errors.length > 0 && (
        <div className="rounded-xl border border-red-800/60 bg-red-950/30 p-3">
          {errors.map((e, i) => <p key={i} className="text-xs text-red-300">{e}</p>)}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <button
          onClick={analyze}
          disabled={!canAnalyze || computing}
          className={[
            'px-6 py-2 rounded-lg text-sm font-medium transition-colors',
            !canAnalyze || computing
              ? 'bg-gray-800 text-gray-600 cursor-not-allowed'
              : 'bg-emerald-600 hover:bg-emerald-500 text-white',
          ].join(' ')}
        >
          {computing ? `Analyzing… ${doneRollouts} rollouts` : 'Analyze'}
        </button>
        <button
          onClick={undo}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-300"
        >
          ↩ Undo
        </button>
        <button
          onClick={clear}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-800 hover:bg-gray-700 text-gray-300"
        >
          Clear
        </button>
      </div>

      {results.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-widest text-gray-300 font-semibold">Ranked EV</span>
            <span className="text-[10px] text-gray-500 tabular-nums">
              {computing ? `${doneRollouts} rollouts…` : `${doneRollouts} rollouts`}
              {yourHand.length > 0 && <span className="ml-2 text-gray-700">· click row to apply</span>}
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
                  <th className="px-1.5 py-1 font-medium text-right">Gap</th>
                </tr>
              </thead>
              <tbody>
                {results.slice(0, 20).map((sp, i) => (
                  <tr
                    key={i}
                    onClick={() => yourHand.length > 0 && applyPlacement(sp.placement)}
                    className={[
                      'border-b border-gray-800/40 last:border-0 transition-colors',
                      yourHand.length > 0 ? 'cursor-pointer hover:bg-gray-800/60 active:bg-gray-700/60' : '',
                    ].join(' ')}
                  >
                    <td className="px-1.5 py-1 text-gray-500 tabular-nums">{i + 1}</td>
                    <td className="px-1.5 py-1">{sp.placement.topAdd.map(cardLabel).join(' ') || '—'}</td>
                    <td className="px-1.5 py-1">{sp.placement.middleAdd.map(cardLabel).join(' ') || '—'}</td>
                    <td className="px-1.5 py-1">{sp.placement.bottomAdd.map(cardLabel).join(' ') || '—'}</td>
                    <td className="px-1.5 py-1 text-gray-400">{sp.placement.discard ? cardLabel(sp.placement.discard) : '—'}</td>
                    <td className={`px-1.5 py-1 text-right tabular-nums font-semibold ${sp.ev > 0 ? 'text-green-400' : sp.ev < 0 ? 'text-red-400' : 'text-gray-300'}`}>
                      {sp.ev > 0 ? '+' : ''}{sp.ev.toFixed(2)}
                    </td>
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

// ── SlotGroup: compact card display with remove buttons ──────────────────────

interface SlotDef {
  key: SlotKey
  label: string
  cards: Card[]
  max: number
}

function SlotGroup({ title, slots, activeSlot, onRemove }: {
  title: string
  slots: SlotDef[]
  activeSlot: SlotKey
  onRemove: (key: SlotKey, idx: number) => void
}) {
  return (
    <div>
      {title && <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1.5">{title}</p>}
      <div className="flex flex-col gap-1.5 bg-gray-900/40 rounded-xl border border-gray-800 p-2.5">
        {slots.map(({ key, label, cards, max }) => {
          const isActive = activeSlot === key
          return (
            <div key={key} className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 transition-colors ${isActive ? 'bg-indigo-950/40' : ''}`}>
              <span className={`text-[10px] uppercase tracking-widest w-8 flex-shrink-0 ${isActive ? 'text-indigo-400' : 'text-gray-600'}`}>
                {label}
              </span>
              <div className="flex gap-1 flex-wrap min-h-[20px] items-center">
                {cards.map((c, i) => (
                  <button
                    key={i}
                    onClick={() => onRemove(key, i)}
                    title="Remove"
                    className={`px-1 py-0.5 text-[11px] rounded bg-gray-800 hover:bg-red-900/40 border border-gray-700 font-medium ${suitColor(c.suit)}`}
                  >
                    {cardLabel(c)}
                  </button>
                ))}
                {cards.length < max && (
                  <span className="text-[10px] text-gray-700 tabular-nums">{cards.length}/{max}</span>
                )}
                {cards.length >= max && (
                  <span className="text-[10px] text-emerald-700">✓</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Bonus solver tab ─────────────────────────────────────────────────────────

function BonusTab() {
  const [cards, setCards] = useState<Card[]>([])
  const [result, setResult] = useState<PartialBoard | null>(null)
  const [solving, setSolving] = useState(false)
  const historyRef = useRef<Card[][]>([])
  const [historyLen, setHistoryLen] = useState(0)
  const cardsRef = useRef(cards)
  // eslint-disable-next-line react-hooks/refs
  cardsRef.current = cards

  const numDiscard = cards.length === 13 ? 0 : cards.length === 14 ? 1 : cards.length === 15 ? 2 : -1

  function addCard(card: Card) {
    if (cards.some(c => sameCard(c, card))) return
    if (cards.length >= 15) return
    historyRef.current = [...historyRef.current.slice(-9), [...cardsRef.current]]
    setHistoryLen(historyRef.current.length)
    setCards(arr => [...arr, card])
    setResult(null)
  }

  function remove(idx: number) {
    historyRef.current = [...historyRef.current.slice(-9), [...cardsRef.current]]
    setHistoryLen(historyRef.current.length)
    setCards(arr => arr.filter((_, i) => i !== idx))
    setResult(null)
  }

  const undo = useCallback(() => {
    const prev = historyRef.current.pop()
    if (!prev) return
    setHistoryLen(historyRef.current.length)
    setCards(prev)
    setResult(null)
  }, [])

  function solve() {
    if (numDiscard < 0) return
    setSolving(true)
    setResult(null)
    setTimeout(() => {
      try {
        setResult(bestBonusBoard(cards, numDiscard))
      } catch (e) {
        console.error('bestBonusBoard error', e)
      } finally {
        setSolving(false)
      }
    }, 0)
  }

  const discarded = useMemo(() => {
    if (!result) return []
    const used = new Set([...result.top, ...result.middle, ...result.bottom].map(c => `${c.rank}${c.suit}`))
    return cards.filter(c => !used.has(`${c.rank}${c.suit}`))
  }, [result, cards])

  const roy = result ? royalties(result as Board) : 0
  const isFouled = result && result.top.length === 3 && result.middle.length === 5 && result.bottom.length === 5
    ? isFoul(result as Board) : false

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">
          Click cards to add <span className="text-gray-600">({cards.length}/13–15)</span>
        </p>
        <CardPicker used={cards} selected={null} onSelect={c => c && addCard(c)} />
        <div className="mt-2 flex gap-2">
          <button
            onClick={undo}
            disabled={historyLen === 0}
            className="text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 disabled:text-gray-600 disabled:cursor-not-allowed text-gray-300"
          >
            ↩ Undo
          </button>
          <button
            onClick={() => { historyRef.current = []; setHistoryLen(0); setCards([]); setResult(null) }}
            className="text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300"
          >
            Clear
          </button>
        </div>
      </div>

      {cards.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {cards.map((c, i) => (
            <button
              key={i}
              onClick={() => remove(i)}
              className={`px-2 py-1 text-xs rounded bg-gray-800 hover:bg-red-900/50 border border-gray-700 ${suitColor(c.suit)}`}
              title="Remove"
            >
              {cardLabel(c)}
            </button>
          ))}
          <span className="self-center text-[10px] text-gray-600 ml-1">
            {numDiscard < 0 ? 'need 13–15 cards' : `${numDiscard} discard${numDiscard === 1 ? '' : 's'}`}
          </span>
        </div>
      )}

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
              {isFouled ? 'No legal arrangement' : `+${roy} royalties`}
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
