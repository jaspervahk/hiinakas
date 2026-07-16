import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { GamePlayView } from './GamePlayView'
import { useReplayGame } from '../game/useReplayGame'
import { buildHandReplayData, buildReplayQueue } from '../game/replayBuilder'
import type { HandReplayData } from '../game/replayBuilder'
import type { ReviewDecision } from '../game/sessionAnalysisTypes'
import type { BonusDecisionPoint, GameSummary } from '../game/sessionParser'

interface ReplaySessionProps {
  username: string
  summaries: GameSummary[]
  streetDecisions: ReviewDecision[]
  bonusBoardDecisions: BonusDecisionPoint[]
  onClose: () => void
}

function noopNavigate() {}

export function ReplaySession({ username, summaries, streetDecisions, bonusBoardDecisions, onClose }: ReplaySessionProps) {
  const queue = useMemo(() => buildReplayQueue(summaries, username), [summaries, username])
  const [index, setIndex] = useState(0)
  const [finished, setFinished] = useState(false)

  // Accumulated once per hand, when it first reaches bonus_scoring — keyed by
  // gameId so re-renders (or an undo back into the same hand) never double-count.
  const countedRef = useRef<Set<string>>(new Set())
  const [cumReplay, setCumReplay] = useState(0)
  const [cumActual, setCumActual] = useState(0)

  const gameId = queue[index]
  const { data: handData, error: buildError } = useMemo<{ data: HandReplayData | null; error: string | null }>(() => {
    if (!gameId) return { data: null, error: null }
    try {
      return { data: buildHandReplayData(gameId, username, streetDecisions, bonusBoardDecisions, summaries), error: null }
    } catch (e) {
      return { data: null, error: e instanceof Error ? e.message : String(e) }
    }
  }, [gameId, username, streetDecisions, bonusBoardDecisions, summaries])

  const [state, dispatch, { canUndo, undo }] = useReplayGame(handData)

  const isLast = index >= queue.length - 1
  const atScoring = state.phase === 'bonus_scoring'

  useEffect(() => {
    if (!atScoring || !gameId || !handData) return
    if (countedRef.current.has(gameId)) return
    countedRef.current.add(gameId)
    setCumReplay(c => c + (state.totalScores[0] ?? 0))
    setCumActual(c => c + handData.replay.historicalTotal)
  }, [atScoring, gameId, handData, state.totalScores])

  const goNext = () => {
    if (isLast) { setFinished(true); return }
    setIndex(i => i + 1)
  }
  const skip = () => {
    if (isLast) { setFinished(true); return }
    setIndex(i => i + 1)
  }

  if (queue.length === 0) {
    return (
      <Overlay>
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-gray-400">No hands found for {username} in this session.</p>
          <button onClick={onClose} className="px-6 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg text-sm">Close</button>
        </div>
      </Overlay>
    )
  }

  if (finished) {
    const diff = cumReplay - cumActual
    return (
      <Overlay>
        <div className="flex flex-col items-center gap-4 text-center max-w-sm">
          <h2 className="text-lg font-semibold text-gray-200">Replay complete</h2>
          <p className="text-gray-500 text-xs">{queue.length} hand{queue.length === 1 ? '' : 's'} replayed for {username}</p>
          <div className="flex gap-6">
            <div className="flex flex-col items-center">
              <span className="text-[10px] uppercase tracking-widest text-gray-600">Actual</span>
              <span className={`text-xl font-bold ${cumActual >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{cumActual > 0 ? '+' : ''}{cumActual}</span>
            </div>
            <div className="flex flex-col items-center">
              <span className="text-[10px] uppercase tracking-widest text-gray-600">Replay</span>
              <span className={`text-xl font-bold ${cumReplay >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{cumReplay > 0 ? '+' : ''}{cumReplay}</span>
            </div>
          </div>
          <p className={`text-sm font-medium ${diff > 0 ? 'text-emerald-400' : diff < 0 ? 'text-red-400' : 'text-gray-400'}`}>
            {diff > 0 ? `+${diff} better than what actually happened` : diff < 0 ? `${diff} worse than what actually happened` : 'Same as what actually happened'}
          </p>
          <button onClick={onClose} className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg text-sm">Done</button>
        </div>
      </Overlay>
    )
  }

  if (buildError) {
    return (
      <Overlay>
        <div className="flex flex-col items-center gap-4 text-center max-w-sm">
          <p className="text-gray-400 text-sm">Couldn't replay this hand — {buildError}</p>
          <button onClick={skip} className="px-6 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg text-sm">
            {isLast ? 'Finish' : 'Skip →'}
          </button>
        </div>
      </Overlay>
    )
  }

  return (
    <Overlay noPad>
      <div className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800 text-xs text-gray-400">
        <span>Replaying {username} — hand {index + 1} of {queue.length}</span>
        {atScoring && handData && (
          <span className="tabular-nums">
            actual {handData.replay.historicalTotal > 0 ? '+' : ''}{handData.replay.historicalTotal} · replay {(state.totalScores[0] ?? 0) > 0 ? '+' : ''}{state.totalScores[0] ?? 0}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0">
        <GamePlayView
          state={state}
          dispatch={dispatch}
          canUndo={canUndo}
          undo={undo}
          onNavigate={noopNavigate}
          currentPage="game"
          onQuit={onClose}
          renderPostHandActions={() => (
            <button
              onClick={goNext}
              className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg transition-colors text-sm"
            >
              {isLast ? 'Finish' : 'Next hand →'}
            </button>
          )}
        />
      </div>
    </Overlay>
  )
}

function Overlay({ children, noPad }: { children: ReactNode; noPad?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 bg-gray-950 flex flex-col items-center justify-center overflow-y-auto">
      <div className={noPad ? 'w-full h-full flex flex-col' : 'p-6'}>
        {children}
      </div>
    </div>
  )
}
