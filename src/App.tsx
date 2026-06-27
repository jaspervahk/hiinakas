import { lazy, Suspense, useEffect, useState } from 'react'
import { AuthGate } from './AuthGate'
import GamePage from './pages/GamePage'
import { workerClient, botWorkerClient } from './worker/client'

const StatsPage = lazy(() => import('./pages/StatsPage'))
const AnalyzerPage = lazy(() => import('./pages/AnalyzerPage'))

export type AppPage = 'game' | 'stats' | 'analyzer'

function PageLoader() {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <span className="text-gray-500 text-sm">Loading…</span>
    </div>
  )
}

export default function App() {
  const [page, setPage] = useState<AppPage>('game')

  // Load NN model into both workers on startup. botWorkerClient loads from the same buffer
  // so we only download once. Silently no-ops if the model hasn't been trained yet.
  useEffect(() => {
    workerClient.loadModel().then(ok => {
      if (ok) botWorkerClient.loadFromCache()
    })
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
    </AuthGate>
  )
}
