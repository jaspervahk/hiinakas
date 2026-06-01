import { lazy, Suspense, useEffect, useState } from 'react'
import { AuthGate } from './AuthGate'
import GamePage from './pages/GamePage'
import { workerClient } from './worker/client'

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

  // Attempt to load NN model weights into the worker on startup.
  // Silently no-ops if the model hasn't been trained yet.
  useEffect(() => {
    void workerClient.loadModel()
  }, [])

  return (
    <AuthGate>
      {page === 'game' && <GamePage onNavigate={setPage} />}
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
