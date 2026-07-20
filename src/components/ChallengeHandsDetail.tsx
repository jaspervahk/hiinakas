// Full hand-by-hand detail view for a sent Huub challenge: every hand's
// original board (reconstructed from Hiinakas's own persisted historical
// record) alongside the challenged player's actual board (pulled live from
// Huub). Opened from SentChallengesList.tsx.

import { useEffect, useState } from 'react'
import { getPersistedHands, getHuubChallengeStatus } from '../firestore/huubBridge'
import type { SentChallenge, HuubReplayHandStatus } from '../firestore/huubBridge'
import { targetFinalBoard, fromHuubBoard, type PersistedHand } from '../game/huubChallengeDetail'
import type { Board } from '../engine/index'
import { CardChip } from './CandidateList'

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

function formatSigned(n: number): string {
  return `${n > 0 ? '+' : ''}${n}`
}

export function ChallengeHandsDetail({ challenge, onClose }: { challenge: SentChallenge; onClose: () => void }) {
  const [hands, setHands] = useState<PersistedHand[] | null>(null)
  const [huubHands, setHuubHands] = useState<HuubReplayHandStatus[]>([])
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [error, setError] = useState('')
  const loading = hands === null && !error

  useEffect(() => {
    let cancelled = false
    Promise.all([
      getPersistedHands(challenge.id),
      getHuubChallengeStatus(challenge.huubChallengeId).catch(() => null),
    ]).then(([persisted, status]) => {
      if (cancelled) return
      setHands(persisted)
      setHuubHands(status?.hands ?? [])
    }).catch(e => {
      if (cancelled) return
      setError(e instanceof Error ? e.message : 'Failed to load')
    })
    return () => { cancelled = true }
  }, [challenge.id, challenge.huubChallengeId])

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl p-6 max-w-2xl w-full max-h-[85vh] overflow-y-auto space-y-3 border border-gray-800">
        <div className="flex items-center justify-between sticky top-0 bg-gray-900 pb-2">
          <h2 className="text-gray-100 font-semibold text-sm">
            {challenge.sessionName || challenge.huubUsername} — all hands
          </h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xs">Close</button>
        </div>
        {loading && <p className="text-gray-500 text-xs">Loading…</p>}
        {error && <p className="text-red-400 text-xs">{error}</p>}
        {!loading && hands?.length === 0 && (
          <p className="text-gray-500 text-xs">
            No hand data saved for this challenge — it was likely sent before this detail view existed.
            Only challenges sent after that keep a full record.
          </p>
        )}
        {hands?.map((hand) => {
          const huub = huubHands.find(h => h.index === hand.index)
          const isOpen = openIndex === hand.index
          const yourBoard = huub?.yourBoard ? fromHuubBoard(huub.yourBoard) : null
          return (
            <div key={hand.index} className="bg-gray-950 rounded-lg border border-gray-800">
              <button
                onClick={() => setOpenIndex(isOpen ? null : hand.index)}
                className="w-full flex items-center justify-between px-3 py-2 text-left"
              >
                <span className="text-gray-300 text-xs">Hand {hand.index + 1}</span>
                <span className="text-[10px] font-mono text-gray-500">
                  you {formatSigned(hand.historicalTotal)}
                  {huub?.resultCumulativePoints != null && (
                    <> · them {formatSigned(huub.resultCumulativePoints)}</>
                  )}
                </span>
                <span className="text-gray-600 text-[10px]">{isOpen ? '▲' : '▼'}</span>
              </button>
              {isOpen && (
                <div className="border-t border-gray-800 px-3 py-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <BoardDisplay board={targetFinalBoard(hand)} label="Your original board" color="text-indigo-400" />
                  {yourBoard ? (
                    <BoardDisplay board={yourBoard} label="Challenged player's board" color="text-amber-400" />
                  ) : (
                    <p className="text-gray-600 text-xs italic">Not played yet.</p>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
