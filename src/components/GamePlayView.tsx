import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import { bonusTrigger, isFoul, royalties, bestBonusBoard } from '../engine/index'
import type { Board, PartialBoard, Card, InfoState, Placement } from '../engine/index'
import { BoardView } from './BoardView'
import { HandView } from './HandView'
import { ScoreView } from './ScoreView'
import { CoachPanel } from './CoachPanel'
import { useCoach } from '../coach/useCoach'
import { botWorkerClient } from '../worker/client'
import type { AppPage } from '../App'
import type { StreetLog, HandLog, GameState } from '../game/types'
import type { Action } from '../game/reducer'
import type { UndoControls } from '../game/useGame'
import { saveHand } from '../firestore/persistence'
import { analyzerBridge } from '../game/analyzerBridge'

function playerLabels(playerCount: number): string[] {
  return playerCount === 2 ? ['You', 'Bot'] : ['You', 'Bot 1', 'Bot 2']
}

function bonusQualifierLabel(q: string): string {
  if (q === 'QQ') return 'Queens+ — 13 cards, 0 discards'
  if (q === 'KK') return 'Kings+ — 14 cards, 1 discard'
  return 'Aces / Trips — 15 cards, 2 discards'
}

function sameCard(a: Card, b: Card): boolean {
  return a.rank === b.rank && a.suit === b.suit
}

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

function makeHandId(seed: number): string {
  return `h-${seed}-${Math.random().toString(36).slice(2, 8)}`
}

export interface GamePlayViewProps {
  state: GameState
  dispatch: (action: Action) => void
  canUndo: boolean
  undo: UndoControls['undo']
  onNavigate: (p: AppPage) => void
  currentPage: AppPage
  // Replay overrides — omitted for live play, which preserves exact current behavior.
  onQuit?: () => void
  renderPostHandActions?: () => ReactNode
}

// Renders every phase of an in-progress hand (placing/bot_thinking/revealing/
// scoring/bonus_oneshot/bonus_scoring) — shared by the live GamePage and
// ReplaySession. Behavior branches on `state.replay` wherever a replayed hand
// must differ from live play (frozen opponent moves, no hand-history writes).
export function GamePlayView({ state, dispatch, canUndo, undo, onNavigate, currentPage, onQuit, renderPostHandActions }: GamePlayViewProps) {
  const labels = playerLabels(state.playerCount)
  const botCount = state.playerCount - 1
  const botLabels = labels.slice(1)

  const { coachMode, botPolicy, coachSims, coachRootTopK, botSims, botRootTopK } = state.appSettings
  const coach = useCoach(
    state, state.appSettings.coachEnabled, coachSims, coachMode, undefined,
    coachMode === 'nn' ? coachRootTopK : undefined,
  )

  // Best bonus board (for bonus_oneshot coaching)
  const bonusOptimal = useMemo<PartialBoard | null>(() => {
    if (state.phase !== 'bonus_oneshot') return null
    if (state.humanBonusCards.length === 0) return null
    const q = state.humanBonusQualifier
    if (!q) return null
    const discardCount = q === 'QQ' ? 0 : q === 'KK' ? 1 : 2
    try {
      return bestBonusBoard(state.humanBonusCards, discardCount)
    } catch (e) {
      console.error('bestBonusBoard failed', e)
      return null
    }
  }, [state.phase, state.humanBonusCards, state.humanBonusQualifier])

  const lockAfterAnalyzerRef = useRef(false)

  // Save hand on bonus_scoring entry (fire-and-forget). Never during replay —
  // a replayed hand must not pollute the user's real Stats-page history.
  const savedRef = useRef<string | null>(null)
  useEffect(() => {
    if (state.phase !== 'bonus_scoring') return
    if (state.replay) return
    const handKey = `${state.seed}`
    if (savedRef.current === handKey) return
    savedRef.current = handKey

    const humanBoard = state.humanBoard as Board
    const humanFouled = humanBoard.top.length === 3 ? isFoul(humanBoard) : false
    const humanRoyalties = !humanFouled && humanBoard.top.length === 3 ? royalties(humanBoard) : 0
    const cumEvLoss = state.currentStreetLogs.reduce((a, l) => a + l.evGap, 0)
    const log: HandLog = {
      id: makeHandId(state.seed),
      timestamp: Date.now(),
      seed: state.seed,
      playerCount: state.playerCount,
      streets: state.currentStreetLogs,
      normalScores: state.normalScores,
      bonusScores: state.bonusScores,
      totalScores: state.totalScores,
      humanFouled,
      humanRoyalties,
      cumEvLoss,
    }
    void saveHand(log)
  }, [state.phase, state.replay, state.seed, state.humanBoard, state.normalScores, state.bonusScores, state.totalScores, state.playerCount, state.currentStreetLogs])

  // Precomputed bot placements — set during placing phase, consumed in bot_thinking.
  const botResultRef = useRef<Placement[] | null>(null)
  const botPromiseRef = useRef<Promise<Placement[]> | null>(null)

  // ── Precompute bot moves during placing (runs in parallel with coach) ─────
  // The bot sees the board at the START of the street — before the human places
  // this street's cards. That is the correct information set in simultaneous OFC.
  // Skipped entirely during replay: opponents always replay frozen historical
  // placements, never a freshly computed move.
  useEffect(() => {
    if (state.phase !== 'placing' || state.context !== 'normal') return
    if (state.replay) return
    let cancelled = false
    // Clear stale results from the previous street at the start of each new street.
    botResultRef.current = null
    botPromiseRef.current = null

    const { botBoards, preDealt, street, humanBoard, playerCount } = state
    const promises: Promise<Placement>[] = []

    for (let i = 0; i < playerCount - 1; i++) {
      const otherBotBoards = botBoards.filter((_, j) => j !== i)
      const infoState: InfoState = {
        board: botBoards[i]!,
        hand: preDealt[i + 1]![street]!,
        street,
        // Human board at START of street (before human places this street's cards).
        revealedOpponentBoards: [humanBoard, ...otherBotBoards],
      }
      const seed = ((state.seed ^ (street * 0x9e3779b9)) + i * 0x517cc1b7) | 0
      promises.push(botWorkerClient.getBotMove(infoState, botSims, seed, botPolicy, botPolicy === 'nn' ? botRootTopK : undefined))
    }

    const all = Promise.all(promises)
    botPromiseRef.current = all
    all.then(placements => {
      if (!cancelled) botResultRef.current = placements
    }).catch(err => {
      console.error('Bot precompute failed:', err)
    })

    return () => {
      cancelled = true
      // Do NOT clear botResultRef.current here — bot_thinking reads it after this cleanup runs.
      // botPromiseRef is kept as fallback if lock-in fires before computation finishes.
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.street, state.context, state.replay])

  // ── Bot thinking: use precomputed result, await the in-flight promise, or
  // (replay) resolve instantly with the frozen historical placement ─────────
  useEffect(() => {
    if (state.phase !== 'bot_thinking') return

    if (state.replay) {
      const placements = state.replay.opponentNormalPlacements.map(p => p[state.street]!)
      dispatch({ type: 'BOT_PLACED', placements })
      return
    }

    let cancelled = false

    const finish = (placements: Placement[]) => {
      if (!cancelled) {
        botResultRef.current = null
        botPromiseRef.current = null
        dispatch({ type: 'BOT_PLACED', placements })
      }
    }

    const result = botResultRef.current
    if (result) {
      // Already computed during placing — reveal instantly.
      finish(result)
      return
    }

    const promise = botPromiseRef.current
    if (promise) {
      promise.then(finish).catch(err => console.error('Bot move failed:', err))
    }

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase])

  // ── Lock-in with coach logging ────────────────────────────────────────────
  function lockInWithLog() {
    if (state.phase === 'placing') {
      const isStreet0 = state.context === 'normal' ? state.street === 0 : state.sideStreet === 0
      const expectedDealt =
        state.context === 'normal'
          ? state.preDealt[0]?.[state.street]
          : state.sidePreDealt[0]?.[state.sideStreet]
      const dealt: Card[] = expectedDealt ? [...expectedDealt] : []
      const discard: Card | null = !isStreet0 && state.humanHand.length > 0 ? state.humanHand[0]! : null

      const evList = coach.placements
      let chosenEV = 0
      let bestEV = 0
      let evGap = 0
      if (evList.length > 0) {
        bestEV = evList[0]!.ev
        const matched = evList.find(sp =>
          sameUnordered(sp.placement.topAdd, state.pending.top) &&
          sameUnordered(sp.placement.middleAdd, state.pending.middle) &&
          sameUnordered(sp.placement.bottomAdd, state.pending.bottom),
        )
        chosenEV = matched ? matched.ev : bestEV
        evGap = bestEV - chosenEV
      }

      const log: StreetLog = {
        street: state.context === 'normal' ? state.street : state.sideStreet,
        context: state.context,
        dealt,
        topAdd: [...state.pending.top],
        middleAdd: [...state.pending.middle],
        bottomAdd: [...state.pending.bottom],
        discard,
        evList,
        chosenEV,
        bestEV,
        evGap,
      }
      dispatch({ type: 'RECORD_STREET_LOG', log })
    }
    dispatch({ type: 'LOCK_IN' })
  }

  // Apply analyzer placement when returning from analyzer page
  useEffect(() => {
    if (currentPage !== 'game') return
    const pl = analyzerBridge.pendingPlacement
    if (!pl) return
    analyzerBridge.pendingPlacement = null
    lockAfterAnalyzerRef.current = true
    dispatch({ type: 'APPLY_COACH_PLACEMENT', placement: pl })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage])

  // Auto lock-in once the analyzer-chosen placement fills all required slots
  useEffect(() => {
    if (!lockAfterAnalyzerRef.current) return
    if (state.phase !== 'placing') return
    const total = state.pending.top.length + state.pending.middle.length + state.pending.bottom.length
    const st = state.context === 'side' ? state.sideStreet : state.street
    if (total !== (st === 0 ? 5 : 2)) return
    lockAfterAnalyzerRef.current = false
    lockInWithLog()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.pending, state.phase])

  // ── Normal scoring ────────────────────────────────────────────────────────
  if (state.phase === 'scoring') {
    const boards = [state.humanBoard, ...state.botBoards] as Board[]
    const hasBonus = boards.some(b => bonusTrigger(b) !== null)
    return (
      <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-6">
        <ScoreView
          title="Round complete"
          boards={boards}
          scores={state.normalScores}
          labels={labels}
          showRoyalties
          onContinue={() => dispatch({ type: hasBonus ? 'START_BONUS' : 'SKIP_BONUS' })}
          continueLabel={hasBonus ? 'Bonus round' : 'See review'}
        />
      </div>
    )
  }

  // ── Bonus one-shot placement ──────────────────────────────────────────────
  if (state.phase === 'bonus_oneshot') {
    const totalPending = state.pending.top.length + state.pending.middle.length + state.pending.bottom.length
    const canLock = totalPending === 13
    const qualifier = state.humanBonusQualifier ?? ''

    return (
      <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center gap-6 p-4 pt-8">
        <div className="flex flex-col items-center gap-1">
          <span className="text-lg font-semibold text-amber-400">Bonus Round</span>
          <span className="text-gray-500 text-xs">{bonusQualifierLabel(qualifier)}</span>
        </div>

        <BoardView
          board={state.humanBonusBoard}
          pending={state.pending}
          label="Your bonus board"
          isHuman
          cardSelected={!!state.selectedCard && !canLock}
          onRowClick={row => dispatch({ type: 'ASSIGN_TO_ROW', row })}
          onPendingRemove={(row, idx) => dispatch({ type: 'REMOVE_PENDING', row, index: idx })}
          showLiveFoul={!!state.selectedCard || totalPending > 0}
        />

        <div className="flex flex-col items-center gap-3">
          {!canLock && (
            <HandView
              cards={state.humanHand}
              selected={state.selectedCard}
              onSelect={card => dispatch({ type: 'SELECT_CARD', card })}
            />
          )}

          {state.selectedCard && !canLock && (
            <p className="text-xs text-indigo-400">Click a highlighted row to place</p>
          )}

          {!state.selectedCard && state.humanHand.length > 0 && !canLock && (
            <p className="text-xs text-gray-600">Select a card, then click a row</p>
          )}

          {!state.selectedCard && totalPending > 0 && !canLock && (
            <p className="text-xs text-gray-600">Click a green card on the board to return it</p>
          )}

          <button
            onClick={() => dispatch({ type: 'LOCK_BONUS_ONESHOT' })}
            disabled={!canLock}
            className={[
              'px-8 py-2.5 font-medium rounded-lg transition-colors text-sm',
              canLock
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer'
                : 'bg-gray-800 text-gray-600 cursor-not-allowed',
            ].join(' ')}
          >
            Lock bonus board — {totalPending}/13 placed
          </button>
        </div>

        {state.appSettings.coachEnabled && bonusOptimal && (
          <div className="w-full max-w-md">
            <div className="rounded-xl border border-amber-700/40 bg-amber-950/20 p-3">
              <div className="text-xs uppercase tracking-widest text-amber-300 mb-2 font-semibold">Optimal board</div>
              <BoardView board={bonusOptimal} />
              <div className="mt-2 text-[11px] text-amber-200 tabular-nums">
                +{royalties(bonusOptimal as Board)} royalties
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Bonus final scoring / Post-hand review ───────────────────────────────
  if (state.phase === 'bonus_scoring') {
    const hasBonus = state.bonusScores.some(s => s !== 0)
    return (
      <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center gap-10 p-6 pt-10">
        {hasBonus && (
          <ScoreView
            title="Bonus round"
            boards={[state.humanBonusBoard, ...state.botBonusBoards] as Board[]}
            scores={state.bonusScores}
            labels={labels}
            showRoyalties
            onContinue={() => {}}
          />
        )}

        <div className="flex flex-col items-center gap-4 w-full max-w-xs">
          <h2 className="text-lg font-semibold text-gray-200">Session totals</h2>
          <div className="bg-gray-900 rounded-xl border border-gray-700/60 overflow-hidden w-full">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-700/60">
                  <th className="text-left px-4 py-2.5 text-gray-500 font-medium">Player</th>
                  <th className="text-right px-3 py-2.5 text-gray-500 font-medium">Round</th>
                  {hasBonus && <th className="text-right px-3 py-2.5 text-gray-500 font-medium">Bonus</th>}
                  <th className="text-right px-4 py-2.5 text-gray-500 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {labels.map((lbl, i) => {
                  const norm = state.normalScores[i] ?? 0
                  const bon = state.bonusScores[i] ?? 0
                  const total = state.totalScores[i] ?? 0
                  return (
                    <tr key={i} className="border-b border-gray-800/60 last:border-0">
                      <td className="px-4 py-2.5 text-gray-300">{lbl}</td>
                      <td className={`px-3 py-2.5 text-right text-xs ${norm > 0 ? 'text-green-400' : norm < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                        {norm > 0 ? `+${norm}` : norm}
                      </td>
                      {hasBonus && (
                        <td className={`px-3 py-2.5 text-right text-xs ${bon > 0 ? 'text-amber-400' : bon < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                          {bon > 0 ? `+${bon}` : bon}
                        </td>
                      )}
                      <td className={`px-4 py-2.5 text-right font-semibold ${total > 0 ? 'text-green-400' : total < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                        {total > 0 ? `+${total}` : total}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex gap-3">
            {renderPostHandActions ? renderPostHandActions() : (
              <>
                <button
                  onClick={() => dispatch({ type: 'RESET' })}
                  className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg transition-colors text-sm"
                >
                  Menu
                </button>
                <button
                  onClick={() => onNavigate('stats')}
                  className="px-6 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 font-medium rounded-lg transition-colors text-sm"
                >
                  Stats
                </button>
                <button
                  onClick={() => onNavigate('arena')}
                  className="px-6 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 font-medium rounded-lg transition-colors text-sm"
                >
                  Arena
                </button>
              </>
            )}
          </div>
        </div>

        {state.currentStreetLogs.length > 0 && (
          <ReviewSection logs={state.currentStreetLogs} />
        )}
      </div>
    )
  }

  // ── Placing + Bot thinking + Revealing ────────────────────────────────────
  const isPlacing   = state.phase === 'placing'
  const isRevealing = state.phase === 'revealing'
  const isBotThinking = state.phase === 'bot_thinking'
  const isSide = state.context === 'side'

  const humanBoard: PartialBoard = isSide ? state.humanSideBoard : state.humanBoard
  const botDisplayBoards: PartialBoard[] = isSide
    ? state.botBonusQualifiers.map((q, i) =>
        q ? (state.botBonusBoards[i] ?? state.botSideBoards[i]!) : state.botSideBoards[i]!
      )
    : state.botBoards

  const currentStreet = isSide ? state.sideStreet : state.street
  const isLastStreet  = currentStreet === 4
  const isStreet0     = currentStreet === 0

  const totalPending = state.pending.top.length + state.pending.middle.length + state.pending.bottom.length
  const requiredPending = isStreet0 ? 5 : 2
  const canLockIn   = isPlacing && totalPending === requiredPending

  const autoDiscardIndex = !isStreet0 && totalPending === 2 && state.humanHand.length === 1 ? 0 : undefined

  const advanceLabel = isLastStreet
    ? (isSide ? 'Calculate bonus' : 'See scores')
    : 'Next street'

  const roundLabel = isSide ? 'Bonus side game' : 'Hiinakas'
  const streetLabel = `Street ${currentStreet + 1} / 5`

  const coachToggle = () => dispatch({ type: 'UPDATE_SETTINGS', settings: { coachEnabled: !state.appSettings.coachEnabled } })
  const coachModeChange = (m: typeof coachMode) => dispatch({ type: 'UPDATE_SETTINGS', settings: { coachMode: m } })
  const coachSelect = (p: Placement) => dispatch({ type: 'APPLY_COACH_PLACEMENT', placement: p })

  return (
    <div className="h-dvh bg-gray-950 text-white flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-800/80 flex-shrink-0">
        <button
          onClick={onQuit ?? (() => dispatch({ type: 'RESET' }))}
          className="text-gray-600 hover:text-gray-400 text-sm transition-colors"
        >
          Quit
        </button>
        <div className="flex flex-col items-center">
          <span className="text-sm font-semibold text-gray-300">{roundLabel}</span>
          {isSide && <span className="text-xs text-amber-500">Bonus side game</span>}
        </div>
        <div className="flex items-center gap-3">
          {canUndo && (isRevealing || isBotThinking) && (
            <button
              onClick={undo}
              className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
            >
              ↩ Undo
            </button>
          )}
          <span className="text-xs text-gray-500 tabular-nums">{streetLabel}</span>
        </div>
      </header>

      {/* Body: side-by-side on desktop, stacked on mobile */}
      <div className="flex-1 min-h-0 flex overflow-hidden">

        {/* Left column: boards + action */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">

          {/* Scrollable boards area */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="flex flex-col gap-4 p-4 max-w-5xl mx-auto w-full">
              {/* Bot boards */}
              <div>
                <p className="text-[11px] text-gray-600 uppercase tracking-widest mb-2">
                  {botCount === 1 ? 'Opponent' : 'Opponents'}
                </p>
                <div className="flex gap-3 flex-wrap">
                  {botDisplayBoards.map((board, i) => (
                    <BoardView
                      key={i}
                      board={board}
                      label={botLabels[i]}
                      showStatus={isRevealing || isLastStreet}
                    />
                  ))}
                </div>
              </div>

              <div className="border-t border-gray-800/60" />

              <div>
                <p className="text-[11px] text-gray-600 uppercase tracking-widest mb-2">You</p>
                <BoardView
                  board={humanBoard}
                  pending={isPlacing ? state.pending : undefined}
                  label={undefined}
                  isHuman
                  cardSelected={isPlacing && !!state.selectedCard}
                  onRowClick={row => dispatch({ type: 'ASSIGN_TO_ROW', row })}
                  onPendingRemove={(row, idx) => dispatch({ type: 'REMOVE_PENDING', row, index: idx })}
                  showStatus={isRevealing}
                  showLiveFoul={isPlacing && (!!state.selectedCard || totalPending > 0)}
                />
              </div>
            </div>
          </div>

          {/* Sticky bottom action area */}
          <div className="flex-shrink-0 border-t border-gray-800/60 bg-gray-950 overflow-y-auto" style={{ maxHeight: '55vh' }}>
            {isPlacing && (
              <div className="flex flex-col items-center gap-3 px-4 pt-3 pb-4">
                <p className="text-xs text-gray-500">
                  {isStreet0
                    ? 'Place all 5 cards'
                    : state.humanHand.length === 1
                      ? 'Last card auto-discarded — ready to lock'
                      : 'Place 2 cards — the third will be discarded'}
                </p>

                <HandView
                  cards={state.humanHand}
                  selected={state.selectedCard}
                  onSelect={card => dispatch({ type: 'SELECT_CARD', card })}
                  discardIndex={autoDiscardIndex}
                />

                {state.selectedCard && (
                  <p className="text-xs text-indigo-400">Click a highlighted row above to place</p>
                )}
                {!state.selectedCard && totalPending > 0 && (
                  <p className="text-xs text-gray-600">Click a green card on your board to return it to hand</p>
                )}

                <div className="flex gap-2 items-center">
                  <button
                    onClick={lockInWithLog}
                    disabled={!canLockIn}
                    className={[
                      'px-8 py-2.5 font-medium rounded-lg transition-colors text-sm',
                      canLockIn
                        ? 'bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer'
                        : 'bg-gray-800 text-gray-600 cursor-not-allowed',
                    ].join(' ')}
                  >
                    {canLockIn ? 'Lock in' : `Lock in (${totalPending} / ${requiredPending})`}
                  </button>
                  <button
                    onClick={() => {
                      // In side game, bonus-qualified bots play a separate game with
                      // a fresh deck — exclude them from the opponent pool entirely.
                      const sideOppBoards = isSide
                        ? state.botBonusQualifiers
                            .map((q, i) => q ? null : state.botSideBoards[i]!)
                            .filter((b): b is PartialBoard => b !== null)
                        : botDisplayBoards
                      analyzerBridge.initialState = {
                        board: humanBoard,
                        hand: [...state.humanHand],
                        street: currentStreet,
                        revealedOpponentBoards: sideOppBoards.map(b => ({
                          top: [...b.top],
                          middle: [...b.middle],
                          bottom: [...b.bottom],
                        })),
                      }
                      analyzerBridge.pendingPlacement = null
                      onNavigate('analyzer')
                    }}
                    className="px-4 py-2.5 text-xs font-medium rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
                  >
                    Analyse
                  </button>
                </div>

                {/* Coach panel — mobile only; desktop shows it in the right sidebar */}
                <div className="w-full max-w-2xl md:hidden">
                  <CoachPanel
                    result={coach}
                    mode={coachMode}
                    onModeChange={coachModeChange}
                    enabled={state.appSettings.coachEnabled}
                    onToggle={coachToggle}
                    onSelectPlacement={coachSelect}
                  />
                </div>
              </div>
            )}

            {isBotThinking && (
              <div className="flex flex-col items-center gap-2 px-4 py-4">
                <div className="flex items-center gap-2 text-gray-400 text-sm">
                  <span className="inline-block w-4 h-4 border-2 border-gray-600 border-t-indigo-400 rounded-full animate-spin" />
                  Bot thinking…
                </div>
              </div>
            )}

            {isRevealing && (
              <div className="flex flex-col items-center gap-3 px-4 pt-3 pb-4">
                <p className="text-xs text-gray-500">
                  {isLastStreet ? 'All cards placed — scoring next' : 'All placed — boards revealed'}
                </p>
                <button
                  onClick={() => dispatch({ type: 'ADVANCE' })}
                  className="px-8 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg transition-colors text-sm"
                >
                  {advanceLabel}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right sidebar: EV coach — desktop only */}
        <div className="hidden md:flex flex-col w-80 lg:w-96 border-l border-gray-800/60 flex-shrink-0 overflow-y-auto bg-gray-950">
          <div className="p-4">
            <CoachPanel
              result={coach}
              mode={coachMode}
              onModeChange={coachModeChange}
              enabled={state.appSettings.coachEnabled}
              onToggle={coachToggle}
              onSelectPlacement={isPlacing ? coachSelect : undefined}
            />
          </div>
        </div>

      </div>
    </div>
  )
}

// ── Review section (post-hand) ──────────────────────────────────────────────

function ReviewSection({ logs }: { logs: readonly StreetLog[] }) {
  const cum = logs.reduce((a, l) => a + l.evGap, 0)
  return (
    <div className="w-full max-w-2xl">
      <h2 className="text-xs uppercase tracking-widest text-gray-500 mb-2">Review</h2>
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-800/60 text-gray-500">
              <th className="text-left px-3 py-2 font-medium">Street</th>
              <th className="text-left px-3 py-2 font-medium">Context</th>
              <th className="text-right px-3 py-2 font-medium">Chosen EV</th>
              <th className="text-right px-3 py-2 font-medium">Best EV</th>
              <th className="text-right px-3 py-2 font-medium">Gap</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l, i) => (
              <tr key={i} className="border-b border-gray-800/40 last:border-0">
                <td className="px-3 py-2 text-gray-300 tabular-nums">{l.street + 1}</td>
                <td className="px-3 py-2 text-gray-500">{l.context}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-300">{l.chosenEV.toFixed(2)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-gray-400">{l.bestEV.toFixed(2)}</td>
                <td className={`px-3 py-2 text-right tabular-nums font-semibold ${l.evGap > 0.5 ? 'text-red-400' : l.evGap > 0.1 ? 'text-amber-400' : 'text-gray-500'}`}>
                  {l.evGap.toFixed(2)}
                </td>
              </tr>
            ))}
            <tr className="bg-gray-950/50">
              <td colSpan={4} className="px-3 py-2 text-right text-gray-500 text-[11px] uppercase tracking-widest">Cumulative EV loss</td>
              <td className={`px-3 py-2 text-right tabular-nums font-semibold ${cum > 1 ? 'text-red-400' : cum > 0.25 ? 'text-amber-400' : 'text-gray-400'}`}>
                {cum.toFixed(2)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
