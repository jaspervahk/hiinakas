import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppPage } from '../App'
import type { Card, PartialBoard, ScoredPlacement, InfoState, Board, Placement, BonusQualifier } from '../engine/index'
import { royalties, isFoul, CLASSIC_RULES, VARIANT_RULES } from '../engine/index'
import { CardPicker } from '../components/CardPicker'
import { BoardView } from '../components/BoardView'
import { workerClient, royaltyWorkerClient, MODEL_URLS } from '../worker/client'
import type { BotPolicy } from '../worker/client'
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

// Row membership is a set, not a sequence: two placements that put the same
// cards in the same rows are the same line however they were ordered.
function sameUnordered(a: readonly Card[], b: readonly Card[]): boolean {
  if (a.length !== b.length) return false
  const used = new Array<boolean>(b.length).fill(false)
  for (const c of a) {
    let found = false
    for (let i = 0; i < b.length; i++) {
      if (!used[i] && sameCard(c, b[i]!)) { used[i] = true; found = true; break }
    }
    if (!found) return false
  }
  return true
}

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

function slotMax(key: SlotKey, handMax: number): number {
  if (key === 'dead') return 52 // no natural cap; whatever the user knows is gone
  if (key.endsWith('-top')) return 3
  if (key === 'you-hand') return handMax
  return 5
}

// How many cards your board holds BEFORE placing each street: nothing at
// street 1, then five from the opening and two more per street after. The
// street is read back out of this rather than chosen by hand — the position
// already determines it, and letting the two disagree is what used to produce
// an unanalysable state.
const BOARD_COUNT_BY_STREET = [0, 5, 7, 9, 11] as const

function slotCards(
  key: SlotKey, board: PartialBoard, hand: Card[], oppBoards: PartialBoard[], dead: Card[] = [],
): Card[] {
  if (key === 'dead') return dead
  if (key === 'you-top') return [...board.top]
  if (key === 'you-mid') return [...board.middle]
  if (key === 'you-bot') return [...board.bottom]
  if (key === 'you-hand') return hand
  const [, idxStr, row] = key.split('-') as [string, string, string]
  const b = oppBoards[Number(idxStr)] ?? { top: [], middle: [], bottom: [] }
  return row === 'top' ? [...b.top] : row === 'mid' ? [...b.middle] : [...b.bottom]
}

function slotLabel(key: SlotKey, playerCount: number): string {
  if (key === 'dead') return 'Dead'
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
  slots.push('dead')
  return slots
}

// ── Position tab ─────────────────────────────────────────────────────────────

interface PositionSnapshot {
  yourBoard: PartialBoard
  yourHand: Card[]
  oppBoards: PartialBoard[]
  deadCards: Card[]
}

function PositionTab({ onNavigate }: { onNavigate: (p: AppPage) => void }) {
  const [playerCount, setPlayerCount] = useState<2 | 3>(2)
  const [activeSlot, setActiveSlot] = useState<SlotKey>('you-hand')
  const [yourBoard, setYourBoard] = useState<PartialBoard>({ top: [], middle: [], bottom: [] })
  const [yourHand, setYourHand] = useState<Card[]>([])
  const [oppBoards, setOppBoards] = useState<PartialBoard[]>([
    { top: [], middle: [], bottom: [] },
  ])
  // Per-opponent: the qualifier tier of an opponent playing the bonus round
  // (null = a normal/side-game opponent). The tier matters, not just the fact
  // of qualifying: a bonus opponent's board is invisible during play but is
  // still scored pairwise against yours at showdown
  // (docs/01_RULES_AND_SCORING.md section 8), and the engine values that via a
  // sampled board drawn from the matching 13/14/15-card tier.
  // Cards known to be gone but not visible on any board: your own discards,
  // cards you saw folded or exposed. The engine removes them from the live
  // deck (buildLiveDeck), so every rollout draws from the deck you are
  // actually facing instead of one that still contains them.
  const [deadCards, setDeadCards] = useState<Card[]>([])
  const [oppBonusTier, setOppBonusTier] = useState<(BonusQualifier | null)[]>([null])
  const oppIsBonus = useMemo(() => oppBonusTier.map(t => t !== null), [oppBonusTier])
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
  }, [])

  function handlePlayerCount(n: 2 | 3) {
    setPlayerCount(n)
    setOppBoards(prev => {
      const next = [...prev]
      while (next.length < n - 1) next.push({ top: [], middle: [], bottom: [] })
      while (next.length > n - 1) next.pop()
      return next
    })
    setOppBonusTier(prev => {
      const next = [...prev]
      while (next.length < n - 1) next.push(null)
      while (next.length > n - 1) next.pop()
      return next
    })
  }

  function setOppBonus(i: number, tier: BonusQualifier | null) {
    setOppBonusTier(prev => {
      const next = [...prev]
      next[i] = tier
      return next
    })
    // If the active slot belongs to this opponent, reset to hand
    if (tier !== null && activeSlot.startsWith(`opp-${i}-`)) setActiveSlot('you-hand')
  }

  const used = useMemo<Card[]>(() => {
    const acc: Card[] = []
    acc.push(...yourBoard.top, ...yourBoard.middle, ...yourBoard.bottom, ...yourHand)
    acc.push(...deadCards)
    // Bonus opponents play a separate game with a fresh deck — their cards are independent
    for (let i = 0; i < oppBoards.length; i++) {
      if (oppIsBonus[i]) continue
      const b = oppBoards[i]!
      acc.push(...b.top, ...b.middle, ...b.bottom)
    }
    return acc
  }, [yourBoard, yourHand, oppBoards, oppIsBonus, deadCards])

  // Keep refs for snapshot capture
  const stateRefs = { yourBoard, yourHand, oppBoards, deadCards }
  const yourBoardRef = useRef(yourBoard)
  // eslint-disable-next-line react-hooks/refs
  yourBoardRef.current = yourBoard
  const yourHandRef = useRef(yourHand)
  // eslint-disable-next-line react-hooks/refs
  yourHandRef.current = yourHand
  const oppBoardsRef = useRef(oppBoards)
  // eslint-disable-next-line react-hooks/refs
  oppBoardsRef.current = oppBoards
  const deadCardsRef = useRef(deadCards)
  // eslint-disable-next-line react-hooks/refs
  deadCardsRef.current = deadCards

  function saveSnapshot() {
    historyRef.current = [
      ...historyRef.current.slice(-9),
      {
        yourBoard: yourBoardRef.current, yourHand: yourHandRef.current,
        oppBoards: oppBoardsRef.current, deadCards: deadCardsRef.current,
      },
    ]
  }

  const undo = useCallback(() => {
    const snap = historyRef.current.pop()
    if (!snap) return
    setYourBoard(snap.yourBoard)
    setYourHand(snap.yourHand)
    setOppBoards(snap.oppBoards)
    setDeadCards(snap.deadCards)
  }, [])

  function placeInSlot(card: Card, key: SlotKey) {
    if (key === 'dead') setDeadCards(d => [...d, card])
    else if (key === 'you-top') setYourBoard(b => ({ ...b, top: [...b.top, card] }))
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
    if (key === 'dead') setDeadCards(d => d.filter((_, i) => i !== cardIdx))
    else if (key === 'you-top') setYourBoard(b => ({ ...b, top: b.top.filter((_, i) => i !== cardIdx) }))
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
    const cur = slotCards(activeSlot, yourBoard, yourHand, oppBoards, deadCards)
    const max = slotMax(activeSlot, handMax)
    if (cur.length >= max) return
    if (used.some(c => sameCard(c, card))) return
    saveSnapshot()
    placeInSlot(card, activeSlot)
    // Auto-advance when slot fills up (skip bonus opponent slots)
    if (cur.length + 1 >= max) {
      const order = orderedSlots(playerCount).filter(key => {
        if (key === 'dead') return false // never auto-advance into the dead pile
        if (!key.startsWith('opp-')) return true
        const idx = Number(key.split('-')[1])
        return !oppIsBonus[idx]
      })
      const idx = order.indexOf(activeSlot)
      for (let i = idx + 1; i < order.length; i++) {
        const next = order[i]!
        const nextCards = slotCards(next, yourBoard, yourHand, oppBoards, deadCards)
        if (nextCards.length < slotMax(next, handMax)) {
          setActiveSlot(next)
          return
        }
      }
    }
  }

  // ── Street detection ────────────────────────────────────────────────────────
  const detection = useMemo(() => {
    const boardCount = yourBoard.top.length + yourBoard.middle.length + yourBoard.bottom.length
    const overfull = yourBoard.top.length > 3 || yourBoard.middle.length > 5 || yourBoard.bottom.length > 5
    const street = overfull ? -1 : (BOARD_COUNT_BY_STREET as readonly number[]).indexOf(boardCount)
    const handMax = boardCount === 0 ? 5 : 3
    if (street === -1) {
      return {
        street: null, handMax, boardCount,
        problem: overfull
          ? 'A row is over its limit, so this board can never be reached.'
          : `A board of ${boardCount} card${boardCount === 1 ? '' : 's'} isn't reachable at any street — you place 5 to open, then 2 per street, so it should hold 0, 5, 7, 9 or 11 before acting.`,
      }
    }
    const need = street === 0 ? 5 : 3
    if (yourHand.length === 0) {
      return { street, handMax, boardCount, pending: `Street ${street + 1} detected — deal ${need} cards to analyse.` }
    }
    if (yourHand.length !== need) {
      return {
        street, handMax, boardCount,
        pending: `Street ${street + 1} deals ${need} cards — ${yourHand.length} entered.`,
      }
    }
    return { street, handMax, boardCount, ready: `Street ${street + 1}` }
  }, [yourBoard, yourHand])

  const street = detection.street ?? 0
  const handMax = detection.handMax

  // ── Validation ──────────────────────────────────────────────────────────────
  const errors = useMemo(() => {
    const errs: string[] = []
    const keys = used.map(c => `${c.rank}${c.suit}`)
    if (new Set(keys).size !== keys.length) errs.push('Duplicate cards detected.')
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
  }, [used, yourBoard, oppBoards, oppIsBonus])

  const [analyzerPolicy, setAnalyzerPolicy] = useState<BotPolicy>('heuristic')
  // Which ruleset the position is analyzed under. Classic is v1 Hiinakas;
  // variant adds the bottom straight-flush bonus trigger, recursive bonus
  // rounds, and ordered placement within a street.
  const [useVariant, setUseVariant] = useState(false)
  const [results, setResults] = useState<ScoredPlacement[]>([])
  const [computing, setComputing] = useState(false)
  const [doneRollouts, setDoneRollouts] = useState(0)
  const [noModel, setNoModel] = useState(false)
  // Assignment of each dealt card to a row (or the discard) for the "what
  // about this line?" lookup below — keyed by index into yourHand.
  const [lineAssign, setLineAssign] = useState<Record<number, 'top' | 'mid' | 'bot' | 'disc'>>({})
  const [showAllRows, setShowAllRows] = useState(false)
  const cancelRef = useRef<(() => void) | null>(null)

  function handleRulesChange(variant: boolean) {
    if (cancelRef.current) { cancelRef.current(); cancelRef.current = null }
    setUseVariant(variant)
    setResults([])
    setDoneRollouts(0)
    setComputing(false)
    setLineAssign({})
  }

  function handlePolicyChange(p: BotPolicy) {
    if (cancelRef.current) { cancelRef.current(); cancelRef.current = null }
    setAnalyzerPolicy(p)
    setResults([])
    setDoneRollouts(0)
    setComputing(false)
    setNoModel(false)
    setLineAssign({})
  }

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
    // The discard is gone from the deck, not merely off the board. Without
    // recording it the next street's analysis would deal it back out of the
    // live deck — and stepping a position forward street by street is the main
    // way discards accumulate here, so this is where they would go missing.
    if (pl.discard) {
      const d = pl.discard
      setDeadCards(prev => prev.some(c => sameCard(c, d)) ? prev : [...prev, d])
    }
    if (cancelRef.current) { cancelRef.current(); cancelRef.current = null }
    setResults([])
    setDoneRollouts(0)
    setComputing(false)
    setLineAssign({})
  }

  async function analyze() {
    // detection.ready means the board maps to a real street AND the hand holds
    // the right number of cards for it; without both, there is no position to
    // analyse and the engine would be handed an unreachable one.
    if (detection.street === null || !detection.ready) return
    if (yourHand.length === 0 || errors.length > 0) return
    if (cancelRef.current) cancelRef.current()
    setNoModel(false)

    // Guarantee the real NN-MCTS policy actually runs rather than silently
    // falling back to brute-force heuristic MC inside the worker (which
    // otherwise happens invisibly whenever the app-wide startup preload in
    // App.tsx hasn't resolved yet, or failed) — same guarantee Session
    // Analysis makes before it will score anything as 'nn' (SessionTab.tsx).
    if (analyzerPolicy === 'nn') {
      const loaded = await workerClient.loadModel(MODEL_URLS.v2)
      if (!loaded) { setNoModel(true); return }
    }

    // An opponent in the bonus round is invisible during play (their board is
    // built from a fresh separate deck, so it's excluded from the live-deck
    // and revealed-board pools) but is still scored pairwise against your
    // final board at showdown — docs/01_RULES_AND_SCORING.md section 8. Pass
    // the tiers so rollout() values each one against a sampled board of the
    // right size instead of silently dropping the matchup from the EV.
    const bonusTiers = oppBonusTier
      .slice(0, playerCount - 1)
      .filter((t): t is BonusQualifier => t !== null)
    const state: InfoState = {
      board: yourBoard,
      hand: yourHand,
      street,
      revealedOpponentBoards: oppBoards.slice(0, playerCount - 1).filter((_, i) => !oppIsBonus[i]),
      // If any opponent triggered the bonus, the position being analyzed is
      // itself a side game — and re-triggering is disabled in v1, so a
      // qualifying top reached here earns no further bonus value.
      ...(bonusTiers.length > 0
        ? { inBonusRound: true, invisibleBonusOpponents: bonusTiers }
        : {}),
      // InfoState calls this `discards` because in a real hand the actor's own
      // discards are the dead cards they know about. Here it carries every
      // card the user has marked dead; buildLiveDeck simply subtracts it.
      ...(deadCards.length > 0 ? { discards: deadCards } : {}),
      rules: useVariant ? VARIANT_RULES : CLASSIC_RULES,
    }
    const seed = (Date.now() & 0xffffffff) | 0
    setResults([])
    setComputing(true)
    setDoneRollouts(0)
    setLineAssign({})
    const client = analyzerPolicy === 'royalty' ? royaltyWorkerClient : workerClient
    const totalRollouts = analyzerPolicy === 'royalty' ? 1000 : 2000
    // Heuristic MC streams a batch at a time over one continuous budget, so a
    // smaller batch just paints the first ranking sooner (street 0's 232
    // candidates make each rollout pass expensive) — it doesn't change the
    // numbers, which stay identical to Live Coach's at the same rollout count.
    const batchSize = analyzerPolicy === 'heuristic' ? 10 : 20
    cancelRef.current = client.streamMC(
      state,
      { totalRollouts, batchSize },
      seed,
      (r) => {
        setResults([...r].sort((a, b) => b.ev - a.ev))
        setDoneRollouts(r.reduce((m, x) => Math.max(m, x.n), 0))
      },
      (r) => {
        setResults([...r].sort((a, b) => b.ev - a.ev))
        setDoneRollouts(r.reduce((m, x) => Math.max(m, x.n), 0))
        setComputing(false)
        cancelRef.current = null
      },
      analyzerPolicy,
    )
  }

  function clear() {
    historyRef.current = []
    setYourBoard({ top: [], middle: [], bottom: [] })
    setYourHand([])
    setOppBoards(Array.from({ length: playerCount - 1 }, () => ({ top: [], middle: [], bottom: [] })))
    setOppBonusTier(Array.from({ length: playerCount - 1 }, () => null))
    setDeadCards([])
    setResults([])
    setDoneRollouts(0)
    setLineAssign({})
    setActiveSlot('you-hand')
  }

  // The EV of one specific line, however far down the ranking it sits. The
  // table only lists the best few, but the question a position analyser
  // actually gets asked is "I was thinking of playing X — how much does it
  // cost?", and X is usually not in the top 20.
  //
  // results holds every legal placement (runMC enumerates legalPlacements), so
  // a complete legal assignment is always found; NN+MCTS can rank a narrowed
  // candidate set, which is why 'missing' is reported separately from illegal.
  const lineLookup = useMemo(() => {
    if (yourHand.length === 0) return null
    const top: Card[] = [], mid: Card[] = [], bot: Card[] = []
    let disc: Card | null = null
    let assigned = 0
    yourHand.forEach((c, i) => {
      const a = lineAssign[i]
      if (!a) return
      assigned++
      if (a === 'top') top.push(c)
      else if (a === 'mid') mid.push(c)
      else if (a === 'bot') bot.push(c)
      else disc = c
    })
    if (assigned < yourHand.length) {
      return { status: 'incomplete' as const, assigned, total: yourHand.length }
    }
    if (results.length === 0) return { status: 'noResults' as const }
    const idx = results.findIndex(sp => {
      const p = sp.placement
      const dOk = p.discard == null
        ? disc == null
        : disc != null && sameCard(p.discard, disc)
      return dOk
        && sameUnordered(p.topAdd, top)
        && sameUnordered(p.middleAdd, mid)
        && sameUnordered(p.bottomAdd, bot)
    })
    if (idx === -1) return { status: 'missing' as const }
    return { status: 'found' as const, rank: idx + 1, sp: results[idx]!, total: results.length }
  }, [results, yourHand, lineAssign])

  const bestEV = results[0]?.ev ?? 0
  const canAnalyze = errors.length === 0 && yourHand.length > 0 && !!detection.ready
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
          <div
            title="Worked out from the position: your board holds 0, 5, 7, 9 or 11 cards before you act"
            className={[
              'px-3 py-1 text-xs rounded border tabular-nums',
              detection.street === null
                ? 'bg-red-950/40 text-red-300 border-red-800/60'
                : detection.ready
                  ? 'bg-indigo-950/40 text-indigo-300 border-indigo-800/60'
                  : 'bg-gray-800 text-gray-400 border-gray-700',
            ].join(' ')}
          >
            {detection.street === null ? 'unreachable' : `${detection.street + 1} of 5`}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-gray-500">Rules</span>
          <div className="flex rounded overflow-hidden border border-gray-700 text-xs">
            {([[false, 'Classic'], [true, 'Variant']] as const).map(([v, lbl]) => (
              <button
                key={lbl}
                onClick={() => handleRulesChange(v)}
                title={v
                  ? 'Bottom straight flush or better also deals a 15-card bonus; side games can trigger further bonus rounds; players place in order'
                  : 'v1 Hiinakas rules'}
                className={[
                  'px-3 py-1 transition-colors',
                  useVariant === v ? 'bg-sky-700 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200',
                ].join(' ')}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-widest text-gray-500">Mode</span>
          <div className="flex rounded overflow-hidden border border-gray-700 text-xs">
            {([['heuristic', 'Heuristic MC'], ['nn', 'NN + MCTS'], ['royalty', 'Royalty']] as const).map(([p, lbl]) => (
              <button
                key={p}
                onClick={() => handlePolicyChange(p)}
                className={[
                  'px-3 py-1 transition-colors',
                  analyzerPolicy === p
                    ? (p === 'royalty'
                        ? 'bg-amber-700 text-white'
                        : p === 'heuristic' ? 'bg-emerald-700 text-white' : 'bg-indigo-700 text-white')
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200',
                ].join(' ')}
              >
                {lbl}
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
              const cur = slotCards(key, yourBoard, yourHand, oppBoards, deadCards)
              const max = slotMax(key, handMax)
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
          <div className="flex gap-1.5 flex-wrap items-center">
            <span className="self-center text-gray-700 text-xs">|</span>
            <button
              onClick={() => setActiveSlot('dead')}
              title="Cards you know are gone but that aren't on any visible board — your own discards, cards you saw folded or exposed"
              className={[
                'px-2.5 py-1 rounded text-xs font-medium transition-colors tabular-nums',
                activeSlot === 'dead'
                  ? 'bg-rose-800 text-white ring-1 ring-rose-500'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700',
              ].join(' ')}
            >
              Dead <span className="opacity-60">{deadCards.length}</span>
            </button>
          </div>
          {oppSlotGroups.map((group, gi) => (
            <div key={gi} className="flex gap-1.5 flex-wrap items-center">
              <span className="self-center text-gray-700 text-xs">|</span>
              {oppIsBonus[gi] ? (
                <span className="text-[10px] text-amber-600/70 italic px-1">
                  {playerCount === 2 ? 'Opp' : `Opp ${gi + 1}`} — bonus game
                </span>
              ) : group.map(key => {
                const cur = slotCards(key, yourBoard, yourHand, oppBoards, deadCards)
                const max = slotMax(key, handMax)
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
            { key: 'you-hand', label: 'Hand', cards: yourHand, max: slotMax('you-hand', handMax) },
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
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-600">Bonus</span>
                {([[null, 'Off'], ['QQ', 'QQ'], ['KK', 'KK'], ['AA_OR_TRIPS', 'AA+']] as const).map(([tier, lbl]) => (
                  <button
                    key={lbl}
                    onClick={() => setOppBonus(i, tier)}
                    title={tier === null
                      ? 'Normal or side-game opponent'
                      : `Opponent is playing the bonus round (${tier === 'AA_OR_TRIPS' ? 'AA or trips — 15 cards' : tier === 'KK' ? 'KK — 14 cards' : 'QQ — 13 cards'})`}
                    className={[
                      'px-1.5 py-0.5 text-[10px] font-medium rounded transition-colors border',
                      oppBonusTier[i] === tier
                        ? 'bg-amber-900/40 text-amber-300 border-amber-700/60'
                        : 'bg-gray-800 text-gray-500 border-gray-700 hover:text-gray-300 hover:border-gray-600',
                    ].join(' ')}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </div>
            {oppIsBonus[i] ? (
              <div className="text-[10px] text-gray-600 italic px-1">
                Playing bonus — separate deck, board hidden, still scored against you
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

        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">Dead cards</p>
            {deadCards.length > 0 && (
              <button
                onClick={() => { saveSnapshot(); setDeadCards([]) }}
                className="px-2 py-0.5 text-[10px] rounded border border-gray-700 bg-gray-800 text-gray-500 hover:text-gray-300"
              >
                Clear
              </button>
            )}
          </div>
          <div
            className={[
              'flex gap-1 flex-wrap min-h-[34px] items-center rounded-xl border p-2.5 transition-colors',
              activeSlot === 'dead'
                ? 'bg-rose-950/30 border-rose-800/60'
                : 'bg-gray-900/40 border-gray-800',
            ].join(' ')}
          >
            {deadCards.length === 0 ? (
              <span className="text-[10px] text-gray-600 italic">
                Removed from the deck the analysis draws from — your discards, or any card you know is gone
              </span>
            ) : deadCards.map((c, i) => (
              <button
                key={i}
                onClick={() => removeFromSlot('dead', i)}
                title="Remove"
                className={`px-1 py-0.5 text-[11px] rounded bg-gray-800 hover:bg-red-900/40 border border-gray-700 font-medium ${suitColor(c.suit)}`}
              >
                {cardLabel(c)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {errors.length === 0 && (detection.street === null || detection.pending) && (
        <div className={[
          'rounded-xl border p-3 text-xs',
          detection.street === null
            ? 'border-red-800/60 bg-red-950/30 text-red-300'
            : 'border-gray-800 bg-gray-900/40 text-gray-400',
        ].join(' ')}>
          {detection.problem ?? detection.pending}
        </div>
      )}

      {errors.length > 0 && (
        <div className="rounded-xl border border-red-800/60 bg-red-950/30 p-3">
          {errors.map((e, i) => <p key={i} className="text-xs text-red-300">{e}</p>)}
        </div>
      )}

      {noModel && (
        <div className="flex items-center justify-between bg-amber-900/20 rounded px-3 py-2">
          <p className="text-amber-400 text-xs">Model unavailable at /models/policy.bin — training may still be in progress.</p>
          <button onClick={() => void analyze()} className="ml-3 shrink-0 px-2 py-1 text-xs rounded bg-amber-800/40 hover:bg-amber-700/40 text-amber-300 transition-colors">
            Retry
          </button>
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => void analyze()}
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
            <span className={`text-xs uppercase tracking-widest font-semibold ${analyzerPolicy === 'royalty' ? 'text-amber-400' : 'text-gray-300'}`}>
              {analyzerPolicy === 'royalty' ? 'Royalty EV' : 'Ranked EV'}
            </span>
            <span className="text-[10px] text-gray-500 tabular-nums flex items-center gap-2">
              <span>{computing ? `${doneRollouts} sims…` : `${doneRollouts} sims`}</span>
              {results.length > 20 && (
                <button
                  onClick={() => setShowAllRows(v => !v)}
                  className="px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200"
                >
                  {showAllRows ? 'Top 20' : `All ${results.length}`}
                </button>
              )}
              {yourHand.length > 0 && <span className="text-gray-700">· click row to apply</span>}
            </span>
          </div>
          {yourHand.length > 0 && (
            <div className="mb-3 rounded-lg border border-gray-800 bg-gray-950/40 p-2.5">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[10px] uppercase tracking-widest text-gray-500">Look up a line</span>
                {Object.keys(lineAssign).length > 0 && (
                  <button
                    onClick={() => setLineAssign({})}
                    className="px-2 py-0.5 text-[10px] rounded border border-gray-700 bg-gray-800 text-gray-500 hover:text-gray-300"
                  >
                    Reset
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2.5">
                {yourHand.map((c, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className={`text-[11px] font-semibold w-6 ${suitColor(c.suit)}`}>{cardLabel(c)}</span>
                    <div className="flex rounded overflow-hidden border border-gray-700">
                      {(street === 0
                        ? ([['top', 'T'], ['mid', 'M'], ['bot', 'B']] as const)
                        : ([['top', 'T'], ['mid', 'M'], ['bot', 'B'], ['disc', '×']] as const)
                      ).map(([slot, lbl]) => (
                        <button
                          key={slot}
                          onClick={() => setLineAssign(prev => {
                            const next = { ...prev }
                            if (next[i] === slot) delete next[i]
                            else next[i] = slot
                            return next
                          })}
                          className={[
                            'px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                            lineAssign[i] === slot
                              ? (slot === 'disc' ? 'bg-rose-800 text-white' : 'bg-indigo-700 text-white')
                              : 'bg-gray-800 text-gray-500 hover:text-gray-300',
                          ].join(' ')}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {lineLookup && (
                <div className="mt-2 text-[11px]">
                  {lineLookup.status === 'incomplete' && (
                    <span className="text-gray-600">
                      Assign every card — {lineLookup.assigned}/{lineLookup.total} placed
                    </span>
                  )}
                  {lineLookup.status === 'noResults' && (
                    <span className="text-gray-600">Run Analyze to price this line.</span>
                  )}
                  {lineLookup.status === 'missing' && (
                    <span className="text-amber-500/80">
                      Not a legal line here{analyzerPolicy === 'nn' ? ', or outside the candidates NN + MCTS explored' : ''}.
                    </span>
                  )}
                  {lineLookup.status === 'found' && (() => {
                    const gap = lineLookup.sp.ev - bestEV
                    return (
                      <div className="flex items-center gap-3 tabular-nums">
                        <span className="text-gray-500">
                          rank <span className="text-gray-300 font-semibold">{lineLookup.rank}</span>
                          <span className="text-gray-700">/{lineLookup.total}</span>
                        </span>
                        <span className={lineLookup.sp.ev > 0 ? 'text-green-400' : lineLookup.sp.ev < 0 ? 'text-red-400' : 'text-gray-300'}>
                          EV <span className="font-semibold">{lineLookup.sp.ev > 0 ? '+' : ''}{lineLookup.sp.ev.toFixed(2)}</span>
                        </span>
                        <span className={gap < -0.005 ? 'text-red-400' : 'text-gray-500'}>
                          {gap < -0.005 ? `${gap.toFixed(2)} vs best` : 'this is the best line'}
                        </span>
                        <span className="text-gray-700">{lineLookup.sp.n} sims</span>
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-800/60">
                  <th className="px-1.5 py-1 font-medium">#</th>
                  <th className="px-1.5 py-1 font-medium">Top</th>
                  <th className="px-1.5 py-1 font-medium">Mid</th>
                  <th className="px-1.5 py-1 font-medium">Bot</th>
                  <th className="px-1.5 py-1 font-medium">Disc</th>
                  <th className="px-1.5 py-1 font-medium text-right">{analyzerPolicy === 'royalty' ? 'Gap' : 'EV'}</th>
                  {analyzerPolicy !== 'royalty' && <th className="px-1.5 py-1 font-medium text-right">Gap</th>}
                </tr>
              </thead>
              <tbody>
                {(showAllRows ? results : results.slice(0, 20)).map((sp, i) => {
                  const gap = sp.ev - bestEV
                  const isRoyalty = analyzerPolicy === 'royalty'
                  const displayEV = isRoyalty ? gap : sp.ev
                  return (
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
                      <td className={`px-1.5 py-1 text-right tabular-nums font-semibold ${
                        isRoyalty
                          ? (i === 0 ? 'text-gray-300' : 'text-red-400')
                          : (displayEV > 0 ? 'text-green-400' : displayEV < 0 ? 'text-red-400' : 'text-gray-300')
                      }`}>
                        {isRoyalty
                          ? (i === 0 ? 'best' : displayEV.toFixed(1))
                          : `${displayEV > 0 ? '+' : ''}${displayEV.toFixed(2)}`
                        }
                      </td>
                      {!isRoyalty && (
                        <td className="px-1.5 py-1 text-right tabular-nums text-gray-500">
                          {i === 0 ? '—' : gap.toFixed(2)}
                        </td>
                      )}
                    </tr>
                  )
                })}
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
    // No real opponents exist here (manual position entry, no game/table) —
    // empty array falls back to the generic field (bonusOpponentScoring.ts)
    // rather than skipping kicker-aware tie-breaking. Routed through the
    // worker per the engine-boundary rule (this used to call bestBonusBoard
    // directly on the main thread).
    workerClient.solveBonus(cards, numDiscard, [], Date.now() & 0xffffffff)
      .then(setResult)
      .catch(e => console.error('solveBonus error', e))
      .finally(() => setSolving(false))
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
