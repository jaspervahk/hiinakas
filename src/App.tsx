import { lazy, Suspense, useEffect, useState } from 'react'
import { AuthGate } from './AuthGate'
import GamePage from './pages/GamePage'
import { workerClient, botWorkerClient, arenaWorkerClient, ROYALTY_MODEL_URL } from './worker/client'

const StatsPage = lazy(() => import('./pages/StatsPage'))
const AnalyzerPage = lazy(() => import('./pages/AnalyzerPage'))
const ArenaPage = lazy(() => import('./pages/ArenaPage'))

export type AppPage = 'game' | 'stats' | 'analyzer' | 'arena'

function PageLoader() {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <span className="text-gray-500 text-sm">Loading…</span>
    </div>
  )
}

export default function App() {
  const [page, setPage] = useState<AppPage>('game')

  // Load NN model into all NN-using workers on startup. Cache means only one download.
  useEffect(() => {
    workerClient.loadModel().then(ok => {
      if (ok) {
        botWorkerClient.loadFromCache()
        arenaWorkerClient.loadFromCache()
      }
    })
    // Load royalty NN model in the background (only used by royalty-nn bot/arena mode).
    // Cache the buffer so other workers can load from it without re-downloading.
    botWorkerClient.loadRoyaltyModel(ROYALTY_MODEL_URL).catch(() => {})
  }, [])

  return (
    <AuthGate>
      {/* GamePage stays mounted so game state survives analyzer navigation */}
      <div className={page !== 'game' ? 'hidden' : undefined}>
        <GamePage onNavigate={setPage} currentPage={page} />
      </div>
      {page === 'stats' && (
        <Suspense fallback={<PageLoader />}>
          <StatsPage onNavigate={setPage} />
        </Suspense>
      )}
      {page === 'analyzer' && (
        <Suspense fallback={<PageLoader />}>
          <AnalyzerPage onNavigate={setPage} />
        </Suspense>
      )}
      {page === 'arena' && (
        <Suspense fallback={<PageLoader />}>
          <ArenaPage onNavigate={setPage} />
        </Suspense>
      )}
    </AuthGate>
  )
}
