// Runs a player's whole historical session through one of Hiinakas's own bot
// policies (Heuristic / NN+MCTS / Royalty), entirely client-side, to see how
// that policy would have scored against the same deals and the same frozen
// opponents. Reuses the exact same HandReplayData the interactive Replay
// feature and the Huub-challenge bridge both build (replayBuilder.ts) — this
// overlay only adds the batch loop and the policy/sims picker (mirrored from
// SessionTab's EV Analysis controls).
//
// Hands are appended to `results` as each one finishes simulating (not just
// once the whole run is done), so the completed-so-far list is always
// browsable — expanding a row shows every board that hand produced: the
// bot's own final board, the target's real historical board, and any
// bonus/side-game board anyone at the table played that hand.

import { useCallback, useMemo, useState } from 'react'
import { buildHandReplayData, buildReplayQueue, buildTargetOwnHistory, targetOwnFinalBoards } from '../game/replayBuilder'
import { simulateHandWithBot } from '../game/botSimulator'
import { botWorkerClient } from '../worker/client'
import type { BotPolicy } from '../worker/client'
import { DEFAULT_ROOT_TOP_K, DEFAULT_SIMS_FOR, MAX_SIMS_FOR } from '../worker/botPolicyDefaults'
import type { Board } from '../engine/index'
import type { ReviewDecision } from '../game/sessionAnalysisTypes'
import type { BonusDecisionPoint, GameSummary } from '../game/sessionParser'
import { CardChip } from './CandidateList'

interface BotSimulationOverlayProps {
  username: string
  summaries: GameSummary[]
  streetDecisions: ReviewDecision[]
  bonusBoardDecisions: BonusDecisionPoint[]
  onClose: () => void
}

interface HandResult {
  gameId: string
  historicalTotal: number
  botTotal: number
  myBoard: Board
  myBonusBoard: Board | null
  botBoard: Board
  botBonusBoard: Board | null
  opponentNames: string[]
  opponentBoards: Board[]
  opponentBonusBoards: (Board | null)[]
}

function formatSigned(n: number): string {
  return `${n > 0 ? '+' : ''}${n}`
}

function BoardDisplay({ board, label, color }: { board: Board; label: string; color: string }) {
  return (
    <div className="space-y-1">
      <p className={`text-[10px] uppercase tracking-wide font-medium ${color}`}>{label}</p>
      {(['top', 'middle', 'bottom'] as const).map(row => (
        <div key={row} className="flex items-center gap-1 flex-wrap">
          <span className="text-gray-600 text-[9px] w-3 shrink-0">{row[0]!.toUpperCase()}</span>
          <span className="flex gap-0.5 flex-wrap">
            {board[row].map((c, i) => <CardChip key={i} c={c} />)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function BotSimulationOverlay({
  username, summaries, streetDecisions, bonusBoardDecisions, onClose,
}: BotSimulationOverlayProps) {
  const queue = useMemo(() => buildReplayQueue(summaries, username), [summaries, username])

  const [policy, setPolicy] = useState<BotPolicy>('nn')
  const [sims, setSims] = useState(DEFAULT_SIMS_FOR.nn)
  const [rootTopK, setRootTopK] = useState(DEFAULT_ROOT_TOP_K)
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState(0)
  const [results, setResults] = useState<HandResult[]>([])
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [error, setError] = useState('')

  const setPolicyAndDefaults = (p: BotPolicy) => { setPolicy(p); setSims(DEFAULT_SIMS_FOR[p]) }

  const run = useCallback(async () => {
    if (queue.length === 0) return
    setState('running'); setError(''); setResults([]); setProgress(0); setOpenIndex(null)
    try {
      for (let i = 0; i < queue.length; i++) {
        const gameId = queue[i]!
        const hand = buildHandReplayData(gameId, username, streetDecisions, bonusBoardDecisions, summaries)
        const ownHistory = buildTargetOwnHistory(gameId, username, streetDecisions, bonusBoardDecisions)
        const own = targetOwnFinalBoards(ownHistory)
        const seed = (i * 0x9e3779b9) | 0
        const sim = await simulateHandWithBot(
          hand, policy, sims, policy === 'nn' ? rootTopK : undefined, seed,
          (...args) => botWorkerClient.getBotMove(...args),
        )
        const handResult: HandResult = {
          gameId,
          historicalTotal: hand.replay.historicalTotal,
          botTotal: sim.totalScores[0] ?? 0,
          myBoard: own.board,
          myBonusBoard: own.bonusBoard,
          botBoard: sim.board,
          botBonusBoard: sim.bonusBoard,
          opponentNames: hand.opponentNames,
          opponentBoards: sim.opponentBoards,
          opponentBonusBoards: sim.opponentBonusBoards,
        }
        setResults(prev => [...prev, handResult])
        setProgress(i + 1)
      }
      setState('done')
    } catch (e) {
      // Keep whatever hands already completed visible — only the run itself failed.
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }, [queue, username, streetDecisions, bonusBoardDecisions, summaries, policy, sims, rootTopK])

  const actualTotal = results.reduce((s, h) => s + h.historicalTotal, 0)
  const botTotal = results.reduce((s, h) => s + h.botTotal, 0)
  const diff = botTotal - actualTotal

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl p-6 max-w-2xl w-full max-h-[85vh] overflow-y-auto space-y-4 border border-gray-800">
        <div className="flex items-center justify-between">
          <h2 className="text-gray-100 font-semibold text-sm">Simulate with a bot</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xs">Close</button>
        </div>
        <p className="text-gray-500 text-xs">
          Replays {queue.length} hand{queue.length === 1 ? '' : 's'} of {username}&rsquo;s session with a bot policy
          standing in for {username} — same deals, same frozen opponents. Runs entirely in your browser; nothing is sent anywhere.
        </p>

        {state !== 'running' && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded overflow-hidden border border-gray-700 text-[10px]">
              <button
                onClick={() => setPolicyAndDefaults('nn')}
                className={`px-2 py-1 transition-colors ${policy === 'nn' ? 'bg-indigo-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                NN + MCTS
              </button>
              <button
                onClick={() => setPolicyAndDefaults('royalty')}
                className={`px-2 py-1 transition-colors ${policy === 'royalty' ? 'bg-amber-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                Royalty
              </button>
              <button
                onClick={() => setPolicyAndDefaults('heuristic')}
                className={`px-2 py-1 transition-colors ${policy === 'heuristic' ? 'bg-teal-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
              >
                Heuristic
              </button>
            </div>
            <label className="flex items-center gap-1 text-[10px] text-gray-500">
              <span>Sims</span>
              <input
                type="number"
                className="w-16 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-[10px]"
                value={sims}
                min={1}
                max={MAX_SIMS_FOR[policy]}
                onChange={e => setSims(Math.max(1, Math.min(MAX_SIMS_FOR[policy], Number(e.target.value))))}
              />
            </label>
            {policy === 'nn' && (
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
          </div>
        )}

        {state === 'running' && (
          <p className="text-gray-400 text-xs">Simulating hand {progress} of {queue.length}… ({results.length} ready to view below)</p>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}

        {results.length > 0 && (
          <div className="space-y-2">
            <p className={`text-sm font-medium ${diff > 0 ? 'text-emerald-400' : diff < 0 ? 'text-red-400' : 'text-gray-400'}`}>
              Actual {formatSigned(actualTotal)} vs bot {formatSigned(botTotal)}
              {diff !== 0 && ` (${formatSigned(diff)})`}
              {state === 'running' && <span className="text-gray-600 font-normal"> so far</span>}
            </p>
            <div className="space-y-1.5">
              {results.map((h, i) => {
                const isOpen = openIndex === i
                const hasBonus = h.myBonusBoard || h.botBonusBoard || h.opponentBonusBoards.some(b => b !== null)
                return (
                  <div key={h.gameId} className="bg-gray-950 rounded-lg border border-gray-800">
                    <button
                      onClick={() => setOpenIndex(isOpen ? null : i)}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-left"
                    >
                      <span className="text-gray-300 text-xs">Hand {i + 1}{hasBonus && <span className="ml-1.5 text-purple-400 text-[9px]">bonus</span>}</span>
                      <span className="text-[10px] font-mono">
                        <span className="text-gray-400">actual {formatSigned(h.historicalTotal)}</span>
                        <span className={`ml-2 ${h.botTotal >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>bot {formatSigned(h.botTotal)}</span>
                      </span>
                      <span className="text-gray-600 text-[10px]">{isOpen ? '▲' : '▼'}</span>
                    </button>
                    {isOpen && (
                      <div className="border-t border-gray-800 px-3 py-3 space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <BoardDisplay board={h.myBoard} label={`${username}'s actual board`} color="text-indigo-400" />
                          <BoardDisplay board={h.botBoard} label="Bot's board" color="text-teal-400" />
                          {h.opponentBoards.map((b, oi) => (
                            <BoardDisplay key={oi} board={b} label={`${h.opponentNames[oi]}'s board`} color="text-amber-400" />
                          ))}
                        </div>
                        {(h.myBonusBoard || h.botBonusBoard) && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {h.myBonusBoard && <BoardDisplay board={h.myBonusBoard} label={`${username}'s bonus board`} color="text-indigo-400" />}
                            {h.botBonusBoard && <BoardDisplay board={h.botBonusBoard} label="Bot's bonus board" color="text-teal-400" />}
                          </div>
                        )}
                        {h.opponentBonusBoards.some(b => b !== null) && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {h.opponentBonusBoards.map((b, oi) => b && (
                              <BoardDisplay key={oi} board={b} label={`${h.opponentNames[oi]}'s bonus board`} color="text-amber-400" />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="flex gap-2">
          {queue.length === 0 ? (
            <p className="text-gray-500 text-xs">No hands found for {username} in this session.</p>
          ) : state === 'done' || state === 'error' ? (
            <button onClick={() => void run()} className="flex-1 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm">
              Run again
            </button>
          ) : (
            <button
              onClick={() => void run()}
              disabled={state === 'running'}
              className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium"
            >
              {state === 'running' ? 'Simulating…' : 'Run simulation'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
