import { useGame } from '../game/useGame'
import { GamePlayView } from '../components/GamePlayView'
import type { AppPage } from '../App'
import type { CoachMode } from '../game/types'

// Default sims when a policy/mode is first selected — the user can override
// via the Sims field. Heuristic MC brute-forces a full rollout per candidate
// with no NN/tree-search guidance, so it needs a far smaller budget to stay
// usable live (see the same tradeoff in Arena's Heuristic MC default).
const DEFAULT_BOT_SIMS_FOR: Record<'nn' | 'royalty' | 'royalty-nn', number> = {
  nn: 500, royalty: 1000, 'royalty-nn': 1000,
}
const DEFAULT_COACH_SIMS_FOR: Record<CoachMode, number> = {
  nn: 500, royalty: 1000, 'royalty-nn': 1000, heuristic: 20,
}

interface GamePageProps {
  onNavigate: (p: AppPage) => void
  currentPage: AppPage
}

export default function GamePage({ onNavigate, currentPage }: GamePageProps) {
  const [state, dispatch, { canUndo, undo }] = useGame()

  if (state.phase === 'setup') {
    return <SetupScreen
      onStart={(playerCount) => dispatch({ type: 'START_GAME', playerCount })}
      settings={state.appSettings}
      onUpdateSettings={(s) => dispatch({ type: 'UPDATE_SETTINGS', settings: s })}
      onNavigate={onNavigate}
    />
  }

  return (
    <GamePlayView
      state={state}
      dispatch={dispatch}
      canUndo={canUndo}
      undo={undo}
      onNavigate={onNavigate}
      currentPage={currentPage}
    />
  )
}

// ── Setup screen ────────────────────────────────────────────────────────────
interface SetupScreenProps {
  onStart: (playerCount: 2 | 3) => void
  settings: import('../game/types').AppSettings
  onUpdateSettings: (s: Partial<import('../game/types').AppSettings>) => void
  onNavigate: (p: AppPage) => void
}

function SetupScreen({ onStart, settings, onUpdateSettings, onNavigate }: SetupScreenProps) {
  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center gap-8 p-6">
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-4xl font-bold tracking-tight text-gray-100">Hiinakas</h1>
        <p className="text-gray-500 text-sm tracking-wide">Open-Face Chinese Poker</p>
      </div>

      {/* Settings */}
      <div className="flex flex-col gap-3 w-full max-w-xs">
        {/* Bot policy */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Opponent bot</span>
          <div className="flex rounded overflow-hidden border border-gray-700 text-xs">
            {(['nn', 'royalty', 'royalty-nn'] as const).map(p => (
              <button
                key={p}
                onClick={() => onUpdateSettings({ botPolicy: p, botSims: DEFAULT_BOT_SIMS_FOR[p] })}
                className={[
                  'px-3 py-1 transition-colors',
                  settings.botPolicy === p
                    ? 'bg-indigo-700 text-white'
                    : 'bg-gray-800 text-gray-500 hover:text-gray-300',
                ].join(' ')}
              >
                {p === 'nn' ? 'NN + MCTS' : p === 'royalty' ? 'Royalty' : 'Royalty NN'}
              </button>
            ))}
          </div>
        </div>

        {/* Bot sims / root top-K */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500">Bot sims</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs"
              value={settings.botSims}
              min={1}
              max={10_000}
              onChange={e => onUpdateSettings({ botSims: Math.max(1, Math.min(10_000, Number(e.target.value))) })}
            />
            {settings.botPolicy === 'nn' && (
              <>
                <span className="text-xs text-gray-500">top-K</span>
                <input
                  type="number"
                  className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs"
                  value={settings.botRootTopK}
                  min={1}
                  max={500}
                  onChange={e => onUpdateSettings({ botRootTopK: Math.max(1, Math.min(500, Number(e.target.value))) })}
                />
              </>
            )}
          </div>
        </div>

        {/* EV coach toggle */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">EV Coach</span>
          <div className="flex rounded overflow-hidden border border-gray-700 text-xs">
            <button
              onClick={() => onUpdateSettings({ coachEnabled: !settings.coachEnabled })}
              className={[
                'px-3 py-1 transition-colors',
                settings.coachEnabled ? 'bg-indigo-700 text-white' : 'bg-gray-800 text-gray-500 hover:text-gray-300',
              ].join(' ')}
            >
              {settings.coachEnabled ? 'On' : 'Off'}
            </button>
          </div>
        </div>

        {/* Coach mode — only relevant when coach is on */}
        {settings.coachEnabled && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-400">Coach mode</span>
              <div className="flex rounded overflow-hidden border border-gray-700 text-xs">
                {(['nn', 'royalty', 'royalty-nn', 'heuristic'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => onUpdateSettings({ coachMode: m, coachSims: DEFAULT_COACH_SIMS_FOR[m] })}
                    className={[
                      'px-3 py-1 transition-colors',
                      settings.coachMode === m
                        ? 'bg-indigo-700 text-white'
                        : 'bg-gray-800 text-gray-500 hover:text-gray-300',
                    ].join(' ')}
                  >
                    {m === 'nn' ? 'NN' : m === 'royalty' ? 'Royalty' : m === 'royalty-nn' ? 'Royalty NN' : 'Heuristic'}
                  </button>
                ))}
              </div>
            </div>

            {/* Coach sims / root top-K */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500">Coach sims</span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs"
                  value={settings.coachSims}
                  min={1}
                  max={settings.coachMode === 'heuristic' ? 500 : 10_000}
                  onChange={e => onUpdateSettings({ coachSims: Math.max(1, Math.min(settings.coachMode === 'heuristic' ? 500 : 10_000, Number(e.target.value))) })}
                />
                {settings.coachMode === 'nn' && (
                  <>
                    <span className="text-xs text-gray-500">top-K</span>
                    <input
                      type="number"
                      className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs"
                      value={settings.coachRootTopK}
                      min={1}
                      max={500}
                      onChange={e => onUpdateSettings({ coachRootTopK: Math.max(1, Math.min(500, Number(e.target.value))) })}
                    />
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex gap-4">
        {([2, 3] as const).map(n => (
          <button
            key={n}
            onClick={() => onStart(n)}
            className="px-8 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl font-medium text-base transition-colors"
          >
            {n} Players
          </button>
        ))}
      </div>

      <div className="flex gap-4 text-xs">
        <button onClick={() => onNavigate('stats')} className="text-gray-500 hover:text-gray-300 transition-colors">Stats</button>
        <span className="text-gray-700">·</span>
        <button onClick={() => onNavigate('analyzer')} className="text-gray-500 hover:text-gray-300 transition-colors">Analyzer</button>
        <span className="text-gray-700">·</span>
        <button onClick={() => onNavigate('arena')} className="text-gray-500 hover:text-gray-300 transition-colors">Arena</button>
      </div>
    </div>
  )
}
