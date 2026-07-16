import { useReducer, useRef, useState, useCallback, useEffect } from 'react'
import { gameReducer, makeInitialState } from './reducer'
import type { Action } from './reducer'
import type { GameState } from './types'
import type { UndoControls } from './useGame'
import type { HandReplayData } from './replayBuilder'

// Same shape as useGame(), but initializes each hand from historical replay
// data (via START_REPLAY) instead of a fresh random deal — kept as a separate
// small hook rather than parameterizing useGame() itself, since the two only
// share the undo-snapshot wrapper, not any actual replay-specific logic.
export function useReplayGame(hand: HandReplayData | null): [GameState, (action: Action) => void, UndoControls] {
  const [state, dispatch] = useReducer(gameReducer, undefined, makeInitialState)
  const [snapshot, setSnapshot] = useState<GameState | null>(null)

  const stateRef = useRef(state)
  // eslint-disable-next-line react-hooks/refs
  stateRef.current = state

  const wrappedDispatch = useCallback((action: Action) => {
    if (action.type === 'LOCK_IN' || action.type === 'LOCK_BONUS_ONESHOT') {
      setSnapshot(stateRef.current)
    } else if (
      action.type === 'START_REPLAY' ||
      action.type === 'RESET' ||
      action.type === 'ADVANCE' ||
      action.type === 'START_BONUS' ||
      action.type === 'SKIP_BONUS'
    ) {
      setSnapshot(null)
    }
    dispatch(action)
  }, [])

  // Start (or restart) the reducer whenever the hand to replay changes.
  // Goes through wrappedDispatch (not the raw dispatch) so the snapshot reset
  // for START_REPLAY happens inside its own useCallback, not directly in this
  // effect's body.
  useEffect(() => {
    if (!hand) return
    wrappedDispatch({ type: 'START_REPLAY', playerCount: hand.playerCount, preDealt: hand.preDealt, replay: hand.replay })
  }, [hand, wrappedDispatch])

  const snapshotRef = useRef(snapshot)
  // eslint-disable-next-line react-hooks/refs
  snapshotRef.current = snapshot

  const undo = useCallback(() => {
    const snap = snapshotRef.current
    if (!snap) return
    setSnapshot(null)
    dispatch({ type: 'RESTORE_SNAPSHOT', snapshot: snap })
  }, [])

  return [state, wrappedDispatch, { canUndo: snapshot !== null, undo }]
}
