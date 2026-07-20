// Runs a player's whole historical session through one of Hiinakas's own bot
// policies (Heuristic / NN+MCTS / Royalty), entirely client-side, to see how
// that policy would have scored against the same deals and the same frozen
// opponents. Reuses the exact same HandReplayData the interactive Replay
// feature and the Huub-challenge bridge both build (replayBuilder.ts) — this
// overlay only adds the batch loop and the policy/sims picker (mirrored from
// SessionTab's EV Analysis controls).

import { useCallback, useMemo, useState } from 'react'
import { buildHandReplayData, buildReplayQueue } from '../game/replayBuilder'
import { simulateHandWithBot } from '../game/botSimulator'
import { botWorkerClient } from '../worker/client'
import type { BotPolicy } from '../worker/client'
import { DEFAULT_ROOT_TOP_K, DEFAULT_SIMS_FOR, MAX_SIMS_FOR } from '../worker/botPolicyDefaults'
import type { ReviewDecision } from '../game/sessionAnalysisTypes'
import type { BonusDecisionPoint, GameSummary } from '../game/sessionParser'

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
}

function formatSigned(n: number): string {
  return `${n > 0 ? '+' : ''}${n}`
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
  const [error, setError] = useState('')

  const setPolicyAndDefaults = (p: BotPolicy) => { setPolicy(p); setSims(DEFAULT_SIMS_FOR[p]) }

  const run = useCallback(async () => {
    if (queue.length === 0) return
    setState('running'); setError(''); setResults([]); setProgress(0)
    const out: HandResult[] = []
    try {
      for (let i = 0; i < queue.length; i++) {
        const gameId = queue[i]!
        const hand = buildHandReplayData(gameId, username, streetDecisions, bonusBoardDecisions, summaries)
        const seed = (i * 0x9e3779b9) | 0
        const sim = await simulateHandWithBot(
          hand, policy, sims, policy === 'nn' ? rootTopK : undefined, seed,
          (...args) => botWorkerClient.getBotMove(...args),
        )
        out.push({ gameId, historicalTotal: hand.replay.historicalTotal, botTotal: sim.totalScores[0] ?? 0 })
        setProgress(i + 1)
      }
      setResults(out)
      setState('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }, [queue, username, streetDecisions, bonusBoardDecisions, summaries, policy, sims, rootTopK])

  const actualTotal = results.reduce((s, h) => s + h.historicalTotal, 0)
  const botTotal = results.reduce((s, h) => s + h.botTotal, 0)
  const diff = botTotal - actualTotal

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl p-6 max-w-lg w-full max-h-[85vh] overflow-y-auto space-y-4 border border-gray-800">
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
          <p className="text-gray-400 text-xs">Simulating hand {progress} of {queue.length}…</p>
        )}
        {error && <p className="text-red-400 text-xs">{error}</p>}

        {state === 'done' && (
          <div className="space-y-2">
            <p className={`text-sm font-medium ${diff > 0 ? 'text-emerald-400' : diff < 0 ? 'text-red-400' : 'text-gray-400'}`}>
              Actual {formatSigned(actualTotal)} vs bot {formatSigned(botTotal)}
              {diff !== 0 && ` (${formatSigned(diff)})`}
            </p>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-600">
                  <th className="text-left font-normal">Hand</th>
                  <th className="text-right font-normal">Actual</th>
                  <th className="text-right font-normal">Bot</th>
                </tr>
              </thead>
              <tbody>
                {results.map((h, i) => (
                  <tr key={h.gameId} className="border-t border-gray-900">
                    <td className="py-0.5 text-gray-500">{i + 1}</td>
                    <td className="py-0.5 text-right font-mono text-gray-400">{formatSigned(h.historicalTotal)}</td>
                    <td className={`py-0.5 text-right font-mono ${h.botTotal >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {formatSigned(h.botTotal)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
