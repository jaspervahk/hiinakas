import { useEffect, useState } from 'react'
import type { AppPage } from '../App'
import type { HandLog } from '../game/types'
import { getRecentHands, getSessionStats, type SessionStats } from '../firestore/persistence'

interface StatsPageProps {
  onNavigate: (p: AppPage) => void
}

function formatDate(ts: number): string {
  try { return new Date(ts).toLocaleString() } catch { return '—' }
}

export default function StatsPage({ onNavigate }: StatsPageProps) {
  const [stats, setStats] = useState<SessionStats | null>(null)
  const [hands, setHands] = useState<HandLog[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [s, h] = await Promise.all([getSessionStats(), getRecentHands(20)])
        if (cancelled) return
        setStats(s)
        setHands(h)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const foulRate = stats && stats.handsPlayed > 0 ? (stats.foulCount / stats.handsPlayed) * 100 : 0
  const scoopRate = stats && stats.handsPlayed > 0 ? (stats.scoopCount / stats.handsPlayed) * 100 : 0

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <header className="flex items-center justify-between px-4 py-3 border-b border-gray-800/80">
        <button
          onClick={() => onNavigate('game')}
          className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
        >
          ← Back
        </button>
        <span className="text-sm font-semibold text-gray-200">Stats</span>
        <span className="w-12" />
      </header>

      <div className="max-w-2xl mx-auto p-4 flex flex-col gap-6">
        {loading && <p className="text-gray-500 text-sm">Loading…</p>}

        {!loading && (
          <>
            <section>
              <h2 className="text-xs uppercase tracking-widest text-gray-500 mb-2">Session</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <StatTile label="Hands played" value={stats?.handsPlayed ?? 0} />
                <StatTile label="Net score" value={stats?.netScore ?? 0} accent={(stats?.netScore ?? 0) >= 0 ? 'green' : 'red'} />
                <StatTile label="Avg EV loss" value={(stats?.avgEvLoss ?? 0).toFixed(2)} />
                <StatTile label="Foul rate" value={`${foulRate.toFixed(1)}%`} />
                <StatTile label="Royalties" value={stats?.royaltyEarned ?? 0} accent="amber" />
                <StatTile label="Scoop rate" value={`${scoopRate.toFixed(1)}%`} />
              </div>
            </section>

            <section>
              <h2 className="text-xs uppercase tracking-widest text-gray-500 mb-2">Recent hands</h2>
              {hands.length === 0 ? (
                <p className="text-sm text-gray-600">No hands recorded yet.</p>
              ) : (
                <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-gray-800/60 text-gray-500">
                        <th className="text-left px-3 py-2 font-medium">Time</th>
                        <th className="text-right px-3 py-2 font-medium">Players</th>
                        <th className="text-right px-3 py-2 font-medium">Net</th>
                        <th className="text-right px-3 py-2 font-medium">EV loss</th>
                        <th className="text-right px-3 py-2 font-medium">Royalties</th>
                        <th className="text-right px-3 py-2 font-medium">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hands.map(h => {
                        const net = h.totalScores[0] ?? 0
                        return (
                          <tr key={h.id} className="border-b border-gray-800/40 last:border-0">
                            <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{formatDate(h.timestamp)}</td>
                            <td className="px-3 py-2 text-right text-gray-500">{h.playerCount}</td>
                            <td className={`px-3 py-2 text-right tabular-nums font-semibold ${net > 0 ? 'text-green-400' : net < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                              {net > 0 ? `+${net}` : net}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-400">{h.cumEvLoss.toFixed(2)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-amber-400">{h.humanRoyalties}</td>
                            <td className="px-3 py-2 text-right text-xs">
                              {h.humanFouled ? <span className="text-red-400">Foul</span> : <span className="text-gray-500">OK</span>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function StatTile({ label, value, accent }: { label: string; value: number | string; accent?: 'green' | 'red' | 'amber' }) {
  const color =
    accent === 'green' ? 'text-green-400' :
    accent === 'red' ? 'text-red-400' :
    accent === 'amber' ? 'text-amber-400' :
    'text-gray-100'
  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-3">
      <div className="text-[10px] uppercase tracking-widest text-gray-500">{label}</div>
      <div className={`text-lg font-semibold mt-1 tabular-nums ${color}`}>{value}</div>
    </div>
  )
}
