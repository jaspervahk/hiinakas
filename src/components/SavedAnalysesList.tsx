import { useEffect, useState } from 'react'
import { listSavedAnalyses, deleteSessionAnalysis, renameSessionAnalysis } from '../firestore/sessionAnalysis'
import type { SavedAnalysisMeta } from '../game/sessionAnalysisTypes'

interface SavedAnalysesListProps {
  onOpen: (analysisId: string) => void
  onClose: () => void
}

export function SavedAnalysesList({ onOpen, onClose }: SavedAnalysesListProps) {
  const [items, setItems] = useState<SavedAnalysisMeta[] | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listSavedAnalyses().then(list => { if (!cancelled) setItems(list) })
    return () => { cancelled = true }
  }, [])

  const startRename = (m: SavedAnalysisMeta) => { setRenamingId(m.id); setRenameValue(m.name) }
  const confirmRename = async (id: string) => {
    const name = renameValue.trim()
    setRenamingId(null)
    if (!name) return
    await renameSessionAnalysis(id, name)
    setItems(prev => prev?.map(m => m.id === id ? { ...m, name } : m) ?? null)
  }

  const confirmDelete = async (id: string) => {
    setDeletingId(null)
    setItems(prev => prev?.filter(m => m.id !== id) ?? null)
    await deleteSessionAnalysis(id)
  }

  return (
    <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-gray-900 border border-gray-800 rounded-xl w-full max-w-lg max-h-[80vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 sticky top-0 bg-gray-900">
          <h3 className="text-gray-200 text-sm font-medium">Saved Analyses</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-sm">✕</button>
        </div>

        {items === null && (
          <p className="text-gray-500 text-xs px-4 py-6 text-center">Loading…</p>
        )}
        {items !== null && items.length === 0 && (
          <p className="text-gray-600 text-xs px-4 py-6 text-center italic">No saved analyses yet.</p>
        )}
        {items !== null && items.length > 0 && (
          <div className="divide-y divide-gray-800">
            {items.map(m => (
              <div key={m.id} className="px-4 py-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  {renamingId === m.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') confirmRename(m.id); if (e.key === 'Escape') setRenamingId(null) }}
                      onBlur={() => confirmRename(m.id)}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white"
                    />
                  ) : (
                    <button onClick={() => onOpen(m.id)} className="text-gray-200 hover:text-indigo-300 text-sm font-medium text-left truncate block w-full">
                      {m.name}
                    </button>
                  )}
                  <p className="text-gray-600 text-[11px] mt-0.5">
                    {m.playerNames.join(' vs ')} · {m.gameCount} games · {m.decisionCount} decisions
                    {m.bonusDecisionCount > 0 && ` · ${m.bonusDecisionCount} bonus`}
                  </p>
                  <p className="text-gray-700 text-[10px] mt-0.5">
                    {new Date(m.dateRangeStart).toLocaleDateString()} · saved {new Date(m.createdAt).toLocaleDateString()} ·{' '}
                    {m.analysisMode} @ {m.sims} sims
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {deletingId === m.id ? (
                    <>
                      <span className="text-red-400 text-[11px]">Delete?</span>
                      <button onClick={() => confirmDelete(m.id)} className="text-red-400 hover:text-red-300 text-[11px] font-medium">Yes</button>
                      <button onClick={() => setDeletingId(null)} className="text-gray-500 hover:text-gray-300 text-[11px]">No</button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => startRename(m)} className="text-gray-600 hover:text-gray-300 text-[11px]">Rename</button>
                      <button onClick={() => setDeletingId(m.id)} className="text-gray-600 hover:text-red-400 text-[11px]">Delete</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
