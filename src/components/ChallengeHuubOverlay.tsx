// Small overlay: pick a Huub username, send this player's whole session as a
// real cross-app replay challenge (see functions/src/replayBridge.ts and
// /Users/jaspervahk/.claude/plans/federated-doodling-zephyr.md). Reuses the
// exact same HandReplayData the local Replay feature builds (replayBuilder.ts)
// — this overlay only adds the translation to a flat per-hand payload
// (huubBridge.ts) and the network call (firestore/huubBridge.ts).

import { useCallback, useMemo, useState } from 'react'
import { buildHandReplayData, buildReplayQueue } from '../game/replayBuilder'
import { buildChallengeHandInput } from '../game/huubBridge'
import { createHuubChallenge } from '../firestore/huubBridge'
import type { ReviewDecision } from '../game/sessionAnalysisTypes'
import type { BonusDecisionPoint, GameSummary } from '../game/sessionParser'

interface ChallengeHuubOverlayProps {
  username: string
  summaries: GameSummary[]
  streetDecisions: ReviewDecision[]
  bonusBoardDecisions: BonusDecisionPoint[]
  onClose: () => void
}

export function ChallengeHuubOverlay({
  username, summaries, streetDecisions, bonusBoardDecisions, onClose,
}: ChallengeHuubOverlayProps) {
  const queue = useMemo(() => buildReplayQueue(summaries, username), [summaries, username])
  const [targetUsername, setTargetUsername] = useState('')
  const [sessionName, setSessionName] = useState(() => {
    const dateStr = summaries.length > 0 ? new Date(summaries[0]!.gameTime).toLocaleDateString() : ''
    return `${username} — ${dateStr} (${queue.length} hands)`
  })
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState('')

  const send = useCallback(async () => {
    if (!targetUsername.trim() || queue.length === 0) return
    setState('sending'); setError('')
    try {
      const hands = queue.map(gameId => {
        const handData = buildHandReplayData(gameId, username, streetDecisions, bonusBoardDecisions, summaries)
        return buildChallengeHandInput(gameId, username, summaries, handData, streetDecisions, bonusBoardDecisions)
      })
      await createHuubChallenge(targetUsername.trim(), sessionName.trim(), hands)
      setState('sent')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }, [targetUsername, sessionName, queue, username, streetDecisions, bonusBoardDecisions, summaries])

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl p-6 max-w-sm w-full space-y-4 border border-gray-800">
        <h2 className="text-gray-100 font-semibold text-sm">Challenge a Huub player</h2>
        <p className="text-gray-500 text-xs">
          Sends {queue.length} hand{queue.length === 1 ? '' : 's'} of {username}&rsquo;s session as a real challenge —
          the invited player replays each hand from {username}&rsquo;s perspective on their own Huub account. Doesn&rsquo;t
          affect their real stats.
        </p>

        {state === 'sent' ? (
          <div className="space-y-3">
            <p className="text-emerald-400 text-sm">Challenge sent ✓</p>
            <button onClick={onClose} className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium">
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-gray-500 text-xs">Huub username</span>
              <input
                autoFocus
                value={targetUsername}
                onChange={e => setTargetUsername(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
                placeholder="their Huub username"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-gray-500 text-xs">Label (optional)</span>
              <input
                value={sessionName}
                onChange={e => setSessionName(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
              />
            </label>
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <div className="flex gap-2">
              <button onClick={onClose} className="flex-1 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm">
                Cancel
              </button>
              <button
                onClick={() => void send()}
                disabled={state === 'sending' || !targetUsername.trim() || queue.length === 0}
                className="flex-1 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium"
              >
                {state === 'sending' ? 'Sending…' : 'Send challenge'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
