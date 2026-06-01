import type { Board } from '../engine/index'
import { isFoul, royalties } from '../engine/index'
import { BoardView } from './BoardView'

interface ScoreViewProps {
  title: string
  boards: Board[]
  scores: number[]
  labels: string[]
  onContinue: () => void
  continueLabel?: string
  showRoyalties?: boolean
}

export function ScoreView({
  title, boards, scores, labels, onContinue, continueLabel, showRoyalties,
}: ScoreViewProps) {
  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-3xl mx-auto">
      <h2 className="text-xl font-semibold text-gray-200 tracking-wide">{title}</h2>

      <div className="bg-gray-900 rounded-xl border border-gray-700/60 overflow-hidden w-full max-w-xs">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700/60">
              <th className="text-left px-4 py-2.5 text-gray-500 font-medium">Player</th>
              {showRoyalties && <th className="text-right px-3 py-2.5 text-gray-500 font-medium">Roy.</th>}
              <th className="text-right px-4 py-2.5 text-gray-500 font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {labels.map((lbl, i) => {
              const board = boards[i]
              const fouled = board ? isFoul(board) : false
              const roy = board && !fouled ? royalties(board) : 0
              const net = scores[i] ?? 0
              return (
                <tr key={i} className="border-b border-gray-800/60 last:border-0">
                  <td className="px-4 py-2.5 text-gray-300">
                    {lbl}
                    {fouled && <span className="ml-2 text-red-500 text-xs font-medium">Foul</span>}
                  </td>
                  {showRoyalties && (
                    <td className="px-3 py-2.5 text-right text-amber-400 text-xs">
                      {roy > 0 ? `+${roy}` : '—'}
                    </td>
                  )}
                  <td className={`px-4 py-2.5 text-right font-semibold ${net > 0 ? 'text-green-400' : net < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                    {net > 0 ? `+${net}` : net}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-4 justify-center">
        {boards.map((board, i) => (
          <BoardView
            key={i}
            board={board}
            label={labels[i]}
            showStatus
          />
        ))}
      </div>

      {continueLabel && (
        <button
          onClick={onContinue}
          className="px-8 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-lg transition-colors text-sm"
        >
          {continueLabel}
        </button>
      )}
    </div>
  )
}
