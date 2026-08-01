// Standalone page (unlike the session-based Huub challenge flow in
// SessionTab.tsx) — this feature has no session dependency at all: fresh,
// freshly-dealt hands played live against a Heuristic-MC bot, not a replay of
// any specific past session. See functions/src/botChallengeBridge.ts and
// Huub's functions/src/botChallengeServer.ts for the rest of the flow.
import { useCallback, useEffect, useState } from 'react'
import type { AppPage } from '../App'
import {
  createHuubBotChallenge, getHuubBotChallengeStatus, cancelHuubBotChallenge, listSentBotChallenges,
} from '../firestore/huubBotBridge'
import type { SentBotChallenge, BotChallengeStatus } from '../firestore/huubBotBridge'

interface BotChallengesPageProps {
  onNavigate: (p: AppPage) => void
}

// Mirrors botChallengeServer.ts's own clamps exactly — kept in sync manually
// since these live in a different repo; the server re-clamps regardless.
const MIN_SIMS = 10
const MAX_SIMS = 150
const DEFAULT_SIMS = 60
const MAX_TOTAL_HANDS = 50
const DEFAULT_TOTAL_HANDS = 5

function formatSigned(n: number): string {
  return `${n > 0 ? '+' : ''}${n}`
}

type StatusEntry = BotChallengeStatus | 'loading' | 'error'

export default function BotChallengesPage({ onNavigate }: BotChallengesPageProps) {
  const [username, setUsername] = useState('')
  const [sims, setSims] = useState(DEFAULT_SIMS)
  const [totalHands, setTotalHands] = useState(DEFAULT_TOTAL_HANDS)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')

  const [challenges, setChallenges] = useState<SentBotChallenge[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [statusById, setStatusById] = useState<Map<string, StatusEntry>>(new Map())
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null)

  const refresh = useCallback(() => { void listSentBotChallenges().then(setChallenges) }, [])
  useEffect(() => { refresh() }, [refresh])

  const send = useCallback(async () => {
    if (!username.trim()) return
    setSending(true); setSendError('')
    try {
      await createHuubBotChallenge(username.trim(), sims, totalHands)
      setUsername('')
      refresh()
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }, [username, sims, totalHands, refresh])

  const toggle = async (c: SentBotChallenge) => {
    if (openId === c.id) { setOpenId(null); return }
    setOpenId(c.id)
    if (statusById.has(c.id)) return
    setStatusById(prev => new Map(prev).set(c.id, 'loading'))
    try {
      const status = await getHuubBotChallengeStatus(c.huubChallengeId)
      setStatusById(prev => new Map(prev).set(c.id, status))
    } catch {
      setStatusById(prev => new Map(prev).set(c.id, 'error'))
    }
  }

  const confirmDelete = async (c: SentBotChallenge) => {
    setDeletingId(c.id)
    setDeleteError(null)
    try {
      await cancelHuubBotChallenge(c.id)
      setChallenges(prev => (prev ?? []).filter(x => x.id !== c.id))
      setConfirmDeleteId(null)
    } catch (e) {
      setDeleteError({ id: c.id, message: e instanceof Error ? e.message : 'Failed to delete' })
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-800/80">
        <button
          onClick={() => onNavigate('game')}
          className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
        >
          ← Back
        </button>
        <span className="text-sm font-semibold text-gray-200">Bot Challenges</span>
        <span className="w-12" />
      </header>

      <div className="max-w-lg mx-auto p-4 flex flex-col gap-6">
        <section className="bg-gray-900 rounded-xl p-4 space-y-3">
          <h2 className="text-xs uppercase tracking-widest text-gray-500">Challenge a Huub player vs the bot</h2>
          <p className="text-gray-500 text-xs">
            Fresh, freshly-dealt hands — not a replay of any past session. The invited player plays live against a bot
            that computes its own placement each street (Heuristic policy — the only one ported into Huub so far).
          </p>
          <label className="block space-y-1">
            <span className="text-gray-500 text-xs">Huub username</span>
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
              placeholder="their Huub username"
            />
          </label>
          <div className="flex gap-3">
            <label className="flex-1 space-y-1">
              <span className="text-gray-500 text-xs">Sims ({MIN_SIMS}–{MAX_SIMS})</span>
              <input
                type="number"
                value={sims}
                min={MIN_SIMS}
                max={MAX_SIMS}
                onChange={e => setSims(Math.max(MIN_SIMS, Math.min(MAX_SIMS, Number(e.target.value))))}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
              />
            </label>
            <label className="flex-1 space-y-1">
              <span className="text-gray-500 text-xs">Number of hands (1–{MAX_TOTAL_HANDS})</span>
              <input
                type="number"
                value={totalHands}
                min={1}
                max={MAX_TOTAL_HANDS}
                onChange={e => setTotalHands(Math.max(1, Math.min(MAX_TOTAL_HANDS, Number(e.target.value))))}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
              />
            </label>
          </div>
          {sendError && <p className="text-red-400 text-xs">{sendError}</p>}
          <button
            onClick={() => void send()}
            disabled={sending || !username.trim()}
            className="w-full px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {sending ? 'Sending…' : 'Send challenge'}
          </button>
        </section>

        <section className="space-y-2">
          <h2 className="text-xs uppercase tracking-widest text-gray-500">Sent bot challenges</h2>
          {challenges === null && <p className="text-gray-500 text-xs">Loading…</p>}
          {challenges?.length === 0 && <p className="text-gray-500 text-xs">No bot challenges sent yet.</p>}
          {challenges?.map(c => {
            const status = statusById.get(c.id)
            const isOpen = openId === c.id
            const isConfirming = confirmDeleteId === c.id
            return (
              <div key={c.id} className="bg-gray-900 rounded-lg border border-gray-800">
                <div className="w-full flex items-center justify-between px-3 py-2">
                  <button onClick={() => void toggle(c)} className="flex-1 text-left min-w-0">
                    <p className="text-gray-200 text-xs font-medium truncate">{c.huubUsername}</p>
                    <p className="text-gray-600 text-[10px]">
                      {c.totalHands} hand{c.totalHands === 1 ? '' : 's'} · {c.sims} sims · {new Date(c.createdAt).toLocaleDateString()}
                    </p>
                  </button>
                  {isConfirming ? (
                    <span className="flex items-center gap-1.5 shrink-0 ml-2">
                      <span className="text-red-400 text-[10px]">Delete?</span>
                      <button
                        onClick={() => void confirmDelete(c)}
                        disabled={deletingId === c.id}
                        className="text-[10px] text-red-400 hover:text-red-300 font-medium"
                      >
                        {deletingId === c.id ? '…' : 'Yes'}
                      </button>
                      <button onClick={() => setConfirmDeleteId(null)} className="text-[10px] text-gray-500 hover:text-gray-300">
                        No
                      </button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2 shrink-0 ml-2">
                      <button
                        onClick={() => { setConfirmDeleteId(c.id); setDeleteError(null) }}
                        className="text-[10px] text-gray-600 hover:text-red-400 transition-colors"
                        title="Cancel and delete this challenge"
                      >
                        Delete
                      </button>
                      <button onClick={() => void toggle(c)} className="text-gray-600 text-[10px]">
                        {isOpen ? '▲' : '▼'}
                      </button>
                    </span>
                  )}
                </div>
                {deleteError?.id === c.id && (
                  <p className="text-red-400 text-[10px] px-3 pb-2">{deleteError.message}</p>
                )}
                {isOpen && (
                  <div className="border-t border-gray-800 px-3 py-2 text-xs space-y-2">
                    {status === 'loading' && <p className="text-gray-500">Checking…</p>}
                    {status === 'error' && <p className="text-red-400">Couldn&rsquo;t reach Huub.</p>}
                    {status && typeof status === 'object' && <BotChallengeStatusDetail status={status} />}
                  </div>
                )}
              </div>
            )
          })}
        </section>
      </div>
    </div>
  )
}

function BotChallengeStatusDetail({ status }: { status: BotChallengeStatus }) {
  const total = status.handResults.reduce((s, h) => s + h.points, 0)

  return (
    <div className="space-y-2">
      <p className="text-gray-400">
        {status.status === 'pending_join' && 'Waiting for them to join…'}
        {status.status === 'in_progress' && `In progress — hand ${status.currentIndex + 1} of ${status.totalHands}`}
        {status.status === 'finished' && 'Finished'}
        {status.status === 'cancelled' && 'Cancelled'}
      </p>
      {status.handResults.length > 0 && (
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-gray-600">
              <th className="text-left font-normal">Hand</th>
              <th className="text-right font-normal">Them</th>
              <th className="text-right font-normal">Bot</th>
            </tr>
          </thead>
          <tbody>
            {[...status.handResults].sort((a, b) => a.index - b.index).map(h => (
              <tr key={h.index} className="border-t border-gray-900">
                <td className="py-0.5 text-gray-500">{h.index + 1}</td>
                <td className={`py-0.5 text-right font-mono ${h.points >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {formatSigned(h.points)}
                </td>
                <td className="py-0.5 text-right font-mono text-gray-400">
                  {formatSigned(-h.points)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {status.status === 'finished' && (
        <p className={`text-xs font-medium ${total >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          Total: them {formatSigned(total)} vs bot {formatSigned(-total)}
        </p>
      )}
    </div>
  )
}
