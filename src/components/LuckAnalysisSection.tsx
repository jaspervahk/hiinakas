// Session-wide luck analysis: for every player, walks their hand queue and
// computes per-street luck (see game/luckAnalysis.ts) — how much of their
// result came from the deal itself vs. decision quality (the latter already
// covered by the EV Analysis section above). This is the slowest analysis in
// the app (a Monte Carlo loop sampling hypothetical hands around an existing
// Monte Carlo EV computation, run per street per hand), so it streams
// per-player progress and defaults to the cheapest policy/sims.

import { useCallback, useState } from 'react'
import { computeHandLuck } from '../game/luckAnalysis'
import type { AnalyzePositionsFn } from '../game/luckAnalysis'
import { buildReplayQueue } from '../game/replayBuilder'
import { workerClient } from '../worker/client'
import type { BotPolicy } from '../worker/client'
import { DEFAULT_ROOT_TOP_K, DEFAULT_SIMS_FOR, MAX_SIMS_FOR } from '../worker/botPolicyDefaults'
import type { ReviewDecision } from '../game/sessionAnalysisTypes'
import type { BonusDecisionPoint, GameSummary } from '../game/sessionParser'

interface LuckAnalysisSectionProps {
  players: string[]
  summaries: GameSummary[]
  streetDecisions: ReviewDecision[]
  bonusBoardDecisions: BonusDecisionPoint[]
}

interface PlayerLuck {
  username: string
  totalLuck: number
  normalByStreet: number[]   // length 5, summed across all hands
  bonusTotal: number         // bonus_oneshot + side-game luck combined
  handsProcessed: number
  handsTotal: number
}

const DEFAULT_OUTER_SAMPLES = 15
const MAX_OUTER_SAMPLES = 100

function formatSigned(n: number): string {
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}`
}

const analyzePositions: AnalyzePositionsFn = (positions, rollouts, policy, rootTopK) =>
  workerClient.analyzePositions(positions, rollouts, undefined, policy, rootTopK)

export function LuckAnalysisSection({ players, summaries, streetDecisions, bonusBoardDecisions }: LuckAnalysisSectionProps) {
  const [policy, setPolicy] = useState<BotPolicy>('heuristic')
  const [sims, setSims] = useState(DEFAULT_SIMS_FOR.heuristic)
  const [rootTopK, setRootTopK] = useState(DEFAULT_ROOT_TOP_K)
  const [outerSamples, setOuterSamples] = useState(DEFAULT_OUTER_SAMPLES)
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [results, setResults] = useState<PlayerLuck[]>([])
  const [currentLabel, setCurrentLabel] = useState('')
  const [error, setError] = useState('')

  const setPolicyAndDefaults = (p: BotPolicy) => { setPolicy(p); setSims(DEFAULT_SIMS_FOR[p]) }

  const run = useCallback(async () => {
    setState('running'); setError(''); setResults([]); setCurrentLabel('')
    try {
      for (const username of players) {
        const queue = buildReplayQueue(summaries, username)
        const player: PlayerLuck = {
          username, totalLuck: 0, normalByStreet: [0, 0, 0, 0, 0], bonusTotal: 0,
          handsProcessed: 0, handsTotal: queue.length,
        }
        setResults(prev => [...prev, player])

        for (let i = 0; i < queue.length; i++) {
          const gameId = queue[i]!
          setCurrentLabel(`${username} — hand ${i + 1} of ${queue.length}`)
          const seed = ((username.length * 0x9e3779b9) ^ (i * 0x517cc1b7)) | 0
          const handLuck = await computeHandLuck(gameId, username, streetDecisions, bonusBoardDecisions, summaries, {
            policy, sims, rootTopK: policy === 'nn' ? rootTopK : undefined, outerSamples, seed, analyzePositions,
          })
          player.totalLuck += handLuck.totalLuck
          player.handsProcessed++
          for (const s of handLuck.streets) {
            if (s.segment === 'normal') player.normalByStreet[s.street]! += s.luck
            else player.bonusTotal += s.luck
          }
          setResults(prev => prev.map(p => (p.username === username ? { ...player, normalByStreet: [...player.normalByStreet] } : p)))
        }
      }
      setState('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }, [players, summaries, streetDecisions, bonusBoardDecisions, policy, sims, rootTopK, outerSamples])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-gray-300 text-sm font-medium">Luck Analysis</h3>
        <div className="flex items-center gap-2">
          {state !== 'running' && (
            <>
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
                  className="w-14 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-[10px]"
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
              <label className="flex items-center gap-1 text-[10px] text-gray-500">
                <span>Baseline samples</span>
                <input
                  type="number"
                  className="w-14 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-[10px]"
                  value={outerSamples}
                  min={1}
                  max={MAX_OUTER_SAMPLES}
                  onChange={e => setOuterSamples(Math.max(1, Math.min(MAX_OUTER_SAMPLES, Number(e.target.value))))}
                />
              </label>
            </>
          )}
          <button
            onClick={() => void run()}
            disabled={state === 'running'}
            className="px-3 py-1 rounded text-xs font-medium bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white transition-colors"
          >
            {state === 'running' ? 'Analyzing…' : results.length > 0 ? 'Rerun' : 'Run Luck Analysis'}
          </button>
        </div>
      </div>

      <p className="text-gray-600 text-[11px]">
        For every street, compares the best EV achievable from the cards you actually got against the average best EV over many
        hypothetical alternate deals from the same remaining deck — isolating variance in the deal from decision quality (already
        covered by EV Analysis above). This is the slowest analysis here; it streams results per player as they finish.
      </p>

      {state === 'running' && currentLabel && (
        <p className="text-gray-400 text-xs">{currentLabel}…</p>
      )}
      {error && <p className="text-red-400 text-xs">{error}</p>}

      {results.length > 0 && (
        <div className={`grid gap-4 ${players.length === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'}`}>
          {results.map(r => (
            <div key={r.username} className="bg-gray-900 rounded-lg p-3 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wider text-gray-300">{r.username}</p>
                {r.handsProcessed < r.handsTotal && (
                  <span className="text-[10px] text-gray-600">{r.handsProcessed}/{r.handsTotal}</span>
                )}
              </div>
              <p className={`text-xl font-bold ${r.totalLuck >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {formatSigned(r.totalLuck)}
              </p>
              <table className="w-full text-[11px]">
                <tbody>
                  {r.normalByStreet.map((luck, street) => (
                    <tr key={street} className="border-t border-gray-800">
                      <td className="py-0.5 text-gray-500">Street {street}</td>
                      <td className={`py-0.5 text-right font-mono ${luck >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {formatSigned(luck)}
                      </td>
                    </tr>
                  ))}
                  {r.bonusTotal !== 0 && (
                    <tr className="border-t border-gray-800">
                      <td className="py-0.5 text-purple-400">Bonus/side</td>
                      <td className={`py-0.5 text-right font-mono ${r.bonusTotal >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {formatSigned(r.bonusTotal)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
