import { useReducer, useRef, useState, useCallback } from 'react'
import { gameReducer, makeInitialState } from './reducer'
import type { Action } from './reducer'
import type { GameState } from './types'

export interface UndoControls {
  canUndo: boolean
  undo: () => void
}

export function useGame(): [GameState, (action: Action) => void, UndoControls] {
  const [state, dispatch] = useReducer(gameReducer, undefined, makeInitialState)
  const [snapshot, setSnapshot] = useState<GameState | null>(null)

  // Keep a ref so wrappedDispatch (stable callback) can read current state.
  const stateRef = useRef(state)
  stateRef.current = state

  const wrappedDispatch = useCallback((action: Action) => {
    if (action.type === 'LOCK_IN' || action.type === 'LOCK_BONUS_ONESHOT') {
      setSnapshot(stateRef.current)
    } else if (
      action.type === 'START_GAME' ||
      action.type === 'RESET' ||
      action.type === 'ADVANCE' ||
      action.type === 'START_BONUS' ||
      action.type === 'SKIP_BONUS'
    ) {
      setSnapshot(null)
    }
    dispatch(action)
  }, [])

  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  const undo = useCallback(() => {
    const snap = snapshotRef.current
    if (!snap) return
    setSnapshot(null)
    dispatch({ type: 'RESTORE_SNAPSHOT', snapshot: snap })
  }, [])

  return [state, wrappedDispatch, { canUndo: snapshot !== null, undo }]
}
