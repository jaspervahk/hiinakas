// Read-only, on-demand "pull" viewer for challenges previously sent to Huub
// (see functions/src/replayBridge.ts). Hiinakas never gets pushed live
// updates — every open pulls the current status straight from Huub via
// getHuubReplayChallengeStatus.

import { useEffect, useState } from 'react'
import { listSentChallenges, getHuubChallengeStatus, cancelHuubChallenge } from '../firestore/huubBridge'
import type { SentChallenge, HuubChallengeStatus } from '../firestore/huubBridge'
import { ChallengeHandsDetail } from './ChallengeHandsDetail'

type StatusEntry = HuubChallengeStatus | 'loading' | 'error'

export function SentChallengesList({ onClose }: { onClose: () => void }) {
  const [challenges, setChallenges] = useState<SentChallenge[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [statusById, setStatusById] = useState<Map<string, StatusEntry>>(new Map())
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null)
  const [detailChallenge, setDetailChallenge] = useState<SentChallenge | null>(null)

  useEffect(() => { void listSentChallenges().then(setChallenges) }, [])

  const toggle = async (c: SentChallenge) => {
    if (openId === c.id) { setOpenId(null); return }
    setOpenId(c.id)
    if (statusById.has(c.id)) return
    setStatusById(prev => new Map(prev).set(c.id, 'loading'))
    try {
      const status = await getHuubChallengeStatus(c.huubChallengeId)
      setStatusById(prev => new Map(prev).set(c.id, status))
    } catch {
      setStatusById(prev => new Map(prev).set(c.id, 'error'))
    }
  }

  const confirmDelete = async (c: SentChallenge) => {
    setDeletingId(c.id)
    setDeleteError(null)
    try {
      await cancelHuubChallenge(c.id)
      setChallenges(prev => (prev ?? []).filter(x => x.id !== c.id))
      setConfirmDeleteId(null)
    } catch (e) {
      setDeleteError({ id: c.id, message: e instanceof Error ? e.message : 'Failed to delete' })
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto space-y-3 border border-gray-800">
        <div className="flex items-center justify-between">
          <h2 className="text-gray-100 font-semibold text-sm">Sent Huub challenges</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xs">Close</button>
        </div>
        {challenges === null && <p className="text-gray-500 text-xs">Loading…</p>}
        {challenges?.length === 0 && <p className="text-gray-500 text-xs">No challenges sent yet.</p>}
        {challenges?.map(c => {
          const status = statusById.get(c.id)
          const isOpen = openId === c.id
          const isConfirming = confirmDeleteId === c.id
          return (
            <div key={c.id} className="bg-gray-950 rounded-lg border border-gray-800">
              <div className="w-full flex items-center justify-between px-3 py-2">
                <button onClick={() => void toggle(c)} className="flex-1 text-left min-w-0">
                  <p className="text-gray-200 text-xs font-medium truncate">{c.sessionName || c.huubUsername}</p>
                  <p className="text-gray-600 text-[10px]">
                    to {c.huubUsername} · {c.sourceGameIds.length} hands · {new Date(c.createdAt).toLocaleDateString()}
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
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="text-[10px] text-gray-500 hover:text-gray-300"
                    >
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
                  {status && typeof status === 'object' && (
                    <ChallengeStatusDetail status={status} />
                  )}
                  <button
                    onClick={() => setDetailChallenge(c)}
                    className="text-indigo-400 hover:text-indigo-300 text-[10px]"
                  >
                    View all hands & boards →
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {detailChallenge && (
        <ChallengeHandsDetail challenge={detailChallenge} onClose={() => setDetailChallenge(null)} />
      )}
    </div>
  )
}

function ChallengeStatusDetail({ status }: { status: HuubChallengeStatus }) {
  const actualTotal = status.hands.reduce((s, h) => s + h.historicalTotal, 0)
  const replayTotal = status.hands.reduce((s, h) => s + (h.resultCumulativePoints ?? 0), 0)
  const diff = replayTotal - actualTotal

  return (
    <div className="space-y-2">
      <p className="text-gray-400">
        {status.status === 'pending_join' && 'Waiting for them to join…'}
        {status.status === 'in_progress' && `In progress — hand ${status.currentIndex + 1} of ${status.totalHands}`}
        {status.status === 'finished' && 'Finished'}
        {status.status === 'cancelled' && 'Cancelled'}
      </p>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-gray-600">
            <th className="text-left font-normal">Hand</th>
            <th className="text-right font-normal">Actual</th>
            <th className="text-right font-normal">Their replay</th>
          </tr>
        </thead>
        <tbody>
          {status.hands.map(h => (
            <tr key={h.index} className="border-t border-gray-900">
              <td className="py-0.5 text-gray-500">{h.index + 1}</td>
              <td className="py-0.5 text-right font-mono text-gray-400">
                {h.historicalTotal > 0 ? '+' : ''}{h.historicalTotal}
              </td>
              <td className="py-0.5 text-right font-mono">
                {h.resultCumulativePoints == null ? (
                  <span className="text-gray-700">—</span>
                ) : (
                  <span className={h.resultCumulativePoints >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                    {h.resultCumulativePoints > 0 ? '+' : ''}{h.resultCumulativePoints}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {status.status === 'finished' && (
        <p className={`text-xs font-medium ${diff > 0 ? 'text-emerald-400' : diff < 0 ? 'text-red-400' : 'text-gray-400'}`}>
          Total: actual {actualTotal > 0 ? '+' : ''}{actualTotal} vs their {replayTotal > 0 ? '+' : ''}{replayTotal}
          {diff !== 0 && ` (${diff > 0 ? '+' : ''}${diff})`}
        </p>
      )}
    </div>
  )
}
